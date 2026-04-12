import { dirname } from "node:path";
import * as core from "@actions/core";
import arg from "arg";
import { main } from "../main.ts";
import { log } from "../utils/cli.ts";
import { runPostCleanup } from "../utils/postCleanup.ts";
import { acquireInstallationToken, revokeInstallationToken } from "../utils/token.ts";

// GitHub Actions runs the action entry point with the node24 binary specified
// in action.yml, but doesn't add that binary's directory to PATH. Without this,
// spawned processes (pnpm, npm, etc.) resolve to the runner's default node (v20).
process.env.PATH = `${dirname(process.execPath)}:${process.env.PATH}`;

const STATE_TOKEN = "token";

interface GhaCliParams {
  args: string[];
  prog: string;
  showHelp?: boolean;
}

async function runMain(): Promise<void> {
  try {
    const result = await main();
    if (!result.success) {
      throw new Error(result.error || "agent execution failed");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "unknown error occurred";
    core.setFailed(`action failed: ${errorMessage}`);
  }
}

async function runPost(): Promise<void> {
  log.debug(`[post] script started at ${new Date().toISOString()}`);
  try {
    await runPostCleanup();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`[post] unexpected error: ${message}`);
  }
}

async function tokenMain(): Promise<void> {
  const reposInput = core.getInput("repos");
  const additionalRepos = reposInput
    ? reposInput
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean)
    : [];

  const token = await acquireInstallationToken({ repos: additionalRepos });

  core.setSecret(token);
  core.saveState(STATE_TOKEN, token);
  core.setOutput("token", token);

  const scope = additionalRepos.length
    ? `current repo + ${additionalRepos.join(", ")}`
    : "current repo only";
  core.info(`» installation token acquired (${scope})`);
}

async function tokenPost(): Promise<void> {
  const token = core.getState(STATE_TOKEN);
  if (!token) {
    core.debug("no token found in state, skipping revocation");
    return;
  }
  await revokeInstallationToken(token);
  core.info("» installation token revoked");
}

function printGhaUsage(params: { stream: typeof console.log; prog: string }): void {
  params.stream(`usage: ${params.prog} gha [token] [--post]\n`);
  params.stream("run the github action runtime flow.");
  params.stream("");
  params.stream("subcommands:");
  params.stream("  token        acquire a github app installation token");
  params.stream("");
  params.stream("options:");
  params.stream("  -h, --help   show help");
  params.stream("  --post       run post-cleanup flow");
}

function parseGhaArgs(args: string[]) {
  return arg(
    {
      "--help": Boolean,
      "--post": Boolean,
      "-h": "--help",
    },
    {
      argv: args,
    }
  );
}

export async function runCli(params: GhaCliParams): Promise<void> {
  if (params.showHelp) {
    printGhaUsage({ stream: console.log, prog: params.prog });
    return;
  }

  let parsed: ReturnType<typeof parseGhaArgs>;
  try {
    parsed = parseGhaArgs(params.args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n`);
    printGhaUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  if (parsed["--help"]) {
    printGhaUsage({ stream: console.log, prog: params.prog });
    return;
  }

  const normalizedArgs = ["gha"];
  const positional = parsed._;

  if (positional.length > 1) {
    console.error(`unexpected positional arguments for gha: ${positional.slice(1).join(" ")}\n`);
    printGhaUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  if (positional[0] === "token") {
    normalizedArgs.push("token");
  } else if (positional[0]) {
    console.error(`unknown gha subcommand: ${positional[0]}\n`);
    printGhaUsage({ stream: console.error, prog: params.prog });
    process.exit(1);
  }

  if (parsed["--post"]) {
    normalizedArgs.push("--post");
  }

  await run(normalizedArgs);
}

export async function run(args: string[]) {
  try {
    if (args.includes("token")) {
      if (args.includes("--post")) {
        await tokenPost();
      } else {
        await tokenMain();
      }
    } else if (args.includes("--post")) {
      await runPost();
    } else {
      await runMain();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
  }
}
