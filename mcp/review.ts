import type { RestEndpointMethodTypes } from "@octokit/rest";
import { type } from "arktype";
import { formatMcpToolRef } from "../external.ts";
import { getApiUrl } from "../utils/apiUrl.ts";
import { buildPullfrogFooter } from "../utils/buildPullfrogFooter.ts";
import { log } from "../utils/cli.ts";
import {
  countLinesInRanges,
  getDiffCoverageBreakdown,
  renderDiffCoverageBreakdown,
} from "../utils/diffCoverage.ts";
import { fixDoubleEscapedString } from "../utils/fixDoubleEscapedString.ts";
import { patchWorkflowRunFields } from "../utils/patchWorkflowRunFields.ts";
import { deleteProgressComment } from "./comment.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

function getHttpStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as Record<string, unknown>).status;
  return typeof status === "number" ? status : undefined;
}

type PullFile = RestEndpointMethodTypes["pulls"]["listFiles"]["response"]["data"][number];
export type CommentableLines = { RIGHT: Set<number>; LEFT: Set<number> };

/**
 * parse a PR file's patch to determine which line numbers on each side are
 * valid anchors for inline comments. GitHub only accepts comments on lines
 * inside a diff hunk: added/context lines on RIGHT, removed/context lines
 * on LEFT.
 */
export function commentableLinesForFile(patch: string | undefined): CommentableLines {
  const right = new Set<number>();
  const left = new Set<number>();
  if (!patch) return { RIGHT: right, LEFT: left };

  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[2], 10);
      continue;
    }
    const changeType = line[0];
    if (changeType === "+") {
      right.add(newLine);
      newLine++;
    } else if (changeType === "-") {
      left.add(oldLine);
      oldLine++;
    } else if (changeType === " ") {
      right.add(newLine);
      left.add(oldLine);
      newLine++;
      oldLine++;
    }
    // "\" (no newline marker) and anything else: skip, don't advance counters
  }
  return { RIGHT: right, LEFT: left };
}

export async function buildCommentableMap(
  ctx: ToolContext,
  pullNumber: number
): Promise<Map<string, CommentableLines>> {
  // prefer the snapshot captured by checkout_pr — it matches the diff GitHub
  // will anchor to (commit_id=checkoutSha). refetching via listFiles at review
  // time gives the LATEST PR state, which can drift from what the agent
  // actually reviewed if the PR was updated mid-run.
  //
  // only reuse the cache if it was built for THIS pull request AND for the
  // sha we will anchor the review to. a second checkout_pr that bumps
  // checkoutSha but fails before repopulating the cache (e.g., listFiles 5xx)
  // would otherwise leave a stale snapshot keyed to the right PR number but
  // the wrong sha, silently mis-validating comments.
  const cached = ctx.toolState.commentableLinesByFile;
  const cachedFor = ctx.toolState.commentableLinesPullNumber;
  const cachedSha = ctx.toolState.commentableLinesCheckoutSha;
  const currentSha = ctx.toolState.checkoutSha;
  if (cached && cachedFor === pullNumber && cachedSha && cachedSha === currentSha) return cached;

  const files: PullFile[] = await ctx.octokit.paginate(ctx.octokit.rest.pulls.listFiles, {
    owner: ctx.repo.owner,
    repo: ctx.repo.name,
    pull_number: pullNumber,
    per_page: 100,
  });
  const map = new Map<string, CommentableLines>();
  for (const file of files) {
    map.set(file.filename, commentableLinesForFile(file.patch));
  }
  return map;
}

export type ReviewCommentInput = NonNullable<
  RestEndpointMethodTypes["pulls"]["createReview"]["parameters"]["comments"]
>[number];

export interface DroppedComment {
  path: string;
  line: number;
  startLine?: number | undefined;
  side: "LEFT" | "RIGHT";
  reason: string;
}

export function validateInlineComments(
  comments: ReviewCommentInput[],
  map: Map<string, CommentableLines>
): { valid: ReviewCommentInput[]; dropped: DroppedComment[] } {
  const valid: ReviewCommentInput[] = [];
  const dropped: DroppedComment[] = [];
  for (const c of comments) {
    const side = c.side === "LEFT" ? "LEFT" : "RIGHT";
    const line = c.line ?? 0;
    const startLine = c.start_line ?? line;
    const lines = map.get(c.path);
    const record = (reason: string): void => {
      const entry: DroppedComment = { path: c.path, line, side, reason };
      if (c.start_line != null) entry.startLine = c.start_line;
      dropped.push(entry);
    };
    if (!lines) {
      record(`file not in PR diff`);
      continue;
    }
    if (lines.LEFT.size === 0 && lines.RIGHT.size === 0) {
      // file is in the PR but has no textual patch — usually binary, a
      // pure rename with no content change, or a mode-only change. GitHub
      // won't accept inline comments on these regardless of line number.
      record(`file has no textual diff (binary, pure rename, or mode change)`);
      continue;
    }
    const anchors = lines[side];
    if (!anchors.has(line)) {
      record(`line ${line} (${side}) is not inside a diff hunk`);
      continue;
    }
    // GitHub requires start_line <= line. both anchors could be valid but
    // inverted (e.g. start=44, line=42) — GitHub 422s with "invalid line
    // numbers". catch it here so the agent sees a precise reason.
    if (c.start_line != null && c.start_line > line) {
      record(
        `start_line ${c.start_line} is after line ${line} — ranges must satisfy start_line <= line`
      );
      continue;
    }
    if (startLine !== line && !anchors.has(startLine)) {
      record(`start_line ${startLine} (${side}) is not inside a diff hunk`);
      continue;
    }
    valid.push(c);
  }
  return { valid, dropped };
}

// cap the detail list so a pathological run (agent emits hundreds of invalid
// comments on a huge PR) doesn't push the review body past GitHub's ~65KB
// limit and fail the whole submission with a body-too-long 422.
export const MAX_DROPPED_COMMENT_LINES = 50;

/**
 * reason a create_pull_request_review call should be skipped without hitting
 * GitHub. returned by reviewSkipDecision; null means submit normally.
 */
export type ReviewSkipDecision =
  | { kind: "no-issues"; reason: string }
  | { kind: "empty-downgraded-approve"; reason: string };

/**
 * decision returned by duplicateReviewDecision when a session has already
 * submitted a review and the current call would be a duplicate.
 */
export type DuplicateReviewDecision = {
  kind: "already-submitted";
  reviewId: number;
  reason: string;
};

/**
 * decide whether a second create_pull_request_review call in the same session
 * is a duplicate of an earlier submission.
 *
 * the agent is instructed to call create_pull_request_review exactly once per
 * Review-mode session (see action/modes.ts), but in practice it sometimes
 * submits twice — once with substantive feedback, then again with the
 * canonical "Reviewed — no issues found." body when the prompt's branch
 * logic re-classifies non-blocking observations. the second submission is
 * always redundant: the first review is the record, and the duplicate just
 * adds noise to the PR.
 *
 * legitimate follow-up reviews after new commits ARE allowed: the
 * new-commits-mid-review path advances toolState.checkoutSha past the
 * previously reviewed sha, and a subsequent checkout_pr advances it again.
 * any call where checkoutSha has moved past the prior reviewedSha is a real
 * follow-up and goes through. anything else — same sha, or no checkoutSha
 * to compare against — is a duplicate.
 */
export function duplicateReviewDecision(params: {
  existing: { id: number; reviewedSha: string | undefined } | undefined;
  currentCheckoutSha: string | undefined;
}): DuplicateReviewDecision | null {
  const existing = params.existing;
  if (!existing) return null;
  // checkoutSha advanced past the prior reviewed sha — legitimate follow-up
  // (e.g. after checkout_pr re-fetched new commits the agent was nudged to
  // pull). only treat as a duplicate when we cannot prove the SHA moved.
  if (
    params.currentCheckoutSha &&
    existing.reviewedSha &&
    params.currentCheckoutSha !== existing.reviewedSha
  ) {
    return null;
  }
  return {
    kind: "already-submitted",
    reviewId: existing.id,
    reason: `review ${existing.id} was already submitted in this session; ignoring duplicate call (call \`checkout_pr\` again first if new commits were pushed)`,
  };
}

/**
 * decide whether to skip a review submission before any network call.
 *
 * GitHub rejects `event: "COMMENT"` reviews with no body and no inline comments
 * with HTTP 422 "Unprocessable Entity". two paths produce that shape:
 *
 *   1. `!approved` + empty body/comments: agent's "no issues found" result.
 *      skipping preserves the agent's intent (nothing to post is a fine
 *      outcome for a review run) without a spurious 422.
 *   2. `approved` + `!prApproveEnabled` + empty body/comments: the runtime
 *      downgrades APPROVE to COMMENT when prApproveEnabled is off, and the
 *      resulting empty-COMMENT is exactly the shape GitHub 422s. skipping
 *      here surfaces the cause (downgrade + nothing to say) instead of an
 *      opaque 422 the agent can't recover from.
 *
 * legitimate bare approvals (`approved` + `prApproveEnabled`, no body/comments)
 * are never skipped — GitHub accepts empty APPROVE reviews and the approval
 * stamp itself is the review's content.
 */
export function reviewSkipDecision(params: {
  approved: boolean;
  body: string | null | undefined;
  hasComments: boolean;
  prApproveEnabled: boolean;
}): ReviewSkipDecision | null {
  if (params.body || params.hasComments) return null;
  if (!params.approved) {
    return {
      kind: "no-issues",
      reason: "no issues found — nothing to post",
    };
  }
  if (!params.prApproveEnabled) {
    return {
      kind: "empty-downgraded-approve",
      reason:
        "approve requested but prApproveEnabled is disabled; no feedback body or comments to post as a COMMENT review instead",
    };
  }
  return null;
}

export function formatDroppedCommentsNote(dropped: DroppedComment[]): string {
  const renderEntry = (d: DroppedComment): string => {
    const range =
      d.startLine != null && d.startLine !== d.line ? `${d.startLine}-${d.line}` : `${d.line}`;
    return `- \`${d.path}:${range}\` (${d.side}) — ${d.reason}`;
  };
  const shown = dropped.slice(0, MAX_DROPPED_COMMENT_LINES).map(renderEntry);
  const remainder = dropped.length - shown.length;
  if (remainder > 0) shown.push(`- …and ${remainder} more dropped comment(s) not shown`);
  return (
    `\n\n---\n\n` +
    `**Note:** ${dropped.length} inline comment(s) dropped because they did not anchor to lines inside the PR diff:\n` +
    shown.join("\n")
  );
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
      "The first submission may error once with a one-time diff-coverage nudge listing unread TOC regions — retry with the same arguments and the pre-flight will not block again. " +
      "Example replacing lines 42-44 (3 lines) with 5 lines: " +
      `{ path: 'src/api.ts', start_line: 42, line: 44, suggestion: '    const result = await fetch(url);\\n    if (!result.ok) {\\n      log.error(result.status);\\n      throw new Error("request failed");\\n    }' }` +
      " CONSTRAINT: Inline comments can ONLY target files and lines that appear in the PR diff." +
      " Comments anchored outside a diff hunk are dropped automatically (with a note appended to the review body) — the rest of the review still posts.",
    parameters: CreatePullRequestReview,
    execute: execute(async ({ pull_number, body, approved, commit_id, comments = [] }) => {
      if (body) body = fixDoubleEscapedString(body);

      // set issue context (PRs are issues)
      ctx.toolState.issueNumber = pull_number;

      // guard against duplicate review submissions in the same session.
      // see duplicateReviewDecision for the rationale — short version: the
      // agent occasionally submits twice (substantive review + canonical
      // "no issues found" follow-up) and the second is always redundant.
      // legit re-reviews after new commits are still allowed because
      // checkout_pr advances toolState.checkoutSha past the prior reviewedSha.
      const dup = duplicateReviewDecision({
        existing: ctx.toolState.review,
        currentCheckoutSha: ctx.toolState.checkoutSha,
      });
      if (dup) {
        log.info(`skipping duplicate review submission: ${dup.reason}`);
        return {
          success: true,
          skipped: true,
          reason: dup.reason,
          reviewId: dup.reviewId,
        };
      }

      // skip empty COMMENT reviews before any GitHub call. see reviewSkipDecision
      // for the cases (no-issues vs empty-downgraded-approve) and why GitHub 422s
      // the shape we'd otherwise POST.
      const skip = reviewSkipDecision({
        approved: approved ?? false,
        body,
        hasComments: comments.length > 0,
        prApproveEnabled: ctx.prApproveEnabled,
      });
      if (skip) {
        log.info(`skipping review submission: ${skip.reason}`);
        return { success: true, skipped: true, reason: skip.reason };
      }

      // enforce prApproveEnabled: downgrade APPROVE to COMMENT if disabled.
      // by this point we already returned if the downgrade would produce an
      // empty COMMENT (the skip above), so every downgrade that reaches here
      // carries either a body or inline comments.
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

      runDiffCoveragePreflight({ ctx });

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

      // pre-validate inline comments against the current PR diff. drop any
      // comment that does not anchor to a line inside a hunk, rather than
      // letting GitHub 422 and sink the whole review.
      let droppedComments: DroppedComment[] = [];
      if (reviewComments.length > 0) {
        const commentableMap = await buildCommentableMap(ctx, pull_number);
        const validation = validateInlineComments(reviewComments, commentableMap);
        droppedComments = validation.dropped;
        if (droppedComments.length > 0) {
          log.info(
            `dropping ${droppedComments.length}/${reviewComments.length} inline comment(s) that do not anchor to PR diff lines`
          );
        }
        // always reassign so all-dropped reviews leave params.comments empty
        // instead of carrying the original invalid set (which would 422).
        params.comments = validation.valid;
      }

      // if we dropped comments, surface them in the review body so the
      // author (and the agent, on retry) can see what was skipped.
      if (droppedComments.length > 0) {
        const note = formatDroppedCommentsNote(droppedComments);
        body = body ? body + note : note.replace(/^\n\n/, "");
      }

      // after dropping, an empty non-approve review has nothing left to post.
      if (!approved && !body && !params.comments?.length) {
        log.info("review has no body and all inline comments were dropped — skipping submission");
        return {
          success: true,
          skipped: true,
          reason: "all inline comments were invalid — nothing to post",
          droppedComments,
        };
      }

      // no body → single-step createReview (no footer needed)
      // has body → pending + submit so we can build footer with Fix links using review ID
      let result;
      try {
        result = body
          ? await createAndSubmitWithFooter(ctx, params, {
              body,
              approved: approved ?? false,
              hasComments: (params.comments?.length ?? 0) > 0,
            })
          : await createReviewWithStrandedRecovery(ctx, params);
      } catch (err: unknown) {
        if (getHttpStatus(err) !== 422 || !params.comments?.length) throw err;

        const details = params.comments.map((c) => {
          const line = c.line ?? 0;
          const startLine = c.start_line ?? line;
          const range = startLine !== line ? `${startLine}-${line}` : `${line}`;
          return `${c.path}:${range} (${c.side ?? "RIGHT"})`;
        });
        // a 422 on createReview-with-comments is USUALLY about comment
        // anchors, but could also be about body length, invalid suggestion
        // blocks, etc. include the verbatim GitHub error so the agent can
        // diagnose non-anchor 422s without us having to enumerate every
        // possible GitHub validation rule.
        const rawMsg = err instanceof Error ? err.message : String(err);
        const checkoutRef = formatMcpToolRef(ctx.agentId, "checkout_pr");
        throw new Error(
          `GitHub rejected the review with 422 even after pre-validation. ` +
            `Likely causes (check "GitHub said" below to narrow down): ` +
            `(1) new commits pushed after pre-validation — call \`${checkoutRef}\` again to refresh the diff snapshot, then resubmit; ` +
            `(2) the review body exceeded GitHub's ~65KB limit — shorten it and retry; ` +
            `(3) a \`suggestion\` block is malformed (missing backticks, extra backticks, or wrong indentation) — inspect the affected comments below. ` +
            `If none apply, move the failing comments into the review body as text so the rest still posts. ` +
            `Affected comments: ${details.join(", ")}. ` +
            `GitHub said: ${rawMsg}`,
          { cause: err }
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

      ctx.toolState.wasUpdated = true;

      // a submitted review obsoletes the progress comment — the review IS the
      // durable artifact. owned here (not in main.ts) so cleanup is atomic with
      // submission and survives any path out of the run (success, timeout,
      // crash). deleteProgressComment sets progressComment = null, so a later
      // report_progress call short-circuits to a no-op.
      // best-effort: a cleanup failure must not turn a successful review into
      // a tool-call failure visible to the agent.
      await deleteProgressComment(ctx).catch((err) => {
        log.debug(`progress comment cleanup after review failed: ${err}`);
      });

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
          droppedComments: droppedComments.length > 0 ? droppedComments : undefined,
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
        droppedComments: droppedComments.length > 0 ? droppedComments : undefined,
      };
    }),
  });
}

function runDiffCoveragePreflight(params: { ctx: ToolContext }): void {
  const coverageState = params.ctx.toolState.diffCoverage;
  if (!coverageState) {
    log.debug("diff coverage pre-flight skipped: no diffCoverage state present in toolState");
    return;
  }
  if (coverageState.coveragePreflightRan) {
    log.debug("diff coverage pre-flight skipped: already ran in this session");
    return;
  }

  coverageState.coveragePreflightRan = true;
  log.debug(
    `diff coverage pre-flight start: diffPath=${coverageState.diffPath}, totalLines=${coverageState.totalLines}, tocEntries=${coverageState.tocEntries.length}, coveredRanges=${coverageState.coveredRanges.length}`
  );
  const breakdown = getDiffCoverageBreakdown({ state: coverageState });
  const unread: Array<{ path: string; ranges: string; unreadLines: number }> = [];
  let unreadLines = 0;
  for (const file of breakdown.files) {
    if (file.unreadRanges.length === 0) continue;
    const rangesText = file.unreadRanges
      .map((range) => `${range.startLine}-${range.endLine}`)
      .join(", ");
    const fileUnreadLines = countLinesInRanges({ ranges: file.unreadRanges });
    unread.push({ path: file.filename, ranges: rangesText, unreadLines: fileUnreadLines });
    unreadLines += fileUnreadLines;
  }
  coverageState.lastBreakdown = renderDiffCoverageBreakdown({
    diffPath: coverageState.diffPath,
    breakdown,
  });
  log.debug(
    `diff coverage pre-flight breakdown: coveredLines=${breakdown.coveredLines}, unreadLines=${unreadLines}`
  );

  if (unreadLines === 0) {
    log.debug("diff coverage pre-flight passed: no unread regions");
    return;
  }

  log.info(
    `diff coverage pre-flight nudge: unread lines=${unreadLines}, unread files=${unread.length}`
  );
  const unreadText = unread
    .map((entry) => `- ${entry.path} (${entry.unreadLines} lines, ${entry.ranges})`)
    .join("\n");
  throw new Error(
    `diff coverage pre-flight: some TOC regions were not read before review submission. ` +
      `this is a one-time nudge — optionally read the ranges below from ${coverageState.diffPath}, then call create_pull_request_review again with the same arguments. ` +
      `this pre-flight will not block again in this review session.\n\n` +
      `unread TOC regions:\n${unreadText}\n\n` +
      `${coverageState.lastBreakdown}`
  );
}

type FooterOpts = { body: string; approved: boolean; hasComments: boolean };

/**
 * clear a pending review draft stranded on the PR by a prior hard-killed run
 * (workflow timeout, OOM) so the next createReview can succeed.
 *
 * GitHub enforces one-pending-review-per-user-per-PR. if the previous process
 * died between createReview(PENDING) and submitReview, the draft remains and
 * the next run's createReview 422s with "already has a pending review".
 * listReviews only exposes PENDING reviews to their author, so filtering on
 * state === "PENDING" is already scoped to the authed token's own draft.
 *
 * if `originalErr` is not a pending-review 422, or no leftover is found, this
 * function rethrows `originalErr` so the caller surfaces the original failure.
 * delete failures with 404 (draft already gone) or 422 (draft submitted by a
 * concurrent caller) are swallowed — the caller's retry will succeed in both
 * cases. any other delete error is rethrown unchanged.
 *
 * known limitation: if two runs on the SAME PR share the authed token and
 * overlap in time, the loser's createReview 422s on the winner's still-active
 * draft. recovery would then delete the winner's active draft and the
 * winner's submitReview would 404. this is not distinguishable from a
 * genuinely-stranded draft via the review object alone (PENDING reviews
 * expose no created_at timestamp, and both reviews are authored by the same
 * bot user). rely on workflow-level concurrency controls (e.g. a concurrency
 * key keyed to the PR number) to prevent overlap.
 */
export async function clearStrandedPendingReview(
  ctx: ToolContext,
  params: { owner: string; repo: string; pull_number: number; originalErr: unknown }
): Promise<void> {
  const originalErr = params.originalErr;
  const msg = originalErr instanceof Error ? originalErr.message.toLowerCase() : "";
  if (getHttpStatus(originalErr) !== 422 || !msg.includes("pending review")) throw originalErr;
  // if listReviews itself fails (5xx, rate limit, etc), surface the ORIGINAL
  // 422 rather than the listing failure — "pending review conflict" is the
  // real blocker the caller needs to see. hiding it behind a transient 502
  // sent agents chasing phantom server errors instead of retrying the
  // conflict. log the listing failure for diagnosis but do not mask.
  const reviews = await ctx.octokit
    .paginate(ctx.octokit.rest.pulls.listReviews, {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pull_number,
      per_page: 100,
    })
    .catch((listErr: unknown) => {
      // surface at info so operators not running at debug still see that
      // recovery was attempted (and why) before the original 422 bubbles up.
      log.info(
        `» listReviews failed during pending-review cleanup, surfacing original 422: ${listErr instanceof Error ? listErr.message : String(listErr)}`
      );
      throw originalErr;
    });
  const leftover = reviews.find((r) => r.state === "PENDING");
  if (!leftover?.id) throw originalErr;
  log.info(
    `» clearing leftover pending review ${leftover.id} (likely stranded by a killed prior run)`
  );
  try {
    await ctx.octokit.rest.pulls.deletePendingReview({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pull_number,
      review_id: leftover.id,
    });
  } catch (cleanupErr) {
    const cleanupStatus = getHttpStatus(cleanupErr);
    if (cleanupStatus !== 404 && cleanupStatus !== 422) throw cleanupErr;
    log.debug(`» delete of leftover pending ${leftover.id} no-op (status ${cleanupStatus})`);
  }
}

/**
 * single-step createReview (event != PENDING) with stranded-draft recovery.
 * the body path goes through createAndSubmitWithFooter which already recovers
 * from a stranded PENDING draft at its own createReview call. the no-body path
 * used to call createReview directly with no recovery — so a PR whose previous
 * body-path run crashed between createReview(PENDING) and submitReview would
 * permanently 422 any subsequent no-body review (approve-with-no-feedback or
 * comments-only) until a body-path run happened to clear the draft.
 */
export async function createReviewWithStrandedRecovery(
  ctx: ToolContext,
  params: RestEndpointMethodTypes["pulls"]["createReview"]["parameters"]
): Promise<Awaited<ReturnType<typeof ctx.octokit.rest.pulls.createReview>>> {
  try {
    return await ctx.octokit.rest.pulls.createReview(params);
  } catch (err) {
    await clearStrandedPendingReview(ctx, {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pull_number,
      originalErr: err,
    });
    return await ctx.octokit.rest.pulls.createReview(params);
  }
}

async function createAndSubmitWithFooter(
  ctx: ToolContext,
  params: RestEndpointMethodTypes["pulls"]["createReview"]["parameters"],
  opts: FooterOpts
) {
  // create as PENDING (strip event) so we get the review ID before publishing
  const { event: _, ...pendingParams } = params;
  let pending: Awaited<ReturnType<typeof ctx.octokit.rest.pulls.createReview>>;
  try {
    pending = await ctx.octokit.rest.pulls.createReview(pendingParams);
  } catch (err) {
    await clearStrandedPendingReview(ctx, {
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pull_number,
      originalErr: err,
    });
    pending = await ctx.octokit.rest.pulls.createReview(pendingParams);
  }
  if (!pending.data.id) {
    throw new Error(`createReview returned invalid data: ${JSON.stringify(pending.data)}`);
  }

  // once the pending draft exists, GitHub only allows one pending review per
  // user per PR — so ANY failure between here and successful submit must
  // clean up, not just a submitReview throw. getApiUrl() can throw if
  // API_URL is misconfigured, and future footer-building changes could
  // introduce new throw paths. keep the whole body wrapped.
  try {
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

    return await ctx.octokit.rest.pulls.submitReview({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.pull_number,
      review_id: pending.data.id,
      event: params.event!,
      body: opts.body + footer,
    });
  } catch (err) {
    // anything failed after the pending draft was created. leaving the draft
    // on the PR would cause the agent's retry to fail with "already has a
    // pending review" (GitHub's one-pending-per-user-per-PR limit). best-effort
    // cleanup so retries start from a clean slate. the cleanup itself may
    // 404/422 (review already submitted by a concurrent caller, or the PR
    // was closed mid-flight) — log and swallow those so the original error
    // isn't masked.
    try {
      await ctx.octokit.rest.pulls.deletePendingReview({
        owner: params.owner,
        repo: params.repo,
        pull_number: params.pull_number,
        review_id: pending.data.id,
      });
      log.debug(`» deleted leftover pending review ${pending.data.id} after failure`);
    } catch (cleanupErr) {
      log.debug(
        `» failed to delete pending review ${pending.data.id}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`
      );
    }
    throw err;
  }
}

/**
 * report the review node ID so the WorkflowRun is marked as "review submitted".
 * exported for use in main.ts post-agent cleanup.
 */
export async function reportReviewNodeId(
  ctx: ToolContext,
  params: { nodeId: string }
): Promise<void> {
  await patchWorkflowRunFields(ctx, { reviewNodeId: params.nodeId });
}
