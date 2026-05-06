import type { ToolState } from "../mcp/server.ts";
import { getApiUrl } from "./apiUrl.ts";
import { buildPullfrogFooter } from "./buildPullfrogFooter.ts";
import { createOctokit, parseRepoContext } from "./github.ts";
import { updateProgressComment } from "./progressComment.ts";
import { getGitHubInstallationToken } from "./token.ts";

interface ReportErrorParams {
  toolState: ToolState;
  error: string;
  title?: string;
}

export async function reportErrorToComment(ctx: ReportErrorParams): Promise<void> {
  const formattedError = ctx.title ? `${ctx.title}\n\n${ctx.error}` : ctx.error;

  const comment = ctx.toolState.progressComment;
  if (!comment) {
    return;
  }

  const repoContext = parseRepoContext();
  const octokit = createOctokit(getGitHubInstallationToken());
  const runId = process.env.GITHUB_RUN_ID
    ? Number.parseInt(process.env.GITHUB_RUN_ID, 10)
    : undefined;

  const customParts: string[] = [];
  if (runId) {
    const apiUrl = getApiUrl();
    customParts.push(
      `[Rerun failed job ➔](${apiUrl}/trigger/${repoContext.owner}/${repoContext.name}/${runId}?action=rerun)`
    );
  }

  const footer = buildPullfrogFooter({
    triggeredBy: true,
    workflowRun: runId ? { owner: repoContext.owner, repo: repoContext.name, runId } : undefined,
    customParts,
    model: ctx.toolState.model,
  });

  await updateProgressComment(
    { octokit, owner: repoContext.owner, repo: repoContext.name },
    comment,
    `${formattedError}${footer}`
  );

  // mark as updated so exit handler doesn't try to update again
  ctx.toolState.wasUpdated = true;
}
