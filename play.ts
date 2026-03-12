import { execSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import arg from "arg";
import { config } from "dotenv";
import type { AgentResult } from "./agents/shared.ts";
import { type Inputs, main } from "./main.ts";
import { defineFixture } from "./test/utils.ts";
import { log } from "./utils/cli.ts";
import { runInDocker } from "./utils/docker.ts";
import { ensureGitHubToken } from "./utils/github.ts";
import { isInsideDocker } from "./utils/globals.ts";
import { runPostCleanup } from "./utils/postCleanup.ts";
import { setupTestRepo } from "./utils/setup.ts";

/**
 * default play fixture for ad-hoc testing.
 * change this freely without affecting any tests.
 */
export const playFixture = defineFixture(
  {
    prompt: `List every MCP tool you have access to. Call set_output with a JSON array of all tool names you can see.`,
  },
  { localOnly: true }
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// load action's .env file in case it exists for local dev
config();
// also load .env from repo root (for monorepo structure)
config({ path: join(__dirname, "..", ".env") });

export async function run(inputsOrPrompt: Inputs | string): Promise<AgentResult> {
  await ensureGitHubToken();

  // create unique temp directory path in OS temp location for parallel execution
  // use a parent dir from mkdtemp, then clone into a 'repo' subdirectory
  const tempParent = await mkdtemp(join(tmpdir(), "pullfrog-play-"));
  const tempDir = join(tempParent, "repo");
  const originalCwd = process.cwd();

  try {
    setupTestRepo({ tempDir });
    process.chdir(tempDir);

    // run repo setup commands if provided (for pre-planting test state like symlinks).
    // this runs AFTER clone but BEFORE the agent, simulating pre-existing repo content.
    if (process.env.PULLFROG_TEST_REPO_SETUP) {
      log.info("» running repo setup commands...");
      execSync(process.env.PULLFROG_TEST_REPO_SETUP, { cwd: tempDir, stdio: "pipe" });
    }

    // set GITHUB_WORKSPACE to tempDir so main() doesn't try to chdir to the CI checkout path
    process.env.GITHUB_WORKSPACE = tempDir;

    // allow passing full Inputs object or just a prompt string
    const inputs: Inputs =
      typeof inputsOrPrompt === "string" ? { prompt: inputsOrPrompt } : inputsOrPrompt;

    // set INPUT_* env vars for @actions/core.getInput()
    for (const [key, value] of Object.entries(inputs)) {
      if (value !== undefined && value !== null) {
        process.env[`INPUT_${key.toUpperCase()}`] = String(value);
      }
    }

    // wrap main() so post cleanup runs even on failure (mirrors action.yml post-if: "failure() || cancelled()")
    let result: AgentResult;
    try {
      result = await main();
    } finally {
      await runPostCleanup();
    }

    process.chdir(originalCwd);

    if (result.success) {
      log.success("Action completed successfully");
      return { success: true, output: result.output || undefined, error: undefined };
    } else {
      log.error(`Action failed: ${result.error || "Unknown error"}`);
      return { success: false, error: result.error || undefined, output: undefined };
    }
  } catch (err) {
    const errorMessage = (err as Error).message;
    log.error(`Error: ${errorMessage}`);
    return { success: false, error: errorMessage, output: undefined };
  } finally {
    // cleanup temp directory - use sudo rm because sandbox isolation may create
    // files with different ownership that rmSync can't delete
    process.chdir(originalCwd);
    try {
      execSync(`sudo rm -rf "${tempParent}"`, { stdio: "ignore" });
    } catch {
      // ignore - cleanup failure is not critical
    }
  }
}

const isDirectExecution = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (isDirectExecution) {
  const args = arg({
    "--help": Boolean,
    "--raw": String,
    "--local": Boolean,
    "-h": "--help",
    "-l": "--local",
  });

  if (args["--help"]) {
    log.info(`
Usage: node play.ts [options]

Test the Pullfrog action with the inline playFixture.

Options:
  --raw [input]           Use raw string as prompt, or JSON object as full fixture
  --local, -l             Run locally (default: runs in Docker)
  -h, --help              Show this help message

Environment:
  PLAY_LOCAL=1            Same as --local

Examples:
  node play.ts                                              # Run inline playFixture
  node play.ts --raw "Hello world"                          # Use raw string as prompt
  node play.ts --raw '{"prompt":"Hello","timeout":"5s"}'    # Use JSON fixture
    `);
    process.exit(0);
  }

  // default: run in Docker (unless --local, PLAY_LOCAL=1, or already inside Docker)
  const useLocal = args["--local"] || process.env.PLAY_LOCAL === "1" || isInsideDocker;

  if (!useLocal) {
    const passArgs = process.argv
      .slice(2)
      .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
      .join(" ");
    const nodeCmd = `node play.ts ${passArgs}`;

    const volumeName = "pullfrog-action-node-modules";

    const result = runInDocker({
      actionDir: __dirname,
      args: process.argv.slice(2),
      nodeCmd,
      volumeName,
      envFilterMode: "passthrough",
      onStart: () => log.info("» running in Docker container..."),
    });

    process.exit(result.status ?? 1);
  }

  if (args["--raw"]) {
    const raw = args["--raw"];
    // try to parse as JSON, otherwise treat as prompt string
    let input: Inputs | string = raw;
    try {
      input = JSON.parse(raw) as Inputs;
    } catch {
      // not valid JSON, use as prompt string
    }
    const result = await run(input);
    process.exit(result.success ? 0 : 1);
  }

  // no args - use inline playFixture
  const result = await run(playFixture);
  process.exit(result.success ? 0 : 1);
}
