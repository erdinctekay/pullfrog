// changes to tool permissions should be reflected in wiki/granular-tools.md
import { initToolState, startMcpHttpServer } from "./mcp/server.ts";
import { computeModes } from "./modes.ts";
import { resolveAgent } from "./utils/agent.ts";
import { validateAgentApiKey } from "./utils/apiKeys.ts";
import { resolveBody } from "./utils/body.ts";
import { log, writeSummary } from "./utils/cli.ts";
import { reportErrorToComment } from "./utils/errorReport.ts";
import { setupExitHandler } from "./utils/exitHandler.ts";
import { createOctokit } from "./utils/github.ts";
import { resolveInstructions } from "./utils/instructions.ts";
import { normalizeEnv } from "./utils/normalizeEnv.ts";
import { resolvePayload } from "./utils/payload.ts";
import { handleAgentResult } from "./utils/run.ts";
import { resolveRunContextData } from "./utils/runContextData.ts";
import { createTempDirectory, setupGit } from "./utils/setup.ts";
import { Timer } from "./utils/timer.ts";
import { resolveInstallationToken } from "./utils/token.ts";
import { resolveRun } from "./utils/workflow.ts";

export { Inputs } from "./utils/payload.ts";

export interface MainResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
}

export async function main(): Promise<MainResult> {
  // normalize env var names to uppercase (handles case-insensitive workflow files)
  normalizeEnv();

  const timer = new Timer();

  await using tokenRef = await resolveInstallationToken();
  process.env.GITHUB_TOKEN = tokenRef.token;


  const octokit = createOctokit(tokenRef.token);
  const runInfo = await resolveRun({ octokit });
  const toolState = initToolState({ runInfo });

  setupExitHandler(toolState);

  try {
    const runContext = await resolveRunContextData({ octokit, token: tokenRef.token });
    timer.checkpoint("runContextData");

    // resolve payload after runContextData so permissions can use DB settings
    // precedence: action inputs > json payload > repoSettings > fallbacks
    const payload = resolvePayload(runContext.repoSettings);
    if (payload.cwd && process.cwd() !== payload.cwd) {
      process.chdir(payload.cwd);
    }

    // resolve body - fetches body_html and converts to markdown if images present
    // this ensures agents receive markdown with working signed image URLs
    const originalBody = payload.event.body;
    const resolvedBody = await resolveBody({
      event: payload.event,
      octokit,
      repo: runContext.repo,
    });
    if (resolvedBody !== originalBody) {
      payload.event.body = resolvedBody;
      // also update prompt if original body was included there
      if (originalBody && payload.prompt.includes(originalBody)) {
        payload.prompt = payload.prompt.replace(originalBody, resolvedBody ?? "");
      }
    }

    const tmpdir = createTempDirectory();

    const agent = resolveAgent({ payload, repoSettings: runContext.repoSettings });

    validateAgentApiKey({
      agent,
      owner: runContext.repo.owner,
      name: runContext.repo.name,
    });

    await setupGit({
      token: tokenRef.token,
      originalToken: tokenRef.originalToken,
      bashPermission: payload.bash,
      owner: runContext.repo.owner,
      name: runContext.repo.name,
      event: payload.event,
      octokit,
      toolState,
    });
    timer.checkpoint("git");

    const modes = [...computeModes(), ...runContext.repoSettings.modes];

    await using mcpHttpServer = await startMcpHttpServer({
      repo: runContext.repo,
      payload,
      octokit,
      githubInstallationToken: tokenRef.token,
      apiToken: runContext.apiToken,
      agent,
      modes,
      toolState,
      runId: runInfo.runId,
      jobId: runInfo.jobId,
    });
    log.info(`» MCP server started at ${mcpHttpServer.url}`);
    timer.checkpoint("mcpServer");

    const instructions = resolveInstructions({
      payload,
      repo: runContext.repo,
      modes,
    });

    const result = await agent.run({
      payload,
      mcpServerUrl: mcpHttpServer.url,
      tmpdir,
      instructions,
    });

    // write last progress body to job summary
    if (toolState.lastProgressBody) {
      await writeSummary(toolState.lastProgressBody);
    }

    return handleAgentResult(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    log.error(errorMessage);
    try {
      await reportErrorToComment({ toolState, error: errorMessage });
    } catch {
      // error reporting failed, but don't let it mask the original error
    }
    return {
      success: false,
      error: errorMessage,
    };
  }
}
