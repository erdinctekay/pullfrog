import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agents as agentMap } from "../agents/index.ts";
import type { Inputs } from "../main.ts";
import { trackChild, untrackChild } from "../utils/subprocess.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const actionDir = join(__dirname, "..");

const LOCAL_TEST_WARNING = "This is a local test - do not post any comments to GitHub.";

// reusable prompt for shell tool tests - covers both MCP and internal agent tools
export function buildShellToolPrompt(command: string): string {
  return `Try to run this shell command: ${command}

Check ALL available tools that could execute shell commands:
- MCP tools from gh_pullfrog server (e.g. shell tool)
- Internal agent tools (e.g. Shell, Task that can run shell commands)
- Any other tool that can execute commands`;
}

export type FixtureOptions = {
  localOnly?: boolean;
};

// type-safe fixture builder with optional local test warning
export function defineFixture(inputs: Inputs, options?: FixtureOptions): Inputs {
  if (options?.localOnly) {
    return {
      ...inputs,
      prompt: `${inputs.prompt}\n\n${LOCAL_TEST_WARNING}`,
    };
  }
  return inputs;
}

export const agents = Object.keys(agentMap) as (keyof typeof agentMap)[];

export type AgentUuids<T extends string> = {
  // get marker value for a specific agent and env var
  getUuid: (agent: string, envVar: T) => string;
  // pre-built agentEnv map for runTests
  agentEnv: Map<string, Record<string, string>>;
};

// simple marker for single-agent or agnostic tests (same value for all agents)
export function generateTestMarker(envVarName: string): {
  value: string;
  agentEnv: Map<string, Record<string, string>>;
} {
  const value = randomUUID();
  const agentEnv = new Map<string, Record<string, string>>();
  for (const agent of agents) {
    agentEnv.set(agent, { [envVarName]: value });
  }
  return { value, agentEnv };
}

// create unique per-agent markers for env vars (useful for cross-agent tests)
export function generateAgentUuids<T extends string>(envVarNames: T[]): AgentUuids<T> {
  // generate unique markers: envVar -> agent -> marker
  const markers = new Map<T, Map<string, string>>();
  for (const envVar of envVarNames) {
    const agentMap = new Map<string, string>();
    for (const agent of agents) {
      agentMap.set(agent, randomUUID());
    }
    markers.set(envVar, agentMap);
  }

  // build agentEnv map for runTests
  const agentEnv = new Map<string, Record<string, string>>();
  for (const agent of agents) {
    const env: Record<string, string> = {};
    for (const envVar of envVarNames) {
      env[envVar] = markers.get(envVar)!.get(agent)!;
    }
    agentEnv.set(agent, env);
  }

  return {
    getUuid: (agent, envVar) => markers.get(envVar)?.get(agent) ?? "",
    agentEnv,
  };
}

// assign consistent colors to agents (using ANSI codes)
const AGENT_COLORS: Record<string, string> = {
  opentoad: "\x1b[32m", // green
};
const RESET = "\x1b[0m";

export type PrefixContext = {
  test: string;
  agent: string;
};

export function getPrefix(ctx: PrefixContext): string {
  const color = AGENT_COLORS[ctx.agent] ?? "\x1b[37m";
  return `${color}[${ctx.test}][${ctx.agent}]${RESET}`;
}

export interface AgentResult {
  agent: string;
  success: boolean;
  output: string;
  structuredOutput: string | null;
}

// get agent output with GitHub Actions masking commands filtered out
// ::add-mask:: lines contain env var values but aren't actual agent output
export function getAgentOutput(result: AgentResult): string {
  return result.output
    .split("\n")
    .filter((line) => !line.includes("::add-mask::"))
    .join("\n");
}

// extract structured output from test result.
export function getStructuredOutput(result: AgentResult): string | null {
  return result.structuredOutput;
}

// parse GITHUB_OUTPUT file format to extract a key's value.
// format: key<<ghadelimiter_<uuid>\n<value>\nghadelimiter_<uuid>
function parseGitHubOutputFile(filePath: string, key: string): string | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const pattern = new RegExp(`${key}<<(ghadelimiter_[\\w-]+)\\n([\\s\\S]*?)\\n\\1`);
  const match = content.match(pattern);
  if (!match) return null;
  return match[2];
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
}

export interface ValidationResult {
  test: string;
  agent: string;
  passed: boolean;
  canceled: boolean;
  checks: ValidationCheck[];
  output: string;
}

export type ValidatorFn = (result: AgentResult) => ValidationCheck[];

export type RunStreamingOptions = {
  test: string;
  agent: string;
  fixture: Inputs;
  env?: Record<string, string> | undefined;
  // env vars to write to $HOME/.pullfrog-env/ files (for MCP servers that
  // don't inherit parent env vars, e.g. Cursor repo-level MCP servers).
  // only these get written to disk -- never write secrets here.
  fileEnv?: Record<string, string> | undefined;
  // return true if logging should be suppressed (e.g. Ctrl+C)
  isCanceled?: () => boolean;
};

const DEFAULT_TEST_TIMEOUT = "10m";

// run agent and stream output with prefix labels
// note: activity timeout is enforced in action main and subprocess utils
export async function runAgentStreaming(options: RunStreamingOptions): Promise<AgentResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const prefix = getPrefix({ test: options.test, agent: options.agent });
    function canLog(): boolean {
      return !options.isCanceled || !options.isCanceled();
    }

    // apply default timeout if not specified in fixture
    const fixture: Inputs = {
      ...options.fixture,
      timeout: options.fixture.timeout ?? DEFAULT_TEST_TIMEOUT,
    };

    // create unique HOME directory per test to avoid config file conflicts
    // when multiple tests run in parallel
    const mcpPort = options.env?.PULLFROG_MCP_PORT ?? "default";
    const testHome = `/tmp/home-${mcpPort}-${Date.now()}`;
    mkdirSync(testHome, { recursive: true });

    const githubOutputFile = join(testHome, "github-output");
    writeFileSync(githubOutputFile, "");

    // write file-based env vars for MCP servers that don't inherit parent env vars
    // (e.g., Cursor CLI doesn't pass env vars to repo-level MCP servers).
    // only explicitly opted-in vars go here -- never secrets.
    if (options.fileEnv) {
      const envDir = join(testHome, ".pullfrog-env");
      mkdirSync(envDir, { recursive: true });
      const entries = Object.entries(options.fileEnv);
      for (const entry of entries) {
        writeFileSync(join(envDir, entry[0]), entry[1]);
      }
    }

    const subEnv: Record<string, string | undefined> = {
      ...process.env,
      GITHUB_REPOSITORY: "pullfrog/test-repo", // default
      ...options.env,
      HOME: testHome,
      GITHUB_OUTPUT: githubOutputFile,
    };

    const child = spawn("node", ["play.ts", "--raw", JSON.stringify(fixture)], {
      cwd: actionDir,
      env: subEnv as Record<string, string>,
      stdio: "pipe",
      detached: true,
    });

    // track child for cleanup on Ctrl+C
    trackChild({ child, killGroup: true });

    child.on("error", (err) => {
      untrackChild(child);
      resolve({
        agent: options.agent,
        success: false,
        output: `spawn error: ${err.message}`,
        structuredOutput: null,
      });
    });

    // buffer for incomplete lines
    let buffer = "";

    function processChunk(data: Buffer): void {
      chunks.push(data);
      buffer += data.toString();

      // split on newlines and print complete lines with prefix
      const lines = buffer.split("\n");
      // keep the last incomplete line in buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.trim() && canLog()) {
          console.log(`${prefix} ${line}`);
        }
      }
    }

    child.stdout?.on("data", processChunk);
    child.stderr?.on("data", processChunk);

    child.on("close", (code) => {
      untrackChild(child);

      // flush any remaining buffer
      if (buffer.trim() && canLog()) {
        console.log(`${prefix} ${buffer}`);
      }
      resolve({
        agent: options.agent,
        success: code === 0,
        output: Buffer.concat(chunks).toString(),
        structuredOutput: parseGitHubOutputFile(githubOutputFile, "result"),
      });
    });
  });
}

export type ValidateResultOptions = {
  test: string;
  // if true, test passes when validation checks pass regardless of agent success
  // (used for tests like timeout that expect the agent run to fail)
  expectFailure?: boolean | undefined;
};

export function validateResult(
  result: AgentResult,
  validator: ValidatorFn,
  options: ValidateResultOptions
): ValidationResult {
  const checks = validator(result);
  const allPassed = checks.every((c) => c.passed);

  // for tests with expectFailure: passed = agent failed AND all validation checks pass
  // for normal tests: passed = agent succeeded AND all validation checks pass
  const passed = options.expectFailure ? !result.success && allPassed : result.success && allPassed;

  return {
    test: options.test,
    agent: result.agent,
    passed,
    canceled: false,
    checks,
    output: result.output,
  };
}

export interface TestRunnerOptions {
  name: string;
  fixture: Inputs;
  validator: ValidatorFn;
  env?: Record<string, string>;
  // per-agent env vars (for unique markers)
  agentEnv?: Map<string, Record<string, string>>;
  // per-agent env vars to write to $HOME/.pullfrog-env/ files (for MCP servers
  // that don't inherit parent env vars). only non-sensitive values.
  fileAgentEnv?: Map<string, Record<string, string>>;
  // specific agents to run this test on (defaults to all agents)
  agents?: string[];
  // if true, test passes when agent fails AND validation checks pass
  // (used for tests like timeout that expect the agent run to fail)
  expectFailure?: boolean;
  // shell commands to run in the repo directory after cloning but before the
  // agent starts. used to simulate pre-existing repo state (e.g., malicious
  // symlinks from a PR). passed to play.ts via PULLFROG_TEST_REPO_SETUP env var.
  repoSetup?: string;
  // tags for grouping tests (e.g., ["agnostic"], ["fs"])
  // special tags:
  //   - "agnostic": runs with opentoad only, excluded when filtering by agent
  //   - "adhoc": excluded from default runs, must be explicitly requested
  tags?: TestTag[];
}

export type TestTag = "adhoc" | "agnostic" | "security";

export function printSingleValidation(validation: ValidationResult): void {
  const checksStr = validation.checks.map((c) => `${c.name}=${c.passed ? "✓" : "✗"}`).join(" ");
  const color = AGENT_COLORS[validation.agent] ?? "";
  const canceledNote = validation.canceled ? " (canceled)" : "";
  console.log(
    `\n${color}[${validation.test}][${validation.agent}]${RESET} ${checksStr}${canceledNote}`
  );
}

export function printResults(validations: ValidationResult[]): void {
  console.log("\nresults:");
  console.log("-".repeat(70));
  console.log("status  test          agent       checks");
  console.log("-".repeat(70));

  for (const v of validations) {
    const color = AGENT_COLORS[v.agent] ?? "";
    const status = v.canceled ? "❌ canceled" : v.passed ? "✅ pass" : "❌ fail";
    const checkCols = v.checks.map((c) => `${c.name}=${c.passed ? "✓" : "✗"}`).join(" ");
    console.log(
      `${status}  ${v.test.padEnd(12)}  ${color}${v.agent.padEnd(10)}${RESET}  ${checkCols}`
    );
  }
  console.log("-".repeat(70));

  const passed = validations.filter((v) => v.passed);
  console.log(`\n${passed.length}/${validations.length} passed`);
}
