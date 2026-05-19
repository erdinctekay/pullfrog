import { performance } from "node:perf_hooks";
import { log } from "./log.ts";

function isMonitorDebugEnabled(): boolean {
  return (
    process.env.ACTIONS_STEP_DEBUG === "true" ||
    process.env.RUNNER_DEBUG === "1" ||
    process.env.LOG_LEVEL === "debug"
  );
}

export const DEFAULT_ACTIVITY_TIMEOUT_MS = 300_000;
export const DEFAULT_ACTIVITY_CHECK_INTERVAL_MS = 5_000;

/**
 * chunks whose every non-empty line matches one of these patterns do not
 * count as agent activity. mcp-proxy SSE reconnects and provider-error
 * retries happen on their own schedule and were keeping the outer activity
 * timer alive long after the agent subprocess had been killed for inactivity,
 * producing multi-hour zombie runs.
 *
 * both patterns anchor to the start of the (optionally debug-timestamped)
 * log line so they don't accidentally match agent output that happens to
 * mention "[mcp-proxy]" or "provider error detected" in analysis text.
 */
const DEBUG_TS_PREFIX = /^(?:\[\d{4}-\d{2}-\d{2}T[^\]]+\]\s+)?/.source;
// our own internal monitors (this file's bypass + subprocess.ts's spawn
// activity timer) emit high-frequency diagnostic logs when debug logging is
// enabled. in the past those lines reached the wrapped process.stdout.write,
// missed the noise check, and marked activity every interval — which in
// debug-enabled runs kept the outer timer alive after the agent subprocess
// was already dead, re-creating the #12 zombie-run bug. the `(?:spawn|process)
// activity ` patterns below explicitly filter our own diagnostic lines in both
// local-debug (`[DEBUG] …`) and GH-runner-debug (`::debug::…`) formats.
export const ACTIVITY_NOISE_PATTERNS: readonly RegExp[] = [
  new RegExp(`${DEBUG_TS_PREFIX}\\[mcp-proxy\\]`),
  new RegExp(`${DEBUG_TS_PREFIX}» provider error detected`),
  new RegExp(`${DEBUG_TS_PREFIX}\\[DEBUG\\]\\s+(?:spawn|process) activity `),
  /^::debug::(?:spawn|process) activity /,
];

export function isActivityNoise(chunk: string | Uint8Array): boolean {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  if (!text.trim()) return true;
  return text.split("\n").every((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    return ACTIVITY_NOISE_PATTERNS.some((pattern) => pattern.test(trimmed));
  });
}

type ActivityTimeoutContext = {
  timeoutMs: number;
  checkIntervalMs: number;
};

export type ActivityTimeout = {
  promise: Promise<never>;
  stop: () => void;
  /** force the timeout to reject immediately with a custom reason */
  forceReject: (reason: string) => void;
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
 * upper bound on how long a single tool call can suspend the activity
 * watchdog. matched against the typical worst-case `checkout_pr`
 * fetch+deepen on a large monorepo (issue #760: 4-5min) plus generous
 * headroom for slower MCP tools, while still bounding the worst case if
 * a tool genuinely hangs and `tool_result` never arrives — auto-resume
 * fires here and the normal idle clock takes over from a fresh baseline.
 */
export const MAX_TOOL_CALL_SUSPENSION_MS = 15 * 60 * 1000;

let _suspendedAt: number | null = null;
let _suspensionTimer: NodeJS.Timeout | null = null;

/**
 * mark activity to reset the no-output timeout.
 * call this whenever the agent emits any event, even if it isn't logged to stdout.
 */
export function markActivity(): void {
  _lastActivity = performance.now();
}

/**
 * get the time since last activity in milliseconds.
 * returns 0 while the watchdog is suspended (issue #760).
 */
export function getIdleMs(): number {
  if (_suspendedAt !== null) return 0;
  return Math.round(performance.now() - _lastActivity);
}

/**
 * suspend the activity watchdog while a long-running, in-flight unit of
 * work is happening (e.g. an MCP `tools/call` that synchronously awaits
 * a multi-minute git fetch). bracket calls with `resumeActivity()` from
 * the agent harness's `tool_use` / `tool_result` event handlers.
 *
 * - idempotent: nested suspends are no-ops; the first resume wins.
 * - bounded: auto-resumes after `maxMs` so a buggy tool that never
 *   produces a `tool_result` can't pin the watchdog open forever.
 * - safe: only the *agent harness* (claude.ts / opencode.ts) on explicit,
 *   paired CLI events should call this. NEVER blanket-suspend on internal
 *   noise — that would resurrect issue #12 zombie runs.
 */
export function suspendActivity(maxMs: number = MAX_TOOL_CALL_SUSPENSION_MS): void {
  if (_suspendedAt !== null) return;
  _suspendedAt = performance.now();
  _suspensionTimer = setTimeout(() => {
    log.warning(`activity watchdog suspended >${Math.round(maxMs / 1000)}s — auto-resuming`);
    resumeActivity();
  }, maxMs);
  _suspensionTimer.unref?.();
}

/**
 * resume the activity watchdog. resets the idle baseline so a stale
 * idle window before the suspend can't immediately re-fire.
 */
export function resumeActivity(): void {
  if (_suspendedAt === null) return;
  _suspendedAt = null;
  if (_suspensionTimer) {
    clearTimeout(_suspensionTimer);
    _suspensionTimer = null;
  }
  _lastActivity = performance.now();
}

export function isActivitySuspended(): boolean {
  return _suspendedAt !== null;
}

function wrapWrite(original: WriteFunction, onActivity: () => void): WriteFunction {
  const wrapped: WriteFunction = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | WriteCallback,
    cb?: WriteCallback
  ): boolean => {
    if (!isActivityNoise(chunk)) {
      onActivity();
    }
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

  // route the monitor's own diagnostics through the captured original write
  // instead of log.debug — otherwise those lines feed back through the
  // wrapped process.stdout.write, miss isActivityNoise, and call
  // markActivity() themselves. in debug mode the periodic check below would
  // then reset the timer every interval and the timeout would never fire,
  // re-creating the exact zombie-run bug #12 was meant to kill.
  const debugBypass = (msg: string): void => {
    if (!isMonitorDebugEnabled()) return;
    originalStdoutWrite(`[${new Date().toISOString()}] [DEBUG] ${msg}\n`);
  };

  debugBypass(`process activity monitor started: timeout=${ctx.timeoutMs}ms`);

  const intervalId = setInterval(() => {
    const idleMs = getIdleMs();
    debugBypass(`process activity check: idle=${idleMs}ms / ${ctx.timeoutMs}ms`);
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
      const reject = rejectFn;
      rejectFn = null;
      reject(new Error(`activity timeout: no output for ${idleSec}s`));
    },
  });

  return {
    promise,
    // stop() also disarms forceReject so a late safety-net fire can't reject
    // the promise after the run has already succeeded.
    stop: () => {
      monitor?.stop();
      rejectFn = null;
    },
    forceReject: (reason: string) => {
      if (!rejectFn) return;
      monitor?.stop();
      const reject = rejectFn;
      rejectFn = null;
      reject(new Error(reason));
    },
  };
}
