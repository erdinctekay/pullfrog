// changes to tool permissions should be reflected in wiki/granular-tools.md

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as core from "@actions/core";
import { deleteProgressComment, reportProgress } from "./mcp/comment.ts";
import { startInstallation } from "./mcp/dependencies.ts";
import {
  initToolState,
  startMcpHttpServer,
  type ToolContext,
  type ToolState,
} from "./mcp/server.ts";
import { computeModes } from "./modes.ts";
import {
  type ActivityTimeout,
  createProcessOutputActivityTimeout,
  DEFAULT_ACTIVITY_CHECK_INTERVAL_MS,
  DEFAULT_ACTIVITY_TIMEOUT_MS,
} from "./utils/activity.ts";
import { resolveAgent, resolveModel } from "./utils/agent.ts";
import { apiFetch } from "./utils/apiFetch.ts";
import { validateAgentApiKey } from "./utils/apiKeys.ts";
import { resolveBody } from "./utils/body.ts";
import { formatUsageSummary, log, writeSummary } from "./utils/cli.ts";
import { recordDiffReadFromToolUse } from "./utils/diffCoverage.ts";
import { reportErrorToComment } from "./utils/errorReport.ts";
import { onExitSignal } from "./utils/exitHandler.ts";
import { resolveGit, setGitAuthServer } from "./utils/gitAuth.ts";
import { startGitAuthServer } from "./utils/gitAuthServer.ts";
import { createOctokit, writeGitHubUsageSummaryToFile } from "./utils/github.ts";
import { resolveInstructions } from "./utils/instructions.ts";
import { executeLifecycleHook } from "./utils/lifecycle.ts";
import { normalizeEnv } from "./utils/normalizeEnv.ts";
import { aggregateUsage, patchWorkflowRunFields } from "./utils/patchWorkflowRunFields.ts";
import { resolvePayload, resolvePromptInput } from "./utils/payload.ts";
import { postReviewCleanup } from "./utils/reviewCleanup.ts";
import { handleAgentResult } from "./utils/run.ts";
import { resolveRunContextData } from "./utils/runContextData.ts";
import { setEnvAllowlist } from "./utils/secrets.ts";
import { createTempDirectory, setupGit } from "./utils/setup.ts";
import { killTrackedChildren } from "./utils/subprocess.ts";
import { resolveTimeoutMs, TIMEOUT_DISABLED } from "./utils/time.ts";
import { Timer } from "./utils/timer.ts";
import { createTodoTracker } from "./utils/todoTracking.ts";
import { getJobToken, resolveTokens } from "./utils/token.ts";
import { resolveRun } from "./utils/workflow.ts";

export { Inputs } from "./utils/payload.ts";

export interface MainResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  result?: string | undefined;
}

function resolveOutputSchema(): Record<string, unknown> | undefined {
  const raw = core.getInput("output_schema");
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid output_schema: not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid output_schema: must be a JSON object`);
  }
  log.info("» structured output schema provided — output will be required");
  return parsed as Record<string, unknown>;
}

function resolveTimeoutForLog(timeout: string | undefined): string {
  if (!timeout) return "1h (default)";
  if (timeout === TIMEOUT_DISABLED) return "none (disabled)";
  return timeout;
}

function resolveModelForLog(ctx: {
  payload: ResolvedPayload;
  resolvedModel: string | undefined;
}): string {
  const envModel = process.env.PULLFROG_MODEL?.trim();
  if (envModel) return `${envModel} (override via PULLFROG_MODEL)`;
  if (ctx.payload.proxyModel) return `${ctx.payload.proxyModel} (proxy)`;
  if (ctx.resolvedModel && ctx.payload.model && ctx.payload.model !== ctx.resolvedModel) {
    return `${ctx.resolvedModel} (resolved from ${ctx.payload.model})`;
  }
  if (ctx.resolvedModel) return ctx.resolvedModel;
  if (ctx.payload.model) return `${ctx.payload.model} (unresolved)`;
  return "auto";
}

function resolveAgentForLog(ctx: { agentName: string; resolvedModel: string | undefined }): string {
  const envAgent = process.env.PULLFROG_AGENT?.trim();
  if (envAgent && envAgent === ctx.agentName) {
    return `${ctx.agentName} (override via PULLFROG_AGENT)`;
  }
  if (ctx.agentName === "claude" && ctx.resolvedModel) {
    return `${ctx.agentName} (auto-selected for ${ctx.resolvedModel})`;
  }
  return ctx.agentName;
}

import type { ResolvedPayload } from "./utils/payload.ts";

interface OidcCredentials {
  requestUrl: string;
  requestToken: string;
}

async function mintProxyKey(ctx: { oidcCredentials: OidcCredentials }): Promise<string | null> {
  try {
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = ctx.oidcCredentials.requestUrl;
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = ctx.oidcCredentials.requestToken;
    const oidcToken = await core.getIDToken("pullfrog-api");
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

    const response = await apiFetch({
      path: "/api/proxy-token",
      method: "POST",
      headers: { Authorization: `Bearer ${oidcToken}` },
    });

    if (!response.ok) {
      log.warning(`proxy key mint failed (${response.status})`);
      return null;
    }

    const data = (await response.json()) as { key: string };
    return data.key;
  } catch (error) {
    log.warning(`proxy key mint error: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  }
}

async function resolveProxyModel(ctx: {
  payload: ResolvedPayload;
  oss: boolean;
  proxyModel?: string | undefined;
  oidcCredentials: OidcCredentials | null;
}): Promise<void> {
  // env override = BYOK escape hatch, don't proxy
  if (process.env.PULLFROG_MODEL?.trim()) return;

  // OSS: server decided the model
  if (ctx.oss && ctx.proxyModel) {
    if (!ctx.oidcCredentials) {
      log.warning("» oss repo but no OIDC credentials available — skipping proxy");
      return;
    }
    const key = await mintProxyKey({ oidcCredentials: ctx.oidcCredentials });
    if (!key) return;

    process.env.OPENROUTER_API_KEY = key;
    core.setSecret(key);
    ctx.payload.proxyModel = ctx.proxyModel;
    log.info(`» proxy: oss → ${ctx.proxyModel}`);
    return;
  }

  // managed billing will add its path here later
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

  // write usage summary on SIGINT/SIGTERM so the worker can read it after sandbox.exec
  const usageSummaryPath = process.env.PULLFROG_USAGE_SUMMARY_PATH;
  if (usageSummaryPath) {
    onExitSignal(() => writeGitHubUsageSummaryToFile(usageSummaryPath));
  }

  const timer = new Timer();
  let activityTimeout: ActivityTimeout | null = null;
  let safetyNetTimer: NodeJS.Timeout | undefined;

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

  // inject account-level secrets into process.env (YAML secrets take precedence)
  if (runContext.dbSecrets) {
    for (const [key, value] of Object.entries(runContext.dbSecrets)) {
      if (!process.env[key]) {
        process.env[key] = value;
        core.setSecret(value);
      }
    }
    const count = Object.keys(runContext.dbSecrets).length;
    if (count > 0) log.info(`» ${count} db secret(s) loaded`);
  }

  // configure env allowlist for subprocess filtering
  if (runContext.repoSettings.envAllowlist) {
    setEnvAllowlist(runContext.repoSettings.envAllowlist);
  }

  // resolve payload to determine shell permission
  const payload = resolvePayload(resolvedPromptInput, runContext.repoSettings);
  toolState.model = payload.model;
  if (payload.event.trigger === "pull_request_synchronize") {
    toolState.beforeSha = payload.event.before_sha;
  }

  // resolve tokens first — acquireNewToken needs OIDC env vars for token exchange
  await using tokenRef = await resolveTokens({ push: payload.push });

  // stash OIDC credentials in memory before wiping from process.env
  // the agent's shell commands can't access JS variables, so this is safe
  const oidcCredentials: OidcCredentials | null =
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
      ? {
          requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
          requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
        }
      : null;

  // clear OIDC env vars in restricted mode to prevent agent from minting tokens
  if (payload.shell !== "enabled") {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  }

  // proxy decision: mint an OpenRouter key for OSS repos (or later, managed billing)
  await resolveProxyModel({
    payload,
    oss: runContext.oss,
    proxyModel: runContext.proxyModel,
    oidcCredentials,
  });

  // create octokit with MCP token for GitHub API calls
  const octokit = createOctokit(tokenRef.mcpToken);

  const runInfo = await resolveRun({ octokit });
  let toolContext: ToolContext | undefined;
  let progressCallbackDisabled = false;
  let todoTracker: ReturnType<typeof createTodoTracker> | undefined;

  try {
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

    await using gitAuthServer = await startGitAuthServer(tmpdir);
    setGitAuthServer(gitAuthServer);

    const resolvedModel = payload.proxyModel ? undefined : resolveModel({ slug: payload.model });
    const agent = resolveAgent({ model: resolvedModel });

    validateAgentApiKey({
      agent,
      model: payload.proxyModel ?? resolvedModel ?? payload.model,
      owner: runContext.repo.owner,
      name: runContext.repo.name,
    });

    await setupGit({
      gitToken: tokenRef.gitToken,
      owner: runContext.repo.owner,
      name: runContext.repo.name,
      octokit,
      toolState,
      shell: payload.shell,
      postCheckoutScript: runContext.repoSettings.postCheckoutScript,
    });
    timer.checkpoint("git");

    // execute setup lifecycle hook (runs once at initialization).
    // setup is load-bearing — if it fails the rest of the run is in an
    // undefined state, so upgrade the soft-fail warning to a hard error.
    const setupHook = await executeLifecycleHook({
      event: "setup",
      script: runContext.repoSettings.setupScript,
    });
    if (setupHook.warning) {
      throw new Error(setupHook.warning);
    }
    timer.checkpoint("lifecycleHooks::setup");

    const agentId = agent.name;
    const modes = [...computeModes(agentId), ...runContext.repoSettings.modes];

    const outputSchema = resolveOutputSchema();

    // mcpServerUrl and tmpdir are set after server starts
    toolContext = {
      agentId,
      repo: runContext.repo,
      payload,
      octokit,
      githubInstallationToken: tokenRef.mcpToken,
      gitToken: tokenRef.gitToken,
      apiToken: runContext.apiToken,
      modes,
      postCheckoutScript: runContext.repoSettings.postCheckoutScript,
      prepushScript: runContext.repoSettings.prepushScript,
      prApproveEnabled: runContext.repoSettings.prApproveEnabled,
      modeInstructions: runContext.repoSettings.modeInstructions,
      toolState,
      runId: runInfo.runId,
      jobId: runInfo.jobId,
      mcpServerUrl: "",
      tmpdir,
      resolvedModel,
    };
    await using mcpHttpServer = await startMcpHttpServer(toolContext, { outputSchema });
    toolContext.mcpServerUrl = mcpHttpServer.url;
    log.info(`» MCP server started at ${mcpHttpServer.url}`);
    timer.checkpoint("mcpServer");

    startInstallation(toolContext);

    const modelForLog = resolveModelForLog({ payload, resolvedModel });
    const agentForLog = resolveAgentForLog({ agentName: agent.name, resolvedModel });
    const timeoutForLog = resolveTimeoutForLog(payload.timeout);
    log.info(`» model:   ${modelForLog}`);
    log.info(`» agent:   ${agentForLog}`);
    log.info(`» push:    ${payload.push}`);
    log.info(`» shell:   ${payload.shell}`);
    log.info(`» timeout: ${timeoutForLog}`);

    const instructions = resolveInstructions({
      payload,
      repo: runContext.repo,
      modes,
      agentId,
      outputSchema,
      learnings: runContext.repoSettings.learnings,
    });
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
    log.group("View full prompt", () => {
      log.info(instructions.full);
    });

    // OpenCode loads .opencode/plugin/ files at startup. if the repo has any,
    // eagerly await dependency installation so plugin imports can resolve.
    if (agentId === "opencode") {
      const pluginDir = join(process.cwd(), ".opencode", "plugin");
      const hasPlugins =
        existsSync(pluginDir) && readdirSync(pluginDir).some((f) => /\.[jt]sx?$/.test(f));
      if (hasPlugins && toolState.dependencyInstallation?.promise) {
        log.info(
          "» .opencode/plugin/ detected — awaiting dependency installation before agent start"
        );
        await toolState.dependencyInstallation.promise.catch(() => {});
        timer.checkpoint("awaitDepsForPlugins");
      }
    }

    // run agent, optionally with timeout enforcement
    activityTimeout = createProcessOutputActivityTimeout({
      timeoutMs: DEFAULT_ACTIVITY_TIMEOUT_MS,
      checkIntervalMs: DEFAULT_ACTIVITY_CHECK_INTERVAL_MS,
    });
    activityTimeout.promise.catch(() => {}); // prevent unhandled rejection if agent wins race
    todoTracker = createTodoTracker(async (body) => {
      if (progressCallbackDisabled || !toolContext) return;
      try {
        await reportProgress(toolContext, { body });
      } catch (err) {
        log.debug(`progress update failed: ${err}`);
      }
    });
    toolState.todoTracker = todoTracker;

    // when the agent subprocess is killed for inner activity timeout, stop
    // the MCP HTTP server so mcp-proxy's SSE reconnect attempts don't keep
    // the outer activity timer alive. start a short safety-net timer — if
    // the agent promise hasn't resolved within 5min after the inner kill,
    // force-reject the outer timer so the run can exit.
    let innerTimeoutFired = false;
    const onInnerActivityTimeout = () => {
      if (innerTimeoutFired) return;
      innerTimeoutFired = true;
      log.info(
        "» inner activity timeout fired — stopping MCP server and starting 5min safety-net timer"
      );
      // fire and forget — the server's dispose is idempotent so the
      // `await using` cleanup at block exit is still safe.
      mcpHttpServer[Symbol.asyncDispose]().catch((err) => {
        log.debug(
          `mcp server stop after inner kill failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      safetyNetTimer = setTimeout(
        () => {
          activityTimeout?.forceReject(
            "agent still pending 5min after inner activity kill — forcing exit"
          );
        },
        5 * 60 * 1000
      );
      safetyNetTimer.unref?.();
    };

    const agentPromise = agent.run({
      payload,
      resolvedModel,
      mcpServerUrl: mcpHttpServer.url,
      tmpdir,
      instructions,
      todoTracker,
      stopScript: runContext.repoSettings.stopScript,
      onActivityTimeout: onInnerActivityTimeout,
      onToolUse: (event) => {
        const wasTracked = recordDiffReadFromToolUse({
          state: toolState.diffCoverage,
          toolName: event.toolName,
          input: event.input,
          cwd: process.cwd(),
        });
        if (!wasTracked) return;
        const trackedRanges = toolState.diffCoverage?.coveredRanges ?? [];
        log.debug(
          `» diff coverage tracked from tool ${event.toolName} (${trackedRanges.length} merged range${trackedRanges.length === 1 ? "" : "s"})`
        );
      },
    });
    // symmetric with the activityTimeout/timeoutPromise catches below: if a
    // timeout wins the race, agentPromise is stranded and its later rejection
    // becomes an unhandled rejection. node 15+ terminates the process on
    // unhandled rejection by default, which would kill main() mid-cleanup and
    // lose the error-reporting / usage-summary work that follows. the race
    // still sees the rejection (the original promise is shared); this catch
    // only keeps node from treating a post-race rejection as unobserved.
    agentPromise.catch(() => {});

    // timeout enforcement: default is 1 hour, but can be overridden via flags in the prompt:
    // - --timeout=2h (or any duration like "--timeout=30m", "--timeout=1h30m") to set a custom timeout
    // - --notimeout to disable timeout entirely
    let result: Awaited<typeof agentPromise>;
    if (payload.timeout === TIMEOUT_DISABLED) {
      result = await Promise.race([agentPromise, activityTimeout.promise]);
    } else {
      // resolveTimeoutMs rejects unparseable / zero / setTimeout-overflow inputs
      // so a bad string can't silently resolve to an instant timeout. fall back
      // to the 1h default with a warning — users who want runtime measured in
      // weeks should use --notimeout.
      const usable = resolveTimeoutMs(payload.timeout);
      if (payload.timeout && usable === null) {
        log.warning(`invalid timeout "${payload.timeout}" (use --notimeout to disable), using 1h`);
      }
      const timeoutMs = usable ?? 3600000;
      const actualTimeout = usable !== null ? payload.timeout : "1h";
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

    // validate this before writing job summary to avoid masking the error
    if (outputSchema && !toolState.output) {
      throw new Error(
        "output_schema was provided but agent did not call set_output — structured output is required"
      );
    }

    // post-agent review cleanup: reportReviewNodeId → follow-up re-review dispatch.
    // runs after the agent exits so ordering is architecturally guaranteed (no LLM involvement).
    // best-effort: cleanup failures must not turn a successful agent run into a failure.
    if (toolContext) {
      await postReviewCleanup(toolContext).catch((error) => {
        log.debug(`post-review cleanup failed: ${error}`);
      });
    }

    // review submitted → always delete the progress comment.
    // the review is the durable artifact; the progress comment is noise.
    // defense-in-depth: covers the case where the agent calls report_progress
    // despite mode instructions, which sets finalSummaryWritten and prevents
    // the stranded-comment heuristic below from firing.
    if (toolContext && toolState.review && toolState.progressCommentId) {
      await deleteProgressComment(toolContext).catch((error) => {
        log.debug(`review progress comment cleanup failed: ${error}`);
      });
    }

    // clean up stranded progress comments. two cases:
    // 1. wasUpdated=false: nothing wrote to the comment ("Leaping into action" orphan)
    // 2. tracker published a checklist but the agent never wrote a final summary
    //    (hasPublished=true, finalSummaryWritten=false).
    // in both cases, delete the comment so it doesn't linger with stale content.
    // wasUpdated is intentionally NOT set here — cleanup is not a real progress update.
    // uses finalSummaryWritten (not todoTracker.enabled) so cleanup survives API failures
    // in report_progress where cancel() ran but the write didn't succeed.
    const trackerWasLastWriter = todoTracker?.hasPublished && !toolState.finalSummaryWritten;
    if (
      toolContext &&
      toolState.progressCommentId &&
      (!toolState.wasUpdated || trackerWasLastWriter)
    ) {
      await deleteProgressComment(toolContext).catch((error) => {
        log.debug(`stranded progress comment cleanup failed: ${error}`);
      });
    }

    await writeJobSummary(toolState);

    // emit structured output marker for test validation
    if (toolState.output) {
      log.info(`::pullfrog-output::${Buffer.from(toolState.output).toString("base64")}`);
      core.setOutput("result", toolState.output);
    }

    return await handleAgentResult({
      result,
      toolState,
      silent: payload.event.silent ?? false,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "unknown error occurred";
    progressCallbackDisabled = true;
    todoTracker?.cancel();
    killTrackedChildren();
    log.error(errorMessage);

    // best-effort summary — write the error so it's visible in the Actions summary tab
    try {
      const errorSummary = `### ❌ Pullfrog failed\n\n\`\`\`\n${errorMessage}\n\`\`\``;
      const usageSummary = formatUsageSummary(toolState.usageEntries);
      const parts = [errorSummary, toolState.lastProgressBody, usageSummary].filter(Boolean);
      await writeSummary(parts.join("\n\n"));
    } catch {}

    try {
      await reportErrorToComment({ toolState, error: errorMessage });
    } catch {
      // error reporting failed, but don't let it mask the original error
    }

    // best-effort review cleanup (e.g., agent timed out after submitting a review)
    if (toolContext) {
      await postReviewCleanup(toolContext).catch((error) => {
        log.debug(`post-review cleanup failed: ${error}`);
      });
    }

    return {
      success: false,
      error: errorMessage,
    };
  } finally {
    activityTimeout?.stop();
    if (safetyNetTimer) clearTimeout(safetyNetTimer);
    if (usageSummaryPath) {
      // a write error here (ENOSPC, EACCES, dirname removed) must not mask
      // either the try's successful return or the catch's error return.
      // the summary is informational — log and move on.
      try {
        await writeGitHubUsageSummaryToFile(usageSummaryPath);
      } catch (err) {
        log.debug(
          `failed to write usage summary to ${usageSummaryPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // persist aggregated token + cost usage to the WorkflowRun row.
    // this is the single shared cleanup path across every agent implementation:
    // each agent harness returns a single AgentUsage from agent.run() that
    // already aggregates its internal retries via mergeAgentUsage, and the
    // success branch above pushes that entry into toolState.usageEntries.
    // aggregateUsage sums across those entries (one per agent.run()).
    //
    // caveat: if the agent promise rejected (timeout or uncaught throw) the
    // usage was never pushed, so nothing gets persisted for that run. runs
    // that returned AgentResult with success=false still report their partial
    // usage because the harness populates AgentUsage before returning.
    if (toolContext) {
      const patch = aggregateUsage(toolState.usageEntries);
      if (Object.keys(patch).length > 0) {
        await patchWorkflowRunFields(toolContext, patch);
      }
    }
  }
}
