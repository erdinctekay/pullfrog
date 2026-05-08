/**
 * Claude Code agent — secure harness around the `claude` CLI.
 *
 * mirrors the opencode harness's security model:
 * - native Bash blocked via --disallowedTools (agent cannot shell out)
 * - managed-settings.json: filesystem sandbox — deny /proc, /sys reads
 * - MCP ShellTool provides restricted shell (filtered env, no secrets)
 * - MCP server injected via --mcp-config (not replacing project config)
 * - ASKPASS handles git auth separately (token never in subprocess env)
 *
 * the agent process itself gets full env (needs LLM API keys, PATH, etc.).
 * security is enforced at the tool layer, not the process layer.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pullfrogMcpName } from "../external.ts";

import { getIdleMs, markActivity } from "../utils/activity.ts";
import { log } from "../utils/cli.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import { detectProviderError } from "../utils/providerErrors.ts";
import { addSkill, installBundledSkills } from "../utils/skills.ts";
import { SPAWN_ACTIVITY_TIMEOUT_CODE, SpawnTimeoutError, spawn } from "../utils/subprocess.ts";
import { ThinkingTimer } from "../utils/timer.ts";
import type { TodoTracker } from "../utils/todoTracking.ts";
import { getDevDependencyVersion } from "../utils/version.ts";
import { buildLearningsReflectionPrompt, runPostRunRetryLoop } from "./postRun.ts";
import { REVIEWER_AGENT_NAME, REVIEWER_SYSTEM_PROMPT } from "./reviewer.ts";
import { deriveLabelFromTaskInput } from "./sessionLabeler.ts";
import {
  type AgentResult,
  type AgentRunContext,
  type AgentUsage,
  agent,
  logTokenTable,
  MAX_STDERR_LINES,
} from "./shared.ts";

async function installClaudeCli(): Promise<string> {
  return await installFromNpmTarball({
    packageName: "@anthropic-ai/claude-code",
    version: getDevDependencyVersion("@anthropic-ai/claude-code"),
    executablePath: "cli.js",
    installDependencies: false,
  });
}

// ── config ─────────────────────────────────────────────────────────────────────

function writeMcpConfig(ctx: AgentRunContext): string {
  const configDir = join(ctx.tmpdir, ".claude");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "mcp.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        [pullfrogMcpName]: { type: "http", url: ctx.mcpServerUrl },
      },
    })
  );
  return configPath;
}

/**
 * Build the `--agents` JSON definition for the `reviewfrog` subagent.
 * The non-mutative + non-recursive contract is enforced by the prose system
 * prompt baked into the agent — see action/agents/reviewer.ts for why we no
 * longer wire per-agent `disallowedTools` here.
 */
function buildAgentsJson(): string {
  const agents = {
    [REVIEWER_AGENT_NAME]: {
      description:
        "Read-only review subagent for self-review and lens-based code review. " +
        "Reads only — no writes, no state-changing shell or MCP calls, no nested subagent dispatch.",
      prompt: REVIEWER_SYSTEM_PROMPT,
    },
  };
  return JSON.stringify(agents);
}

// ── model helpers ─────────────────────────────────────────────────────────────

// claude CLI expects bare model names (e.g. "claude-sonnet-4-6"), not provider-prefixed specifiers
function stripProviderPrefix(specifier: string): string {
  const slashIndex = specifier.indexOf("/");
  return slashIndex > 0 ? specifier.slice(slashIndex + 1) : specifier;
}

// `max` effort is supported on Opus 4.6 / 4.7; other models fall back to `high`.
// claude-code deny-lists older opus/sonnet generations from `max` at invocation time.
function resolveEffort(model: string | undefined): "max" | "high" {
  if (model?.includes("opus")) return "max";
  return "high";
}

// ── NDJSON event types ─────────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

interface ClaudeSystemEvent {
  type: "system";
  [key: string]: unknown;
}

interface ClaudeAssistantEvent {
  type: "assistant";
  message?: {
    role?: string;
    content?: ContentBlock[];
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ClaudeUserEvent {
  type: "user";
  message?: {
    role?: string;
    content?: ContentBlock[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ClaudeResultEvent {
  type: "result";
  subtype?: string;
  result?: string;
  session_id?: string;
  num_turns?: number;
  total_cost_usd?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  [key: string]: unknown;
}

// additional event types emitted by Claude CLI (handled as no-ops / debug)
interface ClaudeStreamEvent {
  type: "stream_event";
  [key: string]: unknown;
}
interface ClaudeToolProgressEvent {
  type: "tool_progress";
  [key: string]: unknown;
}
interface ClaudeToolUseSummaryEvent {
  type: "tool_use_summary";
  [key: string]: unknown;
}
interface ClaudeAuthStatusEvent {
  type: "auth_status";
  [key: string]: unknown;
}

type ClaudeEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent
  | ClaudeStreamEvent
  | ClaudeToolProgressEvent
  | ClaudeToolUseSummaryEvent
  | ClaudeAuthStatusEvent;

// ── runner ──────────────────────────────────────────────────────────────────────

type RunParams = {
  label: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  todoTracker?: TodoTracker | undefined;
  onActivityTimeout?: (() => void) | undefined;
  onToolUse?: ((event: { toolName: string; input: unknown }) => void) | undefined;
};

type ClaudeRunResult = AgentResult & { sessionId?: string | undefined };

async function runClaude(params: RunParams): Promise<ClaudeRunResult> {
  const startTime = performance.now();
  let eventCount = 0;
  const thinkingTimer = new ThinkingTimer();

  let finalOutput = "";
  let sessionId: string | undefined;
  let resultErrorSubtype: string | null = null;
  let accumulatedTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // Claude CLI reports a single end-of-run `total_cost_usd` on the result
  // event. per-message events don't carry cost, so there's nothing to sum —
  // we just capture the final value when it arrives.
  let accumulatedCostUsd = 0;
  let tokensLogged = false;

  function buildUsage(): AgentUsage | undefined {
    const totalInput =
      accumulatedTokens.input + accumulatedTokens.cacheRead + accumulatedTokens.cacheWrite;
    return totalInput > 0 || accumulatedTokens.output > 0
      ? {
          agent: "claude",
          inputTokens: totalInput,
          outputTokens: accumulatedTokens.output,
          cacheReadTokens: accumulatedTokens.cacheRead || undefined,
          cacheWriteTokens: accumulatedTokens.cacheWrite || undefined,
          costUsd: accumulatedCostUsd > 0 ? accumulatedCostUsd : undefined,
        }
      : undefined;
  }

  const handlers = {
    system: (_event: ClaudeSystemEvent) => {
      log.debug(`» ${params.label} system event`);
    },
    assistant: (event: ClaudeAssistantEvent) => {
      const content = event.message?.content;
      if (!content) return;

      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          const message = block.text.trim();
          log.box(message, { title: params.label });
          finalOutput = message;
        } else if (block.type === "tool_use") {
          const toolName = block.name || "unknown";
          if (params.onToolUse) {
            params.onToolUse({
              toolName,
              input: block.input,
            });
          }
          thinkingTimer.markToolCall();
          log.toolCall({ toolName, input: block.input || {} });

          // surface the subagent identity when the orchestrator dispatches a
          // Task — claude rolls subagent activity up into a single tool_result
          // (no per-event session_id in its stream), so this log line is the
          // only attribution available before the subagent's report-back.
          if (toolName === "Task" && block.input && typeof block.input === "object") {
            const taskInput = block.input as {
              description?: string;
              subagent_type?: string;
              prompt?: string;
            };
            const label = deriveLabelFromTaskInput(taskInput);
            log.info(
              `» dispatching subagent: ${label}` +
                (taskInput.subagent_type ? ` (subagent_type=${taskInput.subagent_type})` : "")
            );
          }

          // agent's explicit MCP report_progress takes priority over todo tracking
          if (toolName.includes("report_progress") && params.todoTracker) {
            log.debug("» report_progress detected, disabling todo tracking");
            params.todoTracker.cancel();
          }

          // parse TodoWrite events for live progress tracking
          if (toolName === "TodoWrite" && params.todoTracker?.enabled) {
            params.todoTracker.update(block.input);
          }
        }
      }

      // accumulate per-message usage if available. capture cache fields too
      // so the fallback token table (used when no final `result` event fires)
      // still reports the full breakdown instead of silently dropping cache.
      const msgUsage = event.message?.usage;
      if (msgUsage) {
        accumulatedTokens.input += msgUsage.input_tokens || 0;
        accumulatedTokens.output += msgUsage.output_tokens || 0;
        accumulatedTokens.cacheRead += msgUsage.cache_read_input_tokens || 0;
        accumulatedTokens.cacheWrite += msgUsage.cache_creation_input_tokens || 0;
      }
    },
    user: (event: ClaudeUserEvent) => {
      const content = event.message?.content;
      if (!content) return;

      for (const block of content) {
        if (typeof block === "string") continue;
        if (block.type === "tool_result") {
          thinkingTimer.markToolResult();

          const outputContent =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? (block.content as unknown[])
                    .map((entry: unknown) =>
                      typeof entry === "string"
                        ? entry
                        : typeof entry === "object" && entry !== null && "text" in entry
                          ? String((entry as { text: unknown }).text)
                          : JSON.stringify(entry)
                    )
                    .join("\n")
                : String(block.content);

          if (block.is_error) {
            log.info(`» tool error: ${outputContent}`);
          } else {
            log.debug(`» tool output: ${outputContent}`);
          }
        }
      }
    },
    result: (event: ClaudeResultEvent) => {
      if (event.session_id) sessionId = event.session_id;
      const subtype = event.subtype || "unknown";
      const numTurns = event.num_turns || 0;

      if (subtype === "success") {
        // extract detailed usage from result event (most accurate source).
        // note: `input` here is non-cached input tokens only, matching the
        // semantics of OpenCode's step_finish.tokens.input — the logTokenTable
        // helper sums Input + Cache Read + Cache Write + Output into the Total
        // column so consumers get the real billable figure.
        const usage = event.usage;
        const inputTokens = usage?.input_tokens || 0;
        const cacheRead = usage?.cache_read_input_tokens || 0;
        const cacheWrite = usage?.cache_creation_input_tokens || 0;
        const outputTokens = usage?.output_tokens || 0;
        // guard against NaN/Infinity from malformed CLI output poisoning the total
        const costUsd =
          typeof event.total_cost_usd === "number" && Number.isFinite(event.total_cost_usd)
            ? event.total_cost_usd
            : 0;

        accumulatedTokens = { input: inputTokens, output: outputTokens, cacheRead, cacheWrite };
        accumulatedCostUsd = costUsd;

        log.info(`» ${params.label} result: subtype=${subtype}, turns=${numTurns}`);

        if (!tokensLogged) {
          logTokenTable({
            input: inputTokens,
            cacheRead,
            cacheWrite,
            output: outputTokens,
            costUsd,
          });
          tokensLogged = true;
        }
      } else if (subtype === "error_max_turns") {
        resultErrorSubtype = subtype;
        log.info(`» ${params.label} max turns reached: ${JSON.stringify(event)}`);
      } else if (subtype === "error_during_execution") {
        resultErrorSubtype = subtype;
        log.info(`» ${params.label} execution error: ${JSON.stringify(event)}`);
      } else if (subtype.startsWith("error")) {
        resultErrorSubtype = subtype;
        log.info(`» ${params.label} result: subtype=${subtype}, data=${JSON.stringify(event)}`);
      } else {
        log.info(`» ${params.label} result: subtype=${subtype}, data=${JSON.stringify(event)}`);
      }

      if (event.result?.trim()) {
        finalOutput = event.result.trim();
      }
    },
    // additional Claude CLI event types — debug-logged only
    stream_event: () => {},
    tool_progress: () => {},
    tool_use_summary: () => {},
    auth_status: () => {},
  };

  const recentStderr: string[] = [];

  let lastProviderError: string | null = null;

  let output = "";
  let stdoutBuffer = "";

  try {
    const result = await spawn({
      cmd: "node",
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      activityTimeout: 300_000,
      onActivityTimeout: params.onActivityTimeout,
      stdio: ["ignore", "pipe", "pipe"],
      // run claude in its own process group so SIGKILL on activity timeout /
      // outer cancellation reaches any subprocesses it spawns (rg, file
      // watchers, mcp transports, etc). claude itself is a node bundle so
      // there's no shim-orphan issue like opencode-ai/bin/opencode, but
      // detached + killGroup is the right default for any agent runtime.
      killGroup: true,
      onStdout: async (chunk) => {
        const text = chunk.toString();
        output += text;
        markActivity();

        stdoutBuffer += text;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let event: ClaudeEvent;
          try {
            event = JSON.parse(trimmed) as ClaudeEvent;
          } catch {
            log.debug(`» non-JSON stdout line: ${trimmed.substring(0, 200)}`);
            continue;
          }

          eventCount++;
          log.debug(JSON.stringify(event, null, 2));

          const timeSinceLastActivity = getIdleMs();
          if (timeSinceLastActivity > 10000) {
            log.info(
              `» no activity for ${(timeSinceLastActivity / 1000).toFixed(1)}s (${params.label} may be processing internally) (${eventCount} events processed so far)`
            );
          }
          markActivity();

          const handler = handlers[event.type as keyof typeof handlers];
          if (!handler) {
            log.debug(`» ${params.label} event (unhandled): type=${event.type}`);
            continue;
          }
          try {
            (handler as (e: ClaudeEvent) => void)(event);
          } catch (err) {
            log.info(
              `» ${params.label} handler for type=${event.type} threw: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      },
      onStderr: (chunk) => {
        const trimmed = chunk.trim();
        if (!trimmed) return;

        recentStderr.push(trimmed);
        if (recentStderr.length > MAX_STDERR_LINES) recentStderr.shift();

        const providerError = detectProviderError(trimmed);
        if (providerError) {
          lastProviderError = providerError;
          log.info(`» provider error detected (${providerError}): ${trimmed.substring(0, 500)}`);
        } else {
          log.debug(trimmed);
        }
      },
    });

    if (result.exitCode === 0) {
      await params.todoTracker?.flush();
    } else {
      params.todoTracker?.cancel();
    }

    const duration = performance.now() - startTime;
    log.info(
      `» ${params.label} completed in ${Math.round(duration)}ms with exit code ${result.exitCode}`
    );

    if (eventCount === 0) {
      const stderrContext = recentStderr.join("\n");
      const diagnosis = lastProviderError
        ? `provider error: ${lastProviderError}`
        : "unknown cause (no stdout events received)";
      log.info(`» ${params.label} produced 0 events (${diagnosis})`);
      if (stderrContext) log.info(`» last stderr output:\n${stderrContext}`);
    }

    if (
      !tokensLogged &&
      (accumulatedTokens.input > 0 ||
        accumulatedTokens.output > 0 ||
        accumulatedTokens.cacheRead > 0 ||
        accumulatedTokens.cacheWrite > 0)
    ) {
      logTokenTable({ ...accumulatedTokens, costUsd: accumulatedCostUsd });
      tokensLogged = true;
    }

    const usage = buildUsage();

    if (result.exitCode !== 0) {
      const errorContext = lastProviderError ? ` (${lastProviderError})` : "";
      const errorMessage =
        result.stderr ||
        result.stdout ||
        `unknown error - no output from Claude CLI${errorContext}`;
      log.error(
        `${params.label} exited with code ${result.exitCode}${errorContext}: ${errorMessage}`
      );
      log.debug(`stdout: ${result.stdout?.substring(0, 500)}`);
      log.debug(`stderr: ${result.stderr?.substring(0, 500)}`);
      return {
        success: false,
        output: finalOutput || output,
        error: errorMessage,
        usage,
        sessionId,
      };
    }

    if (eventCount === 0 && lastProviderError) {
      return {
        success: false,
        output: finalOutput || output,
        error: `provider error: ${lastProviderError}`,
        usage,
        sessionId,
      };
    }

    if (resultErrorSubtype) {
      return {
        success: false,
        output: finalOutput || output,
        error: `result subtype: ${resultErrorSubtype}`,
        usage,
        sessionId,
      };
    }

    return { success: true, output: finalOutput || output, usage, sessionId };
  } catch (error) {
    params.todoTracker?.cancel();
    const duration = performance.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isActivityTimeout =
      error instanceof SpawnTimeoutError && error.code === SPAWN_ACTIVITY_TIMEOUT_CODE;

    const stderrContext = recentStderr.slice(-10).join("\n");
    const diagnosis = lastProviderError
      ? `likely cause: ${lastProviderError}`
      : eventCount === 0
        ? "Claude produced 0 stdout events - check if the API is reachable"
        : `${eventCount} events were processed before the hang`;

    log.info(
      `» ${params.label} ${isActivityTimeout ? "hung" : "failed"} after ${(duration / 1000).toFixed(1)}s: ${errorMessage}`
    );
    log.info(`» diagnosis: ${diagnosis}`);
    if (stderrContext)
      log.info(
        `» recent stderr (last ${Math.min(recentStderr.length, 10)} lines):\n${stderrContext}`
      );

    return {
      success: false,
      output: finalOutput || output,
      error: `${errorMessage} [${diagnosis}]`,
      usage: buildUsage(),
      sessionId,
    };
  }
}

// ── managed settings ────────────────────────────────────────────────────────────

const MANAGED_SETTINGS_DIR = "/etc/claude-code";
const MANAGED_SETTINGS_PATH = `${MANAGED_SETTINGS_DIR}/managed-settings.json`;

// managed-settings.json has absolute highest precedence in Claude Code's config hierarchy.
// it cannot be overridden by user, project, or local settings — safe against malicious PRs.
//
// permissions.deny blocks native tools (Read, Grep, Edit, Glob) from accessing /proc and /sys.
// sandbox.filesystem.denyRead blocks the Bash tool sandbox from reading those paths.
// allowManagedPermissionRulesOnly prevents malicious PRs from adding allow rules that override
// our deny rules — safe in CI because --dangerously-skip-permissions makes allow/ask irrelevant.
// allowManagedHooksOnly prevents malicious project hooks from bypassing deny rules.
const managedSettings = {
  allowManagedPermissionRulesOnly: true,
  allowManagedHooksOnly: true,
  permissions: {
    deny: [
      "Read(//proc/**)",
      "Read(//sys/**)",
      "Grep(//proc/**)",
      "Grep(//sys/**)",
      "Edit(//proc/**)",
      "Edit(//sys/**)",
      "Glob(//proc/**)",
      "Glob(//sys/**)",
    ],
  },
  sandbox: {
    filesystem: {
      denyRead: ["/proc", "/sys"],
    },
  },
};

function installManagedSettings(): void {
  if (process.env.CI !== "true") return;

  const content = JSON.stringify(managedSettings, null, 2);
  try {
    execFileSync("sudo", ["mkdir", "-p", MANAGED_SETTINGS_DIR]);
    execFileSync("sudo", ["tee", MANAGED_SETTINGS_PATH], {
      input: content,
      stdio: ["pipe", "ignore", "pipe"],
    });
    log.debug(`» wrote managed settings to ${MANAGED_SETTINGS_PATH}`);
  } catch (err) {
    log.warning(`» failed to install managed settings: ${err}`);
  }
}

// ── agent ───────────────────────────────────────────────────────────────────────

export const claude = agent({
  name: "claude",
  install: installClaudeCli,
  run: async (ctx) => {
    const cliPath = await installClaudeCli();

    const specifier = ctx.payload.proxyModel ?? ctx.resolvedModel;
    const model = specifier ? stripProviderPrefix(specifier) : undefined;

    const homeEnv = {
      HOME: ctx.tmpdir,
      XDG_CONFIG_HOME: join(ctx.tmpdir, ".config"),
    };

    mkdirSync(join(homeEnv.XDG_CONFIG_HOME, "claude"), { recursive: true });

    const agentBrowserVersion = getDevDependencyVersion("agent-browser");
    addSkill({
      ref: `vercel-labs/agent-browser@v${agentBrowserVersion}`,
      skill: "agent-browser",
      env: homeEnv,
      agent: "claude",
    });

    installBundledSkills({ home: homeEnv.HOME });

    const mcpConfigPath = writeMcpConfig(ctx);
    const effort = resolveEffort(model);

    installManagedSettings();

    // base args shared between initial run and continue runs
    const baseArgs = [
      cliPath,
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--mcp-config",
      mcpConfigPath,
      "--verbose",
      "--effort",
      effort,
      "--disallowedTools",
      "Bash,Agent(Bash)",
      "--agents",
      buildAgentsJson(),
    ];

    if (model) {
      baseArgs.push("--model", model);
    }

    // agent process gets full env — needs LLM API keys, PATH, locale, etc.
    // security is enforced via managed-settings.json, --disallowedTools (Bash), and MCP tool filtering.
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...homeEnv,
    };

    const repoDir = process.cwd();

    log.info(`» effort: ${effort}`);
    log.debug(`» starting Pullfrog (Claude Code): node ${baseArgs.join(" ")}`);
    log.debug(`» working directory: ${repoDir}`);

    const runParams = {
      label: "Pullfrog",
      cwd: repoDir,
      env,
      todoTracker: ctx.todoTracker,
      onActivityTimeout: ctx.onActivityTimeout,
      onToolUse: ctx.onToolUse,
    };

    const result = await runClaude({
      ...runParams,
      args: [...baseArgs, "-p", ctx.instructions.full],
    });

    // post-run retry loop aggregates usage across the initial run + every
    // resume, so the caller sees the whole session — not just the final
    // slice. claude needs a sessionId to `--resume`; if it's missing the
    // loop bails (checks still ran, so persistent hook failures still fail
    // the run). the reflection prompt fires once after gates go clean, as a
    // dedicated turn that nudges the agent to persist learnings.
    return runPostRunRetryLoop({
      initialResult: result,
      initialUsage: result.usage,
      stopScript: ctx.stopScript,
      summaryFilePath: ctx.summaryFilePath,
      summarySeed: ctx.summarySeed,
      reflectionPrompt: buildLearningsReflectionPrompt("claude"),
      canResume: (r) => Boolean(r.sessionId),
      resume: async (c) => {
        const sessionId = c.previousResult.sessionId;
        if (!sessionId) throw new Error("unreachable: canResume gated on sessionId");
        return runClaude({
          ...runParams,
          args: [...baseArgs, "-p", c.prompt, "--resume", sessionId],
        });
      },
    });
  },
});
