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
import { type AgentRunContext, type AgentUsage, agent } from "./shared.ts";

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
  // both "disabled" and "restricted" block native shell
  // "restricted" means use MCP shell tool instead
  const shell = ctx.payload.shell;
  if (shell !== "enabled") disallowed.push("Bash");
  // always block native file tools (use MCP file_read/file_write instead)
  disallowed.push("Read", "Write", "Edit", "MultiEdit");
  // block built-in subagent spawning — delegation is handled by gh_pullfrog/delegate
  disallowed.push("Task");
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
  log.debug(`» MCP config written to ${configPath}`);
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
    log.info(`» model: ${model}${effortLevel ? ` (effort: ${effortLevel})` : ""}`);

    // build disallowedTools based on tool permissions
    const disallowedTools = buildDisallowedTools(ctx);
    if (disallowedTools.length > 0) {
      log.debug(`» disallowed built-ins: ${JSON.stringify(disallowedTools)}`);
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
    const usageContainer: UsageContainer = { value: null };

    // track shell tool IDs to identify when shell tool results come back
    const shellToolIds = new Set<string>();
    const thinkingTimer = new ThinkingTimer();

    const result = await spawn({
      cmd: "node",
      args,
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      activityTimeout: 0, // process-level activity timeout (5min) is the single authority
      onStdout: async (chunk) => {
        finalOutput += chunk;
        markActivity(); // reset activity timeout on any CLI output

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
              await handler(message as never, shellToolIds, thinkingTimer, usageContainer);
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
          log.info(`[claude stderr] ${trimmed}`);
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
        usage: usageContainer.value ?? undefined,
      };
    }

    log.info("» Claude CLI completed successfully");

    return {
      success: true,
      output: finalOutput || result.stdout || "",
      usage: usageContainer.value ?? undefined,
    };
  },
});

// run-local usage container — passed to handlers via closure for parallel-safe runs
type UsageContainer = { value: AgentUsage | null };

type SDKMessageType = SDKMessage["type"];

type SDKMessageHandler<type extends SDKMessageType = SDKMessageType> = (
  data: Extract<SDKMessage, { type: type }>,
  shellToolIds: Set<string>,
  thinkingTimer: ThinkingTimer,
  usageContainer: UsageContainer
) => void | Promise<void>;

type SDKMessageHandlers = {
  [type in SDKMessageType]: SDKMessageHandler<type>;
};

const messageHandlers: SDKMessageHandlers = {
  assistant: (data, shellToolIds, thinkingTimer, _usageContainer) => {
    if (data.message?.content) {
      for (const content of data.message.content) {
        if (content.type === "text" && content.text?.trim()) {
          log.box(content.text.trim(), { title: "Claude" });
        } else if (content.type === "tool_use") {
          // track shell tool IDs (Claude's native tool is named "bash")
          if (content.name === "bash" && content.id) {
            shellToolIds.add(content.id);
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
  user: (data, shellToolIds, thinkingTimer, _usageContainer) => {
    if (data.message?.content) {
      for (const content of data.message.content) {
        if (typeof content === "string") {
          continue;
        }
        if (content.type === "tool_result") {
          thinkingTimer.markToolResult();

          const toolUseId = content.tool_use_id;
          const isShellTool = toolUseId && shellToolIds.has(toolUseId);

          const outputContent =
            typeof content.content === "string"
              ? content.content
              : Array.isArray(content.content)
                ? content.content
                    .map((entry: unknown) =>
                      typeof entry === "string"
                        ? entry
                        : typeof entry === "object" && entry !== null && "text" in entry
                          ? String(entry.text)
                          : JSON.stringify(entry)
                    )
                    .join("\n")
                : String(content.content);

          if (isShellTool) {
            // Log shell output in a collapsed group
            log.startGroup(`shell output`);
            if (content.is_error) {
              log.info(outputContent);
            } else {
              log.info(outputContent);
            }
            log.endGroup();
            // Clean up the tracked ID
            shellToolIds.delete(toolUseId);
          } else if (content.is_error) {
            log.info(`Tool error: ${outputContent}`);
          } else {
            // log successful non-shell tool result at debug level
            log.debug(`tool output: ${outputContent}`);
          }
        }
      }
    }
  },
  result: async (data, _shellToolIds, _thinkingTimer, usageContainer) => {
    if (data.subtype === "success") {
      const usage = data.usage;
      const inputTokens = usage?.input_tokens || 0;
      const cacheRead = usage?.cache_read_input_tokens || 0;
      const cacheWrite = usage?.cache_creation_input_tokens || 0;
      const outputTokens = usage?.output_tokens || 0;
      const totalInput = inputTokens + cacheRead + cacheWrite;

      usageContainer.value = {
        agent: "claude",
        inputTokens: totalInput,
        outputTokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        costUsd: data.total_cost_usd ?? undefined,
      };

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
      log.info(`Max turns reached: ${JSON.stringify(data)}`);
    } else if (data.subtype === "error_during_execution") {
      log.info(`Execution error: ${JSON.stringify(data)}`);
    } else {
      log.info(`Failed: ${JSON.stringify(data)}`);
    }
  },
  system: (_data, _shellToolIds, _thinkingTimer, _usageContainer) => {},
  stream_event: (_data, _shellToolIds, _thinkingTimer, _usageContainer) => {},
  tool_progress: (_data, _shellToolIds, _thinkingTimer, _usageContainer) => {},
  tool_use_summary: (_data, _shellToolIds, _thinkingTimer, _usageContainer) => {},
  auth_status: (_data, _shellToolIds, _thinkingTimer, _usageContainer) => {},
};
