// changes to effort level configuration should be reflected in wiki/effort.md and docs/effort.mdx
// changes to tool permissions should be reflected in wiki/granular-tools.md
// changes to web search configuration should be reflected in wiki/websearch.md
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Effort } from "../external.ts";
import { ghPullfrogMcpName } from "../external.ts";
import { markActivity } from "../utils/activity.ts";
import { log } from "../utils/cli.ts";
import { installFromDirectTarball } from "../utils/install.ts";
import { ThinkingTimer } from "../utils/timer.ts";
import { type AgentRunContext, agent } from "./shared.ts";

// pinned CLI version — cursor-agent is downloaded as a tarball from downloads.cursor.com.
// the version format is {date}-{commit_hash}. update by inspecting the install script:
//   curl -fsSL https://cursor.com/install | grep DOWNLOAD_URL
const CURSOR_CLI_VERSION = "2026.01.28-fd13201";

// effort configuration for Cursor
// only "max" overrides the model; mini/auto use default ("auto")
const cursorEffortModels: Record<Effort, string | null> = {
  mini: null, // use default (auto)
  auto: null, // use default (auto)
  max: "opus-4.5-thinking",
} as const;

// cursor cli event types inferred from stream-json output
interface CursorSystemEvent {
  type: "system";
  subtype?: string;
  [key: string]: unknown;
}

interface CursorUserEvent {
  type: "user";
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }>;
  };
  [key: string]: unknown;
}

interface CursorThinkingEvent {
  type: "thinking";
  subtype: "delta" | "completed";
  text?: string;
  [key: string]: unknown;
}

interface CursorAssistantEvent {
  type: "assistant";
  model_call_id?: string;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }>;
  };
  [key: string]: unknown;
}

interface CursorToolCallEvent {
  type: "tool_call";
  subtype: "started" | "completed";
  call_id?: string;
  tool_call?: {
    mcpToolCall?: {
      args?: {
        name?: string;
        args?: unknown;
        toolName?: string;
        providerIdentifier?: string;
      };
      result?: {
        success?: {
          content?: Array<{ text?: { text?: string } }>;
          isError?: boolean;
        };
      };
    };
  };
  [key: string]: unknown;
}

interface CursorResultEvent {
  type: "result";
  subtype: "success" | "error";
  result?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

type CursorEvent =
  | CursorSystemEvent
  | CursorUserEvent
  | CursorThinkingEvent
  | CursorAssistantEvent
  | CursorToolCallEvent
  | CursorResultEvent;

async function installCursor(): Promise<string> {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return await installFromDirectTarball({
    url: `https://downloads.cursor.com/lab/${CURSOR_CLI_VERSION}/${os}/${arch}/agent-cli-package.tar.gz`,
    executablePath: "cursor-agent",
    stripComponents: 1,
  });
}

export const cursor = agent({
  name: "cursor",
  install: installCursor,
  run: async (ctx) => {
    // validate API key exists for headless/CI authentication
    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) {
      throw new Error("CURSOR_API_KEY is required for cursor agent");
    }

    // install CLI at start of run
    const cliPath = await installCursor();

    configureCursorMcpServers(ctx);
    configureCursorTools(ctx);

    // determine model based on effort level
    // respect project's .cursor/cli.json if it specifies a model
    const projectCliConfigPath = join(process.cwd(), ".cursor", "cli.json");
    let modelOverride: string | null = null;

    if (existsSync(projectCliConfigPath)) {
      try {
        const projectConfig = JSON.parse(readFileSync(projectCliConfigPath, "utf-8"));
        if (projectConfig.model) {
          log.info(`» model: ${projectConfig.model} (from .cursor/cli.json)`);
        } else {
          modelOverride = cursorEffortModels[ctx.payload.effort];
        }
      } catch {
        modelOverride = cursorEffortModels[ctx.payload.effort];
      }
    } else {
      modelOverride = cursorEffortModels[ctx.payload.effort];
    }

    if (modelOverride) {
      log.info(`» model: ${modelOverride}`);
    } else if (!existsSync(projectCliConfigPath)) {
      log.info(`» model: default`);
    }

    // track logged model_call_ids to avoid duplicates
    // cursor emits each assistant message twice: once without model_call_id, then again with it
    const loggedModelCallIds = new Set<string>();
    const thinkingTimer = new ThinkingTimer();

    const messageHandlers = {
      system: (_event: CursorSystemEvent) => {
        // system init events - no logging needed
      },
      user: (_event: CursorUserEvent) => {
        // user messages already logged in prompt box
      },
      thinking: (_event: CursorThinkingEvent) => {
        // thinking events are internal - no logging needed
      },
      assistant: (event: CursorAssistantEvent) => {
        const text = event.message?.content?.[0]?.text?.trim();
        if (!text) return;

        if (event.model_call_id) {
          // complete message with model_call_id - log it if we haven't seen this id before
          // cursor emits each message twice: first without model_call_id, then with it
          // we deduplicate by model_call_id to avoid logging the same message twice
          if (!loggedModelCallIds.has(event.model_call_id)) {
            loggedModelCallIds.add(event.model_call_id);
            log.box(text, { title: "Cursor" });
          }
        } else {
          // message without model_call_id - log it immediately
          // this handles cases where:
          // 1. the final summary message might only be emitted without model_call_id
          // 2. messages that don't get re-emitted with model_call_id
          // without this, the final comprehensive summary wouldn't print (as we discovered)
          log.box(text, { title: "Cursor" });
        }
      },
      tool_call: (event: CursorToolCallEvent) => {
        if (event.subtype === "started") {
          // handle both MCP tools and built-in tools (shell, WebFetch, etc)
          const mcpToolCall = event.tool_call?.mcpToolCall;
          const builtinToolCall = (event.tool_call as any)?.builtinToolCall;

          thinkingTimer.markToolCall();
          if (mcpToolCall?.args?.toolName && mcpToolCall?.args?.args) {
            log.toolCall({
              toolName: mcpToolCall.args.toolName,
              input: mcpToolCall.args.args,
            });
          } else if (builtinToolCall?.args?.name && builtinToolCall?.args?.args) {
            log.toolCall({
              toolName: builtinToolCall.args.name,
              input: builtinToolCall.args.args,
            });
          }
        } else if (event.subtype === "completed") {
          thinkingTimer.markToolResult();
          const result = event.tool_call?.mcpToolCall?.result?.success;
          const isError = result?.isError;
          if (isError) {
            log.info("Tool call failed");
          } else {
            // log successful tool result so it appears in output
            // handle both formats: { text: string } or { text: { text: string } }
            const contentItem = result?.content?.[0];
            const textValue = contentItem?.text;
            const text = typeof textValue === "string" ? textValue : textValue?.text;
            if (text) {
              log.debug(`tool output: ${text}`);
            }
          }
        }
      },
      result: async (event: CursorResultEvent) => {
        if (event.subtype === "success" && event.duration_ms) {
          const durationSec = (event.duration_ms / 1000).toFixed(1);
          log.debug(`Cursor completed in ${durationSec}s`);
          // note: we don't log event.result here because it contains the full conversation
          // concatenated together, which would duplicate all the individual assistant
          // messages we've already logged. the individual assistant events are sufficient.
        }
      },
    };

    try {
      // build CLI args
      // IMPORTANT: prompt is a POSITIONAL argument and must come LAST
      // --print is a FLAG (not an option that takes a value)
      const baseArgs = [
        "--print",
        "--output-format",
        "stream-json",
        "--approve-mcps",
        "--api-key",
        apiKey,
      ];

      // add model flag if we have an override
      if (modelOverride) {
        baseArgs.push("--model", modelOverride);
      }

      // always use --force since permissions are controlled via cli-config.json
      // prompt MUST be last as a positional argument
      const cursorArgs = [...baseArgs, "--force", ctx.instructions.full];

      log.info("» running Cursor CLI...");

      const startTime = performance.now();

      // create env without XDG_CONFIG_HOME so CLI uses $HOME/.cursor/ where we wrote config
      const cliEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== "XDG_CONFIG_HOME")
      );

      return new Promise((resolve) => {
        const child = spawn(cliPath, cursorArgs, {
          cwd: process.cwd(),
          env: cliEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let stdoutBuffer = "";

        child.on("spawn", () => {
          log.debug("Cursor CLI process spawned");
        });

        child.stdout?.on("data", async (data) => {
          const text = data.toString();
          stdout += text;
          markActivity(); // reset activity timeout on any CLI output

          // buffer incomplete lines across chunks (NDJSON format)
          stdoutBuffer += text;
          const lines = stdoutBuffer.split("\n");

          // keep the last element (may be incomplete) in the buffer
          stdoutBuffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
              const event = JSON.parse(trimmed) as CursorEvent;
              log.debug(JSON.stringify(event, null, 2));

              // skip empty thinking deltas
              if (event.type === "thinking" && event.subtype === "delta" && !event.text) {
                continue;
              }

              // route to appropriate handler
              const handler = messageHandlers[event.type as keyof typeof messageHandlers];
              if (handler) {
                await handler(event as never);
              }
            } catch {
              // ignore parse errors - might be formatted tool call logs from cursor cli
            }
          }
        });

        child.stderr?.on("data", (data) => {
          const text = data.toString();
          stderr += text;
          process.stderr.write(text);
          log.info(text);
        });

        child.on("close", async (code, signal) => {
          if (signal) {
            log.info(`Cursor CLI terminated by signal: ${signal}`);
          }

          const duration = ((performance.now() - startTime) / 1000).toFixed(1);

          if (code === 0) {
            log.success(`Cursor CLI completed successfully in ${duration}s`);
            resolve({
              success: true,
              output: stdout.trim(),
            });
          } else {
            const errorMessage = stderr || `Cursor CLI exited with code ${code}`;
            log.error(`Cursor CLI failed after ${duration}s: ${errorMessage}`);
            resolve({
              success: false,
              error: errorMessage,
              output: stdout.trim(),
            });
          }
        });

        child.on("error", (error) => {
          const duration = ((performance.now() - startTime) / 1000).toFixed(1);
          const errorMessage = error.message || String(error);
          log.error(`Cursor CLI execution failed after ${duration}s: ${errorMessage}`);
          resolve({
            success: false,
            error: errorMessage,
            output: stdout.trim(),
          });
        });
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`Cursor execution failed: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
        output: "",
      };
    }
  },
});

// get the cursor config directory
// always use $HOME/.cursor/ for consistency
// when spawning the CLI, we unset XDG_CONFIG_HOME so it looks here too
function getCursorConfigDir(): string {
  return join(homedir(), ".cursor");
}

// There was an issue on macOS when you set HOME to a temp directory
// it was unable to find the macOS keychain and would fail
// temp solution is to stick with the actual $HOME
function configureCursorMcpServers(ctx: AgentRunContext): void {
  const cursorConfigDir = getCursorConfigDir();
  const mcpConfigPath = join(cursorConfigDir, "mcp.json");
  mkdirSync(cursorConfigDir, { recursive: true });

  const mcpServers = {
    [ghPullfrogMcpName]: { type: "http", url: ctx.mcpServerUrl },
  };
  writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2), "utf-8");
  log.info(`» MCP config written to ${mcpConfigPath}`);
}

interface CursorCliConfig {
  permissions: {
    allow: string[];
    deny: string[];
  };
  sandbox?: {
    mode: "enabled" | "disabled";
    networkAccess?: "allowlist" | "full";
  };
}

/**
 * Configure Cursor CLI tool permissions via cli-config.json.
 *
 * Config path: $HOME/.cursor/cli-config.json
 */
function configureCursorTools(ctx: AgentRunContext): void {
  const cursorConfigDir = getCursorConfigDir();
  const cliConfigPath = join(cursorConfigDir, "cli-config.json");
  mkdirSync(cursorConfigDir, { recursive: true });

  // build deny list based on tool permissions
  const shell = ctx.payload.shell;
  const deny: string[] = [];
  if (ctx.payload.search === "disabled") deny.push("WebSearch");
  // both "disabled" and "restricted" block native shell
  if (shell !== "enabled") deny.push("Shell(*)");
  // always block native file tools (use MCP file_read/file_write instead)
  deny.push("Read(*)", "Write(*)", "StrReplace(*)", "EditNotebook(*)", "Delete(*)");
  // block built-in subagent spawning — delegation is handled by gh_pullfrog/delegate
  deny.push("Task(*)");

  const config: CursorCliConfig = {
    permissions: {
      allow: [],
      deny,
    },
  };

  // web: "disabled" requires sandbox with network blocking
  // sandbox.networkAccess: "allowlist" blocks network in shell subprocesses via seatbelt
  if (ctx.payload.web === "disabled") {
    config.sandbox = {
      mode: "enabled",
      networkAccess: "allowlist",
    };
  }

  writeFileSync(cliConfigPath, JSON.stringify(config, null, 2), "utf-8");
  log.info(`» CLI config written to ${cliConfigPath}`);
  log.debug(`» disallowed built-ins: ${JSON.stringify(deny)}`);
  log.debug(`» CLI config contents: ${JSON.stringify(config, null, 2)}`);
}
