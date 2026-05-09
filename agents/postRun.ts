import { readFile } from "node:fs/promises";
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

/** check whether the seeded summary file is byte-identical to its seed.
 * a missing or unreadable file returns false (don't nudge — the agent
 * may have legitimately deleted it, or the seed step failed; the read-
 * back path in main.ts handles both cases by skipping persist). */
async function isSummaryUnchanged(filePath: string, seed: string): Promise<boolean> {
  try {
    const current = await readFile(filePath, "utf8");
    return current === seed;
  } catch {
    return false;
  }
}

export function buildSummaryStalePrompt(filePath: string): string {
  return [
    `PR SUMMARY UNTOUCHED — the rolling PR summary file at \`${filePath}\` is byte-identical to its seed; this run did not edit it.`,
    "",
    "review the diff and update the file in place to reflect what changed in the PR. update intent, key changes, and any risks worth flagging — keep the existing section headings stable so incremental runs produce clean diffs.",
    "",
    "if the diff is genuinely too small or noisy to warrant rewriting (e.g. a one-line typo fix, a comment tweak, a formatting-only change), it's fine to leave the structure as-is — but at minimum confirm you considered it by appending one line to the appropriate section noting the run. silence is not an option; the snapshot is what the next review run reads as context.",
  ].join("\n");
}

export function buildUnsubmittedReviewPrompt(mode: "Review" | "IncrementalReview"): string {
  // mode-aware: Review mode's contract is "always submit one review" — its
  // mode prompt forbids `report_progress`, so the nudge here must not offer
  // it as an exit. IncrementalReview legitimately allows a report_progress
  // exit when there are no new issues since the last review (mode prompt
  // step 7), so the nudge mirrors that contract.
  if (mode === "Review") {
    return [
      `MISSING REVIEW OUTPUT — you selected Review mode but stopped without calling \`create_pull_request_review\`. the user has no visible signal that this run produced anything; the progress comment will be deleted on exit and no review will appear on the PR.`,
      "",
      "call `create_pull_request_review` now with your aggregated review (body + inline comments). if you found no actionable issues, submit with `approved: true` and a body opening with `No new issues found.` per the mode prompt — Review mode does not have a no-submit exit. the first call may error once with a diff-coverage nudge — retry the same call to proceed.",
      "",
      "do NOT stop again until `create_pull_request_review` has been called successfully.",
    ].join("\n");
  }
  return [
    `MISSING REVIEW OUTPUT — you selected IncrementalReview mode but stopped without calling \`create_pull_request_review\` or \`report_progress\`. the user has no visible signal that this run produced anything; the progress comment will be deleted on exit and no review will appear on the PR.`,
    "",
    "do exactly one of:",
    "- if you have findings: call `create_pull_request_review` now with your aggregated review (body + inline comments). the first call may error once with a diff-coverage nudge — retry the same call to proceed.",
    "- if there are genuinely no actionable findings since the last review (e.g. only formatting / comment / lockfile changes): call `report_progress` with a 1-2 sentence summary explaining that no review was warranted.",
    "",
    "do NOT stop again until one of those tools has been called successfully.",
  ].join("\n");
}

/**
 * check the post-run gates: did the stop hook pass, is the working tree
 * clean, and (when applicable) did the agent touch the rolling PR summary
 * snapshot? returns everything that still needs nudging so the caller can
 * render a single combined resume prompt.
 *
 * the summary-stale check is skipped when `summaryFilePath` / `summarySeed`
 * are not provided; this is the common case (non-PR runs, runs where the
 * dispatcher didn't request snapshot generation, runs where the seed step
 * failed). loop callers also pass these as undefined after the agent has
 * already been nudged once, to avoid burning the retry budget on a soft
 * non-blocking gate.
 */
export async function collectPostRunIssues(params: {
  stopScript: string | null | undefined;
  summaryFilePath?: string | undefined;
  summarySeed?: string | undefined;
  getUnsubmittedReview?: (() => "Review" | "IncrementalReview" | null) | undefined;
}): Promise<PostRunIssues> {
  const issues: PostRunIssues = {};
  if (params.stopScript) {
    const failure = await executeStopHook(params.stopScript);
    if (failure) issues.stopHook = failure;
  }
  const status = getGitStatus();
  if (status) issues.dirtyTree = status;
  if (params.summaryFilePath && params.summarySeed !== undefined) {
    const stale = await isSummaryUnchanged(params.summaryFilePath, params.summarySeed);
    if (stale) issues.summaryStale = { filePath: params.summaryFilePath };
  }
  if (params.getUnsubmittedReview) {
    const mode = params.getUnsubmittedReview();
    if (mode) issues.unsubmittedReview = mode;
  }
  return issues;
}

export function buildPostRunPrompt(issues: PostRunIssues): string {
  // order matches the terminal hard-fail order in `runPostRunRetryLoop` so
  // the prompt's emphasis (which gate the agent should fix first) lines up
  // with the user-visible failure message reported when retries exhaust.
  // both hard-fail gates first (`stopHook` → `unsubmittedReview`), then the
  // soft gates (`dirtyTree` → `summaryStale`).
  const parts: string[] = [];
  if (issues.stopHook) parts.push(buildStopHookPrompt(issues.stopHook));
  if (issues.unsubmittedReview) {
    parts.push(buildUnsubmittedReviewPrompt(issues.unsubmittedReview));
  }
  if (issues.dirtyTree) parts.push(buildCommitPrompt(issues.dirtyTree));
  if (issues.summaryStale) parts.push(buildSummaryStalePrompt(issues.summaryStale.filePath));
  return parts.join("\n\n---\n\n");
}

/**
 * prompt for a dedicated post-run reflection turn nudging the agent to edit
 * the rolling learnings file if it discovered anything worth persisting.
 *
 * this exists because passive "if you learned something, write it down"
 * instructions baked into mode checklists are frequently ignored — the agent
 * stays focused on the task and the meta-ask falls through. delivering it
 * as its own resume turn, with nothing competing for attention, raises the
 * fire rate substantially.
 *
 * the file is the single source of truth — there is no separate MCP tool
 * call. the server reads the file at end-of-run and persists any edits to
 * `Repo.learnings`.
 */
export function buildLearningsReflectionPrompt(filePath: string): string {
  return [
    `REFLECTION — before you finish, think back over this task: did you discover anything about this repo's setup, test commands, conventions, or patterns that is high-confidence and would reliably help future runs?`,
    "",
    `the rolling learnings file is at \`${filePath}\`. read it first if you haven't already, then edit it in place using your native file tools. the server reads this file at end-of-run and persists any changes — there is no tool to call.`,
    "",
    `keep the file healthy:`,
    `- only add bullets when the finding is high-confidence AND broadly useful. skip speculative, one-off, or "maybe" findings.`,
    `- prune bullets that are clearly wrong, no longer relevant, or low-signal (rarely useful). a focused, accurate file beats a long stale one.`,
    `- format: flat bullet list, one fact per line starting with \`- \`. deduplicate against existing entries — if a bullet covers the same fact, update it in place instead of adding a duplicate.`,
    `- leave the file alone if you have nothing substantively new to add and the existing entries still look healthy. silence is a valid outcome — just reply "done" and stop.`,
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
  /** absolute path to the seeded PR summary file. when set together with
   * `summarySeed`, the loop checks after each agent attempt whether the
   * file has been edited; if not, it nudges the agent ONCE via a resume
   * turn (subsequent iterations skip the check so we don't keep burning
   * retries on a soft gate when the agent has decided no edit is warranted). */
  summaryFilePath?: string | undefined;
  /** exact bytes of the seeded summary file used for the unchanged-check. */
  summarySeed?: string | undefined;
  /** see {@link AgentRunContext.getUnsubmittedReview}. */
  getUnsubmittedReview?: (() => "Review" | "IncrementalReview" | null) | undefined;
  resume: (context: { prompt: string; previousResult: R }) => Promise<R>;
  canResume?: ((result: R) => boolean) | undefined;
  reflectionPrompt?: string | undefined;
}): Promise<AgentResult> {
  let result = params.initialResult;
  let aggregatedUsage = params.initialUsage;
  let finalIssues: PostRunIssues = {};
  let gateResumeCount = 0;
  let pendingReflection = params.reflectionPrompt;
  // nudge for an untouched summary file fires AT MOST ONCE per run. after
  // we've delivered the prompt, subsequent gate checks pass undefined so
  // the loop doesn't keep flagging the same condition — the agent may have
  // legitimately decided no edit is warranted, and re-prompting would
  // burn the retry budget without adding signal.
  let summaryStaleNudged = false;

  while (gateResumeCount < MAX_POST_RUN_RETRIES) {
    if (!result.success) break;
    const issues = await collectPostRunIssues({
      stopScript: params.stopScript,
      summaryFilePath: summaryStaleNudged ? undefined : params.summaryFilePath,
      summarySeed: summaryStaleNudged ? undefined : params.summarySeed,
      getUnsubmittedReview: params.getUnsubmittedReview,
    });
    if (issues.summaryStale) summaryStaleNudged = true;
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
    // summary-stale is a soft gate that must never flip a successful run to
    // failed. when it's the only issue and the resume itself errors out,
    // restore the pre-resume successful result and break — persistSummary
    // detects the unchanged file via its seed comparison and skips the DB
    // write on its own, so no further coordination is needed here.
    const onlySummaryStale =
      issues.summaryStale !== undefined &&
      issues.stopHook === undefined &&
      issues.dirtyTree === undefined;
    const preResume = result;
    result = await params.resume({ prompt, previousResult: result });
    aggregatedUsage = mergeAgentUsage(aggregatedUsage, result.usage);
    if (!result.success && onlySummaryStale) {
      log.warning(
        `» summary-stale resume turn failed (${result.error ?? "unknown error"}), preserving prior successful result`
      );
      result = preResume;
      break;
    }
    gateResumeCount++;
  }

  // we exhausted retries without observing a clean state — finalIssues
  // reflects pre-resume state, so re-check to see what the last resume
  // actually did. when the subprocess failed we skip: its own error is more
  // actionable than a stale "stop hook still failing" message. when the loop
  // already observed a clean state we skip: re-running the hook risks flaky
  // false-positive failures right after it just passed.
  if (gateResumeCount > 0 && result.success && hasPostRunIssues(finalIssues)) {
    // re-check the gates that can actually fail the run (stop hook /
    // dirty tree / unsubmitted review). summary-stale is intentionally
    // NOT re-checked here: we already delivered the one-shot nudge, and
    // a still-unchanged file at this point is the agent's deliberate
    // choice.
    finalIssues = await collectPostRunIssues({
      stopScript: params.stopScript,
      getUnsubmittedReview: params.getUnsubmittedReview,
    });
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

  if (result.success && finalIssues.unsubmittedReview) {
    const retryNote =
      gateResumeCount > 0
        ? ` after ${gateResumeCount} retry ${gateResumeCount === 1 ? "attempt" : "attempts"}`
        : "";
    // mode-aware: Review's contract requires a review submission; only
    // IncrementalReview accepts `report_progress` as an exit. mirroring
    // the nudge prompt avoids contradicting the agent-facing copy.
    const expected =
      finalIssues.unsubmittedReview === "Review"
        ? "create_pull_request_review"
        : "create_pull_request_review or report_progress";
    return {
      ...result,
      success: false,
      error: `${finalIssues.unsubmittedReview} mode finished without calling ${expected}${retryNote}`,
      usage: aggregatedUsage,
    };
  }

  return { ...result, usage: aggregatedUsage };
}
