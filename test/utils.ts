import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsManifest } from "../external.ts";
import type { Inputs } from "../main.ts";
import { installSignalHandlers, trackChild, untrackChild } from "../utils/subprocess.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const actionDir = join(__dirname, "..");

const LOCAL_TEST_WARNING = "This is a local test - do not post any comments to GitHub.";

// reusable prompt for bash tool tests - covers both MCP and internal agent tools
export function buildBashToolPrompt(command: string): string {
  return `Try to run this bash command: ${command}

Check ALL available tools that could execute shell commands:
- MCP tools from gh_pullfrog server (e.g. bash tool)
- Internal agent tools (e.g. Bash, Shell, Task that can run bash)
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

export const agents = Object.keys(agentsManifest) as (keyof typeof agentsManifest)[];

export type AgentUuids<T extends string> = {
  // get marker value for a specific agent and env var
  getUuid: (agent: string, envVar: T) => string;
  // pre-built agentEnv map for runTests
  agentEnv: Map<string, Record<string, string>>;
};

// create unique per-agent markers for env vars (useful for detecting if agent executed something)
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
  claude: "\x1b[35m", // magenta
  codex: "\x1b[32m", // green
  cursor: "\x1b[36m", // cyan
  gemini: "\x1b[33m", // yellow
  opencode: "\x1b[34m", // blue
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
}

// get agent output with GitHub Actions masking commands filtered out
// ::add-mask:: lines contain env var values but aren't actual agent output
export function getAgentOutput(result: AgentResult): string {
  return result.output
    .split("\n")
    .filter((line) => !line.includes("::add-mask::"))
    .join("\n");
}

// get structured output from set_output tool (via ::pullfrog-output:: marker)
// returns null if no structured output was set by the agent
export function getStructuredOutput(result: AgentResult): string | null {
  const match = result.output.match(/::pullfrog-output::([A-Za-z0-9+/=]+)/);
  if (!match) return null;
  return Buffer.from(match[1], "base64").toString();
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
  // return true if logging should be suppressed (e.g. Ctrl+C)
  isCanceled?: () => boolean;
};

const DEFAULT_TEST_TIMEOUT = "10m";

// run agent and stream output with prefix labels
// note: activity timeout is enforced in action main and subprocess utils
export async function runAgentStreaming(options: RunStreamingOptions): Promise<AgentResult> {
  installSignalHandlers();

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
    // when multiple tests run in parallel (e.g., cursor writes ~/.cursor/mcp.json)
    const mcpPort = options.env?.PULLFROG_MCP_PORT ?? "default";
    const testHome = `/tmp/home-${mcpPort}-${Date.now()}`;
    mkdirSync(testHome, { recursive: true });

    const child = spawn("node", ["play.ts", "--raw", JSON.stringify(fixture)], {
      cwd: actionDir,
      env: {
        ...process.env,
        AGENT_OVERRIDE: options.agent,
        ...options.env,
        HOME: testHome,
      },
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
  // if true, test passes when agent fails AND validation checks pass
  // (used for tests like timeout that expect the agent run to fail)
  expectFailure?: boolean;
  // if true, test is agent-agnostic and only needs to run once with any agent
  // agnostic tests run with claude by default, but can be run with specific agent via CLI
  agnostic?: boolean;
}

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
