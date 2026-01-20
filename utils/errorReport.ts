import type { ToolState } from "../mcp/server.ts";
import { buildPullfrogFooter } from "./buildPullfrogFooter.ts";
import { createOctokit, parseRepoContext } from "./github.ts";
import { getGitHubInstallationToken } from "./token.ts";

interface ReportErrorParams {
  toolState: ToolState;
  error: string;
  title?: string;
}

export async function reportErrorToComment(ctx: ReportErrorParams): Promise<void> {
  const formattedError = ctx.title ? `${ctx.title}\n\n${ctx.error}` : ctx.error;

  const commentId = ctx.toolState.progressComment.id;
  if (!commentId) {
    return;
  }

  const repoContext = parseRepoContext();
  const octokit = createOctokit(getGitHubInstallationToken());
  const runId = process.env.GITHUB_RUN_ID;

  // build footer with workflow run link
  const footer = buildPullfrogFooter({
    triggeredBy: true,
    workflowRun: runId
      ? { owner: repoContext.owner, repo: repoContext.name, runId }
      : undefined,
  });

  await octokit.rest.issues.updateComment({
    owner: repoContext.owner,
    repo: repoContext.name,
    comment_id: commentId,
    body: `${formattedError}${footer}`,
  });

  // mark as updated so ensureProgressCommentUpdated doesn't try to update again
  ctx.toolState.progressComment.wasUpdated = true;
}
