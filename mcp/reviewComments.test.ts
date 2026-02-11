import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { acquireNewToken } from "../utils/github.ts";
import {
  buildThreadBlocks,
  formatReviewThreads,
  type ParsedHunk,
  parseFilePatches,
  REVIEW_THREADS_QUERY,
  type ReviewThread,
  type ReviewThreadsQueryResponse,
} from "./reviewComments.ts";

async function getToken(): Promise<string> {
  // prefer explicit GH_TOKEN, fall back to acquiring one via GitHub App credentials
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  return await acquireNewToken();
}

describe("formatReviewThreads", () => {
  it("formats thread blocks with TOC and correct line numbers", { timeout: 30000 }, async () => {
    const token = await getToken();
    const octokit = new Octokit({ auth: token });
    const pullNumber = 49;
    const reviewId = 3485940013;

    // fetch review threads via GraphQL
    const response = await octokit.graphql<ReviewThreadsQueryResponse>(REVIEW_THREADS_QUERY, {
      owner: "pullfrog",
      name: "scratch",
      prNumber: pullNumber,
    });

    const allThreads = response.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    const threadsForReview = allThreads.filter((thread): thread is ReviewThread => {
      if (!thread?.comments?.nodes) return false;
      return thread.comments.nodes.some((c) => c?.pullRequestReview?.databaseId === reviewId);
    });

    // fetch file patches
    const prFilesResponse = await octokit.rest.pulls.listFiles({
      owner: "pullfrog",
      repo: "scratch",
      pull_number: pullNumber,
    });
    const filePatchMap = new Map<string, ParsedHunk[]>();
    for (const file of prFilesResponse.data) {
      if (file.patch) {
        filePatchMap.set(file.filename, parseFilePatches(file.patch));
      }
    }

    // build and format
    const { threadBlocks, reviewer } = buildThreadBlocks(threadsForReview, filePatchMap, reviewId);
    const result = formatReviewThreads(threadBlocks, { pullNumber, reviewId, reviewer });

    expect(result.toc).toMatchSnapshot("toc");
    expect(result.content).toMatchSnapshot("content");
  });
});
