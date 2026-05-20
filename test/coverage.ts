/**
 * shared coverage / glob plumbing for the matrix builder.
 *
 * every test (`crossagent/`, `agnostic/`) and every provider entry
 * (`providers.ts`) declares a `coverage` array of repo-relative globs. on a PR
 * push, the `changes` job feeds the changed-file list into `matrix.ts`, which
 * intersects each entry's globs against the diff and emits only the entries
 * that need to run.
 *
 * `ALWAYS_RUN_ALL` is the escape hatch: any change to a file matched here
 * forces the full matrix (every test, every flagship, every alias). it
 * captures cross-cutting infrastructure where fan-out is unpredictable —
 * agent loader, MCP server boot, test runner itself. if a per-test glob
 * goes stale, this list and the on-`main`-full-matrix policy are the safety
 * nets — there's no completeness lint.
 *
 * `coverage` is optional on tests/providers; missing = always run (treat as
 * "any code change touches me"). default to defensive — opt into precision
 * by adding globs.
 */

/** patterns that, when matched by any changed file, force the full matrix. */
export const ALWAYS_RUN_ALL: string[] = [
  // agent loader + cross-agent shared code
  "action/agents/shared.ts",
  "action/agents/index.ts",
  "action/agents/postRun.ts",
  // test harness — changing these can affect every test
  "action/test/run.ts",
  "action/test/utils.ts",
  "action/test/matrix.ts",
  "action/test/list-aliases.ts",
  "action/test/coverage.ts",
  "action/test/providers.ts",
  // boot + lifecycle
  "action/main.ts",
  "action/index.ts",
  "action/cli.ts",
  "action/utils/setup.ts",
  "action/utils/install.ts",
  "action/utils/runFixture.ts",
  "action/utils/globals.ts",
  // local docker container plumbing (changes invalidate every test's environment)
  "action/Dockerfile",
  "action/docker-entrypoint.sh",
  "action/docker.ts",
  // MCP orchestrator (every test runs through it)
  "action/mcp/server.ts",
  "action/mcp/shared.ts",
  // dependency graph
  "action/package.json",
  "action/pnpm-lock.yaml",
  // workflow itself
  ".github/workflows/test.yml",
];

/**
 * expand a single brace group like `{a,b,c}` into an array of patterns.
 *
 * intentionally minimal: nested braces (`{a,{b,c}}`) and escaped braces are
 * NOT supported — coverage globs in this repo only need flat brace groups
 * (`{claude,opencode}.ts`). add complexity if a real use case emerges.
 */
function expandBraces(pattern: string): string[] {
  const m = pattern.match(/\{([^{}]+)\}/);
  if (!m || m.index === undefined) return [pattern];
  const before = pattern.slice(0, m.index);
  const after = pattern.slice(m.index + m[0].length);
  const opts = m[1].split(",");
  return opts.flatMap((opt) => expandBraces(`${before}${opt}${after}`));
}

/** convert a glob pattern to a regex anchored at start + end. */
function globToRegex(pattern: string): RegExp {
  const DSTAR = "\u0000DSTAR\u0000";
  let s = pattern.replace(/\*\*/g, DSTAR);
  s = s.replace(/[.+^$()|[\]\\]/g, "\\$&");
  s = s.replace(/\*/g, "[^/]*");
  s = s.replace(/\?/g, "[^/]");
  s = s.replaceAll(DSTAR, ".*");
  return new RegExp(`^${s}$`);
}

/** does any path in `paths` match any glob in `patterns`? */
export function anyMatch(paths: string[], patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const regexes = patterns.flatMap((p) => expandBraces(p)).map(globToRegex);
  return paths.some((path) => regexes.some((r) => r.test(path)));
}

/**
 * decide whether an entry runs given changed files + its coverage globs.
 *
 * three short-circuits:
 *   1. `full` flag (e.g. main pushes, workflow_dispatch) → always run
 *   2. any changed file matches `ALWAYS_RUN_ALL` → run everything
 *   3. coverage missing or empty on the entry → run (defensive default)
 *
 * otherwise: run iff any changed file matches the entry's coverage globs.
 *
 * `coverage: []` is treated identically to `coverage: undefined` to avoid the
 * footgun where a future test author intends "skip on PRs" by passing an
 * empty array — silently skipping CI on every PR is worse than always running.
 */
export type ShouldRunInput = {
  changedFiles: string[];
  coverage: string[] | undefined;
  full: boolean;
};

export function shouldRun(input: ShouldRunInput): boolean {
  if (input.full) return true;
  if (anyMatch(input.changedFiles, ALWAYS_RUN_ALL)) return true;
  if (input.coverage === undefined || input.coverage.length === 0) return true;
  return anyMatch(input.changedFiles, input.coverage);
}
