import { isLeapingIntoActionCommentBody } from "../mcp/comment.ts";
import { getApiUrl } from "./apiUrl.ts";
import { buildPullfrogFooter } from "./buildPullfrogFooter.ts";
import { log } from "./cli.ts";
import { createOctokit, parseRepoContext } from "./github.ts";
import { type ResolvedPromptInput, resolvePromptInput } from "./payload.ts";
import {
  getProgressComment,
  type ProgressComment,
  parseProgressComment,
  updateProgressComment,
} from "./progressComment.ts";
import { getJobToken } from "./token.ts";

type JsonPromptInput = Extract<ResolvedPromptInput, object>; // not string

interface PostCleanupContext {
  repoContext: ReturnType<typeof parseRepoContext>;
  octokit: ReturnType<typeof createOctokit>;
  runId: number | undefined;
  promptInput: JsonPromptInput | null;
}

// controls whether the script should check the reason for the workflow termination.
// it can be either canceled or failed.
// YAML file cannot supply it (not in ENV), so an extra request is required to check it.
const SHOULD_CHECK_REASON = true;

function buildErrorCommentBody(ctx: PostCleanupContext, isCancellation: boolean): string {
  let errorMessage = isCancellation
    ? `This run was cancelled 🛑\n\nThe workflow was cancelled before completion.`
    : `This run croaked 😵\n\nThe workflow encountered an error before any progress could be reported.`;

  if (ctx.runId) {
    errorMessage += " Please check the link below for details.";
  }

  const customParts: string[] = [];
  if (!isCancellation && ctx.runId) {
    const apiUrl = getApiUrl();
    customParts.push(
      `[Rerun failed job ➔](${apiUrl}/trigger/${ctx.repoContext.owner}/${ctx.repoContext.name}/${ctx.runId}?action=rerun)`
    );
  }
  const footer = buildPullfrogFooter({
    triggeredBy: true,
    workflowRun: ctx.runId
      ? {
          owner: ctx.repoContext.owner,
          repo: ctx.repoContext.name,
          runId: ctx.runId,
        }
      : undefined,
    customParts,
  });
  return `${errorMessage}${footer}`;
}

async function validateStuckProgressComment(
  ctx: PostCleanupContext
): Promise<ProgressComment | null> {
  const promptComment = ctx.promptInput?.progressComment;
  if (!promptComment) {
    log.info("[post] no progressComment in prompt input, skipping cleanup");
    return null;
  }

  const comment = parseProgressComment(promptComment);
  if (!comment) {
    log.info(`[post] progressComment.id is not a positive integer: ${promptComment.id}`);
    return null;
  }
  log.info(`[post] validating progressComment from prompt input: ${comment.id} (${comment.type})`);

  try {
    const fetched = await getProgressComment(
      { octokit: ctx.octokit, owner: ctx.repoContext.owner, repo: ctx.repoContext.name },
      comment
    );

    const body = fetched.body ?? "";

    if (isLeapingIntoActionCommentBody(body)) {
      log.info(`[post] comment ${comment.id} is stuck on "Leaping into action"`);
      return comment;
    }

    // detect stranded todo checklists left by the tracker when the process was killed
    // before the agent could call report_progress with a final summary
    if (/^- \[[ x]\] |^- \*\*→\*\* |^- ~~/.test(body)) {
      log.info(`[post] comment ${comment.id} is stuck on a todo checklist`);
      return comment;
    }

    log.info(`[post] comment ${comment.id} is not stuck (already updated or different content)`);
    return null;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.info(`[post] failed to get comment ${comment.id}: ${errorMessage}`);
    return null;
  }
}

async function getIsCancelled(ctx: PostCleanupContext): Promise<boolean> {
  if (!ctx.runId) return false; // can't check without a run ID — assume failure
  try {
    const jobsResult = await ctx.octokit.rest.actions.listJobsForWorkflowRun({
      owner: ctx.repoContext.owner,
      repo: ctx.repoContext.name,
      run_id: ctx.runId,
    });

    // find current job by matching GITHUB_JOB env var.
    // GITHUB_JOB is the job ID (yaml key), but job.name is the display name.
    // for matrix jobs, the name includes matrix values like "build (ubuntu-latest, node-18)"
    // so we match jobs that START with the job ID
    const currentJobName = process.env.GITHUB_JOB;
    const currentJob = currentJobName
      ? jobsResult.data.jobs.find(
          (j) => j.name === currentJobName || j.name.startsWith(`${currentJobName} (`)
        )
      : jobsResult.data.jobs[0]; // fallback to first job

    if (!currentJob) {
      log.warning("[post] could not find current job");
      return false;
    }

    log.info(`[post] job status: ${currentJob.status}, conclusion: ${currentJob.conclusion}`);
    if (currentJob.conclusion === "cancelled") return true; // whole job explicit cancellation

    // but if it's still null, check steps for cancellation:
    const cancelledStep = currentJob.steps?.find((step) => step.conclusion === "cancelled");
    if (cancelledStep) {
      log.info(`[post] found cancelled step: ${cancelledStep.name}`);
      return true;
    }
    log.info("[post] no cancellation found, assuming failure");
  } catch (error) {
    log.info(
      `[post] failed to get job status: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return false; // assuming failure
}

export async function runPostCleanup(): Promise<void> {
  log.info("» [post] starting post cleanup");

  const runId = process.env.GITHUB_RUN_ID
    ? Number.parseInt(process.env.GITHUB_RUN_ID, 10)
    : undefined;

  // resolve prompt input once and use it for both issue number and comment ID extraction
  // only use the object form (JSON payload), not plain string prompts
  let promptInput: JsonPromptInput | null = null;
  try {
    const resolved = resolvePromptInput();
    if (typeof resolved !== "string") promptInput = resolved;
  } catch (error) {
    log.info(
      `[post] failed to resolve prompt input: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // get job token for API calls
  const token = getJobToken();
  const repoContext = parseRepoContext();
  const octokit = createOctokit(token);

  const ctx: PostCleanupContext = { repoContext, octokit, runId, promptInput };

  const stuck = await validateStuckProgressComment(ctx);

  if (!stuck) return log.info("» [post] no stuck progress comment to update, skipping cleanup");

  log.info(
    `» [post] validated stuck comment: ${stuck.id} (${stuck.type}), updating with error message`
  );

  try {
    const body = buildErrorCommentBody(
      ctx,
      SHOULD_CHECK_REASON ? await getIsCancelled(ctx) : false
    );

    await writeAndVerify(ctx, stuck, body);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.info(`[post] failed to update comment: ${errorMessage}`);
  }
}

// post-cleanup runs in a separate process from the cancelled action, so any in-flight
// HTTP write the action's todoTracker had on the wire when SIGTERM landed can still get
// processed by GitHub *after* our update — clobbering the cancellation message back to
// the stale task list. (action-side mitigation: SIGTERM handler cancels the tracker; here
// we close the remaining race by reading back our write and re-issuing if it lost.)
const VERIFY_DELAY_MS = 3000;
const MAX_WRITE_ATTEMPTS = 3;

async function writeAndVerify(
  ctx: PostCleanupContext,
  comment: ProgressComment,
  body: string
): Promise<void> {
  const apiCtx = {
    octokit: ctx.octokit,
    owner: ctx.repoContext.owner,
    repo: ctx.repoContext.name,
  };
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    await updateProgressComment(apiCtx, comment, body);
    await new Promise((resolve) => setTimeout(resolve, VERIFY_DELAY_MS));

    let fetched: Awaited<ReturnType<typeof getProgressComment>>;
    try {
      fetched = await getProgressComment(apiCtx, comment);
    } catch (error) {
      // verify GET failed (5xx, secondary rate limit, network blip). the PUT itself
      // returned 200, so we trust it landed; another write-and-verify pass would just
      // amplify writes against a flaky GitHub. log and exit — if a stale tracker write
      // does clobber us, the comment will be wrong but the agent's commit + replies
      // already conveyed the substance of the run.
      log.warning(
        `[post] verify GET failed after attempt ${attempt} — trusting our PUT landed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }

    if (fetched.body === body) {
      log.info(
        `» [post] successfully updated progress comment (attempt ${attempt}/${MAX_WRITE_ATTEMPTS})`
      );
      return;
    }
    log.info(
      `[post] body was overwritten after our write (attempt ${attempt}/${MAX_WRITE_ATTEMPTS}), retrying`
    );
  }
  log.warning(
    `[post] gave up after ${MAX_WRITE_ATTEMPTS} attempts — comment may be stale (in-flight writes from the cancelled run kept clobbering us)`
  );
}
