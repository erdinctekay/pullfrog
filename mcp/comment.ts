import { type } from "arktype";
import { apiFetch } from "../utils/apiFetch.ts";
import { getApiUrl } from "../utils/apiUrl.ts";
import { buildPullfrogFooter, stripExistingFooter } from "../utils/buildPullfrogFooter.ts";
import { log } from "../utils/cli.ts";
import { fixDoubleEscapedString } from "../utils/fixDoubleEscapedString.ts";
import { type OctokitWithPlugins, parseRepoContext } from "../utils/github.ts";
import { retry } from "../utils/retry.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

/** PATCH workflow-run with plan comment node_id so plan revisions can update that comment in place. */
async function updatePlanCommentId(ctx: ToolContext, planCommentNodeId: string): Promise<void> {
  if (ctx.runId === undefined || !ctx.apiToken) return;
  try {
    await retry(
      async () => {
        const response = await apiFetch({
          path: `/api/workflow-run/${ctx.runId}`,
          method: "PATCH",
          headers: {
            authorization: `Bearer ${ctx.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ planCommentNodeId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`PATCH workflow-run: ${response.status}`);
      },
      {
        maxAttempts: 3,
        delayMs: 2000,
        label: "updatePlanCommentId",
      }
    );
  } catch (error) {
    log.warning(`updatePlanCommentId exhausted retries: ${error}`);
  }
}

/**
 * The prefix text for the initial "leaping into action" comment.
 * This is used to identify if a comment is still in its initial state
 * and hasn't been updated with progress or error messages.
 */
export const LEAPING_INTO_ACTION_PREFIX = "Leaping into action";

interface BuildCommentFooterParams {
  octokit?: OctokitWithPlugins | undefined;
  customParts?: string[] | undefined;
}

async function buildCommentFooter(params: BuildCommentFooterParams): Promise<string> {
  const repoContext = parseRepoContext();
  const runId = process.env.GITHUB_RUN_ID
    ? Number.parseInt(process.env.GITHUB_RUN_ID, 10)
    : undefined;

  let jobId: string | undefined;
  if (runId && params.octokit) {
    try {
      const { data: jobs } = await params.octokit.rest.actions.listJobsForWorkflowRun({
        owner: repoContext.owner,
        repo: repoContext.name,
        run_id: runId,
      });
      jobId = jobs.jobs[0]?.id.toString();
    } catch {
      // fall back to computed URL from runId alone
    }
  }

  const footerParams = {
    triggeredBy: true,
    workflowRun: runId
      ? { owner: repoContext.owner, repo: repoContext.name, runId, jobId }
      : undefined,
  };

  if (params.customParts && params.customParts.length > 0) {
    return buildPullfrogFooter({ ...footerParams, customParts: params.customParts });
  }
  return buildPullfrogFooter(footerParams);
}

function buildImplementPlanLink(
  owner: string,
  repo: string,
  issueNumber: number,
  commentId: number
): string {
  const apiUrl = getApiUrl();
  return `[Implement plan ➔](${apiUrl}/trigger/${owner}/${repo}/${issueNumber}?action=implement&comment_id=${commentId})`;
}

export interface AddFooterCtx {
  octokit?: OctokitWithPlugins | undefined;
}

export async function addFooter(ctx: AddFooterCtx, body: string): Promise<string> {
  const bodyWithoutFooter = stripExistingFooter(fixDoubleEscapedString(body));
  const footer = await buildCommentFooter({ octokit: ctx.octokit });
  return `${bodyWithoutFooter}${footer}`;
}

export const Comment = type({
  issueNumber: type.number.describe("the issue number to comment on"),
  body: type.string.describe("the comment body content"),
  type: type
    .enumerated("Plan", "Comment")
    .describe(
      "Plan: record this comment as the plan for this run (use report_progress for progress/plan updates on the current run). Comment: regular comment (default)."
    )
    .optional(),
});

export function CreateCommentTool(ctx: ToolContext) {
  return tool({
    name: "create_issue_comment",
    description:
      "Create a comment on a GitHub issue. For progress/plan updates on the current run use report_progress instead. Use type: 'Plan' only when creating a standalone plan comment to record as this run's plan.",
    parameters: Comment,
    execute: execute(async ({ issueNumber, body, type: commentType }) => {
      const bodyWithFooter = await addFooter(ctx, body);

      const result = await ctx.octokit.rest.issues.createComment({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        issue_number: issueNumber,
        body: bodyWithFooter,
      });

      if (commentType === "Plan" && result.data.node_id) {
        await updatePlanCommentId(ctx, result.data.node_id);
      }

      return {
        success: true,
        commentId: result.data.id,
        url: result.data.html_url,
        body: result.data.body,
      };
    }),
  });
}

export const EditComment = type({
  commentId: type.number.describe("the ID of the comment to edit"),
  body: type.string.describe("the new comment body content"),
});

export function EditCommentTool(ctx: ToolContext) {
  return tool({
    name: "edit_issue_comment",
    description: "Edit a GitHub issue comment by its ID",
    parameters: EditComment,
    execute: execute(async ({ commentId, body }) => {
      const bodyWithFooter = await addFooter(ctx, body);

      const result = await ctx.octokit.rest.issues.updateComment({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        comment_id: commentId,
        body: bodyWithFooter,
      });

      return {
        success: true,
        commentId: result.data.id,
        url: result.data.html_url,
        body: result.data.body,
        updatedAt: result.data.updated_at,
      };
    }),
  });
}

export const ReportProgress = type({
  body: type.string.describe("the progress update content to share"),
  "target_plan_comment?": type("boolean").describe(
    "when true, update the existing plan comment (from select_mode lookup) instead of the progress comment; use when editing an existing plan"
  ),
});

/**
 * Report progress to a GitHub comment.
 *
 * progressCommentId has three states:
 *   - undefined: no comment yet — will create one if an issue/PR target exists
 *   - number:    active comment — will update it in place
 *   - null:      deliberately deleted (e.g. after submitting a PR review) — skips silently
 *
 * The body is always tracked in lastProgressBody for the job summary regardless of comment state.
 */
export async function reportProgress(
  ctx: ToolContext,
  params: { body: string; target_plan_comment?: boolean }
): Promise<{
  commentId?: number;
  url?: string;
  body: string;
  action: "created" | "updated" | "skipped";
}> {
  const { body, target_plan_comment } = params;
  // always track the body for job summary
  ctx.toolState.lastProgressBody = body;

  // silent events (e.g., auto-label, PR summary) should never create or update progress comments.
  // the body is still tracked above for the GitHub Actions job summary.
  if (ctx.payload.event.silent) {
    return { body, action: "skipped" };
  }

  const issueNumber = ctx.payload.event.issue_number ?? ctx.toolState.issueNumber;
  const isPlanMode = ctx.toolState.selectedMode === "Plan";

  // when editing existing plan: update the plan comment from tool state (set by select_mode)
  if (target_plan_comment === true && ctx.toolState.existingPlanCommentId === undefined) {
    log.warning("target_plan_comment requested but no existingPlanCommentId in tool state");
  }
  if (target_plan_comment === true && ctx.toolState.existingPlanCommentId !== undefined) {
    const commentId = ctx.toolState.existingPlanCommentId;
    const customParts =
      isPlanMode && issueNumber !== undefined
        ? [buildImplementPlanLink(ctx.repo.owner, ctx.repo.name, issueNumber, commentId)]
        : undefined;
    const bodyWithoutFooter = stripExistingFooter(body);
    const footer = await buildCommentFooter({
      octokit: ctx.octokit,
      customParts,
    });
    const bodyWithFooter = `${bodyWithoutFooter}${footer}`;

    const result = await ctx.octokit.rest.issues.updateComment({
      owner: ctx.repo.owner,
      repo: ctx.repo.name,
      comment_id: commentId,
      body: bodyWithFooter,
    });

    ctx.toolState.wasUpdated = true;

    if (isPlanMode && result.data.node_id) {
      await updatePlanCommentId(ctx, result.data.node_id);
    }

    return {
      commentId: result.data.id,
      url: result.data.html_url,
      body: result.data.body || "",
      action: "updated",
    };
  }

  const existingCommentId = ctx.toolState.progressCommentId;

  // if we already have a progress comment, update it
  if (existingCommentId) {
    const customParts =
      isPlanMode && issueNumber !== undefined
        ? [buildImplementPlanLink(ctx.repo.owner, ctx.repo.name, issueNumber, existingCommentId)]
        : undefined;

    const bodyWithoutFooter = stripExistingFooter(body);
    const footer = await buildCommentFooter({
      octokit: ctx.octokit,
      customParts,
    });
    const bodyWithFooter = `${bodyWithoutFooter}${footer}`;

    const result = await ctx.octokit.rest.issues.updateComment({
      owner: ctx.repo.owner,
      repo: ctx.repo.name,
      comment_id: existingCommentId,
      body: bodyWithFooter,
    });

    ctx.toolState.wasUpdated = true;

    if (isPlanMode && result.data.node_id) {
      await updatePlanCommentId(ctx, result.data.node_id);
    }

    return {
      commentId: result.data.id,
      url: result.data.html_url,
      body: result.data.body || "",
      action: "updated",
    };
  }

  // null = progress comment was deliberately deleted (e.g. by create_pull_request_review)
  if (existingCommentId === null) {
    return { body, action: "skipped" };
  }

  // no existing comment - need an issue/PR to create one on
  // use fallback chain: dynamically set context > event payload
  if (issueNumber === undefined) {
    // no-op: no comment target (e.g., workflow_dispatch events)
    // body is already tracked for job summary
    return { body, action: "skipped" };
  }

  // for new comments, we need to create first, then update with Plan link if in Plan mode
  const initialBody = await addFooter(ctx, body);

  const result = await ctx.octokit.rest.issues.createComment({
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    issue_number: issueNumber,
    body: initialBody,
  });

  // store the comment ID for future updates
  ctx.toolState.progressCommentId = result.data.id;
  ctx.toolState.wasUpdated = true;

  // if Plan mode, update the comment to add the "Implement plan" link
  if (isPlanMode) {
    const customParts = [
      buildImplementPlanLink(ctx.repo.owner, ctx.repo.name, issueNumber, result.data.id),
    ];
    const bodyWithoutFooter = stripExistingFooter(body);
    const footer = await buildCommentFooter({
      octokit: ctx.octokit,
      customParts,
    });
    const bodyWithPlanLink = `${bodyWithoutFooter}${footer}`;

    const updateResult = await ctx.octokit.rest.issues.updateComment({
      owner: ctx.repo.owner,
      repo: ctx.repo.name,
      comment_id: result.data.id,
      body: bodyWithPlanLink,
    });

    if (updateResult.data.node_id) {
      await updatePlanCommentId(ctx, updateResult.data.node_id);
    }

    return {
      commentId: updateResult.data.id,
      url: updateResult.data.html_url,
      body: updateResult.data.body || "",
      action: "created",
    };
  }

  return {
    commentId: result.data.id,
    url: result.data.html_url,
    body: result.data.body || "",
    action: "created",
  };
}

export function ReportProgressTool(ctx: ToolContext) {
  return tool({
    name: "report_progress",
    description:
      "Share progress on the associated GitHub issue/PR. Call this to post updates as you work. The first call creates a comment, subsequent calls update it. Use this throughout your work to keep stakeholders informed.",
    parameters: ReportProgress,
    execute: execute(async (params) => {
      const reportParams: { body: string; target_plan_comment?: boolean } = { body: params.body };
      if (params.target_plan_comment !== undefined) {
        reportParams.target_plan_comment = params.target_plan_comment;
      }
      const result = await reportProgress(ctx, reportParams);

      if (result.action === "skipped") {
        // no-op: no comment target, but progress is still tracked for job summary
        return {
          success: true,
          message:
            "progress recorded (no GitHub comment created - this may occur for workflow_dispatch events or when there is no associated issue/PR)",
        };
      }

      return {
        success: true,
        ...result,
      };
    }),
  });
}

/**
 * Delete the progress comment if it exists.
 * Used after submitting a PR review since the review body contains all necessary info.
 * Sets progressCommentId to null, which prevents future report_progress calls from
 * creating a new comment (the agent may call report_progress again after this).
 */
export async function deleteProgressComment(ctx: ToolContext): Promise<boolean> {
  const existingCommentId = ctx.toolState.progressCommentId;
  if (!existingCommentId) {
    return false;
  }

  try {
    await ctx.octokit.rest.issues.deleteComment({
      owner: ctx.repo.owner,
      repo: ctx.repo.name,
      comment_id: existingCommentId,
    });
  } catch (error) {
    // ignore 404 - comment already deleted
    if (error instanceof Error && error.message.includes("Not Found")) {
      // comment already deleted, continue
    } else {
      throw error;
    }
  }

  // set to null (not undefined) so report_progress skips instead of creating a new comment
  ctx.toolState.progressCommentId = null;
  ctx.toolState.wasUpdated = true;

  return true;
}

export const ReplyToReviewComment = type({
  pull_number: type.number.describe("the pull request number"),
  comment_id: type.number.describe("the ID of the review comment to reply to"),
  body: type.string.describe(
    "extremely brief reply (1 sentence max) explaining what was fixed, e.g. 'Fixed by renaming to X' or 'Added null check'"
  ),
});

export function ReplyToReviewCommentTool(ctx: ToolContext) {
  return tool({
    name: "reply_to_review_comment",
    description:
      "Reply to a PR review comment thread (NOT issue comments — this only works for inline review comments on PR diffs). Call this for EACH comment you address in AddressReviews mode. Keep replies extremely brief (1 sentence max).",
    parameters: ReplyToReviewComment,
    execute: execute(async ({ pull_number, comment_id, body }) => {
      const bodyWithFooter = await addFooter(ctx, body);

      const result = await ctx.octokit.rest.pulls.createReplyForReviewComment({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        pull_number,
        comment_id,
        body: bodyWithFooter,
      });

      // mark progress as updated so post script doesn't think the run failed
      ctx.toolState.wasUpdated = true;

      return {
        success: true,
        commentId: result.data.id,
        url: result.data.html_url,
        body: result.data.body,
        in_reply_to_id: result.data.in_reply_to_id,
      };
    }, "reply_to_review_comment"),
  });
}
