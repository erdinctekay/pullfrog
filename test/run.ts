import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { runInDocker } from "../utils/docker.ts";
import { acquireNewToken } from "../utils/github.ts";
import { isInsideDocker } from "../utils/globals.ts";
import {
  installSignalHandlers,
  killTrackedChildren,
  setSignalHandler,
} from "../utils/subprocess.ts";
import {
  agents,
  printResults,
  printSingleValidation,
  runAgentStreaming,
  type TestRunnerOptions,
  type ValidationResult,
  validateResult,
} from "./utils.ts";

/**
 * unified test runner for all agent tests.
 *
 * usage: node test/run.ts [filters...]
 *
 * filters can be test names, agent names, or special keywords:
 *   node test/run.ts               # run all tests (excludes adhoc tests)
 *   node test/run.ts smoke         # run smoke test for all agents
 *   node test/run.ts claude        # run all tests for claude (excludes adhoc)
 *   node test/run.ts smoke claude  # run smoke test for claude only
 *   node test/run.ts agnostic      # run all agnostic tests (with claude)
 *   node test/run.ts timeout codex # run timeout test with codex
 *   node test/run.ts adhoc         # run all adhoc tests (exploratory, not CI)
 *   node test/run.ts nobashcreative # run specific adhoc test by name
 *
 * by default, runs in a Docker container for isolation.
 * automatically detects if already inside Docker and skips spawning another container.
 *
 * tests mark themselves as agnostic via the `agnostic: true` option.
 * agnostic tests only need to run once with any agent (default: claude).
 *
 * adhoc tests are in the `adhoc/` directory and are excluded from default runs.
 * they are for exploration and manual testing, not CI.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
export const actionDir = join(__dirname, "..");

// load .env files
config({ path: join(actionDir, ".env") });
config({ path: join(actionDir, "..", ".env") });

const nodeModulesVolume = "pullfrog-action-test-node-modules";
const mcpPortBase = 49000;
let nextMcpPort = mcpPortBase;

function allocateMcpPort(): number {
  const port = nextMcpPort;
  nextMcpPort += 1;
  return port;
}

function buildNodeCmd(args: string[]): string {
  const passArgs = args.map((arg) => `'${arg.replace(/'/g, "'\\''")}'`).join(" ");
  return `node test/run.ts ${passArgs}`;
}

// run the test runner inside docker
function runTestsInDocker(args: string[]): never {
  const result = runInDocker({
    actionDir,
    args,
    nodeCmd: buildNodeCmd(args),
    volumeName: nodeModulesVolume,
    envFilterMode: "allowlist",
    onStart: () => console.log("» running tests in docker container...\n"),
  });

  process.exit(result.status ?? 1);
}

type TestInfo = {
  name: string;
  config: TestRunnerOptions;
};

type CancelState = {
  canceled: boolean;
  signal: NodeJS.Signals | null;
};

async function loadTest(testName: string): Promise<TestInfo | null> {
  // check crossagent directory first
  const crossagentPath = join(__dirname, "crossagent", `${testName}.ts`);
  if (existsSync(crossagentPath)) {
    const module = await import(crossagentPath);
    return { name: testName, config: module.test };
  }

  // check agnostic directory
  const agnosticPath = join(__dirname, "agnostic", `${testName}.ts`);
  if (existsSync(agnosticPath)) {
    const module = await import(agnosticPath);
    return { name: testName, config: module.test };
  }

  // check adhoc directory
  const adhocPath = join(__dirname, "adhoc", `${testName}.ts`);
  if (existsSync(adhocPath)) {
    const module = await import(adhocPath);
    return { name: testName, config: module.test };
  }

  return null;
}

function listTestsFromDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(".ts", ""));
}

function listAdhocTests(): string[] {
  const adhocDir = join(__dirname, "adhoc");
  return listTestsFromDir(adhocDir);
}

function listCoreTests(): string[] {
  const crossagentDir = join(__dirname, "crossagent");
  const agnosticDir = join(__dirname, "agnostic");
  return [...listTestsFromDir(crossagentDir), ...listTestsFromDir(agnosticDir)];
}

function listAvailableTests(): string[] {
  return [...listCoreTests(), ...listAdhocTests()];
}

type ParsedArgs = {
  tests: string[];
  agents: string[];
  agnosticOnly: boolean;
  adhocOnly: boolean;
};

function parseArgs(args: string[]): ParsedArgs {
  const availableTests = listAvailableTests();
  const tests: string[] = [];
  const agentsFound: string[] = [];
  let agnosticOnly = false;
  let adhocOnly = false;

  for (const arg of args) {
    if (arg === "agnostic") {
      agnosticOnly = true;
    } else if (arg === "adhoc") {
      adhocOnly = true;
    } else if (availableTests.includes(arg)) {
      tests.push(arg);
    } else if (agents.includes(arg as (typeof agents)[number])) {
      agentsFound.push(arg);
    } else {
      console.error(`unknown argument: ${arg}`);
      console.error(`available tests: ${availableTests.join(", ")}`);
      console.error(`available agents: ${agents.join(", ")}`);
      console.error(`special keywords: agnostic, adhoc`);
      process.exit(1);
    }
  }

  return { tests, agents: agentsFound, agnosticOnly, adhocOnly };
}

type RunContext = {
  testInfo: TestInfo;
  agent: string;
  cancelState: CancelState;
  results: Map<string, ValidationResult>;
};

function getRunKey(test: string, agent: string): string {
  return `${test}::${agent}`;
}

type CanceledValidationContext = {
  testInfo: TestInfo;
  agent: string;
  signal: NodeJS.Signals;
};

function buildCanceledValidation(ctx: CanceledValidationContext): ValidationResult {
  return {
    test: ctx.testInfo.name,
    agent: ctx.agent,
    passed: false,
    canceled: true,
    checks: [{ name: "canceled", passed: false }],
    output: `canceled by ${ctx.signal}`,
  };
}

async function runTestForAgent(ctx: RunContext): Promise<ValidationResult> {
  const config = ctx.testInfo.config;
  const env: Record<string, string> = {};
  if (config.env) {
    const entries = Object.entries(config.env);
    for (const entry of entries) {
      env[entry[0]] = entry[1];
    }
  }
  if (config.agentEnv) {
    const agentEnv = config.agentEnv.get(ctx.agent);
    if (agentEnv) {
      const entries = Object.entries(agentEnv);
      for (const entry of entries) {
        env[entry[0]] = entry[1];
      }
    }
  }

  if (!Object.hasOwn(env, "PULLFROG_MCP_PORT")) {
    env.PULLFROG_MCP_PORT = String(allocateMcpPort());
  }

  const result = await runAgentStreaming({
    test: ctx.testInfo.name,
    agent: ctx.agent,
    fixture: config.fixture,
    env,
    isCanceled: () => ctx.cancelState.canceled,
  });

  const validation = validateResult(result, config.validator, {
    test: ctx.testInfo.name,
    expectFailure: config.expectFailure,
  });
  ctx.results.set(getRunKey(ctx.testInfo.name, ctx.agent), validation);
  return validation;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // run in Docker unless already inside
  if (!isInsideDocker) {
    // acquire token for docker if needed (before spawning containers)
    // this ensures GITHUB_TOKEN is available when setupTestRepo() runs inside docker
    if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
      if (process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY) {
        console.log("» acquiring github installation token...");
        const token = await acquireNewToken();
        process.env.GITHUB_TOKEN = token;
      }
    }
    runTestsInDocker(args);
  }

  const parsed = parseArgs(args);
  const adhocTests = listAdhocTests();

  // determine which tests to load
  let testsToLoad: string[];
  if (parsed.tests.length > 0) {
    testsToLoad = parsed.tests;
  } else if (parsed.adhocOnly) {
    testsToLoad = adhocTests;
  } else {
    // by default, exclude adhoc tests
    testsToLoad = listCoreTests();
  }

  // load all test configs
  const testInfos: TestInfo[] = [];
  for (const testName of testsToLoad) {
    const info = await loadTest(testName);
    if (!info) {
      console.error(`failed to load test: ${testName}`);
      process.exit(1);
    }
    testInfos.push(info);
  }

  // filter to agnostic-only if requested
  const filteredTests = parsed.agnosticOnly
    ? testInfos.filter((t) => t.config.agnostic)
    : testInfos;

  if (filteredTests.length === 0) {
    console.error("no tests to run");
    process.exit(1);
  }

  // determine which agents to run
  const agentsToRun = parsed.agents.length > 0 ? parsed.agents : [...agents];

  // build list of test runs
  type TestRun = { testInfo: TestInfo; agent: string };
  const runs: TestRun[] = [];

  // determine behavior for agnostic tests:
  // - if specific tests were requested (e.g., `timeout codex`), run with specified agent
  // - if agnosticOnly flag is set, run with specified agent (or claude)
  // - if only agents specified (e.g., `codex`), skip agnostic tests (they run separately)
  // - if no filters at all, include agnostic tests with claude
  const specificTestsRequested = parsed.tests.length > 0;
  const onlyAgentsSpecified =
    parsed.agents.length > 0 && !specificTestsRequested && !parsed.agnosticOnly;
  const noFiltersAtAll =
    parsed.tests.length === 0 && parsed.agents.length === 0 && !parsed.agnosticOnly;

  for (const testInfo of filteredTests) {
    if (testInfo.config.agnostic) {
      // skip agnostic tests when only agents are specified (e.g., `pnpm runtest codex`)
      if (onlyAgentsSpecified) continue;

      // agnostic: run once with appropriate agent
      // - if specific tests requested or agnosticOnly: use specified agent or first in list
      // - otherwise (no filters): use default agent (claude)
      const agent = noFiltersAtAll ? agents[0] : agentsToRun[0];
      runs.push({ testInfo, agent });
    } else {
      // non-agnostic: run for all specified agents
      for (const agent of agentsToRun) {
        runs.push({ testInfo, agent });
      }
    }
  }

  // describe what we're running
  const runTestNames = [...new Set(runs.map((r) => r.testInfo.name))];
  const runAgentNames = [...new Set(runs.map((r) => r.agent))];
  console.log(`running ${runTestNames.join(", ")} for: ${runAgentNames.join(", ")}\n`);

  const cancelState: CancelState = { canceled: false, signal: null };
  const results = new Map<string, ValidationResult>();
  let resultsPrinted = false;

  function printAndExit(validations: ValidationResult[]): void {
    if (resultsPrinted) return;
    resultsPrinted = true;
    console.log();
    for (const v of validations) {
      printSingleValidation(v);
    }
    printResults(validations);
    const allPassed = validations.every((v) => v.passed);
    process.exit(allPassed ? 0 : 1);
  }

  function handleCancel(signal: NodeJS.Signals): void {
    if (cancelState.canceled) return;
    cancelState.canceled = true;
    cancelState.signal = signal;
    killTrackedChildren();

    const validations: ValidationResult[] = [];
    for (const run of runs) {
      const key = getRunKey(run.testInfo.name, run.agent);
      const existing = results.get(key);
      if (existing) {
        validations.push(existing);
      } else {
        validations.push(
          buildCanceledValidation({
            testInfo: run.testInfo,
            agent: run.agent,
            signal,
          })
        );
      }
    }
    printAndExit(validations);
  }

  setSignalHandler(handleCancel);
  installSignalHandlers();

  // run tests with limited concurrency to avoid overwhelming agent APIs
  // group by agent to ensure each agent only runs one test at a time
  const maxConcurrency = 5; // one per agent
  const validations = await runWithConcurrencyLimit(
    runs,
    maxConcurrency,
    (run) =>
      runTestForAgent({
        testInfo: run.testInfo,
        agent: run.agent,
        cancelState,
        results,
      })
  );

  if (!cancelState.canceled) {
    printAndExit(validations);
  }
}

// simple concurrency limiter
async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const p = fn(item).then(
      (result) => {
        results.push(result);
      },
      (err: unknown) => {
        // fn must never reject; log and rethrow to surface bugs
        console.error("runWithConcurrencyLimit: fn rejected unexpectedly", err);
        throw err;
      }
    );

    const e = p.then(() => {
      executing.splice(executing.indexOf(e), 1);
    });
    executing.push(e);

    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

main();
