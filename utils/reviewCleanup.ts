import type { WriteablePayload } from "../external.ts";
import { reportReviewNodeId } from "../mcp/review.ts";
import type { ToolContext } from "../mcp/server.ts";
import { log } from "./cli.ts";

const RE_REVIEW_PREAMBLE =
  "Incrementally re-review the new commits on this pull request. Use the IncrementalReview mode.";

/**
 * post-agent review lifecycle: runs after the agent exits (success or timeout).
 *
 * normally the agent handles new commits inline: create_pull_request_review
 * detects HEAD movement and tells the agent to pull and review the delta.
 * this dispatch is a safety net for cases where the agent couldn't handle
 * it (timeout, error, etc).
 *
 * ordering matters: reportReviewNodeId marks this run "done" FIRST so push
 * webhooks stop being suppressed by dedup. the HEAD check runs SECOND to
 * catch any pushes that were suppressed while this run was in-flight.
 */
export async function postReviewCleanup(ctx: ToolContext): Promise<void> {
  const review = ctx.toolState.review;
  if (!review) return;
  delete ctx.toolState.review;

  // mark review as submitted — unlocks webhook dedup for new pushes
  await bestEffort(() => reportReviewNodeId(ctx, { nodeId: review.nodeId }), "reportReviewNodeId");

  // dispatch follow-up if PR HEAD moved past the reviewed commit
  if (review.reviewedSha) {
    await bestEffort(
      () => dispatchFollowUpReReview(ctx, review.reviewedSha!),
      "follow-up re-review dispatch"
    );
  }
}

async function bestEffort(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    log.debug(`${label} failed: ${error}`);
  }
}

async function dispatchFollowUpReReview(ctx: ToolContext, reviewedSha: string): Promise<void> {
  const issueNumber = ctx.payload.event.issue_number;
  if (!issueNumber) return;

  const pr = await ctx.octokit.rest.pulls.get({
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    pull_number: issueNumber,
  });

  if (pr.data.head.sha === reviewedSha) return;
  if (pr.data.state !== "open") return;
  if (pr.data.draft) return;

  log.info(
    `safety net: pr HEAD moved from ${reviewedSha.slice(0, 7)} to ${pr.data.head.sha.slice(0, 7)} ` +
      `and agent did not review inline — dispatching follow-up re-review`
  );

  const event: WriteablePayload["event"] = {
    trigger: "pull_request_synchronize",
    issue_number: issueNumber,
    is_pr: true,
    title: pr.data.title,
    body: null,
    branch: pr.data.head.ref,
    before_sha: reviewedSha,
    silent: true,
  };
  if (ctx.payload.event.authorPermission) {
    event.authorPermission = ctx.payload.event.authorPermission;
  }

  const payload: WriteablePayload = {
    "~pullfrog": true,
    version: ctx.payload.version,
    model: ctx.payload.model,
    prompt: "",
    eventInstructions: RE_REVIEW_PREAMBLE,
    event,
  };

  await ctx.octokit.rest.actions.createWorkflowDispatch({
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    workflow_id: "pullfrog.yml",
    ref: pr.data.base.repo.default_branch,
    inputs: { prompt: JSON.stringify(payload) },
  });
}
