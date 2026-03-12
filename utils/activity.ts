import { performance } from "node:perf_hooks";
import { log } from "./log.ts";

export const DEFAULT_ACTIVITY_TIMEOUT_MS = 300_000;
export const DEFAULT_ACTIVITY_CHECK_INTERVAL_MS = 5_000;

type ActivityTimeoutContext = {
  timeoutMs: number;
  checkIntervalMs: number;
};

export type ActivityTimeout = {
  promise: Promise<never>;
  stop: () => void;
};

type OutputMonitorContext = {
  timeoutMs: number;
  checkIntervalMs: number;
  onTimeout: (idleMs: number) => void;
};

type OutputMonitor = {
  stop: () => void;
};

type WriteCallback = (error?: Error | null) => void;
type WriteFunction = {
  (chunk: string | Uint8Array, cb?: WriteCallback): boolean;
  (chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: WriteCallback): boolean;
};

// module-level activity tracking - allows agents to mark activity on any event
let _lastActivity = performance.now();

/**
 * mark activity to reset the no-output timeout.
 * call this whenever the agent emits any event, even if it isn't logged to stdout.
 */
export function markActivity(): void {
  _lastActivity = performance.now();
}

/**
 * get the time since last activity in milliseconds
 */
export function getIdleMs(): number {
  return Math.round(performance.now() - _lastActivity);
}

function wrapWrite(original: WriteFunction, onActivity: () => void): WriteFunction {
  const wrapped: WriteFunction = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | WriteCallback,
    cb?: WriteCallback
  ): boolean => {
    onActivity();
    if (typeof encodingOrCb === "function") {
      return original(chunk, encodingOrCb);
    }
    return original(chunk, encodingOrCb, cb);
  };
  return wrapped;
}

function startProcessOutputMonitor(ctx: OutputMonitorContext): OutputMonitor {
  let timedOut = false;

  const originalStdoutWrite: WriteFunction = process.stdout.write.bind(process.stdout);
  const originalStderrWrite: WriteFunction = process.stderr.write.bind(process.stderr);

  // stdout/stderr writes also mark activity
  process.stdout.write = wrapWrite(originalStdoutWrite, markActivity);
  process.stderr.write = wrapWrite(originalStderrWrite, markActivity);

  log.debug(`process activity monitor started: timeout=${ctx.timeoutMs}ms`);

  const intervalId = setInterval(() => {
    const idleMs = getIdleMs();
    log.debug(`process activity check: idle=${idleMs}ms / ${ctx.timeoutMs}ms`);
    if (timedOut || idleMs <= ctx.timeoutMs) return;
    timedOut = true;
    ctx.onTimeout(idleMs);
  }, ctx.checkIntervalMs);

  function stop(): void {
    clearInterval(intervalId);
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  return { stop };
}

export function createProcessOutputActivityTimeout(ctx: ActivityTimeoutContext): ActivityTimeout {
  markActivity(); // reset baseline

  let rejectFn: ((error: Error) => void) | null = null;
  const promise = new Promise<never>((_, reject) => {
    rejectFn = reject;
  });

  let monitor: OutputMonitor | null = null;
  monitor = startProcessOutputMonitor({
    timeoutMs: ctx.timeoutMs,
    checkIntervalMs: ctx.checkIntervalMs,
    onTimeout: (idleMs) => {
      if (!rejectFn) return;
      const idleSec = Math.round(idleMs / 1000);
      if (monitor) {
        monitor.stop();
      }
      rejectFn(new Error(`activity timeout: no output for ${idleSec}s`));
    },
  });

  return {
    promise,
    stop: monitor.stop,
  };
}
