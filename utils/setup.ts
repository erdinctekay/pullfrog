import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellPermission } from "../external.ts";
import type { ToolState } from "../toolState.ts";
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

/**
 * build an env suitable for targeting a specific git repo via `cwd`.
 *
 * inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE override cwd resolution,
 * which matters when this code runs as a child of `git push` (pre-push hook)
 * or inside another git subcommand. if we don't strip them, a call that
 * names `repoDir` in cwd silently operates on the outer repo instead.
 */
function envScopedToRepo(): NodeJS.ProcessEnv {
  const scoped = { ...process.env };
  for (const key of Object.keys(scoped)) {
    if (key.startsWith("GIT_")) delete scoped[key];
  }
  return scoped;
}

/**
 * remove any `[includeIf ...]` entries from the local git config so that
 * actions/checkout-persisted credentials don't ride alongside ASKPASS-provided
 * auth for subsequent git operations.
 *
 * SECURITY: git config subsection values can contain arbitrary characters
 * including `$(...)` command substitutions, and `${IFS}` spacing tricks defeat
 * naive split-on-space filtering. we read keys via the `-z` (null-terminated)
 * output format and feed them to a spawn-array `git config --unset-all` so
 * the shell never interpolates key contents — closing the RCE path that a
 * string-interpolated `execSync(...)` would expose.
 */
export function removeIncludeIfEntries(repoDir: string): void {
  const env = envScopedToRepo();
  let configOutput: string;
  try {
    configOutput = execSync("git config --local --get-regexp -z ^includeif\\.", {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: "pipe",
      env,
    });
  } catch {
    log.debug("» no includeIf credential entries to remove");
    return;
  }
  const seen = new Set<string>();
  for (const entry of configOutput.split("\0")) {
    if (!entry) continue;
    // -z format: each entry is "<key>\n<value>". the key is up to the first newline.
    const nl = entry.indexOf("\n");
    const key = nl === -1 ? entry : entry.slice(0, nl);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    try {
      // execFileSync (not execSync) so the key — which can contain arbitrary
      // characters including shell metacharacters and $() command substitutions
      // — is passed as an argv element and never interpolated by a shell.
      // this is the load-bearing side of a9aa3b2b's injection fix.
      execFileSync("git", ["config", "--local", "--unset-all", key], {
        cwd: repoDir,
        stdio: "pipe",
        env,
      });
    } catch (error) {
      log.debug(
        `» failed to unset ${key}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (seen.size > 0)
    log.info(
      `» removed ${seen.size} includeIf credential ${seen.size === 1 ? "entry" : "entries"}`
    );
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

export type SetupGitParams = GitContext;

/**
 * setup git configuration and authentication for the repository.
 * - configures git identity (user.email, user.name)
 * - sets up authentication via gitToken (minimal contents:write)
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
  // --unset-all above doesn't catch. without this, stale credentials from actions/checkout
  // would be sent alongside ASKPASS-provided credentials.
  removeIncludeIfEntries(repoDir);

  // SECURITY: set origin URL without token - auth is injected via GIT_ASKPASS
  // in $git() calls. this prevents token leakage to git hooks and subprocesses.
  const originUrl = `https://github.com/${params.owner}/${params.name}.git`;
  $("git", ["remote", "set-url", "origin", originUrl], { cwd: repoDir });

  // initialize pushUrl to base repo - may be updated by checkout_pr for fork PRs
  params.toolState.pushUrl = originUrl;

  // disable credential helpers to prevent prompts and ensure clean auth state
  $("git", ["config", "--local", "credential.helper", ""], { cwd: repoDir });

  // pin the run-entry HEAD for the checkout_pr initial-branch invariant; see
  // captureInitialHead for the named-branch vs detached split and why it
  // matters (zed-industries/cloud 2026-05-18 cross-PR clobber shape).
  params.toolState.initialHead = captureInitialHead(repoDir);

  log.info("» git authentication configured");
}

/**
 * snapshot the current HEAD as either a branch name (when on a named branch)
 * or a literal SHA (when detached). used by setupGit to pin the run-entry
 * position and by checkout_pr to compare the live HEAD against it.
 *
 * splitting the two cases is load-bearing: `git rev-parse --abbrev-ref HEAD`
 * returns the sentinel string `"HEAD"` on detached entry — which is the
 * default `actions/checkout` state for `pull_request` events. storing that
 * raw string would make any future detached state (including a subagent's
 * `git checkout --detach <sha>`) compare equal.
 */
export function captureInitialHead(
  repoDir: string
): { kind: "branch"; name: string } | { kind: "detached"; sha: string } {
  try {
    const name = $("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: repoDir,
      log: false,
    }).trim();
    if (name) return { kind: "branch", name };
  } catch {
    // detached HEAD — fall through
  }
  const sha = $("git", ["rev-parse", "HEAD"], { cwd: repoDir, log: false }).trim();
  return { kind: "detached", sha };
}
