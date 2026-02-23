// changes to effort level configuration should be reflected in wiki/effort.md and docs/effort.mdx
// changes to tool permissions should be reflected in wiki/granular-tools.md
// changes to web search configuration should be reflected in wiki/websearch.md
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ghPullfrogMcpName } from "../external.ts";
import { getIdleMs, markActivity } from "../utils/activity.ts";
import { log } from "../utils/cli.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import { spawn } from "../utils/subprocess.ts";
import { ThinkingTimer } from "../utils/timer.ts";
import { type AgentRunContext, type AgentUsage, agent } from "./shared.ts";

// pinned CLI version — no 1-1 package.json dependency for the CLI package
// (package.json has @opencode-ai/sdk which is the SDK, not the CLI)
const OPENCODE_CLI_VERSION = "1.1.56";

// known provider error patterns in stderr (from --print-logs output).
// when OpenCode encounters these, it often goes silent on stdout (Issue #752),
// so we surface them prominently instead of burying them in debug warnings.
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

async function installOpencode(): Promise<string> {
  return await installFromNpmTarball({
    packageName: "opencode-ai",
    version: OPENCODE_CLI_VERSION,
    executablePath: "bin/opencode",
    installDependencies: true,
  });
}

export const opencode = agent({
  name: "opencode",
  install: installOpencode,
  run: async (ctx) => {
    // install CLI at start of run
    const cliPath = await installOpencode();

    // 1. configure home/config directory
    const tempHome = ctx.tmpdir;
    const configDir = join(tempHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });

    configureOpenCode(ctx);

    // message positional must come right after "run", before flags.
    // --print-logs makes OpenCode write internal logs to stderr (otherwise they only go to a log file).
    // this is critical for debugging since opencode run suppresses errors by default (Issue #752).
    const args = ["run", ctx.instructions.full, "--format", "json", "--print-logs"];

    // only override model when OPENCODE_MODEL is set (e.g., test environments with
    // restricted API quotas). in production, OpenCode auto-selects the best available
    // model based on which provider API keys are present.
    const modelOverride = process.env.OPENCODE_MODEL;
    if (modelOverride) {
      args.push("--model", modelOverride);
      log.info(`» model: ${modelOverride} (override)`);
    } else {
      log.info(`» model: auto-selected by OpenCode`);
    }

    process.env.HOME = tempHome;

    // XDG_CONFIG_HOME must be set because GitHub Actions sets it to a different path,
    // and OpenCode follows XDG spec (checks XDG_CONFIG_HOME before falling back to $HOME/.config)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: tempHome,
      XDG_CONFIG_HOME: join(tempHome, ".config"),
      // set GOOGLE_GENERATIVE_AI_API_KEY alias for Google provider compatibility (if not already set)
      GOOGLE_GENERATIVE_AI_API_KEY:
        process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY,
    };
    // OpenCode doesn't support GitHub App installation tokens
    delete env.GITHUB_TOKEN;

    // run OpenCode in the repository directory (process.cwd() is set to GITHUB_WORKSPACE or repo dir)
    const repoDir = process.cwd();

    log.debug(`» starting OpenCode: ${cliPath} ${args.join(" ")}`);
    log.debug(`» working directory: ${repoDir}`);
    log.debug(`» HOME: ${env.HOME}`);
    log.debug(`» XDG_CONFIG_HOME: ${env.XDG_CONFIG_HOME}`);

    const startTime = performance.now();
    let eventCount = 0;
    const thinkingTimer = new ThinkingTimer();

    // reset module-level state before each run (same pattern as claude/codex/gemini).
    // without this, a failed subprocess that never emits an init event would
    // carry stale token counts or output from a prior delegation run.
    finalOutput = "";
    accumulatedTokens = { input: 0, output: 0 };
    tokensLogged = false;

    // track recent stderr lines for provider error diagnosis.
    // when OpenCode goes silent on stdout, these are the only clue.
    const recentStderr: string[] = [];
    const MAX_STDERR_LINES = 20;
    let lastProviderError: string | null = null;

    let output = "";
    let stdoutBuffer = ""; // buffer for incomplete lines across chunks

    try {
      const result = await spawn({
        cmd: cliPath,
        args,
        cwd: repoDir,
        env,
        activityTimeout: 0, // process-level activity timeout (5min) is the single authority
        stdio: ["ignore", "pipe", "pipe"],
        onStdout: async (chunk) => {
          const text = chunk.toString();
          output += text;
          markActivity(); // reset activity timeout on any CLI output

          // buffer incomplete lines across chunks (NDJSON format)
          stdoutBuffer += text;
          const lines = stdoutBuffer.split("\n");

          // keep the last element (may be incomplete) in the buffer
          stdoutBuffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }

            try {
              const event = JSON.parse(trimmed) as OpenCodeEvent;
              eventCount++;

              // debug log all events to diagnose ordering and missing MCP/shell tool calls
              log.debug(JSON.stringify(event, null, 2));

              const timeSinceLastActivity = getIdleMs();
              if (timeSinceLastActivity > 10000) {
                const activeToolCalls = toolCallTimings.size;
                const toolCallInfo =
                  activeToolCalls > 0
                    ? ` (waiting for ${activeToolCalls} tool call${activeToolCalls > 1 ? "s" : ""})`
                    : " (OpenCode may be processing internally - LLM calls, planning, etc.)";
                log.info(
                  `» no activity for ${(timeSinceLastActivity / 1000).toFixed(1)}s${toolCallInfo} (${eventCount} events processed so far)`
                );
              }
              markActivity(); // reset activity timeout on every event
              const handler = messageHandlers[event.type as keyof typeof messageHandlers];
              if (handler) {
                await handler(event as never, thinkingTimer);
              } else {
                // log unhandled event types for visibility
                log.info(
                  `» OpenCode event (unhandled): type=${event.type}, data=${JSON.stringify(event).substring(0, 500)}`
                );
              }
            } catch {
              // non-JSON lines are ignored (might be debug output from opencode)
              log.debug(`» non-JSON stdout line: ${trimmed.substring(0, 200)}`);
            }
          }
        },
        onStderr: (chunk) => {
          const trimmed = chunk.trim();
          if (!trimmed) return;

          // track recent stderr for diagnosis
          recentStderr.push(trimmed);
          if (recentStderr.length > MAX_STDERR_LINES) recentStderr.shift();

          // detect provider errors and surface them prominently
          const providerError = detectProviderError(trimmed);
          if (providerError) {
            lastProviderError = providerError;
            log.info(`» provider error detected (${providerError}): ${trimmed.substring(0, 500)}`);
          } else {
            // OpenCode's --print-logs output goes to stderr. demote internal
            // INFO/DEBUG bus traffic to debug so it doesn't drown out tool
            // call logs in the GitHub Actions step output.
            log.debug(trimmed);
          }
        },
      });

      const duration = performance.now() - startTime;
      log.info(
        `» OpenCode CLI completed in ${Math.round(duration)}ms with exit code ${result.exitCode}`
      );

      // if zero events processed, something went wrong - surface stderr context
      if (eventCount === 0) {
        const stderrContext = recentStderr.join("\n");
        const diagnosis = lastProviderError
          ? `provider error: ${lastProviderError}`
          : "unknown cause (no stdout events received)";
        log.info(`» OpenCode produced 0 events (${diagnosis})`);
        if (stderrContext) {
          log.info(`» last stderr output:\n${stderrContext}`);
        }
      }

      // log tokens if they weren't logged yet (fallback if result event wasn't emitted)
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

      const usage = buildOpenCodeUsage();

      // return result
      if (result.exitCode !== 0) {
        const errorContext = lastProviderError ? ` (${lastProviderError})` : "";
        const errorMessage =
          result.stderr ||
          result.stdout ||
          `unknown error - no output from OpenCode CLI${errorContext}`;
        log.error(
          `OpenCode CLI exited with code ${result.exitCode}${errorContext}: ${errorMessage}`
        );
        log.debug(`OpenCode stdout: ${result.stdout?.substring(0, 500)}`);
        log.debug(`OpenCode stderr: ${result.stderr?.substring(0, 500)}`);
        return {
          success: false,
          output: finalOutput || output,
          error: errorMessage,
          usage,
        };
      }

      return {
        success: true,
        output: finalOutput || output,
        usage,
      };
    } catch (error) {
      // activity timeout or process timeout - surface the real cause
      const duration = performance.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isActivityTimeout = errorMessage.includes("activity timeout");

      // build a diagnostic message that includes provider context
      const stderrContext = recentStderr.slice(-10).join("\n");
      const diagnosis = lastProviderError
        ? `likely cause: ${lastProviderError}`
        : eventCount === 0
          ? "OpenCode produced 0 stdout events - check if the model provider is reachable"
          : `${eventCount} events were processed before the hang`;

      log.info(
        `» OpenCode ${isActivityTimeout ? "hung" : "failed"} after ${(duration / 1000).toFixed(1)}s: ${errorMessage}`
      );
      log.info(`» diagnosis: ${diagnosis}`);
      if (stderrContext) {
        log.info(
          `» recent stderr (last ${Math.min(recentStderr.length, 10)} lines):\n${stderrContext}`
        );
      }

      return {
        success: false,
        output: finalOutput || output,
        error: `${errorMessage} [${diagnosis}]`,
        usage: buildOpenCodeUsage(),
      };
    }
  },
});

/**
 * Configure OpenCode via opencode.json config file.
 * Builds complete config with MCP servers and permissions in a single write to avoid race conditions.
 */
function configureOpenCode(ctx: AgentRunContext): void {
  const configDir = join(ctx.tmpdir, ".config", "opencode");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "opencode.json");

  // build MCP servers config
  const opencodeMcpServers = {
    [ghPullfrogMcpName]: { type: "remote" as const, url: ctx.mcpServerUrl },
  };

  // build permission object based on tool permissions
  // note: OpenCode has no built-in web search tool
  const shell = ctx.payload.shell;
  const permission = {
    edit: "deny",
    read: "deny",
    bash: shell !== "enabled" ? "deny" : "allow",
    webfetch: ctx.payload.web === "disabled" ? "deny" : "allow",
    external_directory: "deny",
  };

  // build complete config in one object
  const config = {
    mcp: opencodeMcpServers,
    permission,
  };

  const configJson = JSON.stringify(config, null, 2);
  try {
    writeFileSync(configPath, configJson, "utf-8");
  } catch (error) {
    log.error(
      `failed to write OpenCode config to ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }

  log.info(`» OpenCode config written to ${configPath}`);
  log.debug(`» disallowed built-ins: ${JSON.stringify(permission)}`);
  log.debug(`OpenCode config contents:\n${configJson}`);
}

////////////////////////////////////////////
////////////   EVENT HANDLERS   ////////////
////////////////////////////////////////////

// opencode cli event types inferred from json output format
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
  part?: {
    id?: string;
    type?: string;
    text?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface OpenCodeStepStartEvent {
  type: "step_start";
  timestamp?: string;
  sessionID?: string;
  part?: {
    id?: string;
    type?: string;
    [key: string]: unknown;
  };
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
      cache?: {
        read?: number;
        write?: number;
      };
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
    state?: {
      status?: string;
      input?: unknown;
      output?: string;
    };
  };
  [key: string]: unknown;
}

interface OpenCodeToolResultEvent {
  type: "tool_result";
  timestamp?: number;
  sessionID?: string;
  part?: {
    callID?: string;
    state?: {
      status?: string;
      output?: string;
    };
  };
  // fallback fields for older format
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
  error?: {
    name?: string;
    message?: string;
    data?: unknown;
    [key: string]: unknown;
  };
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

let finalOutput = "";
let accumulatedTokens: { input: number; output: number } = { input: 0, output: 0 };
let tokensLogged = false;

function buildOpenCodeUsage(): AgentUsage | undefined {
  return accumulatedTokens.input > 0 || accumulatedTokens.output > 0
    ? {
        agent: "opencode",
        inputTokens: accumulatedTokens.input,
        outputTokens: accumulatedTokens.output,
      }
    : undefined;
}

const toolCallTimings = new Map<string, number>();
let currentStepId: string | null = null;
let currentStepType: string | null = null;
let stepHistory: Array<{ stepId: string; stepType: string; toolCalls: string[] }> = [];

const messageHandlers = {
  init: (event: OpenCodeInitEvent) => {
    // initialization event - reset state
    log.debug(
      `» OpenCode init: session_id=${event.session_id || "unknown"}, model=${event.model || "unknown"}`
    );
    log.debug(`» OpenCode init event (full): ${JSON.stringify(event)}`);
    finalOutput = "";
    accumulatedTokens = { input: 0, output: 0 };
    tokensLogged = false;
  },
  message: (event: OpenCodeMessageEvent) => {
    if (event.role === "assistant" && event.content?.trim()) {
      const message = event.content.trim();
      if (message) {
        if (event.delta) {
          // delta messages are streaming thoughts/reasoning
          log.debug(
            `» OpenCode thinking: ${message.substring(0, 300)}${message.length > 300 ? "..." : ""}`
          );
        } else {
          // complete messages
          log.debug(
            `» OpenCode message (${event.role}): ${message.substring(0, 100)}${message.length > 100 ? "..." : ""}`
          );
          finalOutput = message;
        }
      }
    } else if (event.role === "user") {
      log.debug(
        `» OpenCode message (${event.role}): ${event.content?.substring(0, 100) || ""}${event.content && event.content.length > 100 ? "..." : ""}`
      );
    }
  },
  text: (event: OpenCodeTextEvent) => {
    // log from text events only to avoid duplicates
    if (event.part?.text?.trim()) {
      const message = event.part.text.trim();
      log.box(message, { title: "OpenCode" });
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

    // accumulate tokens from step_finish events (they come here, not in result)
    const eventTokens = event.part?.tokens;
    if (eventTokens) {
      const inputTokens = eventTokens.input || 0;
      const outputTokens = eventTokens.output || 0;

      // accumulate tokens (don't log yet - wait for result event)
      accumulatedTokens.input += inputTokens;
      accumulatedTokens.output += outputTokens;
    }

    // clear current step
    if (currentStepId === stepId) {
      currentStepId = null;
      currentStepType = null;
    }
  },
  tool_use: (event: OpenCodeToolUseEvent, thinkingTimer: ThinkingTimer) => {
    const toolName = event.part?.tool;
    const toolId = event.part?.callID;
    const parameters = event.part?.state?.input;
    const status = event.part?.state?.status;
    const output = event.part?.state?.output;

    if (!toolName || !toolId) {
      // surface dropped tool_use events visibly so missing tool calls are diagnosable
      log.info(
        `» tool_use event missing toolName or toolId: ${JSON.stringify(event).substring(0, 500)}`
      );
      return;
    }

    // track tool call in current step
    if (stepHistory.length > 0) {
      stepHistory[stepHistory.length - 1].toolCalls.push(toolName);
    }

    thinkingTimer.markToolCall();
    log.toolCall({
      toolName,
      input: parameters || {},
    });

    // if tool already completed (status in same event), log output
    if (status === "completed" && output) {
      log.debug(`  output: ${output}`);
    }
  },
  tool_result: (event: OpenCodeToolResultEvent, thinkingTimer: ThinkingTimer) => {
    // handle both new part structure and legacy flat structure
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
          `» OpenCode tool_result${stepContext}: id=${toolId}, status=${status}, duration=${Math.round(toolDuration)}ms`
        );
        if (output) {
          log.debug(`  output: ${typeof output === "string" ? output : JSON.stringify(output)}`);
        }
        if (toolDuration > 5000) {
          log.info(
            `» ⚠️ tool call took ${(toolDuration / 1000).toFixed(1)}s - this may indicate network latency or slow processing`
          );
        }
      }
    }
    if (status === "error") {
      const errorMsg = typeof output === "string" ? output : JSON.stringify(output);
      log.info(`» ❌ tool call failed: ${errorMsg}`);
    } else if (output) {
      // log successful tool result so it appears in captured output
      const outputStr = typeof output === "string" ? output : JSON.stringify(output);
      log.debug(`tool output: ${outputStr}`);
    }
  },
  result: async (event: OpenCodeResultEvent) => {
    const status = event.status || "unknown";
    const duration = event.stats?.duration_ms || 0;
    const toolCalls = event.stats?.tool_calls || 0;
    log.info(
      `» OpenCode result: status=${status}, duration=${duration}ms, tool_calls=${toolCalls}`
    );

    if (event.status === "error") {
      log.info(`» OpenCode CLI failed: ${JSON.stringify(event)}`);
    } else {
      // log tokens once at the end (use stats from result if available, otherwise use accumulated from step_finish)
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
