// changes to effort level configuration should be reflected in wiki/effort.md and docs/effort.mdx
// changes to tool permissions should be reflected in wiki/granular-tools.md
// changes to web search configuration should be reflected in wiki/websearch.md
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { Effort } from "../external.ts";
import { ghPullfrogMcpName } from "../external.ts";
import { markActivity } from "../utils/activity.ts";
import { log } from "../utils/cli.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import { spawn } from "../utils/subprocess.ts";
import { type AgentRunContext, agent } from "./shared.ts";

// configuration based on effort level
// https://developers.openai.com/codex/models/
// gpt-5.3-codex announced 2026-02-05 but not yet available in codex CLI
type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
type CodexEffortConfig = { model: string; reasoningEffort?: ModelReasoningEffort };
const codexEffortConfig: Record<Effort, CodexEffortConfig> = {
  mini: { model: "gpt-5.1-codex-mini", reasoningEffort: "low" },
  auto: { model: "gpt-5.2-codex" },
  max: { model: "gpt-5.2-codex", reasoningEffort: "high" },
};

function writeCodexConfig(ctx: AgentRunContext): string {
  const codexDir = join(ctx.tmpdir, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const configPath = join(codexDir, "config.toml");

  // build MCP servers section
  log.info(`» adding MCP server '${ghPullfrogMcpName}' at ${ctx.mcpServerUrl}`);
  const mcpServerSections = [`[mcp_servers.${ghPullfrogMcpName}]\nurl = "${ctx.mcpServerUrl}"`];

  // build features section for tool control
  // disable native shell if bash is "disabled" or "restricted"
  // when "restricted", agent uses MCP bash tool which filters secrets
  const bash = ctx.payload.bash;
  const features: string[] = [];
  if (bash !== "enabled") {
    features.push("shell_command_tool = false");
    features.push("unified_exec = false");
  }
  const featuresSection = features.length > 0 ? `[features]\n${features.join("\n")}` : "";

  // trust the project so codex loads repo-level .codex/config.toml
  const cwd = process.cwd();
  const projectTrustSection = `[projects."${cwd}"]\ntrust_level = "trusted"`;

  writeFileSync(
    configPath,
    `# written by pullfrog
${featuresSection}

${projectTrustSection}

${mcpServerSections.join("\n\n")}
`.trim() + "\n"
  );

  log.info(
    `» Codex config written to ${configPath} (shell: ${bash === "enabled" ? "enabled" : "disabled"}, project trusted: ${cwd})`
  );

  return codexDir;
}

async function installCodex(): Promise<string> {
  return await installFromNpmTarball({
    packageName: "@openai/codex",
    version: "latest",
    executablePath: "bin/codex.js",
  });
}

export const codex = agent({
  name: "codex",
  install: installCodex,
  run: async (ctx) => {
    // validate API key first
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required for codex agent");
    }

    // install CLI at start of run
    const cliPath = await installCodex();

    // write config file (creates ~/.codex/config.toml)
    const codexDir = writeCodexConfig(ctx);

    // get model and reasoning effort based on effort level
    const effortConfig = codexEffortConfig[ctx.payload.effort];
    log.info(`» using model: ${effortConfig.model} (effort: ${ctx.payload.effort})`);
    if (effortConfig.reasoningEffort) {
      log.info(`» using modelReasoningEffort: ${effortConfig.reasoningEffort}`);
    }

    // determine sandbox mode based on push permission
    // push: "disabled" → read-only sandbox, otherwise full access for git ops
    const sandboxMode = ctx.payload.push === "disabled" ? "read-only" : "danger-full-access";

    // determine network and search permissions
    // web: "disabled" → no network access, otherwise enabled
    const networkAccessEnabled = ctx.payload.web !== "disabled";
    // search: "disabled" → no web search, otherwise enabled
    const webSearchEnabled = ctx.payload.search !== "disabled";

    const args: string[] = [
      cliPath,
      "exec",
      ctx.instructions.full,
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      effortConfig.model,
      "--sandbox",
      sandboxMode,
      "--json",
      "--config",
      `sandbox_workspace_write.network_access=${networkAccessEnabled}`,
      "--config",
      `features.web_search_request=${webSearchEnabled}`,
    ];

    if (effortConfig.reasoningEffort) {
      args.push("--config", `model_reasoning_effort="${effortConfig.reasoningEffort}"`);
    }

    log.info(
      `» Codex options: sandboxMode=${sandboxMode}, networkAccess=${networkAccessEnabled}, webSearch=${webSearchEnabled}`
    );
    log.info("» running Codex CLI...");

    let stdoutBuffer = "";
    let finalOutput = "";

    // Track command execution IDs to identify when command results come back
    const commandExecutionIds = new Set<string>();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: codexDir,
      CODEX_API_KEY: apiKey,
    };

    const result = await spawn({
      cmd: "node",
      args,
      cwd: process.cwd(),
      env,
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
            const event = JSON.parse(trimmed) as ThreadEvent;
            markActivity(); // reset activity timeout on every event
            log.debug(JSON.stringify(event, null, 2));

            const handler = messageHandlers[event.type as keyof typeof messageHandlers];
            if (handler) {
              await handler(event as never, commandExecutionIds);
            }
          } catch {
            // ignore parse errors - might be non-JSON output
            log.debug(`[codex] non-JSON stdout line: ${trimmed.substring(0, 200)}`);
          }
        }
      },
      onStderr: (chunk) => {
        const trimmed = chunk.trim();
        if (trimmed) {
          log.debug(`[codex stderr] ${trimmed}`);
          log.warning(trimmed);
          finalOutput += trimmed + "\n";
        }
      },
    });

    if (result.exitCode !== 0) {
      const errorMessage =
        result.stderr || finalOutput || result.stdout || "Unknown error - no output from Codex CLI";
      log.error(`Codex CLI exited with code ${result.exitCode}: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
        output: finalOutput || result.stdout || "",
      };
    }

    log.info("» Codex CLI completed successfully");

    return {
      success: true,
      output: finalOutput || result.stdout || "",
    };
  },
});

type ThreadEventHandler<type extends ThreadEvent["type"]> = (
  event: Extract<ThreadEvent, { type: type }>,
  commandExecutionIds: Set<string>
) => void | Promise<void>;

const messageHandlers: {
  [type in ThreadEvent["type"]]: ThreadEventHandler<type>;
} = {
  "thread.started": () => {
    // No logging needed
  },
  "turn.started": () => {
    // No logging needed
  },
  "turn.completed": async (event) => {
    log.table([
      [
        { data: "Input Tokens", header: true },
        { data: "Cached Input Tokens", header: true },
        { data: "Output Tokens", header: true },
      ],
      [
        String(event.usage.input_tokens || 0),
        String(event.usage.cached_input_tokens || 0),
        String(event.usage.output_tokens || 0),
      ],
    ]);
  },
  "turn.failed": (event) => {
    log.error(`Turn failed: ${event.error.message}`);
  },
  "item.started": (event, commandExecutionIds) => {
    const item = event.item;
    if (item.type === "command_execution") {
      commandExecutionIds.add(item.id);
      log.toolCall({
        toolName: item.command,
        input: (item as any).args || {},
      });
    } else if (item.type === "agent_message") {
      // Will be handled on completion
    } else if (item.type === "mcp_tool_call") {
      log.toolCall({
        toolName: item.tool,
        input: {
          server: item.server,
          ...((item as any).arguments || {}),
        },
      });
    }
    // Reasoning items are handled on completion for better readability
  },
  "item.updated": (event) => {
    const item = event.item;
    if (item.type === "command_execution") {
      if (item.status === "in_progress" && item.aggregated_output) {
        // Command is still running, could show progress if needed
      }
    }
  },
  "item.completed": (event, commandExecutionIds) => {
    const item = event.item;
    if (item.type === "agent_message") {
      log.box(item.text.trim(), { title: "Codex" });
    } else if (item.type === "command_execution") {
      const isTracked = commandExecutionIds.has(item.id);
      if (isTracked) {
        log.startGroup(`bash output`);
        if (item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0)) {
          log.warning(item.aggregated_output || "Command failed");
        } else {
          log.info(item.aggregated_output || "");
        }
        log.endGroup();
        commandExecutionIds.delete(item.id);
      }
    } else if (item.type === "mcp_tool_call") {
      if (item.status === "failed" && item.error) {
        log.warning(`MCP tool call failed: ${item.error.message}`);
      } else if ((item as any).output) {
        // log successful MCP tool call output so it appears in captured output
        const output = (item as any).output;
        const outputStr = typeof output === "string" ? output : JSON.stringify(output);
        log.debug(`tool output: ${outputStr}`);
      }
    } else if (item.type === "reasoning") {
      // Display reasoning in a human-readable format
      const reasoningText = item.text.trim();
      // Remove markdown bold markers if present for cleaner output
      const cleanText = reasoningText.replace(/\*\*/g, "");
      log.box(cleanText, { title: "Codex" });
    }
  },
  error: (event) => {
    log.error(`Error: ${event.message}`);
  },
};
