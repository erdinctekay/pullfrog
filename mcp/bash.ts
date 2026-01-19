import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const BashParams = type({
  command: "string",
  description: "string",
  "timeout?": "number",
  "working_directory?": "string",
  "background?": "boolean",
});

// patterns for sensitive env vars: suffixes (_KEY, _SECRET, _TOKEN) plus AI provider prefixes
const SENSITIVE_PATTERNS = [/_KEY$/i, /_SECRET$/i, /_TOKEN$/i, /_PASSWORD$/i, /_CREDENTIAL$/i];

function isSensitive(key: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(key));
}

/** filter env vars, removing sensitive values (only for public repos) */
function filterEnv(isPublicRepo: boolean): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // only filter sensitive vars for public repos
    if (isPublicRepo && isSensitive(key)) continue;
    filtered[key] = value;
  }
  // restore original GITHUB_TOKEN (the one set by GitHub Actions, not our installation token)
  // this allows git operations in subprocesses to work while keeping our installation token secure
  if (process.env.ORIGINAL_GITHUB_TOKEN) {
    filtered.GITHUB_TOKEN = process.env.ORIGINAL_GITHUB_TOKEN;
  }
  return filtered;
}

type SpawnSandboxedParams = {
  command: string;
  env: Record<string, string>;
  cwd: string;
  isPublicRepo: boolean;
  stdio: StdioOptions;
};

/**
 * spawn command with filtered env. in CI, also use PID namespace isolation
 * to prevent child from reading /proc/$PPID/environ (only for public repos)
 */
function spawnSandboxed(params: SpawnSandboxedParams): ChildProcess {
  const spawnOpts = { env: params.env, cwd: params.cwd, stdio: params.stdio, detached: true };
  // only use PID namespace isolation for public repos in CI
  const useNamespaceIsolation = process.env.CI === "true" && params.isPublicRepo;
  return useNamespaceIsolation
    ? spawn("unshare", ["--pid", "--fork", "--mount-proc", "bash", "-c", params.command], spawnOpts)
    : spawn("bash", ["-c", params.command], spawnOpts);
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

export function BashTool(ctx: ToolContext) {
  const isPublicRepo = !ctx.repo.repo.private;

  return tool({
    name: "bash",
    description: `Execute shell commands securely.${isPublicRepo ? " Environment is filtered to remove API keys and secrets." : ""}

Use this tool to:
- Run shell commands (ls, cat, grep, find, etc.)
- Execute build tools (npm, pnpm, cargo, make, etc.)
- Run tests and linters
- Perform git operations
- Run shell commands in a secure environment. Unlike the built-in bash tool, this tool filters sensitive environment variables from the subprocess's environment to avoid leaking secrets.`,
    parameters: BashParams,
    execute: execute(async (params) => {
      const timeout = Math.min(params.timeout ?? 120000, 600000);
      const cwd = params.working_directory ?? process.cwd();
      const env = filterEnv(isPublicRepo);

      if (params.background) {
        const tempDir = getTempDir();
        const handle = `bg-${randomUUID().slice(0, 8)}`;
        const outputPath = join(tempDir, `${handle}.log`);
        const pidPath = join(tempDir, `${handle}.pid`);
        const logFd = openSync(outputPath, "a");
        let proc: ChildProcess;
        try {
          proc = spawnSandboxed({
            command: params.command,
            env,
            cwd,
            isPublicRepo,
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

      const proc = spawnSandboxed({
        command: params.command,
        env,
        cwd,
        isPublicRepo,
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

      return {
        output: output.trim(),
        exit_code: exitCode ?? (timedOut ? 124 : -1),
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
    description: `Kill a background process by its handle. Use this to stop dev servers or other long-running processes started with bash({ background: true }).`,
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
