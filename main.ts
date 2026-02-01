// changes to tool permissions should be reflected in wiki/granular-tools.md
import { initToolState, startMcpHttpServer } from "./mcp/server.ts";
import { computeModes } from "./modes.ts";
import {
  type ActivityTimeout,
  createProcessOutputActivityTimeout,
  DEFAULT_ACTIVITY_CHECK_INTERVAL_MS,
  DEFAULT_ACTIVITY_TIMEOUT_MS,
} from "./utils/activity.ts";
import { resolveAgent } from "./utils/agent.ts";
import { validateAgentApiKey } from "./utils/apiKeys.ts";
import { resolveBody } from "./utils/body.ts";
import { log, writeSummary } from "./utils/cli.ts";
import { reportErrorToComment } from "./utils/errorReport.ts";
import { setupExitHandler } from "./utils/exitHandler.ts";
import { createOctokit } from "./utils/github.ts";
import { resolveInstructions } from "./utils/instructions.ts";
import { normalizeEnv } from "./utils/normalizeEnv.ts";
import { resolvePayload, resolvePromptInput } from "./utils/payload.ts";
import { handleAgentResult } from "./utils/run.ts";
import { resolveRunContextData } from "./utils/runContextData.ts";
import { createTempDirectory, setupGit } from "./utils/setup.ts";
import { killTrackedChildren } from "./utils/subprocess.ts";
import { parseTimeString, TIMEOUT_DISABLED } from "./utils/time.ts";
import { Timer } from "./utils/timer.ts";
import { resolveInstallationToken } from "./utils/token.ts";
import { resolveRun } from "./utils/workflow.ts";

export { Inputs } from "./utils/payload.ts";

export interface MainResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  result?: string | undefined;
}

export async function main(): Promise<MainResult> {
  // normalize env var names to uppercase (handles case-insensitive workflow files)
  normalizeEnv();

  const timer = new Timer();
  let activityTimeout: ActivityTimeout | null = null;

  // parse prompt early to extract progressCommentId for toolState
  const resolvedPromptInput = resolvePromptInput();

  const toolState = initToolState({
    progressCommentId:
      typeof resolvedPromptInput !== "string" ? resolvedPromptInput.progressCommentId : undefined,
  });

  setupExitHandler(toolState);

  await using tokenRef = await resolveInstallationToken();

  const octokit = createOctokit(tokenRef.token);
  const runContext = await resolveRunContextData({ octokit, token: tokenRef.token });
  timer.checkpoint("runContextData");

  const runInfo = await resolveRun({ octokit });

  try {
    // resolve payload after runContextData so permissions can use DB settings
    // precedence: action inputs > json payload > repoSettings > fallbacks
    const payload = resolvePayload(resolvedPromptInput, runContext.repoSettings);
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
      githubJobToken: tokenRef.githubJobToken,
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

    // run agent, optionally with timeout enforcement
    activityTimeout = createProcessOutputActivityTimeout({
      timeoutMs: DEFAULT_ACTIVITY_TIMEOUT_MS,
      checkIntervalMs: DEFAULT_ACTIVITY_CHECK_INTERVAL_MS,
    });
    activityTimeout.promise.catch(() => {}); // prevent unhandled rejection if agent wins race
    const agentPromise = agent.run({
      payload,
      mcpServerUrl: mcpHttpServer.url,
      tmpdir,
      instructions,
    });

    // timeout enforcement: default is 1 hour, but can be overridden via macros in the prompt:
    // - #timeout2h (or any duration like "#timeout30m", "#timeout1h30m") to set a custom timeout
    // - #notimeout to disable timeout entirely
    let result: Awaited<typeof agentPromise>;
    if (payload.timeout === TIMEOUT_DISABLED) {
      result = await Promise.race([agentPromise, activityTimeout.promise]);
    } else {
      const parsed = payload.timeout ? parseTimeString(payload.timeout) : null;
      if (payload.timeout && parsed === null) {
        log.warning(`invalid timeout format "${payload.timeout}", using default 1h`);
      }
      const timeoutMs = parsed ?? 3600000;
      const actualTimeout = parsed !== null ? payload.timeout : "1h";
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`agent run timed out after ${actualTimeout}`));
        }, timeoutMs);
      });
      timeoutPromise.catch(() => {}); // prevent unhandled rejection if agent wins race
      try {
        result = await Promise.race([agentPromise, timeoutPromise, activityTimeout.promise]);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // write last progress body to job summary
    if (toolState.lastProgressBody) {
      await writeSummary(toolState.lastProgressBody);
    }

    // emit structured output marker for test validation
    if (toolState.output) {
      log.info(`::pullfrog-output::${Buffer.from(toolState.output).toString("base64")}`);
    }

    return {
      ...handleAgentResult(result),
      result: toolState.output,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "unknown error occurred";
    killTrackedChildren();
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
  } finally {
    if (activityTimeout) {
      activityTimeout.stop();
    }
  }
}
