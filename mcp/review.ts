import type { RestEndpointMethodTypes } from "@octokit/rest";
import { type } from "arktype";
import { formatMcpToolRef } from "../external.ts";
import { apiFetch } from "../utils/apiFetch.ts";
import { getApiUrl } from "../utils/apiUrl.ts";
import { buildPullfrogFooter } from "../utils/buildPullfrogFooter.ts";
import { log } from "../utils/cli.ts";
import { fixDoubleEscapedString } from "../utils/fixDoubleEscapedString.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

function getHttpStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as Record<string, unknown>).status;
  return typeof status === "number" ? status : undefined;
}

// one-shot review tool
export const CreatePullRequestReview = type({
  pull_number: type.number.describe("The pull request number to review"),
  body: type.string
    .describe(
      "1-2 sentence high-level summary with urgency level, critical callouts, and feedback about code outside the diff. Specific feedback on diff lines goes in 'comments' array."
    )
    .optional(),
  approved: type.boolean
    .describe(
      "Set to true to submit as an approval. ONLY when the review contains no actionable feedback — neither inline comments nor actionable content in the body. Defaults to false (comment-only review). Rejections are not supported."
    )
    .optional(),
  commit_id: type.string
    .describe("Optional SHA of the commit being reviewed. Defaults to latest.")
    .optional(),
  comments: type({
    path: type.string.describe(
      "The file path to comment on (relative to repo root). Must be a file that appears in the PR diff."
    ),
    line: type.number.describe(
      "Line number to comment on. For multi-line ranges, this is the end line. Use NEW column from diff format."
    ),
    side: type
      .enumerated("LEFT", "RIGHT")
      .describe(
        "Side of the diff: LEFT (old code, lines starting with -) or RIGHT (new code, lines starting with + or unchanged). Defaults to RIGHT."
      )
      .optional(),
    body: type.string
      .describe("Explanatory comment text (optional if suggestion is provided)")
      .optional(),
    suggestion: type.string
      .describe(
        "Full replacement code for the line range [start_line, line]. MUST preserve the exact indentation of the original code."
      )
      .optional(),
    start_line: type.number
      .describe(
        "Start line for multi-line comment ranges. Omit for single-line comments. The range [start_line, line] defines which lines a suggestion replaces."
      )
      .optional(),
  })
    .array()
    .describe(
      "Inline comments on lines within diff hunks. Feedback about code outside the diff goes in 'body' instead."
    )
    .optional(),
});

export function CreatePullRequestReviewTool(ctx: ToolContext) {
  return tool({
    name: "create_pull_request_review",
    description:
      "Submit a review for an existing pull request. " +
      "Each call creates a permanent, visible review on the PR — NEVER submit test or diagnostic reviews. " +
      "Reviews with no body AND no comments are silently skipped (nothing to post). " +
      "IMPORTANT: 95%+ of feedback should be in 'comments' array with file paths and line numbers. " +
      "Only use 'body' for a 1-2 sentence summary with urgency and critical callouts. " +
      "Use 'suggestion' to propose replacement code - MUST preserve exact indentation of original code. " +
      "Example replacing lines 42-44 (3 lines) with 5 lines: " +
      `{ path: 'src/api.ts', start_line: 42, line: 44, suggestion: '    const result = await fetch(url);\\n    if (!result.ok) {\\n      log.error(result.status);\\n      throw new Error("request failed");\\n    }' }` +
      " CONSTRAINT: Inline comments can ONLY target files and lines that appear in the PR diff." +
      " If GitHub rejects comments due to incorrect line numbers, re-read the diff and retry.",
    parameters: CreatePullRequestReview,
    execute: execute(async ({ pull_number, body, approved, commit_id, comments = [] }) => {
      if (body) body = fixDoubleEscapedString(body);

      // set issue context (PRs are issues)
      ctx.toolState.issueNumber = pull_number;

      // skip empty COMMENT reviews (no body, no inline comments) — nothing to post.
      // APPROVE reviews are never skipped: the approval stamp itself is the content.
      if (!approved && !body && comments.length === 0) {
        log.info(
          "review has no body and no inline comments — skipping submission (no issues found)"
        );
        return {
          success: true,
          skipped: true,
          reason: "no issues found — nothing to post",
        };
      }

      // enforce prApproveEnabled: downgrade APPROVE to COMMENT if disabled
      let event: "APPROVE" | "COMMENT" = approved ? "APPROVE" : "COMMENT";
      if (event === "APPROVE" && !ctx.prApproveEnabled) {
        log.info("prApproveEnabled is disabled — downgrading APPROVE to COMMENT");
        event = "COMMENT";
      }

      const params: RestEndpointMethodTypes["pulls"]["createReview"]["parameters"] = {
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        pull_number,
        event,
      };
      let latestHeadSha: string | undefined;
      if (commit_id) {
        params.commit_id = commit_id;
      } else {
        const pr = await ctx.octokit.rest.pulls.get({
          owner: ctx.repo.owner,
          repo: ctx.repo.name,
          pull_number,
        });
        latestHeadSha = pr.data.head.sha;
        // anchor to checkout sha so line numbers match the diff the agent analyzed
        params.commit_id = ctx.toolState.checkoutSha ?? latestHeadSha;
        if (ctx.toolState.checkoutSha && latestHeadSha !== ctx.toolState.checkoutSha) {
          log.info(
            `anchoring review to checkout ${ctx.toolState.checkoutSha.slice(0, 7)} ` +
              `(HEAD is now ${latestHeadSha.slice(0, 7)})`
          );
        }
      }
      type ReviewComment = NonNullable<typeof params.comments>[number];
      const reviewComments = comments.map((comment) => {
        let commentBody = fixDoubleEscapedString(comment.body || "");
        if (comment.suggestion !== undefined) {
          const suggestionBlock = "```suggestion\n" + comment.suggestion + "\n```";
          commentBody = commentBody ? commentBody + "\n\n" + suggestionBlock : suggestionBlock;
        }
        const side = comment.side || "RIGHT";
        const reviewComment: ReviewComment = {
          path: comment.path,
          line: comment.line,
          body: commentBody,
          side,
        };
        if (comment.start_line != null && comment.start_line !== comment.line) {
          reviewComment.start_line = comment.start_line;
          reviewComment.start_side = side;
        }
        return reviewComment;
      });

      if (reviewComments.length > 0) {
        params.comments = reviewComments;
      }

      // no body → single-step createReview (no footer needed)
      // has body → pending + submit so we can build footer with Fix links using review ID
      let result;
      try {
        result = body
          ? await createAndSubmitWithFooter(ctx, params, {
              body,
              approved: approved ?? false,
              hasComments: reviewComments.length > 0,
            })
          : await ctx.octokit.rest.pulls.createReview(params);
      } catch (err: unknown) {
        if (getHttpStatus(err) !== 422 || !params.comments?.length) throw err;

        const details = params.comments.map((c) => {
          const line = c.line ?? 0;
          const startLine = c.start_line ?? line;
          const range = startLine !== line ? `${startLine}-${line}` : `${line}`;
          return `${c.path}:${range} (${c.side ?? "RIGHT"})`;
        });
        throw new Error(
          `GitHub rejected inline comment(s) with "Line could not be resolved". ` +
            `This usually means the diff changed since you last read it (new commits pushed). ` +
            `Re-read the diff to get current line numbers, or move failing comments to the review body. ` +
            `Affected: ${details.join(", ")}`
        );
      }
      log.debug(`createReview response: ${JSON.stringify(result.data)}`);
      if (!result.data.id) {
        throw new Error(`createReview returned invalid data: ${JSON.stringify(result.data)}`);
      }
      const reviewId = result.data.id;
      const reviewNodeId = result.data.node_id;

      // reviewedSha = what the agent actually reviewed (checkout SHA), not the
      // submission anchor (current HEAD). this ensures postReviewCleanup dispatches
      // a follow-up if the agent doesn't handle new commits inline.
      const actuallyReviewedSha = ctx.toolState.checkoutSha ?? params.commit_id;
      ctx.toolState.review = {
        id: reviewId,
        nodeId: reviewNodeId,
        reviewedSha: actuallyReviewedSha,
      };

      // detect commits pushed since checkout and guide the agent to review them
      // inline instead of dispatching a separate workflow run
      if (
        ctx.toolState.checkoutSha &&
        latestHeadSha &&
        latestHeadSha !== ctx.toolState.checkoutSha
      ) {
        const fromSha = ctx.toolState.checkoutSha;
        const toSha = latestHeadSha;
        // store old checkoutSha as beforeSha so the next checkout_pr computes an incremental diff
        ctx.toolState.beforeSha = fromSha;
        // advance checkoutSha so the next review submission tracks correctly (just in case, checkout_pr will overwrite it again)
        ctx.toolState.checkoutSha = toSha;

        log.info(
          `new commits detected during review: ${fromSha.slice(0, 7)}..${toSha.slice(0, 7)}`
        );

        return {
          success: true,
          reviewId,
          html_url: result.data.html_url,
          state: result.data.state,
          user: result.data.user?.login,
          submitted_at: result.data.submitted_at,
          newCommits: {
            from: fromSha,
            to: toSha,
            instructions:
              `new commits were pushed while you were reviewing. ` +
              `call \`${formatMcpToolRef(ctx.agentId, "checkout_pr")}\` again to fetch the latest version — it will compute the incremental diff automatically. ` +
              `submit another review covering only the new changes. do not repeat feedback from your previous review.`,
          },
        };
      }

      return {
        success: true,
        reviewId,
        html_url: result.data.html_url,
        state: result.data.state,
        user: result.data.user?.login,
        submitted_at: result.data.submitted_at,
      };
    }),
  });
}

type FooterOpts = { body: string; approved: boolean; hasComments: boolean };

async function createAndSubmitWithFooter(
  ctx: ToolContext,
  params: RestEndpointMethodTypes["pulls"]["createReview"]["parameters"],
  opts: FooterOpts
) {
  // create as PENDING (strip event) so we get the review ID before publishing
  const { event: _, ...pendingParams } = params;
  const pending = await ctx.octokit.rest.pulls.createReview(pendingParams);
  if (!pending.data.id) {
    throw new Error(`createReview returned invalid data: ${JSON.stringify(pending.data)}`);
  }

  const customParts: string[] = [];
  if (!opts.approved) {
    const apiUrl = getApiUrl();
    if (opts.hasComments) {
      const fixAllUrl = `${apiUrl}/trigger/${ctx.repo.owner}/${ctx.repo.name}/${params.pull_number}?action=fix&review_id=${pending.data.id}`;
      const fixApprovedUrl = `${apiUrl}/trigger/${ctx.repo.owner}/${ctx.repo.name}/${params.pull_number}?action=fix-approved&review_id=${pending.data.id}`;
      customParts.push(`[Fix all ➔](${fixAllUrl})`, `[Fix 👍s ➔](${fixApprovedUrl})`);
    } else {
      const fixUrl = `${apiUrl}/trigger/${ctx.repo.owner}/${ctx.repo.name}/${params.pull_number}?action=fix&review_id=${pending.data.id}`;
      customParts.push(`[Fix it ➔](${fixUrl})`);
    }
  }

  const footer = buildPullfrogFooter({
    workflowRun: ctx.runId
      ? { owner: ctx.repo.owner, repo: ctx.repo.name, runId: ctx.runId, jobId: ctx.jobId }
      : undefined,
    customParts,
    model: ctx.toolState.model,
  });

  return ctx.octokit.rest.pulls.submitReview({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pull_number,
    review_id: pending.data.id,
    event: params.event!,
    body: opts.body + footer,
  });
}

/**
 * report the review node ID to the server so the WorkflowRun is marked as "review submitted".
 * exported for use in main.ts post-agent cleanup.
 */
export async function reportReviewNodeId(ctx: ToolContext, reviewNodeId: string): Promise<void> {
  for (let remaining = 2; remaining >= 0; remaining--) {
    try {
      const response = await apiFetch({
        path: `/api/workflow-run/${ctx.runId}`,
        method: "PATCH",
        headers: {
          authorization: `Bearer ${ctx.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ reviewNodeId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return;
      if (remaining > 0) {
        log.debug(`reportReviewNodeId got ${response.status}, retrying (${remaining} left)`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (error) {
      if (remaining > 0) {
        log.debug(`reportReviewNodeId failed, retrying (${remaining} left): ${error}`);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        log.debug(`reportReviewNodeId exhausted retries: ${error}`);
      }
    }
  }
}
