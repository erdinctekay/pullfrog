/**
 * OpenToad agent — secure harness around OpenCode CLI.
 *
 * transparently wraps OpenCode with a security layer:
 * - bash: "deny" via OPENCODE_CONFIG_CONTENT (agent cannot shell out)
 * - MCP ShellTool provides restricted shell (filtered env, no secrets)
 * - MCP server injected alongside project config (not replacing)
 * - ASKPASS handles git auth separately (token never in subprocess env)
 *
 * the agent process itself gets full env (needs LLM API keys, PATH, etc.).
 * security is enforced at the tool layer, not the process layer.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ghPullfrogMcpName } from "../external.ts";
import { modelAliases, resolveCliModel } from "../models.ts";
import { getIdleMs, markActivity } from "../utils/activity.ts";
import { log } from "../utils/cli.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import { spawn } from "../utils/subprocess.ts";
import { ThinkingTimer } from "../utils/timer.ts";
import { type AgentResult, type AgentRunContext, type AgentUsage, agent } from "./shared.ts";

// pinned CLI version
const OPENCODE_CLI_VERSION = "1.1.56";

async function installOpencodeCli(): Promise<string> {
  return await installFromNpmTarball({
    packageName: "opencode-ai",
    version: OPENCODE_CLI_VERSION,
    executablePath: "bin/opencode",
    installDependencies: true,
  });
}

// ── config ─────────────────────────────────────────────────────────────────────

type OpenCodeConfig = {
  mcp?: Record<string, unknown>;
  permission?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  model?: string;
  enabled_providers?: string[];
  [key: string]: unknown;
};

function buildSecurityConfig(ctx: AgentRunContext, model: string | undefined): string {
  const config: OpenCodeConfig = {
    permission: {
      bash: "deny",
      edit: "allow",
      read: "allow",
      webfetch: "allow",
      external_directory: "deny",
    },
    mcp: {
      [ghPullfrogMcpName]: { type: "remote", url: ctx.mcpServerUrl },
    },
  };

  if (model) {
    config.model = model;

    const slashIndex = model.indexOf("/");
    if (slashIndex > 0) {
      config.enabled_providers = [model.slice(0, slashIndex).toLowerCase()];
    }
  }

  return JSON.stringify(config);
}

// ── model resolution (see wiki/model-resolution.md) ─────────────────────────────
//
// priority:
//   1. OPENCODE_MODEL env var (explicit override)
//   2. explicit slug from repo config / payload
//   3. auto-select: `opencode models` → recommended aliases first, then secondary
//   4. undefined → let OpenCode decide

function getOpenCodeModels(cliPath: string): string[] {
  try {
    const output = execFileSync(cliPath, ["models"], {
      encoding: "utf-8",
      timeout: 30_000,
      env: process.env,
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    log.debug(
      `» failed to run \`opencode models\`: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

const AUTO_SELECT_WARNING =
  "select a model explicitly in the Pullfrog console (https://pullfrog.com/console) to avoid this.";

function resolveOpenCodeModel(ctx: {
  cliPath: string;
  modelSlug?: string | undefined;
}): string | undefined {
  // 1. explicit env var override
  const envModel = process.env.OPENCODE_MODEL?.trim();
  if (envModel) {
    log.info(`» model: ${envModel} (override via OPENCODE_MODEL)`);
    return envModel;
  }

  // 2. explicit slug from repo config / payload
  if (ctx.modelSlug) {
    const resolved = resolveCliModel(ctx.modelSlug);
    if (resolved) {
      log.info(`» model: ${resolved} (from repo config)`);
      return resolved;
    }
    log.warning(`» unknown model slug "${ctx.modelSlug}" — falling through to auto-select`);
  }

  // 3. auto-select: ask OpenCode what's available, pick our best curated match.
  // `opencode models` returns `provider/model-id` specifiers matching our resolve values exactly.
  // two-pass: recommended (top-tier per provider) first, then secondary models.
  const availableModels = getOpenCodeModels(ctx.cliPath);
  const availableSet = new Set(availableModels);
  if (availableSet.size > 0) {
    log.debug(`» opencode models (${availableSet.size}): ${availableModels.join(", ")}`);
    const match =
      modelAliases.find((a) => a.recommended && availableSet.has(a.resolve)) ??
      modelAliases.find((a) => availableSet.has(a.resolve));
    if (match) {
      log.info(
        `» model: ${match.resolve} (auto-selected${match.recommended ? " — recommended" : ""} curated match)`
      );
      log.warning(`» model auto-selected. ${AUTO_SELECT_WARNING}`);
      return match.resolve;
    }
    log.info(
      `» opencode has ${availableSet.size} models but none match curated aliases — letting OpenCode auto-select`
    );
  }

  log.warning(`» no model resolved. letting OpenCode auto-select. ${AUTO_SELECT_WARNING}`);
  return undefined;
}

// ── provider error detection ───────────────────────────────────────────────────

const PROVIDER_ERROR_PATTERNS = [
  { pattern: "429", label: "rate limited (429)" },
  { pattern: "RESOURCE_EXHAUSTED", label: "quota exhausted" },
  { pattern: "quota", label: "quota error" },
  { pattern: "status: 500", label: "provider 500 error" },
  { pattern: "INTERNAL", label: "provider internal error" },
  { pattern: "status: 503", label: "provider unavailable (503)" },
  { pattern: "UNAVAILABLE", label: "provider unavailable" },
  { pattern: "rate limit", label: "rate limited" },
  { pattern: "limit: 0", label: "zero quota" },
];

function detectProviderError(text: string): string | null {
  for (const entry of PROVIDER_ERROR_PATTERNS) {
    if (text.includes(entry.pattern)) return entry.label;
  }
  return null;
}

// ── NDJSON event types ─────────────────────────────────────────────────────────

interface OpenCodeInitEvent {
  type: "init";
  timestamp?: string;
  session_id?: string;
  model?: string;
  [key: string]: unknown;
}

interface OpenCodeMessageEvent {
  type: "message";
  timestamp?: string;
  role?: "user" | "assistant";
  content?: string;
  delta?: boolean;
  [key: string]: unknown;
}

interface OpenCodeTextEvent {
  type: "text";
  timestamp?: string;
  sessionID?: string;
  part?: { id?: string; type?: string; text?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface OpenCodeStepStartEvent {
  type: "step_start";
  timestamp?: string;
  sessionID?: string;
  part?: { id?: string; type?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface OpenCodeStepFinishEvent {
  type: "step_finish";
  timestamp?: string;
  sessionID?: string;
  part?: {
    id?: string;
    type?: string;
    reason?: string;
    cost?: number;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface OpenCodeToolUseEvent {
  type: "tool_use";
  timestamp?: number;
  sessionID?: string;
  part?: {
    id?: string;
    callID?: string;
    tool?: string;
    state?: { status?: string; input?: unknown; output?: string };
  };
  [key: string]: unknown;
}

interface OpenCodeToolResultEvent {
  type: "tool_result";
  timestamp?: number;
  sessionID?: string;
  part?: { callID?: string; state?: { status?: string; output?: string } };
  tool_id?: string;
  status?: "success" | "error";
  output?: string;
  [key: string]: unknown;
}

interface OpenCodeResultEvent {
  type: "result";
  timestamp?: string;
  status?: "success" | "error";
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    duration_ms?: number;
    tool_calls?: number;
  };
  [key: string]: unknown;
}

interface OpenCodeErrorEvent {
  type: "error";
  timestamp?: string;
  sessionID?: string;
  error?: { name?: string; message?: string; data?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

type OpenCodeEvent =
  | OpenCodeInitEvent
  | OpenCodeMessageEvent
  | OpenCodeTextEvent
  | OpenCodeStepStartEvent
  | OpenCodeStepFinishEvent
  | OpenCodeToolUseEvent
  | OpenCodeToolResultEvent
  | OpenCodeResultEvent
  | OpenCodeErrorEvent;

// ── runner ──────────────────────────────────────────────────────────────────────

type RunParams = {
  label: string;
  cliPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
};

async function runOpenCode(params: RunParams): Promise<AgentResult> {
  const startTime = performance.now();
  let eventCount = 0;
  const thinkingTimer = new ThinkingTimer();

  let finalOutput = "";
  let accumulatedTokens = { input: 0, output: 0 };
  let tokensLogged = false;
  const toolCallTimings = new Map<string, number>();
  let currentStepId: string | null = null;
  let currentStepType: string | null = null;
  let stepHistory: Array<{ stepId: string; stepType: string; toolCalls: string[] }> = [];

  function buildUsage(): AgentUsage | undefined {
    return accumulatedTokens.input > 0 || accumulatedTokens.output > 0
      ? {
          agent: "opentoad",
          inputTokens: accumulatedTokens.input,
          outputTokens: accumulatedTokens.output,
        }
      : undefined;
  }

  const handlers = {
    init: (event: OpenCodeInitEvent) => {
      log.debug(
        `» ${params.label} init: session_id=${event.session_id || "unknown"}, model=${event.model || "unknown"}`
      );
      log.debug(`» ${params.label} init event (full): ${JSON.stringify(event)}`);
      finalOutput = "";
      accumulatedTokens = { input: 0, output: 0 };
      tokensLogged = false;
    },
    message: (event: OpenCodeMessageEvent) => {
      if (event.role === "assistant" && event.content?.trim()) {
        const message = event.content.trim();
        if (event.delta) {
          log.debug(
            `» ${params.label} thinking: ${message.substring(0, 300)}${message.length > 300 ? "..." : ""}`
          );
        } else {
          log.debug(
            `» ${params.label} message (${event.role}): ${message.substring(0, 100)}${message.length > 100 ? "..." : ""}`
          );
          finalOutput = message;
        }
      } else if (event.role === "user") {
        log.debug(
          `» ${params.label} message (${event.role}): ${event.content?.substring(0, 100) || ""}${event.content && event.content.length > 100 ? "..." : ""}`
        );
      }
    },
    text: (event: OpenCodeTextEvent) => {
      if (event.part?.text?.trim()) {
        const message = event.part.text.trim();
        log.box(message, { title: params.label });
        finalOutput = message;
      }
    },
    step_start: (event: OpenCodeStepStartEvent) => {
      const stepType = event.part?.type || "unknown";
      const stepId = event.part?.id || "unknown";
      currentStepId = stepId;
      currentStepType = stepType;
      stepHistory.push({ stepId, stepType, toolCalls: [] });
    },
    step_finish: async (event: OpenCodeStepFinishEvent) => {
      const stepId = event.part?.id || "unknown";
      const eventTokens = event.part?.tokens;
      if (eventTokens) {
        accumulatedTokens.input += eventTokens.input || 0;
        accumulatedTokens.output += eventTokens.output || 0;
      }
      if (currentStepId === stepId) {
        currentStepId = null;
        currentStepType = null;
      }
    },
    tool_use: (event: OpenCodeToolUseEvent) => {
      const toolName = event.part?.tool;
      const toolId = event.part?.callID;
      if (!toolName || !toolId) {
        log.info(
          `» tool_use event missing toolName or toolId: ${JSON.stringify(event).substring(0, 500)}`
        );
        return;
      }

      if (stepHistory.length > 0) {
        stepHistory[stepHistory.length - 1]!.toolCalls.push(toolName);
      }

      thinkingTimer.markToolCall();
      log.toolCall({ toolName, input: event.part?.state?.input || {} });

      if (event.part?.state?.status === "completed" && event.part.state.output) {
        log.debug(`  output: ${event.part.state.output}`);
      }
    },
    tool_result: (event: OpenCodeToolResultEvent) => {
      const toolId = event.part?.callID || event.tool_id;
      const status = event.part?.state?.status || event.status || "unknown";
      const output = event.part?.state?.output || event.output;

      thinkingTimer.markToolResult();

      if (toolId) {
        const toolStartTime = toolCallTimings.get(toolId);
        if (toolStartTime) {
          const toolDuration = performance.now() - toolStartTime;
          toolCallTimings.delete(toolId);
          const stepContext = currentStepId ? ` (step=${currentStepType || "unknown"})` : "";
          log.debug(
            `» ${params.label} tool_result${stepContext}: id=${toolId}, status=${status}, duration=${Math.round(toolDuration)}ms`
          );
          if (output) {
            log.debug(`  output: ${typeof output === "string" ? output : JSON.stringify(output)}`);
          }
          if (toolDuration > 5000) {
            log.info(
              `» tool call took ${(toolDuration / 1000).toFixed(1)}s - may indicate network latency`
            );
          }
        }
      }
      if (status === "error") {
        const errorMsg = typeof output === "string" ? output : JSON.stringify(output);
        log.info(`» tool call failed: ${errorMsg}`);
      } else if (output) {
        const outputStr = typeof output === "string" ? output : JSON.stringify(output);
        log.debug(`tool output: ${outputStr}`);
      }
    },
    result: async (event: OpenCodeResultEvent) => {
      const status = event.status || "unknown";
      const duration = event.stats?.duration_ms || 0;
      const toolCalls = event.stats?.tool_calls || 0;
      log.info(
        `» ${params.label} result: status=${status}, duration=${duration}ms, tool_calls=${toolCalls}`
      );

      if (event.status === "error") {
        log.info(`» ${params.label} failed: ${JSON.stringify(event)}`);
      } else {
        const inputTokens = event.stats?.input_tokens || accumulatedTokens.input || 0;
        const outputTokens = event.stats?.output_tokens || accumulatedTokens.output || 0;
        const totalTokens = event.stats?.total_tokens || inputTokens + outputTokens;
        log.info(`» run complete: tool_calls=${toolCalls}, duration=${duration}ms`);

        if ((inputTokens > 0 || outputTokens > 0) && !tokensLogged) {
          log.table([
            [
              { data: "Input Tokens", header: true },
              { data: "Output Tokens", header: true },
              { data: "Total Tokens", header: true },
            ],
            [String(inputTokens), String(outputTokens), String(totalTokens)],
          ]);
          tokensLogged = true;
        }
      }
    },
  };

  const recentStderr: string[] = [];
  const MAX_STDERR_LINES = 20;
  let lastProviderError: string | null = null;

  let output = "";
  let stdoutBuffer = "";

  try {
    const result = await spawn({
      cmd: params.cliPath,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      activityTimeout: 0,
      stdio: ["ignore", "pipe", "pipe"],
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

          try {
            const event = JSON.parse(trimmed) as OpenCodeEvent;
            eventCount++;
            log.debug(JSON.stringify(event, null, 2));

            const timeSinceLastActivity = getIdleMs();
            if (timeSinceLastActivity > 10000) {
              const activeToolCalls = toolCallTimings.size;
              const toolCallInfo =
                activeToolCalls > 0
                  ? ` (waiting for ${activeToolCalls} tool call${activeToolCalls > 1 ? "s" : ""})`
                  : ` (${params.label} may be processing internally - LLM calls, planning, etc.)`;
              log.info(
                `» no activity for ${(timeSinceLastActivity / 1000).toFixed(1)}s${toolCallInfo} (${eventCount} events processed so far)`
              );
            }
            markActivity();
            const handler = handlers[event.type as keyof typeof handlers];
            if (handler) {
              await handler(event as never);
            } else {
              log.info(
                `» ${params.label} event (unhandled): type=${event.type}, data=${JSON.stringify(event).substring(0, 500)}`
              );
            }
          } catch {
            log.debug(`» non-JSON stdout line: ${trimmed.substring(0, 200)}`);
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

    if (!tokensLogged && (accumulatedTokens.input > 0 || accumulatedTokens.output > 0)) {
      const totalTokens = accumulatedTokens.input + accumulatedTokens.output;
      log.table([
        [
          { data: "Input Tokens", header: true },
          { data: "Output Tokens", header: true },
          { data: "Total Tokens", header: true },
        ],
        [String(accumulatedTokens.input), String(accumulatedTokens.output), String(totalTokens)],
      ]);
    }

    const usage = buildUsage();

    if (result.exitCode !== 0) {
      const errorContext = lastProviderError ? ` (${lastProviderError})` : "";
      const errorMessage =
        result.stderr ||
        result.stdout ||
        `unknown error - no output from OpenCode CLI${errorContext}`;
      log.error(
        `${params.label} exited with code ${result.exitCode}${errorContext}: ${errorMessage}`
      );
      log.debug(`stdout: ${result.stdout?.substring(0, 500)}`);
      log.debug(`stderr: ${result.stderr?.substring(0, 500)}`);
      return { success: false, output: finalOutput || output, error: errorMessage, usage };
    }

    if (eventCount === 0 && lastProviderError) {
      return {
        success: false,
        output: finalOutput || output,
        error: `provider error: ${lastProviderError}`,
        usage,
      };
    }

    return { success: true, output: finalOutput || output, usage };
  } catch (error) {
    const duration = performance.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isActivityTimeout = errorMessage.includes("activity timeout");

    const stderrContext = recentStderr.slice(-10).join("\n");
    const diagnosis = lastProviderError
      ? `likely cause: ${lastProviderError}`
      : eventCount === 0
        ? "OpenCode produced 0 stdout events - check if the model provider is reachable"
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
    };
  }
}

// ── agent ───────────────────────────────────────────────────────────────────────

export const opentoad = agent({
  name: "opentoad",
  install: installOpencodeCli,
  run: async (ctx) => {
    const cliPath = await installOpencodeCli();

    const model = resolveOpenCodeModel({
      cliPath,
      modelSlug: ctx.payload.model,
    });

    const tempHome = ctx.tmpdir;
    mkdirSync(join(tempHome, ".config", "opencode"), { recursive: true });

    const args = ["run", ctx.instructions.full, "--format", "json", "--print-logs"];

    // agent process gets full env — needs LLM API keys, PATH, locale, etc.
    // security is enforced via OPENCODE_CONFIG_CONTENT (bash: deny) and MCP tool filtering.
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: tempHome,
      XDG_CONFIG_HOME: join(tempHome, ".config"),
      OPENCODE_CONFIG_CONTENT: buildSecurityConfig(ctx, model),
      GOOGLE_GENERATIVE_AI_API_KEY:
        process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY,
    };

    const repoDir = process.cwd();

    log.debug(`» starting OpenToad (OpenCode): ${cliPath} ${args.join(" ")}`);
    log.debug(`» working directory: ${repoDir}`);

    return runOpenCode({
      label: "OpenToad",
      cliPath,
      args,
      cwd: repoDir,
      env,
    });
  },
});
