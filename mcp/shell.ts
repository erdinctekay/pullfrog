// changes to shell security (filterEnv, spawnShell) should be reflected in wiki/security.md and docs/security.mdx
import { type ChildProcess, type StdioOptions, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { type } from "arktype";
import { log } from "../utils/log.ts";
import { resolveEnv } from "../utils/secrets.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const ShellParams = type({
  command: "string",
  description: "string",
  "timeout?": "number",
  "working_directory?": "string",
  "background?": "boolean",
});

type SpawnParams = {
  command: string;
  env: Record<string, string | undefined>;
  cwd: string;
  stdio: StdioOptions;
};

export type SandboxMethod = "unshare" | "sudo-unshare" | "none";

/** cached result of sandbox capability check */
let detectedSandboxMethod: SandboxMethod | undefined;

/** get the current sandbox method (for testing/diagnostics) */
export function getSandboxMethod(): SandboxMethod {
  return detectSandboxMethod();
}

/** detect which sandbox method is available on this system */
function detectSandboxMethod(): SandboxMethod {
  if (detectedSandboxMethod !== undefined) {
    return detectedSandboxMethod;
  }

  // only attempt in CI environments - sandbox has overhead and is primarily for untrusted code
  if (process.env.CI !== "true") {
    detectedSandboxMethod = "none";
    log.debug("sandbox disabled (CI !== true)");
    return "none";
  }

  // try unprivileged unshare first (works on some systems)
  try {
    const result = spawnSync("unshare", ["--pid", "--fork", "--mount-proc", "true"], {
      timeout: 5000,
      stdio: "ignore",
    });
    if (result.status === 0) {
      detectedSandboxMethod = "unshare";
      log.debug("PID namespace isolation enabled (unprivileged unshare)");
      return "unshare";
    }
  } catch {
    // continue to try sudo
  }

  // try sudo unshare (works on GHA runners)
  try {
    const result = spawnSync("sudo", ["unshare", "--pid", "--fork", "--mount-proc", "true"], {
      timeout: 5000,
      stdio: "ignore",
    });
    if (result.status === 0) {
      detectedSandboxMethod = "sudo-unshare";
      log.debug("PID namespace isolation enabled (sudo unshare)");
      return "sudo-unshare";
    }
  } catch {
    // no sandbox available
  }

  detectedSandboxMethod = "none";
  log.info("PID namespace isolation not available - falling back to env filtering only");
  return "none";
}

// strip inherited proc mount that sits underneath --mount-proc's overlay.
// --mount-proc mounts fresh proc on top, but `umount /proc` peels it off and exposes the
// host's proc with all host PIDs — allowing /proc/<pid>/environ exfiltration.
// double-umount removes both layers, then a clean mount gives only sandbox PIDs.
// on unprivileged systems where umount fails, --mount-proc still provides isolation
// (the agent also can't umount in that case).
const PROC_CLEANUP =
  "umount /proc 2>/dev/null; umount /proc 2>/dev/null; mount -t proc proc /proc 2>/dev/null;";

function spawnShell(params: SpawnParams): ChildProcess {
  const spawnOpts = { env: params.env, cwd: params.cwd, stdio: params.stdio, detached: true };
  const sandboxMethod = detectSandboxMethod();

  if (sandboxMethod === "unshare") {
    return spawn(
      "unshare",
      ["--pid", "--fork", "--mount-proc", "bash", "-c", `${PROC_CLEANUP} ${params.command}`],
      spawnOpts
    );
  }

  if (sandboxMethod === "sudo-unshare") {
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(params.env)) {
      if (v !== undefined) {
        envArgs.push(`${k}=${v}`);
      }
    }
    // drop back to original user after PROC_CLEANUP so files aren't owned by root.
    // sudo is only needed for unshare; the actual command should run as the normal user
    // to avoid ownership mismatches with file_write/file_edit (which run in the Node.js parent).
    const username = userInfo().username;
    const escaped = params.command.replace(/'/g, "'\\''");
    return spawn(
      "sudo",
      [
        "env",
        ...envArgs,
        "unshare",
        "--pid",
        "--fork",
        "--mount-proc",
        "bash",
        "-c",
        `${PROC_CLEANUP} exec su -p -s /bin/bash ${username} -c '${escaped}'`,
      ],
      { ...spawnOpts, env: {} }
    );
  }

  return spawn("bash", ["-c", params.command], spawnOpts);
}

/** kill process and its entire process group */
async function killProcessGroup(proc: ChildProcess): Promise<void> {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

function getTempDir(): string {
  const tempDir = process.env.PULLFROG_TEMP_DIR;
  if (!tempDir) {
    throw new Error("PULLFROG_TEMP_DIR not set");
  }
  return tempDir;
}

/** detect git as a command invocation (not as part of another word like .gitignore) */
function isGitCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed === "git" || trimmed.startsWith("git ")) return true;
  if (trimmed.startsWith("sudo git")) return true;
  return /[;&|]\s*(?:sudo\s+)?git(?:\s|$)/.test(trimmed);
}

export function ShellTool(ctx: ToolContext) {
  return tool({
    name: "shell",
    description: `Execute shell commands securely. Environment is filtered to remove API keys and secrets.

Use this tool to:
- Run shell commands (ls, cat, grep, find, etc.)
- Execute build tools (npm, pnpm, cargo, make, etc.)
- Run tests and linters

Do NOT use this tool for git commands — use the dedicated git tools instead.`,
    parameters: ShellParams,
    execute: execute(async (params) => {
      if (isGitCommand(params.command)) {
        throw new Error(
          "git commands are not allowed in the shell tool. use the dedicated git tools instead:\n" +
            "- git: local operations (status, log, diff, add, commit, checkout, merge, rebase, etc.)\n" +
            "- push_branch: push to remote (handles authentication)\n" +
            "- git_fetch: fetch from remote (handles authentication)\n" +
            "- checkout_pr: check out PR branches"
        );
      }

      const timeout = Math.min(params.timeout ?? 30000, 120000);
      const cwd = params.working_directory ?? process.cwd();
      const env = resolveEnv(ctx.payload.shell === "enabled" ? "inherit" : "restricted");

      if (params.background) {
        const tempDir = getTempDir();
        const handle = `bg-${randomUUID().slice(0, 8)}`;
        const outputPath = join(tempDir, `${handle}.log`);
        const pidPath = join(tempDir, `${handle}.pid`);
        const logFd = openSync(outputPath, "a");
        let proc: ChildProcess;
        try {
          proc = spawnShell({
            command: params.command,
            env,
            cwd,
            stdio: ["ignore", logFd, logFd],
          });
        } finally {
          closeSync(logFd);
        }
        if (!proc.pid) {
          throw new Error("failed to start background process");
        }
        proc.unref();
        writeFileSync(pidPath, `${proc.pid}\n`);
        ctx.toolState.backgroundProcesses.set(handle, { pid: proc.pid, outputPath, pidPath });
        return {
          handle,
          outputPath,
          pidPath,
          message: `started background process ${handle} (pid ${proc.pid})`,
        };
      }

      const proc = spawnShell({
        command: params.command,
        env,
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "",
        stderr = "",
        timedOut = false,
        exited = false;
      proc.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timeoutId = setTimeout(async () => {
        if (!exited) {
          timedOut = true;
          await killProcessGroup(proc);
        }
      }, timeout);

      const exitCode = await new Promise<number | null>((resolve) => {
        const done = (code: number | null) => {
          exited = true;
          clearTimeout(timeoutId);
          resolve(code);
        };
        proc.on("exit", done);
        proc.on("error", () => done(null));
      });

      let output = stderr ? (stdout ? `${stdout}\n${stderr}` : stderr) : stdout;
      if (timedOut)
        output = output
          ? `${output}\n[timed out after ${timeout}ms]`
          : `[timed out after ${timeout}ms]`;

      const finalExitCode = exitCode ?? (timedOut ? 124 : -1);
      if (finalExitCode !== 0) {
        log.info(`shell command failed with exit code ${finalExitCode}: ${params.command}`);
        if (output) log.info(`output: ${output.trim()}`);
      }

      return {
        output: output.trim(),
        exit_code: finalExitCode,
        timed_out: timedOut,
      };
    }),
  });
}

export const KillBackgroundParams = type({
  handle: type.string.describe("The handle of the background process to kill (e.g., bg-a1b2c3d4)"),
});

export function KillBackgroundTool(ctx: ToolContext) {
  return tool({
    name: "kill_background",
    description: `Kill a background process by its handle. Use this to stop dev servers or other long-running processes started with shell({ background: true }).`,
    parameters: KillBackgroundParams,
    execute: execute(async (params) => {
      const proc = ctx.toolState.backgroundProcesses.get(params.handle);
      if (!proc) {
        return {
          success: false,
          message: `no background process with handle ${params.handle}`,
        };
      }

      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        // already dead
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        // already dead
      }

      ctx.toolState.backgroundProcesses.delete(params.handle);
      return {
        success: true,
        message: `killed background process ${params.handle} (pid ${proc.pid})`,
      };
    }),
  });
}
