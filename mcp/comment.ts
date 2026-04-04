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

type CommentNodeIdField = "planCommentNodeId" | "summaryCommentNodeId";

// IMPORTANT: this route authenticates via Pullfrog API JWT (verifyApiToken),
// NOT a GitHub token. use ctx.apiToken here. see wiki/api-auth.md.
export async function updateCommentNodeId(
  ctx: ToolContext,
  field: CommentNodeIdField,
  nodeId: string
): Promise<void> {
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
          body: JSON.stringify({ [field]: nodeId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`PATCH workflow-run: ${response.status}`);
      },
      {
        maxAttempts: 3,
        delayMs: 2000,
        label: `updateCommentNodeId(${field})`,
      }
    );
  } catch (error) {
    log.warning(`updateCommentNodeId(${field}) exhausted retries: ${error}`);
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
  model?: string | undefined;
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

  return buildPullfrogFooter({
    triggeredBy: true,
    workflowRun: runId
      ? { owner: repoContext.owner, repo: repoContext.name, runId, jobId }
      : undefined,
    customParts: params.customParts,
    model: params.model,
  });
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
  toolState?: { model?: string | undefined } | undefined;
}

export async function addFooter(ctx: AddFooterCtx, body: string): Promise<string> {
  if (/<br\s*\/?>[ \t]*\n(?!\s*\n)/i.test(body)) {
    throw new Error(
      "body contains <br/> followed by a non-blank line, which breaks GitHub markdown rendering. always add a blank line after <br/> tags."
    );
  }
  const bodyWithoutFooter = stripExistingFooter(fixDoubleEscapedString(body));
  const footer = await buildCommentFooter({ octokit: ctx.octokit, model: ctx.toolState?.model });
  return `${bodyWithoutFooter}${footer}`;
}

export const Comment = type({
  issueNumber: type.number.describe("the issue number to comment on"),
  body: type.string.describe("the comment body content"),
  type: type
    .enumerated("Plan", "Summary", "Comment")
    .describe(
      "Plan: record as the plan for this run. Summary: record as the PR summary comment (one per PR, updated in place). Comment: regular comment (default)."
    )
    .optional(),
});

export function CreateCommentTool(ctx: ToolContext) {
  return tool({
    name: "create_issue_comment",
    description:
      "Create a comment on a GitHub issue or PR. For progress/plan updates on the current run use report_progress instead. Use type: 'Plan' for plan comments, type: 'Summary' for PR summary comments.",
    parameters: Comment,
    execute: execute(async ({ issueNumber, body, type: commentType }) => {
      const bodyWithFooter = await addFooter(ctx, body);

      // if a summary comment already exists (found by select_mode), update instead of creating
      if (commentType === "Summary" && ctx.toolState.existingSummaryCommentId) {
        log.info(
          `» redirecting create_issue_comment(Summary) to update existing comment ${ctx.toolState.existingSummaryCommentId}`
        );
        const result = await ctx.octokit.rest.issues.updateComment({
          owner: ctx.repo.owner,
          repo: ctx.repo.name,
          comment_id: ctx.toolState.existingSummaryCommentId,
          body: bodyWithFooter,
        });

        if (result.data.node_id) {
          await updateCommentNodeId(ctx, "summaryCommentNodeId", result.data.node_id);
        }

        return {
          success: true,
          commentId: result.data.id,
          url: result.data.html_url,
          body: result.data.body,
        };
      }

      const result = await ctx.octokit.rest.issues.createComment({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        issue_number: issueNumber,
        body: bodyWithFooter,
      });

      if (commentType === "Plan" && result.data.node_id) {
        await updateCommentNodeId(ctx, "planCommentNodeId", result.data.node_id);
      }
      if (commentType === "Summary" && result.data.node_id) {
        await updateCommentNodeId(ctx, "summaryCommentNodeId", result.data.node_id);
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
      model: ctx.toolState.model,
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
      await updateCommentNodeId(ctx, "planCommentNodeId", result.data.node_id);
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
      model: ctx.toolState.model,
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
      await updateCommentNodeId(ctx, "planCommentNodeId", result.data.node_id);
    }

    return {
      commentId: result.data.id,
      url: result.data.html_url,
      body: result.data.body || "",
      action: "updated",
    };
  }

  // null = progress comment was deleted by stranded-comment cleanup in main.ts
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
      model: ctx.toolState.model,
    });
    const bodyWithPlanLink = `${bodyWithoutFooter}${footer}`;

    const updateResult = await ctx.octokit.rest.issues.updateComment({
      owner: ctx.repo.owner,
      repo: ctx.repo.name,
      comment_id: result.data.id,
      body: bodyWithPlanLink,
    });

    if (updateResult.data.node_id) {
      await updateCommentNodeId(ctx, "planCommentNodeId", updateResult.data.node_id);
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
      "Share progress on the associated GitHub issue/PR. The first call creates a comment; subsequent calls update it in place. Call this at the end of every run with a brief final summary (1-3 sentences) unless the mode guidance instructs otherwise. The current task list is automatically appended in a collapsible section — do not restate individual steps.",
    parameters: ReportProgress,
    execute: execute(async (params) => {
      let body = params.body;

      // for non-plan calls: stop auto-updates, wait for in-flight writes to settle,
      // then append completed task list collapsible
      if (!params.target_plan_comment && ctx.toolState.todoTracker) {
        ctx.toolState.todoTracker.cancel();
        await ctx.toolState.todoTracker.settled();
        const collapsible = ctx.toolState.todoTracker.renderCollapsible();
        if (collapsible) {
          body = `${body}\n\n${collapsible}`;
        }
      }

      const reportParams: { body: string; target_plan_comment?: boolean } = { body };
      if (params.target_plan_comment !== undefined) {
        reportParams.target_plan_comment = params.target_plan_comment;
      }
      const result = await reportProgress(ctx, reportParams);

      if (!params.target_plan_comment) {
        ctx.toolState.finalSummaryWritten = true;
      }

      if (result.action === "skipped") {
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
 * Used by main.ts for stranded-comment cleanup (orphaned "Leaping into action" or
 * checklist left by the todo tracker when the agent didn't call report_progress).
 * Sets progressCommentId to null so subsequent report_progress calls are no-ops.
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
