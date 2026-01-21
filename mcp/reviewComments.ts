import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import { log } from "../utils/log.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

// fragment for nested replyTo (5 levels deep covers most threads)
const REPLY_TO_FRAGMENT = `
  replyTo {
    databaseId
    body
    author { login }
    replyTo {
      databaseId
      body
      author { login }
      replyTo {
        databaseId
        body
        author { login }
        replyTo {
          databaseId
          body
          author { login }
          replyTo {
            databaseId
            body
            author { login }
          }
        }
      }
    }
  }
`;

// fetch specific review by node ID with nested thread context (single efficient query)
const REVIEW_QUERY = `
query ($nodeId: ID!) {
  node(id: $nodeId) {
    ... on PullRequestReview {
      databaseId
      author { login }
      comments(first: 100) {
        nodes {
          databaseId
          body
          path
          line
          startLine
          diffHunk
          url
          author { login }
          createdAt
          ${REPLY_TO_FRAGMENT}
          reactionGroups {
            content
            reactors(first: 10) {
              nodes {
                ... on Actor { login }
              }
            }
          }
        }
      }
    }
  }
}
`;

// nested replyTo type (recursive up to 5 levels)
type NestedReplyTo = {
  databaseId: number;
  body: string;
  author: { login: string } | null;
  replyTo?: NestedReplyTo | null;
} | null;

type ReviewComment = {
  databaseId: number;
  body: string;
  path: string;
  line: number | null;
  startLine: number | null;
  diffHunk: string;
  url: string;
  author: { login: string } | null;
  createdAt: string;
  replyTo: NestedReplyTo;
  reactionGroups:
    | {
        content: string;
        reactors: { nodes: ({ login: string } | null)[] | null };
      }[]
    | null;
};

type ReviewQueryResponse = {
  node: {
    databaseId: number;
    author: { login: string } | null;
    comments: {
      nodes: (ReviewComment | null)[] | null;
    } | null;
  } | null;
};

const MAX_BODY_PREVIEW = 80;

function truncateBody(body: string): string {
  const oneLine = body.replace(/\n/g, " ").trim();
  if (oneLine.length <= MAX_BODY_PREVIEW) return oneLine;
  return oneLine.slice(0, MAX_BODY_PREVIEW - 3) + "...";
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hasThumbsUpFrom(comment: ReviewComment, username: string): boolean {
  if (!comment.reactionGroups) return false;
  const thumbsUp = comment.reactionGroups.find((g) => g.content === "THUMBS_UP");
  if (!thumbsUp?.reactors?.nodes) return false;
  return thumbsUp.reactors.nodes.some((r) => r?.login === username);
}

// flatten nested replyTo chain into array (oldest first)
function flattenReplyToChain(replyTo: NestedReplyTo): Array<{ body: string; author: string }> {
  if (!replyTo) return [];
  const parent = flattenReplyToChain(replyTo.replyTo ?? null);
  return [...parent, { body: replyTo.body, author: replyTo.author?.login ?? "unknown" }];
}

export const GetReviewComments = type({
  pull_number: type.number.describe("The pull request number"),
  review_id: type.number.describe("The review ID to get comments for"),
  approved_by: type.string
    .describe("Optional GitHub username - only return comments this user gave a 👍 to")
    .optional(),
});

export function GetReviewCommentsTool(ctx: ToolContext) {
  return tool({
    name: "get_review_comments",
    description:
      "Get review comments for a pull request review, including thread context. " +
      "When approved_by is provided, only returns comments that user approved with 👍. " +
      "Returns commentsPath pointing to a file with full comment details in XML format.",
    parameters: GetReviewComments,
    execute: execute(async ({ pull_number, review_id, approved_by }) => {
      // fetch the review to get node_id and reviewer
      const { data: review } = await ctx.octokit.rest.pulls.getReview({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        pull_number,
        review_id,
      });

      const reviewer = review.user?.login ?? "unknown";

      // fetch comments with nested thread context via GraphQL
      const response = await ctx.octokit.graphql<ReviewQueryResponse>(REVIEW_QUERY, {
        nodeId: review.node_id,
      });

      const reviewComments = response.node?.comments?.nodes;
      if (!reviewComments) {
        return {
          review_id,
          pull_number,
          reviewer,
          count: 0,
          commentsPath: null,
          message: "No comments found for this review",
        };
      }

      const allComments = reviewComments.filter((c): c is ReviewComment => c !== null);

      // filter by approved_by if specified
      const comments = approved_by
        ? allComments.filter((c) => hasThumbsUpFrom(c, approved_by))
        : allComments;

      if (comments.length === 0) {
        return {
          review_id,
          pull_number,
          reviewer,
          count: 0,
          commentsPath: null,
          message: approved_by
            ? `No comments with 👍 from ${approved_by}`
            : "No comments found for this review",
        };
      }

      // build XML output
      const lines: string[] = [];
      lines.push(`<review_comments count="${comments.length}" reviewer="${escapeXml(reviewer)}">`);
      lines.push("");

      // summary section
      lines.push("<summary>");
      for (const comment of comments) {
        const line = comment.line ?? comment.startLine ?? 0;
        const preview = escapeXml(truncateBody(comment.body));
        lines.push(
          `  <comment id="${comment.databaseId}" file="${escapeXml(comment.path)}" line="${line}">${preview}</comment>`
        );
      }
      lines.push("</summary>");
      lines.push("");

      // detailed comments with thread context
      for (const comment of comments) {
        const line = comment.line ?? comment.startLine ?? 0;
        const author = comment.author?.login ?? "unknown";
        lines.push(
          `<comment id="${comment.databaseId}" file="${escapeXml(comment.path)}" line="${line}" author="${escapeXml(author)}">`
        );

        // thread history (parent comments from nested replyTo)
        const thread = flattenReplyToChain(comment.replyTo);
        if (thread.length > 0) {
          lines.push("  <thread>");
          for (const msg of thread) {
            lines.push(
              `    <message author="${escapeXml(msg.author)}">${escapeXml(msg.body)}</message>`
            );
          }
          lines.push("  </thread>");
        }

        // diff context
        lines.push("  <diff>");
        lines.push(escapeXml(comment.diffHunk));
        lines.push("  </diff>");

        // the actual comment body to address
        lines.push(`  <body>${escapeXml(comment.body)}</body>`);
        lines.push("</comment>");
        lines.push("");
      }

      lines.push("</review_comments>");

      const content = lines.join("\n");

      // write to temp file
      const tempDir = process.env.PULLFROG_TEMP_DIR;
      if (!tempDir) {
        throw new Error("PULLFROG_TEMP_DIR not set");
      }
      const filename = approved_by
        ? `review-${review_id}-approved-by-${approved_by}.xml`
        : `review-${review_id}-comments.xml`;
      const commentsPath = join(tempDir, filename);
      writeFileSync(commentsPath, content);
      log.info(`wrote ${comments.length} comments to ${commentsPath}`);
      log.box(content);

      return {
        review_id,
        pull_number,
        reviewer,
        count: comments.length,
        commentsPath,
      };
    }),
  });
}

export const ListPullRequestReviews = type({
  pull_number: type.number.describe("The pull request number to list reviews for"),
});

export function ListPullRequestReviewsTool(ctx: ToolContext) {
  return tool({
    name: "list_pull_request_reviews",
    description:
      "List all reviews for a pull request. Returns all reviews including approvals, request changes, and comments.",
    parameters: ListPullRequestReviews,
    execute: execute(async ({ pull_number }) => {
      const reviews = await ctx.octokit.paginate(ctx.octokit.rest.pulls.listReviews, {
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        pull_number,
      });

      return {
        pull_number,
        reviews: reviews.map((review) => ({
          id: review.id,
          node_id: review.node_id,
          body: review.body,
          state: review.state,
          user: review.user?.login,
          submitted_at: review.submitted_at,
        })),
        count: reviews.length,
      };
    }),
  });
}
