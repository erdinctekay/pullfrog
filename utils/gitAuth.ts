/**
 * git authentication via GIT_ASKPASS.
 *
 * a localhost HTTP server serves tokens via single-use UUID codes.
 * each $git() call writes a unique askpass script with the server
 * port+code baked into the file body — no secrets in subprocess env.
 *
 * see wiki/askpass.md for full security documentation.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, unlinkSync } from "node:fs";
import { log } from "./cli.ts";
import type { GitAuthServer } from "./gitAuthServer.ts";
import { filterEnv } from "./secrets.ts";
import { spawn } from "./subprocess.ts";

type SafeGitSubcommand = "fetch" | "push";

type GitAuthOptions = {
  token: string;
  cwd?: string;
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

let gitBinary: GitBinaryInfo | undefined;

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * resolve and fingerprint the git binary. must be called once at startup
 * (in main()) before any agent code runs, so the path and hash reflect
 * the untampered binary.
 *
 * resolves symlinks via realpath so the hash is of the actual binary.
 * a malicious agent with sudo could replace the binary later, which is
 * caught by verifyGitBinary() before each authenticated call.
 */
export function resolveGit(): void {
  const whichPath = execSync("which git", { encoding: "utf-8" }).trim();
  const resolvedPath = realpathSync(whichPath);
  const sha256 = hashFile(resolvedPath);
  gitBinary = { path: resolvedPath, sha256 };
  log.info(`git binary: ${resolvedPath} (sha256: ${sha256.slice(0, 12)}...)`);
}

function verifyGitBinary(): string {
  if (!gitBinary) {
    throw new Error("git binary not initialized — call resolveGit() at startup");
  }
  const currentHash = hashFile(gitBinary.path);
  if (currentHash !== gitBinary.sha256) {
    throw new Error(
      `git binary tampered: expected sha256 ${gitBinary.sha256}, got ${currentHash}. ` +
        `path: ${gitBinary.path}`
    );
  }
  return gitBinary.path;
}

// --- auth server ---

let authServer: GitAuthServer | undefined;

export function setGitAuthServer(server: GitAuthServer): void {
  authServer = server;
}

/**
 * execute authenticated git command via ASKPASS.
 *
 * subcommand is restricted to "fetch" | "push" — operations that talk to
 * a remote and need credentials. working-tree operations (checkout, merge)
 * use $() from shell.ts which has no token.
 *
 * per call: registers a one-time code with the auth server, writes a
 * unique askpass script with port+code baked in, spawns git with
 * GIT_ASKPASS pointing to the script, and deletes the script in finally.
 *
 * @example
 * await $git("fetch", ["origin", "main"], { token });
 * await $git("push", ["-u", "origin", "feature"], { token });
 */
export async function $git(
  subcommand: SafeGitSubcommand,
  args: string[],
  options: GitAuthOptions
): Promise<GitResult> {
  const gitPath = verifyGitBinary();

  if (!authServer) {
    throw new Error("git auth server not initialized — call setGitAuthServer() at startup");
  }

  const cwd = options.cwd ?? process.cwd();

  const code = authServer.register(options.token);
  const scriptPath = authServer.writeAskpassScript(code);

  // -c flags override local .git/config — defense-in-depth against
  // agent-set config that could spawn subprocesses before ASKPASS runs
  const fullArgs = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "core.sshCommand=ssh",
    subcommand,
    ...args,
  ];

  log.debug(`git ${fullArgs.join(" ")}`);

  try {
    const result = await spawn({
      cmd: gitPath,
      args: fullArgs,
      cwd,
      env: {
        ...filterEnv(),
        GIT_ASKPASS: scriptPath,
        GIT_TERMINAL_PROMPT: "0",
        // blocks env-based git config injection from outer processes.
        // GIT_CONFIG_COUNT=0 blocks the newer KEY_n/VALUE_n mechanism.
        // GIT_CONFIG_PARAMETERS="" clears the legacy quoted-list mechanism.
        // both are needed — they are independent systems.
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_PARAMETERS: "",
      },
      activityTimeout: 0,
    });

    if (result.stderr.includes("askpass-compromised")) {
      log.info("askpass code was already consumed — token has been revoked");
      throw new Error("git auth failed — askpass code was already consumed, token revoked");
    }

    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      log.info(`git ${subcommand} failed: ${stderr}`);
      throw new Error(`git ${subcommand} failed: ${stderr}`);
    }

    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } finally {
    try {
      unlinkSync(scriptPath);
    } catch {
      // script may have self-deleted already
    }
  }
}
