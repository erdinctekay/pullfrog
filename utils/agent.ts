import type { Agent } from "../agents/index.ts";
import { agents } from "../agents/index.ts";
import { getModelProvider } from "../models.ts";
import { log } from "./cli.ts";

function hasEnvVar(name: string): boolean {
  const val = process.env[name];
  return typeof val === "string" && val.length > 0;
}

function hasClaudeCodeAuth(): boolean {
  return hasEnvVar("CLAUDE_CODE_OAUTH_TOKEN") || hasEnvVar("ANTHROPIC_API_KEY");
}

export function resolveAgent(ctx?: { model?: string | undefined }): Agent {
  // 1. explicit env var override (escape hatch)
  const envAgent = process.env.PULLFROG_AGENT?.trim();
  if (envAgent) {
    if (envAgent in agents) {
      log.info(`» agent: ${envAgent} (override via PULLFROG_AGENT)`);
      return agents[envAgent as keyof typeof agents];
    }
    log.warning(`» unknown PULLFROG_AGENT="${envAgent}" — falling through to auto-select`);
  }

  // 2. if model is Anthropic and Claude Code credentials are available, use Claude Code
  if (ctx?.model) {
    try {
      const provider = getModelProvider(ctx.model);
      if (provider === "anthropic" && hasClaudeCodeAuth()) {
        log.info(`» agent: claude (auto-selected for ${ctx.model})`);
        return agents.claude;
      }
    } catch {
      // invalid model slug format — fall through
    }
  }

  // 3. default: OpenCode (universal, supports all providers)
  return agents.opentoad;
}
