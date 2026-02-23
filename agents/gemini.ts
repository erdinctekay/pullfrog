// changes to effort level configuration should be reflected in wiki/effort.md and docs/effort.mdx
// changes to tool permissions should be reflected in wiki/granular-tools.md
// changes to web search configuration should be reflected in wiki/websearch.md
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Effort } from "../external.ts";
import { ghPullfrogMcpName } from "../external.ts";
import { markActivity } from "../utils/activity.ts";
import { log } from "../utils/cli.ts";
import { installFromGithub } from "../utils/install.ts";
import { spawn } from "../utils/subprocess.ts";
import { ThinkingTimer } from "../utils/timer.ts";
import { getGitHubInstallationToken } from "../utils/token.ts";
import { type AgentRunContext, type AgentUsage, agent } from "./shared.ts";

// effort configuration: model + thinking level
// thinkingLevel is set via settings.json modelConfig.generateContentConfig.thinkingConfig
// see: https://ai.google.dev/gemini-api/docs/thinking#thinking-levels
// latest models:
const geminiEffortConfig: Record<Effort, { model: string; thinkingLevel: string }> = {
  // https://ai.google.dev/gemini-api/docs/models
  // the docs mention needing to enable preview features for these models but if you
  // pass the model directly it works if we ever did need to do something like this,
  // we could write to .gemini/settings.json
  mini: { model: "gemini-3-flash-preview", thinkingLevel: "LOW" },
  auto: { model: "gemini-3-pro-preview", thinkingLevel: "HIGH" },
  max: { model: "gemini-3-pro-preview", thinkingLevel: "HIGH" },
} as const;

// gemini cli event types inferred from stream-json output (NDJSON format)
interface GeminiInitEvent {
  type: "init";
  timestamp?: string;
  session_id?: string;
  model?: string;
  [key: string]: unknown;
}

interface GeminiMessageEvent {
  type: "message";
  timestamp?: string;
  role?: "user" | "assistant";
  content?: string;
  delta?: boolean;
  [key: string]: unknown;
}

interface GeminiToolUseEvent {
  type: "tool_use";
  timestamp?: string;
  tool_name?: string;
  tool_id?: string;
  parameters?: unknown;
  [key: string]: unknown;
}

interface GeminiToolResultEvent {
  type: "tool_result";
  timestamp?: string;
  tool_id?: string;
  status?: "success" | "error";
  output?: string;
  [key: string]: unknown;
}

interface GeminiResultEvent {
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

type GeminiEvent =
  | GeminiInitEvent
  | GeminiMessageEvent
  | GeminiToolUseEvent
  | GeminiToolResultEvent
  | GeminiResultEvent;

// pinned CLI version — gemini-cli is installed from GitHub releases, not npm
const GEMINI_CLI_VERSION = "v0.28.2";

// transient API error patterns that warrant a retry.
// these are server-side issues, not client errors.
const TRANSIENT_ERROR_PATTERNS = [
  "INTERNAL",
  "status: 500",
  "status: 503",
  "UNAVAILABLE",
  "RESOURCE_EXHAUSTED",
];

function isTransientApiError(output: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => output.includes(pattern));
}

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 5_000;

// run-local state container — passed to handlers via closure for parallel-safe runs
type GeminiRunState = {
  assistantMessageBuffer: string;
  usage: AgentUsage | null;
};

function createMessageHandlers(runState: GeminiRunState) {
  return {
    init: (_event: GeminiInitEvent) => {
      log.debug(JSON.stringify(_event, null, 2));
      // initialization event - no logging needed
      runState.assistantMessageBuffer = "";
    },
    message: (event: GeminiMessageEvent) => {
      log.debug(JSON.stringify(event, null, 2));
      if (event.role === "assistant" && event.content?.trim()) {
        if (event.delta) {
          // accumulate delta messages
          runState.assistantMessageBuffer += event.content;
        } else {
          // final message - log it
          const message = event.content.trim();
          if (message) {
            log.box(message, { title: "Gemini" });
          }
          runState.assistantMessageBuffer = "";
        }
      } else if (
        event.role === "assistant" &&
        !event.delta &&
        runState.assistantMessageBuffer.trim()
      ) {
        // if we have buffered content and get a non-delta message, log the buffer
        log.box(runState.assistantMessageBuffer.trim(), { title: "Gemini" });
        runState.assistantMessageBuffer = "";
      }
    },
    tool_use: (event: GeminiToolUseEvent, thinkingTimer: ThinkingTimer) => {
      log.debug(JSON.stringify(event, null, 2));
      if (event.tool_name) {
        thinkingTimer.markToolCall();
        log.toolCall({
          toolName: event.tool_name,
          input: event.parameters || {},
        });
      }
    },
    tool_result: (event: GeminiToolResultEvent, thinkingTimer: ThinkingTimer) => {
      log.debug(JSON.stringify(event, null, 2));
      thinkingTimer.markToolResult();
      if (event.status === "error") {
        const errorMsg =
          typeof event.output === "string" ? event.output : JSON.stringify(event.output);
        log.info(`Tool call failed: ${errorMsg}`);
      } else if (event.output) {
        // log successful tool result so it appears in output
        const outputStr =
          typeof event.output === "string" ? event.output : JSON.stringify(event.output);
        log.debug(`tool output: ${outputStr}`);
      }
    },
    result: async (event: GeminiResultEvent) => {
      log.debug(JSON.stringify(event, null, 2));
      // log any remaining buffered assistant message
      if (runState.assistantMessageBuffer.trim()) {
        log.box(runState.assistantMessageBuffer.trim(), { title: "Gemini" });
        runState.assistantMessageBuffer = "";
      }

      if (event.status === "success" && event.stats) {
        const stats = event.stats;

        runState.usage = {
          agent: "gemini",
          inputTokens: stats.input_tokens ?? 0,
          outputTokens: stats.output_tokens ?? 0,
        };

        const rows: Array<Array<{ data: string; header?: boolean } | string>> = [
          [
            { data: "Input Tokens", header: true },
            { data: "Output Tokens", header: true },
            { data: "Total Tokens", header: true },
            { data: "Tool Calls", header: true },
            { data: "Duration (ms)", header: true },
          ],
          [
            String(stats.input_tokens || 0),
            String(stats.output_tokens || 0),
            String(stats.total_tokens || 0),
            String(stats.tool_calls || 0),
            String(stats.duration_ms || 0),
          ],
        ];
        log.table(rows);
      } else if (event.status === "error") {
        log.error(`Gemini CLI failed: ${JSON.stringify(event)}`);
      }
    },
  };
}

async function installGemini(githubInstallationToken?: string): Promise<string> {
  return await installFromGithub({
    owner: "google-gemini",
    repo: "gemini-cli",
    tag: GEMINI_CLI_VERSION,
    assetName: "gemini.js",
    ...(githubInstallationToken && { githubInstallationToken }),
  });
}

export const gemini = agent({
  name: "gemini",
  install: installGemini,
  run: async (ctx) => {
    // install CLI at start of run - use token for GitHub API rate limiting
    const cliPath = await installGemini(getGitHubInstallationToken());

    const model = configureGeminiSettings(ctx);

    if (!process.env.GOOGLE_API_KEY && !process.env.GEMINI_API_KEY) {
      throw new Error("GOOGLE_API_KEY or GEMINI_API_KEY is required for gemini agent");
    }

    // build CLI args - --yolo for auto-approval
    // tool restrictions handled via settings.json tools.exclude
    const args = [
      "--model",
      model,
      "--yolo",
      "--output-format=stream-json",
      "-p",
      ctx.instructions.full,
    ];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let finalOutput = "";
      let stdoutBuffer = "";
      const runState: GeminiRunState = { assistantMessageBuffer: "", usage: null };
      const messageHandlers = createMessageHandlers(runState);
      const thinkingTimer = new ThinkingTimer();

      try {
        const result = await spawn({
          cmd: "node",
          args: [cliPath, ...args],
          env: process.env,
          activityTimeout: 0, // process-level activity timeout (5min) is the single authority
          onStdout: async (chunk) => {
            const text = chunk.toString();
            finalOutput += text;
            markActivity(); // reset activity timeout on any CLI output

            // buffer incomplete lines across chunks (NDJSON format)
            stdoutBuffer += text;
            const lines = stdoutBuffer.split("\n");

            // keep the last element (may be incomplete) in the buffer
            stdoutBuffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              log.debug(`[gemini stdout] ${trimmed}`);

              try {
                const event = JSON.parse(trimmed) as GeminiEvent;
                markActivity(); // reset activity timeout on every event
                const handler = messageHandlers[event.type as keyof typeof messageHandlers];
                if (handler) {
                  await handler(event as never, thinkingTimer);
                }
              } catch {
                // ignore parse errors - might be non-JSON output from gemini cli
                log.debug(`[gemini] non-JSON stdout line: ${trimmed.substring(0, 200)}`);
              }
            }
          },
          onStderr: (chunk) => {
            const trimmed = chunk.trim();
            if (trimmed) {
              log.info(`[gemini stderr] ${trimmed}`);
              finalOutput += trimmed + "\n";
            }
          },
        });

        if (result.exitCode !== 0) {
          const errorMessage =
            result.stderr ||
            finalOutput ||
            result.stdout ||
            "Unknown error - no output from Gemini CLI";

          // retry on transient API errors (500, 503, INTERNAL, etc.)
          if (attempt < MAX_ATTEMPTS && isTransientApiError(errorMessage)) {
            log.info(
              `» transient Gemini API error on attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${RETRY_DELAY_MS / 1000}s...`
            );
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
            continue;
          }

          log.error(`Gemini CLI exited with code ${result.exitCode}: ${errorMessage}`);
          return {
            success: false,
            error: errorMessage,
            output: finalOutput || result.stdout || "",
            usage: runState.usage ?? undefined,
          };
        }

        finalOutput = finalOutput || result.stdout || "Gemini CLI completed successfully.";
        log.info("» Gemini CLI completed successfully");

        return {
          success: true,
          output: finalOutput,
          usage: runState.usage ?? undefined,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // retry on transient API errors from spawn exceptions too
        if (attempt < MAX_ATTEMPTS && isTransientApiError(errorMessage)) {
          log.info(
            `» transient Gemini API error on attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${RETRY_DELAY_MS / 1000}s...`
          );
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          continue;
        }

        log.error(`Failed to run Gemini CLI: ${errorMessage}`);
        return {
          success: false,
          error: errorMessage,
          output: finalOutput || "",
          usage: runState.usage ?? undefined,
        };
      }
    }

    // should never reach here, but satisfy TypeScript
    return { success: false, error: "exhausted all retry attempts", output: "" };
  },
});

/**
 * Configure Gemini CLI settings by writing to settings.json.
 * Returns the model to use for CLI args.
 *
 * See: https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/configuration.md
 */
function configureGeminiSettings(ctx: AgentRunContext): string {
  const effortConfig = geminiEffortConfig[ctx.payload.effort];
  // allow env var override for tests (e.g., to avoid flash RPD quota limits)
  const model = process.env.GEMINI_MODEL ?? effortConfig.model;
  const thinkingLevel = effortConfig.thinkingLevel;
  log.info(`» model: ${model} (thinkingLevel: ${thinkingLevel})`);

  const realHome = homedir();
  const geminiConfigDir = join(realHome, ".gemini");
  const settingsPath = join(geminiConfigDir, "settings.json");
  mkdirSync(geminiConfigDir, { recursive: true });

  // read existing settings if present
  let existingSettings: Record<string, unknown> = {};
  try {
    const content = readFileSync(settingsPath, "utf-8");
    existingSettings = JSON.parse(content);
  } catch {
    // file doesn't exist or is invalid - start fresh
  }

  // convert to Gemini's expected format (httpUrl for HTTP transport, no type field)
  interface GeminiMcpServerConfig {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    httpUrl?: string;
    headers?: Record<string, string>;
    timeout?: number;
    trust?: boolean;
    description?: string;
    includeTools?: string[];
    excludeTools?: string[];
  }
  log.info(`» adding MCP server '${ghPullfrogMcpName}' at ${ctx.mcpServerUrl}...`);
  const geminiMcpServers: Record<string, GeminiMcpServerConfig> = {
    [ghPullfrogMcpName]: {
      httpUrl: ctx.mcpServerUrl,
      trust: true, // trust our own MCP server to avoid confirmation prompts
    },
  };

  // build tools.exclude based on permissions (v0.3.0+ nested format)
  const shell = ctx.payload.shell;
  const exclude: string[] = [];
  if (shell !== "enabled") exclude.push("run_shell_command");
  if (ctx.payload.web === "disabled") exclude.push("web_fetch");
  if (ctx.payload.search === "disabled") exclude.push("google_web_search");
  // always block native file tools (use MCP file_read/file_write instead)
  exclude.push("read_file", "write_file", "list_directory");

  // merge with existing settings, overwriting mcpServers and modelConfig
  const newSettings: Record<string, unknown> = {
    ...existingSettings,
    mcpServers: geminiMcpServers,
    // configure thinking level via modelConfig
    // see: https://ai.google.dev/api/generate-content (ThinkingConfig)
    modelConfig: {
      generateContentConfig: {
        thinkingConfig: {
          thinkingLevel,
        },
      },
    },
    // v0.3.0+ nested format
    ...(exclude.length > 0 && { tools: { exclude } }),
  };

  writeFileSync(settingsPath, JSON.stringify(newSettings, null, 2), "utf-8");
  log.info(`» Gemini settings written to ${settingsPath}`);
  if (exclude.length > 0) {
    log.debug(`» disallowed built-ins: ${JSON.stringify(exclude)}`);
  }

  return model;
}
