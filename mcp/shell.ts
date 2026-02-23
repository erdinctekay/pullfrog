// changes to shell security (filterEnv, spawnShell) should be reflected in wiki/security.md and docs/security.mdx
import { type ChildProcess, type StdioOptions, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, writeFileSync } from "node:fs";
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

function spawnShell(params: SpawnParams): ChildProcess {
  const spawnOpts = { env: params.env, cwd: params.cwd, stdio: params.stdio, detached: true };
  const sandboxMethod = detectSandboxMethod();

  if (sandboxMethod === "unshare") {
    // use PID namespace isolation to prevent reading /proc/$PPID/environ
    // this creates a new PID namespace where:
    // 1. the subprocess becomes PID 1 in its namespace
    // 2. parent PIDs are not visible (PPID = 0)
    // 3. fresh /proc is mounted showing only sandbox PIDs
    // combined with resolveEnv("restricted"), this prevents all /proc-based secret theft
    return spawn(
      "unshare",
      ["--pid", "--fork", "--mount-proc", "bash", "-c", params.command],
      spawnOpts
    );
  }

  if (sandboxMethod === "sudo-unshare") {
    // on GHA runners, unprivileged namespaces are blocked but sudo works
    // pass filtered env via sudo env command since sudo clears environment
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(params.env)) {
      if (v !== undefined) {
        envArgs.push(`${k}=${v}`);
      }
    }
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
        params.command,
      ],
      { ...spawnOpts, env: {} } // empty env since we pass via sudo env
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

export function ShellTool(ctx: ToolContext) {
  return tool({
    name: "shell",
    description: `Execute shell commands securely. Environment is filtered to remove API keys and secrets.

Use this tool to:
- Run shell commands (ls, cat, grep, find, etc.)
- Execute build tools (npm, pnpm, cargo, make, etc.)
- Run tests and linters
- Perform git operations`,
    parameters: ShellParams,
    execute: execute(async (params) => {
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
