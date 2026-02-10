// changes to effort level configuration should be reflected in wiki/effort.md and docs/effort.mdx
// changes to tool permissions should be reflected in wiki/granular-tools.md
// changes to web search configuration should be reflected in wiki/websearch.md
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Effort } from "../external.ts";
import { ghPullfrogMcpName } from "../external.ts";
import packageJson from "../package.json" with { type: "json" };
import { markActivity } from "../utils/activity.ts";
import { log } from "../utils/cli.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import { spawn } from "../utils/subprocess.ts";
import { ThinkingTimer } from "../utils/timer.ts";
import { type AgentRunContext, agent } from "./shared.ts";

// model selection based on effort level
// these are aliases that always resolve to the latest version
const claudeEffortModels: Record<Effort, string> = {
  mini: "sonnet",
  auto: "opus",
  max: "opus",
};

// Claude Code CLI --effort level per pullfrog effort
// null = use default (high). "max" is Opus 4.6 only.
const claudeEffortLevels: Record<Effort, string | null> = {
  mini: null,
  auto: null,
  max: "max",
};

/**
 * Build disallowedTools list from payload permissions.
 */
function buildDisallowedTools(ctx: AgentRunContext): string[] {
  const disallowed: string[] = [];
  if (ctx.payload.web === "disabled") disallowed.push("WebFetch");
  if (ctx.payload.search === "disabled") disallowed.push("WebSearch");
  // both "disabled" and "restricted" block native bash
  // "restricted" means use MCP bash tool instead
  const bash = ctx.payload.bash;
  if (bash !== "enabled") disallowed.push("Bash", "Task(Bash)");
  // always block native file tools (use MCP file_read/file_write instead)
  disallowed.push("Read", "Write", "Edit", "MultiEdit");
  disallowed.push("Task(Read)", "Task(Write)", "Task(Edit)", "Task(MultiEdit)");
  return disallowed;
}

/**
 * Write MCP config file for Claude CLI.
 * Returns the path to the config file.
 */
function writeMcpConfig(ctx: AgentRunContext): string {
  const configDir = join(ctx.tmpdir, ".claude");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "mcp.json");

  const mcpConfig = {
    mcpServers: {
      [ghPullfrogMcpName]: { type: "http", url: ctx.mcpServerUrl },
    },
  };

  writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
  log.info(`» MCP config written to ${configPath}`);
  return configPath;
}

async function installClaude(): Promise<string> {
  const versionRange = packageJson.dependencies["@anthropic-ai/claude-agent-sdk"] || "latest";
  return await installFromNpmTarball({
    packageName: "@anthropic-ai/claude-agent-sdk",
    version: versionRange,
    executablePath: "cli.js",
  });
}

export const claude = agent({
  name: "claude",
  install: installClaude,
  run: async (ctx) => {
    // install CLI at start of run
    const cliPath = await installClaude();

    // select model and effort level
    const model = claudeEffortModels[ctx.payload.effort];
    const effortLevel = claudeEffortLevels[ctx.payload.effort];
    log.info(`» using model: ${model}${effortLevel ? ` (effort: ${effortLevel})` : ""}`);

    // build disallowedTools based on tool permissions
    const disallowedTools = buildDisallowedTools(ctx);
    if (disallowedTools.length > 0) {
      log.info(`» disallowed tools: ${disallowedTools.join(", ")}`);
    }

    // write MCP config file
    const mcpConfigPath = writeMcpConfig(ctx);

    // build CLI args
    // claude -p "prompt" --dangerously-skip-permissions --mcp-config ./mcp.json --model opus --output-format stream-json --verbose
    const args: string[] = [
      cliPath,
      "-p",
      ctx.instructions.full,
      "--dangerously-skip-permissions",
      "--mcp-config",
      mcpConfigPath,
      "--model",
      model,
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    // add --effort flag if specified (e.g. "max" for Opus 4.6)
    if (effortLevel) {
      args.push("--effort", effortLevel);
    }

    // add disallowed tools if any
    if (disallowedTools.length > 0) {
      args.push("--disallowedTools");
      args.push(...disallowedTools);
    }

    log.info("» running Claude CLI...");

    let stdoutBuffer = "";
    let finalOutput = "";

    // Track bash tool IDs to identify when bash tool results come back
    const bashToolIds = new Set<string>();
    const thinkingTimer = new ThinkingTimer();

    const result = await spawn({
      cmd: "node",
      args,
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      onStdout: async (chunk) => {
        finalOutput += chunk;

        // buffer incomplete lines across chunks (NDJSON format)
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");

        // keep the last element (may be incomplete) in the buffer
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const message = JSON.parse(trimmed) as SDKMessage;
            markActivity(); // reset activity timeout on every event
            log.debug(JSON.stringify(message, null, 2));

            const handler = messageHandlers[message.type];
            if (handler) {
              await handler(message as never, bashToolIds, thinkingTimer);
            }
          } catch {
            // ignore parse errors - might be non-JSON output
            log.debug(`[claude] non-JSON stdout line: ${trimmed.substring(0, 200)}`);
          }
        }
      },
      onStderr: (chunk) => {
        const trimmed = chunk.trim();
        if (trimmed) {
          log.debug(`[claude stderr] ${trimmed}`);
          log.warning(trimmed);
          finalOutput += trimmed + "\n";
        }
      },
    });

    if (result.exitCode !== 0) {
      const errorMessage =
        result.stderr ||
        finalOutput ||
        result.stdout ||
        "Unknown error - no output from Claude CLI";
      log.error(`Claude CLI exited with code ${result.exitCode}: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
        output: finalOutput || result.stdout || "",
      };
    }

    log.info("» Claude CLI completed successfully");

    return {
      success: true,
      output: finalOutput || result.stdout || "",
    };
  },
});

type SDKMessageType = SDKMessage["type"];

type SDKMessageHandler<type extends SDKMessageType = SDKMessageType> = (
  data: Extract<SDKMessage, { type: type }>,
  bashToolIds: Set<string>,
  thinkingTimer: ThinkingTimer
) => void | Promise<void>;

type SDKMessageHandlers = {
  [type in SDKMessageType]: SDKMessageHandler<type>;
};

const messageHandlers: SDKMessageHandlers = {
  assistant: (data, bashToolIds, thinkingTimer) => {
    if (data.message?.content) {
      for (const content of data.message.content) {
        if (content.type === "text" && content.text?.trim()) {
          log.box(content.text.trim(), { title: "Claude" });
        } else if (content.type === "tool_use") {
          // Track bash tool IDs
          if (content.name === "bash" && content.id) {
            bashToolIds.add(content.id);
          }

          thinkingTimer.markToolCall();
          log.toolCall({
            toolName: content.name,
            input: content.input,
          });
        }
      }
    }
  },
  user: (data, bashToolIds, thinkingTimer) => {
    if (data.message?.content) {
      for (const content of data.message.content) {
        if (content.type === "tool_result") {
          thinkingTimer.markToolResult();

          const toolUseId = (content as any).tool_use_id;
          const isBashTool = toolUseId && bashToolIds.has(toolUseId);

          const outputContent =
            typeof content.content === "string"
              ? content.content
              : Array.isArray(content.content)
                ? content.content
                    .map((c: any) => (typeof c === "string" ? c : c.text || JSON.stringify(c)))
                    .join("\n")
                : String(content.content);

          if (isBashTool) {
            // Log bash output in a collapsed group
            log.startGroup(`bash output`);
            if (content.is_error) {
              log.warning(outputContent);
            } else {
              log.info(outputContent);
            }
            log.endGroup();
            // Clean up the tracked ID
            bashToolIds.delete(toolUseId);
          } else if (content.is_error) {
            log.warning(`Tool error: ${outputContent}`);
          } else {
            // log successful non-bash tool result at debug level
            log.debug(`tool output: ${outputContent}`);
          }
        }
      }
    }
  },
  result: async (data) => {
    if (data.subtype === "success") {
      const usage = data.usage;
      const inputTokens = usage?.input_tokens || 0;
      const cacheRead = usage?.cache_read_input_tokens || 0;
      const cacheWrite = usage?.cache_creation_input_tokens || 0;
      const outputTokens = usage?.output_tokens || 0;
      const totalInput = inputTokens + cacheRead + cacheWrite;

      log.table([
        [
          { data: "Cost", header: true },
          { data: "Input", header: true },
          { data: "Cache Read", header: true },
          { data: "Cache Write", header: true },
          { data: "Output", header: true },
        ],
        [
          `$${data.total_cost_usd?.toFixed(4) || "0.0000"}`,
          String(totalInput),
          String(cacheRead),
          String(cacheWrite),
          String(outputTokens),
        ],
      ]);
    } else if (data.subtype === "error_max_turns") {
      log.error(`Max turns reached: ${JSON.stringify(data)}`);
    } else if (data.subtype === "error_during_execution") {
      log.error(`Execution error: ${JSON.stringify(data)}`);
    } else {
      log.error(`Failed: ${JSON.stringify(data)}`);
    }
  },
  system: () => {},
  stream_event: () => {},
  tool_progress: () => {},
  tool_use_summary: () => {},
  auth_status: () => {},
};
