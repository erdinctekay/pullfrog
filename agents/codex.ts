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
import { ThinkingTimer } from "../utils/timer.ts";
import { type AgentRunContext, agent } from "./shared.ts";

// configuration based on effort level
// https://developers.openai.com/codex/models/
type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
type CodexEffortConfig = { model: string; reasoningEffort?: ModelReasoningEffort };

// preferred model for auto/max — falls back to gpt-5.2-codex if API key lacks access
const PREFERRED_MODEL = "gpt-5.3-codex";
const FALLBACK_MODEL = "gpt-5.2-codex";

function getCodexEffortConfig(model: string): Record<Effort, CodexEffortConfig> {
  return {
    mini: { model: "gpt-5.1-codex-mini", reasoningEffort: "low" },
    auto: { model },
    max: { model, reasoningEffort: "high" },
  };
}

// check if a model is available for the given API key via GET /v1/models
async function isModelAvailable(ctx: { apiKey: string; model: string }): Promise<boolean> {
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${ctx.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      log.warning(
        `failed to list models (HTTP ${response.status}), falling back to ${FALLBACK_MODEL}`
      );
      return false;
    }
    const body = (await response.json()) as { data: Array<{ id: string }> };
    return body.data.some((m) => m.id === ctx.model);
  } catch (err) {
    log.warning(`failed to list models: ${err}, falling back to ${FALLBACK_MODEL}`);
    return false;
  }
}

// resolve the best available model for auto/max effort levels
async function resolveModel(apiKey: string): Promise<string> {
  const available = await isModelAvailable({ apiKey, model: PREFERRED_MODEL });
  if (available) {
    log.info(`» ${PREFERRED_MODEL} is available for this API key`);
    return PREFERRED_MODEL;
  }
  log.info(`» ${PREFERRED_MODEL} not available, using ${FALLBACK_MODEL}`);
  return FALLBACK_MODEL;
}

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
  // note: there is no Codex feature flag to disable the native apply_patch tool.
  // apply_patch_freeform only controls the freeform variant and defaults to false.
  // native file tools are steered to MCP via instructions, and the sandbox (workspace-write
  // or read-only) constrains what the native tool can access even if the agent ignores instructions.
  const featuresSection = features.length > 0 ? `[features]\n${features.join("\n")}` : "";

  // trust the project so codex loads repo-level .codex/config.toml
  const cwd = process.cwd();
  const projectTrustSection = `[projects."${cwd}"]\ntrust_level = "trusted"`;

  // set approval_policy = "never" so we can avoid --dangerously-bypass-approvals-and-sandbox.
  // this keeps sandbox enforcement active while still running non-interactively.
  // the sandbox (workspace-write or read-only) constrains native file tool access.
  const approvalSection = `approval_policy = "never"`;

  writeFileSync(
    configPath,
    `# written by pullfrog
${approvalSection}

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

    // install CLI and resolve model concurrently
    const [cliPath, model] = await Promise.all([installCodex(), resolveModel(apiKey)]);

    // write config file (creates ~/.codex/config.toml)
    const codexDir = writeCodexConfig(ctx);

    // get model and reasoning effort based on effort level
    const effortConfig = getCodexEffortConfig(model)[ctx.payload.effort];
    log.info(`» using model: ${effortConfig.model} (effort: ${ctx.payload.effort})`);
    if (effortConfig.reasoningEffort) {
      log.info(`» using modelReasoningEffort: ${effortConfig.reasoningEffort}`);
    }

    // determine sandbox mode based on push permission
    // push: "disabled" → read-only sandbox, otherwise workspace-write.
    // we avoid danger-full-access because it completely disables the sandbox,
    // which would let native file tools (apply_patch) write anywhere unrestricted.
    // workspace-write constrains native file access to the working directory.
    const sandboxMode = ctx.payload.push === "disabled" ? "read-only" : "workspace-write";

    // determine network and search permissions
    // web: "disabled" → no network access, otherwise enabled
    const networkAccessEnabled = ctx.payload.web !== "disabled";
    // search: "disabled" → no web search, otherwise enabled
    const webSearchEnabled = ctx.payload.search !== "disabled";

    // note: we intentionally do NOT use --dangerously-bypass-approvals-and-sandbox.
    // that flag bypasses both approvals AND the sandbox. instead, we set
    // approval_policy = "never" in config.toml and keep the sandbox active.
    // this ensures native file tools (apply_patch) are constrained by the sandbox
    // even if the agent ignores MCP-only instructions.
    const args: string[] = [
      cliPath,
      "exec",
      ctx.instructions.full,
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
    const thinkingTimer = new ThinkingTimer();

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
              await handler(event as never, commandExecutionIds, thinkingTimer);
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
  commandExecutionIds: Set<string>,
  thinkingTimer: ThinkingTimer
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
  "item.started": (event, commandExecutionIds, thinkingTimer) => {
    const item = event.item;
    if (item.type === "command_execution") {
      commandExecutionIds.add(item.id);
      thinkingTimer.markToolCall();
      log.toolCall({
        toolName: item.command,
        input: (item as any).args || {},
      });
    } else if (item.type === "agent_message") {
      // Will be handled on completion
    } else if (item.type === "mcp_tool_call") {
      thinkingTimer.markToolCall();
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
  "item.completed": (event, commandExecutionIds, thinkingTimer) => {
    const item = event.item;
    if (item.type === "agent_message") {
      log.box(item.text.trim(), { title: "Codex" });
    } else if (item.type === "command_execution") {
      const isTracked = commandExecutionIds.has(item.id);
      if (isTracked) {
        thinkingTimer.markToolResult();
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
      thinkingTimer.markToolResult();
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
