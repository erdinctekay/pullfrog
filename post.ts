#!/usr/bin/env node

/**
 * Post cleanup entry point for pullfrog/pullfrog action.
 * Runs independently after workflow failure or cancellation.
 * Searches for Pullfrog comment via GitHub API and updates if stuck on "Leaping into action".
 */

import { LEAPING_INTO_ACTION_PREFIX } from "./mcp/comment.ts";
import { log } from "./utils/cli.ts";
import { buildErrorCommentBody } from "./utils/exitHandler.ts";
import { createOctokit, parseRepoContext } from "./utils/github.ts";
import { type ResolvedPromptInput, resolvePromptInput } from "./utils/payload.ts";
import { getJobToken } from "./utils/token.ts";

type JsonPromptInput = Extract<ResolvedPromptInput, object>; // not string

/**
 * Controls whether the script should check the reason for the workflow termination.
 * It can be either canceled or failed.
 * YAML file cannot supply it (not in ENV), so an extra request is required to check it.
 * */
const SHOULD_CHECK_REASON = true;

/**
 * Validate that the progress comment is stuck on "Leaping into action"
 * Fetches the comment by ID and checks if it starts with LEAPING_INTO_ACTION_PREFIX
 * Returns the comment ID if stuck, null otherwise
 */
async function validateStuckProgressComment(
  promptInput: JsonPromptInput | null,
  octokit: ReturnType<typeof createOctokit>,
  owner: string,
  repo: string
): Promise<number | null> {
  if (!promptInput?.progressCommentId) {
    log.info("[post] no progressCommentId in prompt input, skipping cleanup");
    return null;
  }

  const commentId = parseInt(promptInput.progressCommentId, 10);
  log.info(`[post] validating progressCommentId from prompt input: ${commentId}`);

  try {
    const { data: comment } = await octokit.rest.issues.getComment({
      owner,
      repo,
      comment_id: commentId,
    });

    // check if comment is stuck on "Leaping into action"
    if (comment.body?.startsWith(LEAPING_INTO_ACTION_PREFIX)) {
      log.info(`[post] comment ${commentId} is stuck on "Leaping into action"`);
      return commentId;
    }

    log.info(`[post] comment ${commentId} is not stuck (already updated or different content)`);
    return null;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`[post] failed to get comment ${commentId}: ${errorMessage}`);
    return null;
  }
}

/**
 * Detect if the workflow or its steps is cancelled.
 * While the job is still in_progress, the individual steps may have their conclusions set.
 */
async function getIsCancelled(params: {
  repoContext: ReturnType<typeof parseRepoContext>,
  octokit: ReturnType<typeof createOctokit>,
  runIdStr: string;
}): Promise<boolean> {
  try {
    const { data: jobs } = await params.octokit.rest.actions.listJobsForWorkflowRun({
      owner: params.repoContext.owner,
      repo: params.repoContext.name,
      run_id: Number.parseInt(params.runIdStr, 10),
    });

    // find current job by matching GITHUB_JOB env var
    // Note: GITHUB_JOB is the job ID (yaml key), but job.name is the display name
    // For matrix jobs, the name includes matrix values like "build (ubuntu-latest, node-18)"
    // So we match jobs that START with the job ID
    const currentJobName = process.env.GITHUB_JOB;
    const currentJob = currentJobName
      ? jobs.jobs.find(j => j.name === currentJobName || j.name.startsWith(`${currentJobName} (`))
      : jobs.jobs[0]; // fallback to first job

    if (!currentJob) {
      log.warning("[post] could not find current job");
      return false;
    }

    log.info(`[post] job status: ${currentJob.status}, conclusion: ${currentJob.conclusion}`);
    if (currentJob.conclusion === "cancelled") return true; // whole job explicit cancellation

    // but if it's still null, check steps for cancellation:
    const cancelledStep = currentJob.steps?.find(step => step.conclusion === "cancelled");
    if (cancelledStep) {
      log.info(`[post] found cancelled step: ${cancelledStep.name}`);
      return true;
    }
    log.info("[post] no cancellation found, assuming failure");
  } catch (error) {
    log.warning(`[post] failed to get job status: ${error instanceof Error ? error.message : String(error)}`);
  }
  return false; // assuming failure
}

async function runPostCleanup(): Promise<void> {
  log.info("» [post] starting post cleanup");

  const runIdStr = process.env.GITHUB_RUN_ID;

  if (!runIdStr)
    return log.info("» [post] no GITHUB_RUN_ID available, skipping cleanup");

  // resolve prompt input once and use it for both issue number and comment ID extraction
  // only use the object form (JSON payload), not plain string prompts
  let promptInput: JsonPromptInput | null = null;
  try {
    const resolved = resolvePromptInput();
    if (typeof resolved !== "string") promptInput = resolved;
  } catch (error) {
    log.warning(`[post] failed to resolve prompt input: ${error instanceof Error ? error.message : String(error)}`);
  }

  // get job token for API calls
  const token = getJobToken();
  const repoContext = parseRepoContext();
  const octokit = createOctokit(token);

  // validate that progressCommentId from prompt input is stuck on "Leaping into action"
  const commentId = await validateStuckProgressComment(promptInput, octokit, repoContext.owner, repoContext.name);

  if (!commentId)
    return log.info("» [post] no stuck progress comment to update, skipping cleanup");

  log.info(`» [post] validated stuck comment: ${commentId}, updating with error message`);

  try {
    const body = buildErrorCommentBody({
      owner: repoContext.owner,
      repo: repoContext.name,
      runId: runIdStr,
      isCancellation: SHOULD_CHECK_REASON
        ? await getIsCancelled({ octokit, repoContext, runIdStr })
        : false,
    });

    await octokit.rest.issues.updateComment({
      owner: repoContext.owner,
      repo: repoContext.name,
      comment_id: commentId,
      body,
    });

    log.info("» [post] successfully updated progress comment");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`[post] failed to update comment: ${errorMessage}`);
  }
}

async function run(): Promise<void> {
  try {
    await runPostCleanup();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`[post] unexpected error: ${message}`);
    // don't fail the post script - best effort cleanup
  }
}

log.debug(`[post] script started at ${new Date().toISOString()}`);
await run();
