import { LIFECYCLE_HOOK_TIMEOUT_MS } from "../lifecycle.ts";
import { log } from "./cli.ts";
import {
  SPAWN_ACTIVITY_TIMEOUT_CODE,
  SPAWN_TIMEOUT_CODE,
  SpawnTimeoutError,
  spawn,
} from "./subprocess.ts";

export interface ExecuteLifecycleHookParams {
  event: string;
  script: string | null;
}

/** structured failure info — `output` on the `exit` variant is trimmed
 * stderr, falling back to stdout when stderr is empty. */
export type LifecycleHookFailure =
  | { kind: "exit"; exitCode: number; output: string }
  | { kind: "timeout" }
  | { kind: "spawn"; spawnError: string };

export interface LifecycleHookResult {
  /**
   * human-readable warning when the hook failed. includes retry guidance:
   * transient spawn/exit errors are worth retrying, timeouts and
   * persistent failures are not. absent when the hook succeeded or was
   * skipped. setup/post-checkout callers surface this verbatim; prepush
   * builds its own message from `failure` instead.
   */
  warning?: string;
  /**
   * structured failure info — undefined when the hook succeeded or was
   * skipped. lets callers compose their own messaging without parsing the
   * `warning` string.
   */
  failure?: LifecycleHookFailure;
}

/**
 * execute a lifecycle hook script if one is configured.
 *
 * soft-fails: instead of throwing on hook errors, returns a warning string
 * (and structured failure info) so callers can choose whether to surface
 * it (mcp tools) or upgrade it to a fatal error (setup). timeouts are
 * flagged as non-retryable in the warning text.
 */
export async function executeLifecycleHook(
  params: ExecuteLifecycleHookParams
): Promise<LifecycleHookResult> {
  if (!params.script) return {};

  log.info(`» executing ${params.event} lifecycle hook...`);

  try {
    const result = await spawn({
      cmd: "bash",
      args: ["-c", params.script],
      env: process.env,
      timeout: LIFECYCLE_HOOK_TIMEOUT_MS,
      activityTimeout: 0,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });

    if (result.exitCode !== 0) {
      const output = (result.stderr || result.stdout).trim();
      return {
        failure: { kind: "exit", output, exitCode: result.exitCode },
        warning:
          `lifecycle hook '${params.event}' failed with exit code ${result.exitCode}. ` +
          `output: ${output || "(empty)"}. ` +
          `retry the operation if the failure looks flaky (network blips, transient rate limits). ` +
          `do NOT retry if the script is broken (missing commands, syntax errors) or the error is persistent.`,
      };
    }

    log.info(`» ${params.event} lifecycle hook completed successfully`);
    return {};
  } catch (err) {
    const isTimeout =
      err instanceof SpawnTimeoutError &&
      (err.code === SPAWN_TIMEOUT_CODE || err.code === SPAWN_ACTIVITY_TIMEOUT_CODE);
    if (isTimeout) {
      const minutes = Math.round(LIFECYCLE_HOOK_TIMEOUT_MS / 60000);
      return {
        failure: { kind: "timeout" },
        warning:
          `lifecycle hook '${params.event}' timed out after ${minutes}min. ` +
          `do NOT retry — the script is likely hung or doing too much work. ` +
          `ask the repo owner to simplify the hook (e.g. move long-running work out of the hook, add caching, or split it).`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      failure: { kind: "spawn", spawnError: msg },
      warning:
        `lifecycle hook '${params.event}' failed to spawn: ${msg}. ` +
        `this is likely a transient failure — retry the operation.`,
    };
  }
}
