import { type } from "arktype";
import type { Agent } from "../agents/index.ts";
import { buildPullfrogFooter, stripExistingFooter } from "../utils/buildPullfrogFooter.ts";
import { type OctokitWithPlugins, parseRepoContext } from "../utils/github.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

/**
 * The prefix text for the initial "leaping into action" comment.
 * This is used to identify if a comment is still in its initial state
 * and hasn't been updated with progress or error messages.
 */
export const LEAPING_INTO_ACTION_PREFIX = "Leaping into action";

interface BuildCommentFooterParams {
  agent: Agent | undefined;
  octokit?: OctokitWithPlugins | undefined;
  customParts?: string[] | undefined;
}

async function buildCommentFooter({
  agent,
  octokit,
  customParts,
}: BuildCommentFooterParams): Promise<string> {
  const repoContext = parseRepoContext();
  const runId = process.env.GITHUB_RUN_ID;

  let workflowRunHtmlUrl: string | undefined;
  if (runId && octokit) {
    try {
      // fetch jobs to get the job URL for deep linking
      const { data: jobs } = await octokit.rest.actions.listJobsForWorkflowRun({
        owner: repoContext.owner,
        repo: repoContext.name,
        run_id: parseInt(runId, 10),
      });
      // use the first job's URL if available
      workflowRunHtmlUrl = jobs.jobs[0]?.html_url ?? undefined;
    } catch {
      // fall back to building URL from runId if jobs can't be fetched
    }
  }

  const footerParams = {
    triggeredBy: true,
    agent: {
      displayName: agent?.displayName || "Unknown agent",
      url: agent?.url || "https://pullfrog.com",
    },
    workflowRun: runId
      ? {
          owner: repoContext.owner,
          repo: repoContext.name,
          runId,
          ...(workflowRunHtmlUrl ? { htmlUrl: workflowRunHtmlUrl } : {}),
        }
      : undefined,
  };

  if (customParts && customParts.length > 0) {
    return buildPullfrogFooter({ ...footerParams, customParts });
  }
  return buildPullfrogFooter(footerParams);
}

function buildImplementPlanLink(
  owner: string,
  repo: string,
  issueNumber: number,
  commentId: number
): string {
  const apiUrl = process.env.API_URL || "https://pullfrog.com";
  return `[Implement plan ➔](${apiUrl}/trigger/${owner}/${repo}/${issueNumber}?action=implement&comment_id=${commentId})`;
}

export interface AddFooterCtx {
  agent?: Agent | undefined;
  octokit?: OctokitWithPlugins | undefined;
}

export async function addFooter(ctx: AddFooterCtx, body: string): Promise<string> {
  const bodyWithoutFooter = stripExistingFooter(body);
  const footer = await buildCommentFooter({ agent: ctx.agent, octokit: ctx.octokit });
  return `${bodyWithoutFooter}${footer}`;
}

export const Comment = type({
  issueNumber: type.number.describe("the issue number to comment on"),
  body: type.string.describe("the comment body content"),
});

export function CreateCommentTool(ctx: ToolContext) {
  return tool({
    name: "create_issue_comment",
    description:
      "Create a comment on a GitHub issue. NOTE: Do NOT use this for progress updates or status summaries - use report_progress instead, which updates the existing progress comment.",
    parameters: Comment,
    execute: execute(async ({ issueNumber, body }) => {
      const bodyWithFooter = await addFooter(ctx, body);

      const result = await ctx.octokit.rest.issues.createComment({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        issue_number: issueNumber,
        body: bodyWithFooter,
      });

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
});

/**
 * Standalone function to report progress to GitHub comment.
 * Can be called directly without going through the MCP tool interface.
 * Returns result data if successful.
 * When there's no comment target (no progressCommentId and no issueNumber), returns a "skipped" result.
 */
export async function reportProgress(
  ctx: ToolContext,
  { body }: { body: string }
): Promise<{
  commentId?: number;
  url?: string;
  body: string;
  action: "created" | "updated" | "skipped";
}> {
  // always track the body for job summary
  ctx.toolState.lastProgressBody = body;

  const existingCommentId = ctx.toolState.progressCommentId;
  const issueNumber =
    ctx.toolState.prNumber ?? ctx.toolState.issueNumber ?? ctx.payload.event.issue_number;
  const isPlanMode = ctx.toolState.selectedMode === "Plan";

  // if we already have a progress comment, update it
  if (existingCommentId) {
    const customParts =
      isPlanMode && issueNumber !== undefined
        ? [buildImplementPlanLink(ctx.repo.owner, ctx.repo.name, issueNumber, existingCommentId)]
        : undefined;

    const bodyWithoutFooter = stripExistingFooter(body);
    const footer = await buildCommentFooter({
      agent: ctx.agent,
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

    return {
      commentId: result.data.id,
      url: result.data.html_url,
      body: result.data.body || "",
      action: "updated",
    };
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
      agent: ctx.agent,
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
    execute: execute(async ({ body }) => {
      const result = await reportProgress(ctx, { body });

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

  // reset state and mark as updated so post script doesn't try to handle it
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
      "Reply to a PR review comment thread. Call this for EACH comment you address. Keep replies extremely brief (1 sentence max).",
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
