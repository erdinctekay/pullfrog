// changes to tool permissions should be reflected in wiki/granular-tools.md
import { initToolState, startMcpHttpServer, type ToolState } from "./mcp/server.ts";
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
import { formatUsageSummary, log, writeSummary } from "./utils/cli.ts";
import { reportErrorToComment } from "./utils/errorReport.ts";
import { resolveGit } from "./utils/gitAuth.ts";
import { createOctokit } from "./utils/github.ts";
import { resolveInstructions } from "./utils/instructions.ts";
import { executeLifecycleHook } from "./utils/lifecycle.ts";
import { normalizeEnv } from "./utils/normalizeEnv.ts";
import { resolvePayload, resolvePromptInput } from "./utils/payload.ts";
import { handleAgentResult } from "./utils/run.ts";
import { resolveRunContextData } from "./utils/runContextData.ts";
import { createTempDirectory, setupGit } from "./utils/setup.ts";
import { killTrackedChildren } from "./utils/subprocess.ts";
import { parseTimeString, TIMEOUT_DISABLED } from "./utils/time.ts";
import { Timer } from "./utils/timer.ts";
import { getJobToken, resolveTokens } from "./utils/token.ts";
import { resolveRun } from "./utils/workflow.ts";

export { Inputs } from "./utils/payload.ts";

export interface MainResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  result?: string | undefined;
}

async function writeJobSummary(toolState: ToolState): Promise<void> {
  const usageSummary = formatUsageSummary(toolState.usageEntries);
  const summaryParts = [toolState.lastProgressBody, usageSummary].filter(Boolean);
  if (summaryParts.length > 0) {
    await writeSummary(summaryParts.join("\n\n"));
  }
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

  // resolve and fingerprint git binary before any agent code runs
  resolveGit();

  // get job token for initial API calls
  const jobToken = getJobToken();
  const initialOctokit = createOctokit(jobToken);
  const runContext = await resolveRunContextData({ octokit: initialOctokit, token: jobToken });
  timer.checkpoint("runContextData");

  // resolve payload to determine shell permission
  const payload = resolvePayload(resolvedPromptInput, runContext.repoSettings);

  // resolve tokens:
  // - gitToken: contents permission based on push setting (assumed exfiltratable)
  // - mcpToken: full installation token (not exfiltratable via MCP tools)
  await using tokenRef = await resolveTokens({ push: payload.push });

  // clear OIDC env vars in restricted mode to prevent agent from minting tokens
  if (payload.shell !== "enabled") {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  }

  // create octokit with MCP token for GitHub API calls
  const octokit = createOctokit(tokenRef.mcpToken);

  const runInfo = await resolveRun({ octokit });

  try {
    // enable debug logging if --debug flag was used
    if (payload.debug) {
      process.env.LOG_LEVEL = "debug";
      log.info("» debug mode enabled via --debug flag");
    }

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
      gitToken: tokenRef.gitToken,
      owner: runContext.repo.owner,
      name: runContext.repo.name,
      event: payload.event,
      octokit,
      toolState,
      shell: payload.shell,
      postCheckoutScript: runContext.repoSettings.postCheckoutScript,
    });
    timer.checkpoint("git");

    // execute setup lifecycle hook (runs once at initialization)
    await executeLifecycleHook({
      event: "setup",
      script: runContext.repoSettings.setupScript,
    });
    timer.checkpoint("lifecycleHooks::setup");

    const modes = [...computeModes(), ...runContext.repoSettings.modes];

    // mcpServerUrl and tmpdir are set after server starts — delegate tool reads them at call time
    const toolContext = {
      repo: runContext.repo,
      payload,
      octokit,
      githubInstallationToken: tokenRef.mcpToken,
      gitToken: tokenRef.gitToken,
      apiToken: runContext.apiToken,
      agent,
      modes,
      postCheckoutScript: runContext.repoSettings.postCheckoutScript,
      toolState,
      runId: runInfo.runId,
      jobId: runInfo.jobId,
      mcpServerUrl: "",
      tmpdir,
    };
    await using mcpHttpServer = await startMcpHttpServer(toolContext);
    toolContext.mcpServerUrl = mcpHttpServer.url;
    log.info(`» MCP server started at ${mcpHttpServer.url}`);
    timer.checkpoint("mcpServer");

    const instructions = resolveInstructions({
      payload,
      repo: runContext.repo,
      modes,
    });
    // log instructions as soon as they are fully resolved
    const logParts = [
      instructions.eventInstructions
        ? `EVENT-LEVEL INSTRUCTIONS:\n${instructions.eventInstructions}`
        : null,
      instructions.user ? `USER REQUEST:\n${instructions.user}` : null,
      instructions.event,
    ].filter(Boolean);
    log.box(logParts.join("\n\n---\n\n"), {
      title: "Instructions",
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

    // timeout enforcement: default is 1 hour, but can be overridden via flags in the prompt:
    // - --timeout=2h (or any duration like "--timeout=30m", "--timeout=1h30m") to set a custom timeout
    // - --notimeout to disable timeout entirely
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

    // accumulate top-level agent usage
    if (result.usage) {
      toolState.usageEntries.push(result.usage);
    }

    await writeJobSummary(toolState);

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

    // best-effort summary — don't mask the original error
    try {
      await writeJobSummary(toolState);
    } catch {}

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
    activityTimeout?.stop();
  }
}
