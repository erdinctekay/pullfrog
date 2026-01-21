import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type } from "arktype";
import { log } from "../utils/log.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

// graphql query to fetch all review threads with comments, replies, and reactions
const REVIEW_THREADS_QUERY = `
query ($owner: String!, $repo: String!, $pullNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pullNumber) {
      reviewThreads(first: 100) {
        nodes {
          diffSide
          startDiffSide
          comments(first: 100) {
            nodes {
              id
              databaseId
              body
              path
              line
              startLine
              url
              author {
                login
              }
              createdAt
              updatedAt
              pullRequestReview {
                databaseId
              }
              replyTo {
                databaseId
              }
              reactionGroups {
                content
                reactors(first: 10) {
                  nodes {
                    ... on Actor {
                      login
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

type GraphQLReviewComment = {
  id: string;
  databaseId: number;
  body: string;
  path: string;
  line: number | null;
  startLine: number | null;
  url: string;
  author: {
    login: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  pullRequestReview: {
    databaseId: number;
  } | null;
  replyTo: {
    databaseId: number;
  } | null;
  reactionGroups:
    | {
        content: string;
        reactors: {
          nodes: ({ login: string } | null)[] | null;
        };
      }[]
    | null;
};

type GraphQLReviewThread = {
  diffSide: "LEFT" | "RIGHT";
  startDiffSide: "LEFT" | "RIGHT" | null;
  comments: {
    nodes: (GraphQLReviewComment | null)[] | null;
  } | null;
} | null;

type GraphQLResponse = {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: (GraphQLReviewThread | null)[] | null;
      } | null;
    } | null;
  } | null;
};

const MAX_BODY_PREVIEW = 80;
const MAX_THREAD_DEPTH = 10;

function truncateBody(body: string): string {
  const oneLine = body.replace(/\n/g, " ").trim();
  if (oneLine.length <= MAX_BODY_PREVIEW) return oneLine;
  return oneLine.slice(0, MAX_BODY_PREVIEW - 3) + "...";
}

// walk up the replyTo chain to get actual conversation (oldest first)
function getReplyChain(
  comment: GraphQLReviewComment,
  commentMap: Map<number, GraphQLReviewComment>,
  depth = 0
): GraphQLReviewComment[] {
  if (depth >= MAX_THREAD_DEPTH) return [];
  const parentId = comment.replyTo?.databaseId;
  if (!parentId) return [];
  const parent = commentMap.get(parentId);
  if (!parent) return [];
  return [...getReplyChain(parent, commentMap, depth + 1), parent];
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hasThumbsUpFrom(comment: GraphQLReviewComment, username: string): boolean {
  if (!comment.reactionGroups) return false;
  const thumbsUp = comment.reactionGroups.find((g) => g.content === "THUMBS_UP");
  if (!thumbsUp?.reactors?.nodes) return false;
  return thumbsUp.reactors.nodes.some((r) => r?.login === username);
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
      // fetch all review threads using graphql (single API call)
      const response = await ctx.octokit.graphql<GraphQLResponse>(REVIEW_THREADS_QUERY, {
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        pullNumber: pull_number,
      });

      const pullRequest = response.repository?.pullRequest;
      if (!pullRequest?.reviewThreads?.nodes) {
        return {
          review_id,
          pull_number,
          reviewer: "unknown",
          count: 0,
          commentsPath: null,
          message: "No review threads found",
        };
      }

      // build a map of all comments for O(1) lookup when walking replyTo chains
      const commentMap = new Map<number, GraphQLReviewComment>();
      for (const thread of pullRequest.reviewThreads.nodes) {
        if (!thread?.comments?.nodes) continue;
        for (const comment of thread.comments.nodes) {
          if (comment) commentMap.set(comment.databaseId, comment);
        }
      }

      // collect leaf comments (from target review) with their thread context
      type LeafComment = {
        comment: GraphQLReviewComment;
        thread: GraphQLReviewComment[]; // parent comments in order (oldest first)
        side: "LEFT" | "RIGHT";
      };
      const leafComments: LeafComment[] = [];

      for (const thread of pullRequest.reviewThreads.nodes) {
        if (!thread?.comments?.nodes) continue;

        const threadComments = thread.comments.nodes.filter(
          (c): c is GraphQLReviewComment => c !== null
        );
        if (threadComments.length === 0) continue;

        // find comments from the target review (these are the "leaf" comments to address)
        for (const comment of threadComments) {
          if (comment.pullRequestReview?.databaseId !== review_id) continue;

          // filter by approved_by if specified
          if (approved_by && !hasThumbsUpFrom(comment, approved_by)) continue;

          // get thread context by walking up the replyTo chain (not just chronological)
          const replyChain = getReplyChain(comment, commentMap);

          leafComments.push({
            comment,
            thread: replyChain,
            side: thread.diffSide,
          });
        }
      }

      if (leafComments.length === 0) {
        return {
          review_id,
          pull_number,
          reviewer: "unknown",
          count: 0,
          commentsPath: null,
          message: approved_by
            ? `No comments with 👍 from ${approved_by}`
            : "No comments found for this review",
        };
      }

      // derive reviewer from first comment (all comments in a review are from the same user)
      const reviewer = leafComments[0].comment.author?.login ?? "unknown";

      // build XML output
      const lines: string[] = [];
      lines.push(
        `<review_comments count="${leafComments.length}" reviewer="${escapeXml(reviewer)}">`
      );
      lines.push("");

      // summary section
      lines.push("<summary>");
      for (const leaf of leafComments) {
        const line = leaf.comment.line ?? leaf.comment.startLine ?? 0;
        const preview = escapeXml(truncateBody(leaf.comment.body));
        lines.push(
          `  <comment id="${leaf.comment.databaseId}" file="${escapeXml(leaf.comment.path)}" line="${line}">${preview}</comment>`
        );
      }
      lines.push("</summary>");
      lines.push("");

      // detailed comments with thread context
      for (const leaf of leafComments) {
        const line = leaf.comment.line ?? leaf.comment.startLine ?? 0;
        const author = leaf.comment.author?.login ?? "unknown";
        lines.push(
          `<comment id="${leaf.comment.databaseId}" file="${escapeXml(leaf.comment.path)}" line="${line}" author="${escapeXml(author)}">`
        );

        // thread history (parent comments)
        if (leaf.thread.length > 0) {
          lines.push("  <thread>");
          for (const msg of leaf.thread) {
            const msgAuthor = msg.author?.login ?? "unknown";
            lines.push(
              `    <message id="${msg.databaseId}" author="${escapeXml(msgAuthor)}">${escapeXml(msg.body)}</message>`
            );
          }
          lines.push("  </thread>");
        }

        // the actual comment body to address
        lines.push(`  <body>${escapeXml(leaf.comment.body)}</body>`);
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
      log.debug(`wrote ${leafComments.length} comments to ${commentsPath}`);
      log.debug(`content: ${content}`);

      return {
        review_id,
        pull_number,
        reviewer,
        count: leafComments.length,
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
