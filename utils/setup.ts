import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PayloadEvent, ShellPermission } from "../external.ts";
import { checkoutPrBranch } from "../mcp/checkout.ts";
import type { ToolState } from "../mcp/server.ts";
import { log } from "./cli.ts";
import type { OctokitWithPlugins } from "./github.ts";
import { isInsideDocker } from "./globals.ts";
import { $ } from "./shell.ts";

export interface SetupOptions {
  tempDir: string;
}

/**
 * Create a shared temp directory for the action
 */
export function createTempDirectory(): string {
  const sharedTempDir = mkdtempSync(join(tmpdir(), "pullfrog-"));
  process.env.PULLFROG_TEMP_DIR = sharedTempDir;
  log.info(`» created temp dir at ${sharedTempDir}`);
  return sharedTempDir;
}

/**
 * Setup the test repository for running actions
 */
export function setupTestRepo(options: SetupOptions): void {
  const tempDir = options.tempDir;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY is required");
  log.info(`» cloning ${repo} into ${tempDir}...`);

  // use https with token in ci or when running inside docker
  if (process.env.CI || isInsideDocker) {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!token) {
      throw new Error("GITHUB_TOKEN or GH_TOKEN is required for https clone in ci or docker");
    }
    $("git", ["clone", `https://x-access-token:${token}@github.com/${repo}.git`, tempDir]);
  } else {
    $("git", ["clone", `git@github.com:${repo}.git`, tempDir]);
  }
}

export interface GitContext {
  gitToken: string;
  owner: string;
  name: string;
  octokit: OctokitWithPlugins;
  toolState: ToolState;
  // shell permission level — controls hook and security behavior:
  //   enabled: full shell, hooks run, no restrictions
  //   restricted: MCP shell in stripped env, hooks run, token protection on auth ops
  //   disabled: no shell, hooks disabled globally, all code execution paths blocked
  shell: ShellPermission;
  postCheckoutScript: string | null;
}

export interface SetupGitParams extends GitContext {
  event: PayloadEvent;
}

/**
 * setup git configuration and authentication for the repository.
 * - configures git identity (user.email, user.name)
 * - sets up authentication via gitToken (minimal contents:write)
 * - for PR events, checks out the PR branch using shared helper
 *
 * gitToken is a minimal-permission token (contents + workflows) used for git operations.
 * it is assumed to be potentially exfiltratable, so it has limited scope.
 */
export async function setupGit(params: SetupGitParams): Promise<void> {
  const repoDir = process.cwd();

  // 1. configure git identity
  log.info("» setting up git configuration...");
  try {
    // check current config - only set defaults if not configured or using generic bot
    let currentEmail = "";
    try {
      currentEmail = execSync("git config user.email", {
        cwd: repoDir,
        stdio: "pipe",
        encoding: "utf-8",
      }).trim();
    } catch {
      // not configured
    }

    const shouldSetDefaults =
      !currentEmail || currentEmail === "github-actions[bot]@users.noreply.github.com";

    if (shouldSetDefaults) {
      execSync('git config --local user.email "226033991+pullfrog[bot]@users.noreply.github.com"', {
        cwd: repoDir,
        stdio: "pipe",
      });
      execSync('git config --local user.name "pullfrog[bot]"', {
        cwd: repoDir,
        stdio: "pipe",
      });
      log.debug("» git user configured (using defaults)");
    } else {
      log.debug(`» git user already configured (${currentEmail}), skipping`);
    }

    // SECURITY: disable git hooks when shell is disabled to prevent code execution.
    // in restricted mode, hooks run in the stripped sandbox — that's fine.
    // in enabled mode, the agent has full shell anyway.
    // in disabled mode, hooks are the primary code-execution escape vector.
    if (params.shell === "disabled") {
      execSync("git config --local core.hooksPath /dev/null", {
        cwd: repoDir,
        stdio: "pipe",
      });
      log.debug("» git hooks disabled (shell=disabled)");
    }
  } catch (error) {
    // If git config fails, log warning but don't fail the action
    // This can happen if we're not in a git repo or git isn't available
    log.info(`Failed to set git config: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. setup authentication
  // remove existing git auth headers that actions/checkout might have set
  try {
    execSync("git config --local --unset-all http.https://github.com/.extraheader", {
      cwd: repoDir,
      stdio: "pipe",
    });
    log.info("» removed existing authentication headers");
  } catch {
    log.debug("» no existing authentication headers to remove");
  }

  // remove includeIf entries that actions/checkout@v6 uses for credential persistence.
  // v6 stores credentials in an external file loaded via includeIf.gitdir, which our
  // --unset-all above doesn't catch. without this, $git() would produce duplicate
  // Authorization headers (one from includeIf, one from GIT_CONFIG_PARAMETERS).
  try {
    const configOutput = execSync("git config --local --get-regexp ^includeif\\.", {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
    for (const line of configOutput.trim().split("\n")) {
      const key = line.split(" ")[0];
      if (!key) continue;
      execSync(`git config --local --unset "${key}"`, {
        cwd: repoDir,
        stdio: "pipe",
      });
    }
    log.info("» removed includeIf credential entries");
  } catch {
    log.debug("» no includeIf credential entries to remove");
  }

  // SECURITY: set origin URL without token - auth is injected via GIT_CONFIG_PARAMETERS
  // in $git() calls. this prevents token leakage to git hooks and subprocesses.
  const originUrl = `https://github.com/${params.owner}/${params.name}.git`;
  $("git", ["remote", "set-url", "origin", originUrl], { cwd: repoDir });

  // initialize pushUrl to base repo - may be updated by checkout_pr for fork PRs
  params.toolState.pushUrl = originUrl;

  // disable credential helpers to prevent prompts and ensure clean auth state
  $("git", ["config", "--local", "credential.helper", ""], { cwd: repoDir });

  // non-PR events: stay on default branch
  if (params.event.is_pr !== true || !params.event.issue_number) {
    log.info("» git authentication configured");
    return;
  }

  // PR event: checkout PR branch using shared helper
  const prNumber = params.event.issue_number;

  // use shared checkout helper (handles fork remotes, push config, post-checkout hook)
  // this updates toolState.pushUrl for fork PRs and sets toolState.issueNumber
  await checkoutPrBranch(prNumber, params);
}
