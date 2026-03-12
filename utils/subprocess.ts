import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { DEFAULT_ACTIVITY_CHECK_INTERVAL_MS, DEFAULT_ACTIVITY_TIMEOUT_MS } from "./activity.ts";
import { log } from "./cli.ts";
import { onExitSignal } from "./exitHandler.ts";

export type TrackChildOptions = {
  child: ChildProcess;
  // if true, kill the entire process group (requires detached spawn)
  killGroup?: boolean;
};

// track all spawned child processes for cleanup on Ctrl+C
const activeChildren = new Map<ChildProcess, boolean>();

// signal handler override (used by test runner for graceful shutdown)
export type SignalHandler = (signal: NodeJS.Signals) => void;
let externalSignalHandler: SignalHandler | null = null;

// track a child process for cleanup on Ctrl+C
export function trackChild(options: TrackChildOptions): void {
  // the signal handler cleans up all tracked children
  // so we only have to install it once some child gets tracked
  installSignalHandler();
  activeChildren.set(options.child, options.killGroup ?? false);
}

// untrack a child process
export function untrackChild(child: ChildProcess): void {
  activeChildren.delete(child);
}

// allow callers to override default signal handling
export function setSignalHandler(handler: SignalHandler | null): void {
  externalSignalHandler = handler;
}

// kill all tracked children without exiting
export function killTrackedChildren() {
  for (const entry of activeChildren) {
    const child = entry[0];
    const killGroup = entry[1];
    if (killGroup && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
        continue;
      } catch {
        // fall through to direct kill
      }
    }
    child.kill("SIGKILL");
  }
}

// install signal handlers once (call early in process lifecycle)
let handlersInstalled = false;
function installSignalHandler(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  onExitSignal((signal) => {
    if (externalSignalHandler) {
      externalSignalHandler(signal);
      return;
    }
    const count = activeChildren.size;
    if (count > 0) {
      log.info(`» received ${signal}, killing ${count} subprocess(es)...`);
    }
    killTrackedChildren();
  });
}

export interface SpawnOptions {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeout?: number;
  // activity timeout: kill process if no stdout/stderr for this many ms (default: 30s, 0 to disable)
  activityTimeout?: number;
  cwd?: string;
  stdio?: ("pipe" | "ignore" | "inherit")[];
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Spawn a subprocess with streaming callbacks and buffered results
 */
export async function spawn(options: SpawnOptions): Promise<SpawnResult> {
  const { cmd, args, env, input, timeout, cwd, stdio, onStdout, onStderr } = options;
  const activityTimeoutMs = options.activityTimeout ?? DEFAULT_ACTIVITY_TIMEOUT_MS;

  installSignalHandler();

  const startTime = performance.now();
  let stdoutBuffer = "";
  let stderrBuffer = "";

  return new Promise((resolve, reject) => {
    // security: caller must provide complete env object, not merged with process.env
    const child = nodeSpawn(cmd, args, {
      env: env || {
        PATH: process.env.PATH || "",
        HOME: process.env.HOME || "",
      },
      stdio: stdio || ["pipe", "pipe", "pipe"],
      cwd: cwd || process.cwd(),
    });

    // track child for cleanup on Ctrl+C
    trackChild({ child });

    let timeoutId: NodeJS.Timeout | undefined;
    let activityCheckIntervalId: NodeJS.Timeout | undefined;
    let isTimedOut = false;
    let isActivityTimedOut = false;
    let lastActivityTime = performance.now();

    // overall timeout
    if (timeout) {
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        child.kill("SIGTERM");

        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        }, 5000);
      }, timeout);
    }

    // activity timeout: kill if no output for too long
    if (activityTimeoutMs > 0) {
      log.debug(`spawn activity timer: pid=${child.pid} cmd=${cmd} timeout=${activityTimeoutMs}ms`);
      activityCheckIntervalId = setInterval(() => {
        const idleMs = performance.now() - lastActivityTime;
        log.debug(
          `spawn activity check: pid=${child.pid} idle=${Math.round(idleMs)}ms / ${activityTimeoutMs}ms`
        );
        if (idleMs > activityTimeoutMs) {
          isActivityTimedOut = true;
          const idleSec = Math.round(idleMs / 1000);
          log.info(`no output for ${idleSec}s from pid=${child.pid} (${cmd}), killing process`);
          child.kill("SIGKILL");
          clearInterval(activityCheckIntervalId);
        }
      }, DEFAULT_ACTIVITY_CHECK_INTERVAL_MS);
    }

    function updateActivity(): void {
      lastActivityTime = performance.now();
    }

    if (child.stdout) {
      child.stdout.on("data", (data: Buffer) => {
        updateActivity();
        const chunk = data.toString();
        stdoutBuffer += chunk;
        onStdout?.(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        updateActivity();
        const chunk = data.toString();
        stderrBuffer += chunk;
        onStderr?.(chunk);
      });
    }

    child.on("close", (exitCode) => {
      const durationMs = performance.now() - startTime;

      untrackChild(child);
      if (timeoutId) clearTimeout(timeoutId);
      if (activityCheckIntervalId) clearInterval(activityCheckIntervalId);

      if (isTimedOut) {
        reject(new Error(`process timed out after ${timeout}ms`));
        return;
      }

      if (isActivityTimedOut) {
        const idleSec = Math.round((performance.now() - lastActivityTime) / 1000);
        reject(new Error(`activity timeout: no output for ${idleSec}s`));
        return;
      }

      resolve({
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        exitCode: exitCode || 0,
        durationMs,
      });
    });

    child.on("error", (error) => {
      const durationMs = performance.now() - startTime;

      untrackChild(child);
      if (timeoutId) clearTimeout(timeoutId);
      if (activityCheckIntervalId) clearInterval(activityCheckIntervalId);

      // log spawn errors for debugging
      console.error(`[spawn] process spawn error: ${error.message}`);

      resolve({
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        exitCode: 1,
        durationMs,
      });
    });

    if (input && child.stdin && stdio?.[0] !== "ignore") {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}
