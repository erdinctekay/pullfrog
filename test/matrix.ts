/**
 * unified CI matrix builder. emits the four matrices consumed by
 * `.github/workflows/test.yml`:
 *
 *   - agents:    crossagent tests × eligible agents (fan-out)
 *   - agnostic:  agnostic infrastructure tests (run with opencode)
 *   - flagships: one harness smoke per provider (providers-live)
 *   - aliases:   one CLI smoke per model alias (models-live)
 *
 * input: a JSON array of repo-relative changed paths on stdin (the
 * `paths-filter` action's `*_files` output). PR pushes pass the diff;
 * `main` pushes and `workflow_dispatch` set FULL=1 to skip filtering and
 * emit every entry.
 *
 * each test/provider declares its own `coverage` globs colocated with the
 * test (`crossagent/`, `agnostic/`) or provider (`providers.ts`). the matrix
 * builder intersects coverage against the diff. a top-level `ALWAYS_RUN_ALL`
 * (see `coverage.ts`) bypasses filtering when test-harness or cross-cutting
 * agent code changes — keeps stale globs from silently skipping critical
 * tests on test runner / shared.ts churn.
 *
 * usage:
 *   echo '["action/agents/opencode.ts"]' | node action/test/matrix.ts
 *   FULL=1 node action/test/matrix.ts < /dev/null
 *   MATRIX_FILTER=gemini FULL=1 node action/test/matrix.ts < /dev/null
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldRun } from "./coverage.ts";
import { buildAliasMatrix, buildFlagshipMatrix } from "./list-aliases.ts";
import { providers } from "./providers.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

type AgentEntry = { agent: string; test: string; name: string };
type AgnosticEntry = { test: string; name: string };
type SlugEntry = { slug: string; agent: string; name: string };

type MatrixOutput = {
  agents: AgentEntry[];
  agnostic: AgnosticEntry[];
  flagships: SlugEntry[];
  aliases: SlugEntry[];
};

/**
 * extracted test metadata. parsed via regex from the test source — see
 * `parseTestFile`. dynamic-import is intentionally avoided: the GHA `changes`
 * job runs without `pnpm install`, and the real test modules transitively
 * import `@actions/core` etc. parsing keeps `matrix.ts` zero-dep.
 */
type ParsedTest = {
  name: string;
  agents: string[] | undefined;
  coverage: string[] | undefined;
};

const STRING_LITERAL = /"((?:\\.|[^"\\])*)"/g;

function extractStringLiterals(source: string): string[] {
  const out: string[] = [];
  STRING_LITERAL.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = STRING_LITERAL.exec(source))) {
    out.push(m[1]);
  }
  return out;
}

/**
 * extract a `key: [...]` array literal of strings from a test object. matches
 * line-leading indented `key:` to avoid colliding with the same word inside
 * prompts / template literals.
 */
function extractStringArray(source: string, key: string): string[] | undefined {
  const re = new RegExp(`^\\s+${key}:\\s*\\[([\\s\\S]*?)\\]`, "m");
  const m = source.match(re);
  if (!m) return undefined;
  return extractStringLiterals(m[1]);
}

function parseTestFile(source: string): ParsedTest | null {
  // strip line comments — `//` inside string literals is rare in test files,
  // and the static parser doesn't need to be perfect (defensive default of
  // "missing coverage = always run" covers parse misses).
  const stripped = source.replace(/\/\/[^\n]*$/gm, "");
  const nameMatch = stripped.match(/^\s+name:\s*"([^"]+)"/m);
  if (!nameMatch) return null;
  return {
    name: nameMatch[1],
    agents: extractStringArray(stripped, "agents"),
    coverage: extractStringArray(stripped, "coverage"),
  };
}

function loadDir(dir: string): ParsedTest[] {
  const dirPath = join(__dirname, dir);
  if (!existsSync(dirPath)) return [];
  const files = readdirSync(dirPath).filter((f) => f.endsWith(".ts"));
  const out: ParsedTest[] = [];
  for (const file of files) {
    const source = readFileSync(join(dirPath, file), "utf8");
    const parsed = parseTestFile(source);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * derive the active agent list from `agents/index.ts` so adding a new harness
 * file automatically wires it into the matrix. avoids dynamic-import
 * (transitively pulls `@actions/core` etc. — would explode in the no-install
 * `changes` job) by regex-parsing the imports the same way `parseTestFile`
 * handles tests.
 */
function loadAgents(): string[] {
  const indexPath = join(__dirname, "..", "agents", "index.ts");
  const source = readFileSync(indexPath, "utf8");
  const out: string[] = [];
  const re = /^\s*import\s+\{\s*(\w+)\s*\}\s+from\s+"\.\/(\w+)\.ts"/gm;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = re.exec(source))) {
    if (m[2] === "shared") continue;
    out.push(m[1]);
  }
  return out.sort();
}

function readChangedFiles(): string[] {
  const raw = readFileSync(0, "utf8").trim();
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("matrix: stdin must be a JSON array of changed paths");
  }
  return parsed.map((p) => {
    if (typeof p !== "string") {
      throw new Error(`matrix: non-string entry in changed paths: ${JSON.stringify(p)}`);
    }
    return p;
  });
}

function buildAgentsMatrix(input: { changedFiles: string[]; full: boolean }): AgentEntry[] {
  const tests = loadDir("crossagent");
  const allAgents = loadAgents();
  const out: AgentEntry[] = [];
  for (const t of tests) {
    if (!shouldRun({ changedFiles: input.changedFiles, coverage: t.coverage, full: input.full })) {
      continue;
    }
    const agents = t.agents ?? allAgents;
    for (const agent of agents) {
      out.push({ agent, test: t.name, name: `${t.name}-${agent}` });
    }
  }
  return out;
}

function buildAgnosticMatrix(input: { changedFiles: string[]; full: boolean }): AgnosticEntry[] {
  const tests = loadDir("agnostic");
  const out: AgnosticEntry[] = [];
  for (const t of tests) {
    if (!shouldRun({ changedFiles: input.changedFiles, coverage: t.coverage, full: input.full })) {
      continue;
    }
    out.push({ test: t.name, name: t.name });
  }
  return out;
}

function buildFlagshipsMatrix(input: {
  changedFiles: string[];
  full: boolean;
  filter: string;
}): SlugEntry[] {
  const all = buildFlagshipMatrix({ filter: input.filter });
  const byName = new Map(providers.map((p) => [p.flagship, p]));
  return all.filter((entry) => {
    const provider = byName.get(entry.slug);
    return shouldRun({
      changedFiles: input.changedFiles,
      coverage: provider?.coverage,
      full: input.full,
    });
  });
}

function buildAliasesMatrix(input: {
  changedFiles: string[];
  full: boolean;
  filter: string;
  includePassthroughs: boolean;
}): SlugEntry[] {
  const all = buildAliasMatrix({
    filter: input.filter,
    includePassthroughs: input.includePassthroughs,
  });
  const coverageByProvider = new Map(providers.map((p) => [p.name, p.coverage]));
  return all.filter((entry) => {
    const provider = entry.slug.split("/")[0];
    return shouldRun({
      changedFiles: input.changedFiles,
      coverage: coverageByProvider.get(provider),
      full: input.full,
    });
  });
}

function main(): void {
  const full = process.env.FULL === "1";
  const filter = process.env.MATRIX_FILTER?.trim().toLowerCase() ?? "";
  const includePassthroughs = process.env.INCLUDE_PASSTHROUGHS === "1";
  const changedFiles = full ? [] : readChangedFiles();

  const output: MatrixOutput = {
    agents: buildAgentsMatrix({ changedFiles, full }),
    agnostic: buildAgnosticMatrix({ changedFiles, full }),
    flagships: buildFlagshipsMatrix({ changedFiles, full, filter }),
    aliases: buildAliasesMatrix({ changedFiles, full, filter, includePassthroughs }),
  };

  process.stdout.write(JSON.stringify(output));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
