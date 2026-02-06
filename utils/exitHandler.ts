import { LEAPING_INTO_ACTION_PREFIX } from "../mcp/comment.ts";
import type { ToolState } from "../mcp/server.ts";
import { buildPullfrogFooter } from "./buildPullfrogFooter.ts";
import { log } from "./cli.ts";
import { createOctokit, parseRepoContext } from "./github.ts";
import { revokeGitHubInstallationToken } from "./token.ts";

/**
 * Build error comment body with error message and footer
 */
export function buildErrorCommentBody(params: {
  owner: string;
  repo: string;
  runId: string | undefined;
  isCancellation: boolean;
}): string {
  const workflowRunLink = params.runId
    ? `[workflow run logs](https://github.com/${params.owner}/${params.repo}/actions/runs/${params.runId})`
    : "workflow run logs";
  const errorMessage = params.isCancellation
    ? `This run was cancelled 🛑\n\nThe workflow was cancelled before completion. Please check the ${workflowRunLink} for details.`
    : `This run croaked 😵\n\nThe workflow encountered an error before any progress could be reported. Please check the ${workflowRunLink} for details.`;
  const footer = buildPullfrogFooter({
    triggeredBy: true,
    workflowRun: params.runId
      ? { owner: params.owner, repo: params.repo, runId: params.runId }
      : undefined,
  });
  return `${errorMessage}${footer}`;
}

let cleanupFn: ((isCancellation: boolean) => Promise<void>) | undefined;

export function setupExitHandler(toolState: ToolState): void {
  let hasCleanedUp = false;

  async function cleanup(isCancellation: boolean): Promise<void> {
    if (hasCleanedUp) {
      return;
    }
    hasCleanedUp = true;

    const token = process.env.GITHUB_TOKEN;
    const commentId = toolState.progressCommentId;
    const wasUpdated = toolState.wasUpdated === true;

    // update progress comment if it was never updated (still shows "leaping into action")
    if (token && commentId && !wasUpdated) {
      try {
        const repoContext = parseRepoContext();
        const octokit = createOctokit(token);

        const existingComment = await octokit.rest.issues.getComment({
          owner: repoContext.owner,
          repo: repoContext.name,
          comment_id: commentId,
        });

        const commentBody = existingComment.data.body || "";

        // only update if comment still shows the initial "leaping into action" message
        if (commentBody.startsWith(LEAPING_INTO_ACTION_PREFIX)) {
          const runId = process.env.GITHUB_RUN_ID;

          const body = buildErrorCommentBody({
            owner: repoContext.owner,
            repo: repoContext.name,
            runId,
            isCancellation,
          });

          await octokit.rest.issues.updateComment({
            owner: repoContext.owner,
            repo: repoContext.name,
            comment_id: commentId,
            body,
          });

          log.info("» updated progress comment with error message");
        }
      } catch {
        // ignore errors during cleanup
      }
    }

    // revoke token
    if (token) {
      try {
        await revokeGitHubInstallationToken(token);
        log.debug("» installation token revoked");
      } catch {
        // ignore errors during cleanup
      }
    }
  }

  // store cleanup function for runCleanup()
  cleanupFn = cleanup;

  // handle cancellation signals
  function handleSignal(): void {
    log.info("» workflow cancelled, cleaning up...");
    cleanup(true).finally(() => process.exit(1));
  }

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
}

/**
 * Run cleanup explicitly. Called from entry.ts in finally block.
 */
export async function runCleanup(): Promise<void> {
  try {
    await cleanupFn?.(false);
  } catch {
    // ignore errors during cleanup
  }
}
