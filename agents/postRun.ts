import { type AgentId, formatMcpToolRef } from "../external.ts";
import { LIFECYCLE_HOOK_TIMEOUT_MS } from "../lifecycle.ts";
import { log } from "../utils/cli.ts";
import {
  SPAWN_ACTIVITY_TIMEOUT_CODE,
  SPAWN_TIMEOUT_CODE,
  SpawnTimeoutError,
  spawn,
} from "../utils/subprocess.ts";
import {
  type AgentResult,
  type AgentUsage,
  buildCommitPrompt,
  getGitStatus,
  hasPostRunIssues,
  MAX_POST_RUN_RETRIES,
  mergeAgentUsage,
  type PostRunIssues,
  type StopHookFailure,
} from "./shared.ts";

/**
 * hook output can flow into two size-sensitive places: the LLM resume prompt
 * (context window) and AgentResult.error (surfaced in GitHub comments capped
 * at 65535 chars). truncate the tail to keep both bounded; the tail is
 * usually the most actionable part of a failing script's output.
 */
const MAX_HOOK_OUTPUT_CHARS = 4096;

function truncateHookOutput(raw: string): string {
  if (raw.length <= MAX_HOOK_OUTPUT_CHARS) return raw;
  return `...(truncated, showing last ${MAX_HOOK_OUTPUT_CHARS} chars)\n${raw.slice(-MAX_HOOK_OUTPUT_CHARS)}`;
}

/**
 * run the user-configured stop hook.
 *
 * parallel to `executeLifecycleHook` (which soft-fails with a warning), but
 * returns structured output so agent harnesses can feed the failure back into
 * the session as a resume prompt.
 *
 * - non-zero exit → `StopHookFailure`, actionable: the output is fed to the
 *   agent so it can fix the underlying issue.
 * - timeout / spawn error → null, treated as passed: we can't usefully ask the
 *   agent to fix an infrastructure problem, and retrying would risk infinite
 *   loops.
 */
export async function executeStopHook(script: string): Promise<StopHookFailure | null> {
  log.info("» executing stop hook...");
  try {
    const result = await spawn({
      cmd: "bash",
      args: ["-c", script],
      env: process.env,
      timeout: LIFECYCLE_HOOK_TIMEOUT_MS,
      activityTimeout: 0,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });
    if (result.exitCode === 0) {
      log.info("» stop hook passed");
      return null;
    }
    // include both streams — scripts often emit a benign warning to stderr
    // and the actionable error to stdout (or vice versa), and picking one
    // starves the agent of the diagnostic it needs. stderr-first so stdout
    // (typically longer, where truncation is more likely to bite) keeps its
    // tail — summaries/totals usually live at the end.
    const combined = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    const output = truncateHookOutput(combined);
    log.info(`» stop hook failed with exit code ${result.exitCode}`);
    return { exitCode: result.exitCode, output };
  } catch (err) {
    const isTimeout =
      err instanceof SpawnTimeoutError &&
      (err.code === SPAWN_TIMEOUT_CODE || err.code === SPAWN_ACTIVITY_TIMEOUT_CODE);
    const msg = err instanceof Error ? err.message : String(err);
    log.warning(
      `stop hook ${isTimeout ? "timed out" : "failed to spawn"}: ${msg} — skipping retry`
    );
    return null;
  }
}

export function buildStopHookPrompt(failure: StopHookFailure): string {
  return [
    `STOP HOOK FAILED — the repo-configured stop hook exited with code ${failure.exitCode}. your work is not done until the hook exits cleanly. address the issue below and push any resulting changes to a pull request.`,
    "",
    "```",
    failure.output || "(no output)",
    "```",
  ].join("\n");
}

/**
 * check the two post-run gates: did the stop hook pass and is the working
 * tree clean? returns everything that still needs fixing so the caller can
 * render a single combined resume prompt.
 */
export async function collectPostRunIssues(params: {
  stopScript: string | null | undefined;
}): Promise<PostRunIssues> {
  const issues: PostRunIssues = {};
  if (params.stopScript) {
    const failure = await executeStopHook(params.stopScript);
    if (failure) issues.stopHook = failure;
  }
  const status = getGitStatus();
  if (status) issues.dirtyTree = status;
  return issues;
}

export function buildPostRunPrompt(issues: PostRunIssues): string {
  const parts: string[] = [];
  if (issues.stopHook) parts.push(buildStopHookPrompt(issues.stopHook));
  if (issues.dirtyTree) parts.push(buildCommitPrompt(issues.dirtyTree));
  return parts.join("\n\n---\n\n");
}

/**
 * prompt for a dedicated post-run reflection turn nudging the agent to call
 * `update_learnings` if it discovered anything worth persisting.
 *
 * this exists because the learnings step baked into mode checklists is
 * frequently ignored — the agent stays focused on the task and the meta-ask
 * falls through. delivering it as its own resume turn, with nothing competing
 * for attention, raises the fire rate substantially.
 */
export function buildLearningsReflectionPrompt(agentId: AgentId): string {
  const t = (name: string) => formatMcpToolRef(agentId, name);
  return [
    `REFLECTION — before you finish, think back over this task: did you discover anything about this repo's setup, test commands, conventions, or patterns that you are confident is correct and would reliably help future runs?`,
    "",
    `if so, call \`${t("update_learnings")}\` to persist it.`,
    "",
    `rules:`,
    `- only call \`${t("update_learnings")}\` when the finding is high-confidence and broadly useful. skip if unsure, speculative, or one-off.`,
    `- pass the FULL merged list: existing learnings from the original prompt + your new discoveries. one fact per bullet, lines starting with \`- \`.`,
    `- deduplicate, and drop bullets that are clearly wrong or no longer relevant to the current codebase.`,
    `- if you already called \`${t("update_learnings")}\` earlier in this run, or nothing new is worth capturing, just reply "done" and stop — do not edit the repo for this reflection.`,
  ].join("\n");
}

/**
 * shared post-run retry loop used by every agent harness.
 *
 * checks the post-run gates (stop hook + dirty tree), and if either is
 * failing, invokes `resume` to let the agent fix and push in the same turn.
 * bails at `MAX_POST_RUN_RETRIES` attempts. the `canResume` predicate is
 * consulted before each retry — harnesses that can't re-enter the session
 * (e.g. claude without a sessionId) return false here.
 *
 * an optional `reflectionPrompt` fires exactly once, after the gates first
 * observe a clean state. it's a one-shot nudge (e.g. "update learnings if
 * relevant"), not a gate, so it does not consume the gate-retry budget. if
 * the reflection turn dirties the tree, the loop picks that up on the next
 * iteration via the normal dirty-tree gate.
 *
 * stop hook must pass for the run to succeed; persistent hook failures are
 * surfaced as `AgentResult.error`. dirty-tree-only failures preserve prior
 * behavior: they're logged but don't fail the run.
 */
export async function runPostRunRetryLoop<R extends AgentResult>(params: {
  initialResult: R;
  initialUsage: AgentUsage | undefined;
  stopScript: string | null | undefined;
  resume: (context: { prompt: string; previousResult: R }) => Promise<R>;
  canResume?: ((result: R) => boolean) | undefined;
  reflectionPrompt?: string | undefined;
}): Promise<AgentResult> {
  let result = params.initialResult;
  let aggregatedUsage = params.initialUsage;
  let finalIssues: PostRunIssues = {};
  let gateResumeCount = 0;
  let pendingReflection = params.reflectionPrompt;

  while (gateResumeCount < MAX_POST_RUN_RETRIES) {
    if (!result.success) break;
    const issues = await collectPostRunIssues({ stopScript: params.stopScript });
    finalIssues = issues;

    if (!hasPostRunIssues(issues)) {
      // gates are clean. if a reflection prompt is pending, deliver it once
      // and loop back to re-check — the reflection may have touched the tree.
      if (!pendingReflection) break;
      if (params.canResume && !params.canResume(result)) break;
      log.info("» post-run reflection: nudging agent to update learnings if relevant");
      const preReflection = result;
      const reflectionResult = await params.resume({
        prompt: pendingReflection,
        previousResult: result,
      });
      aggregatedUsage = mergeAgentUsage(aggregatedUsage, reflectionResult.usage);
      pendingReflection = undefined;
      if (!reflectionResult.success) {
        // reflection is a best-effort nudge. its failure must not flip a
        // successful run to failed — the gated work is already done. keep
        // the pre-reflection result and exit without re-running the gates
        // (which would risk a flaky false-positive hook failure right after
        // it just passed).
        log.warning(
          `» reflection turn failed (${reflectionResult.error ?? "unknown error"}), preserving prior successful result`
        );
        result = preReflection;
        break;
      }
      // reflection replies are meta-asks ("done", "updated learnings with N
      // bullets") — not a task summary. keep the pre-reflection output so
      // the returned AgentResult still reflects what the run accomplished,
      // while inheriting reflection-specific fields the harness needs for
      // any subsequent gate retry (e.g. the new sessionId claude emits per
      // --resume invocation).
      // use `||` (not `??`) so an empty pre-reflection output falls through
      // to the reflection's reply. runs that only emit MCP tool calls and no
      // plain text leave result.output = "" — keeping "" would starve the
      // fallback path in handleAgentResult of anything to show.
      result = {
        ...reflectionResult,
        output: preReflection.output || reflectionResult.output,
      };
      continue;
    }

    // checks still ran even if we can't resume, so the failure gate below
    // can still catch a persistent stop-hook failure.
    if (params.canResume && !params.canResume(result)) {
      log.info("» post-run retry skipped: cannot resume agent session");
      break;
    }

    log.info(`» post-run retry (attempt ${gateResumeCount + 1}/${MAX_POST_RUN_RETRIES})`);
    const prompt = buildPostRunPrompt(issues);
    result = await params.resume({ prompt, previousResult: result });
    aggregatedUsage = mergeAgentUsage(aggregatedUsage, result.usage);
    gateResumeCount++;
  }

  // we exhausted retries without observing a clean state — finalIssues
  // reflects pre-resume state, so re-check to see what the last resume
  // actually did. when the subprocess failed we skip: its own error is more
  // actionable than a stale "stop hook still failing" message. when the loop
  // already observed a clean state we skip: re-running the hook risks flaky
  // false-positive failures right after it just passed.
  if (gateResumeCount > 0 && result.success && hasPostRunIssues(finalIssues)) {
    finalIssues = await collectPostRunIssues({ stopScript: params.stopScript });
  }

  if (result.success && finalIssues.stopHook) {
    const retryNote =
      gateResumeCount > 0
        ? ` after ${gateResumeCount} retry ${gateResumeCount === 1 ? "attempt" : "attempts"}`
        : "";
    return {
      ...result,
      success: false,
      error: `stop hook failed${retryNote} (exit code ${finalIssues.stopHook.exitCode}): ${finalIssues.stopHook.output || "(no output)"}`,
      usage: aggregatedUsage,
    };
  }

  return { ...result, usage: aggregatedUsage };
}
