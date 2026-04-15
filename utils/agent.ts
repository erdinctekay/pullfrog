import type { Agent } from "../agents/index.ts";
import { agents } from "../agents/index.ts";
import { getModelProvider, resolveCliModel } from "../models.ts";
import { log } from "./cli.ts";

function hasEnvVar(name: string): boolean {
  const val = process.env[name];
  return typeof val === "string" && val.length > 0;
}

function hasClaudeCodeAuth(): boolean {
  return hasEnvVar("CLAUDE_CODE_OAUTH_TOKEN") || hasEnvVar("ANTHROPIC_API_KEY");
}

/**
 * resolve the effective model for this run.
 *
 * priority:
 *   1. PULLFROG_MODEL env var (explicit specifier override)
 *   2. slug from repo config / payload → alias registry
 *   3. undefined — agent will auto-select
 */
export function resolveModel(ctx: { slug?: string | undefined }): string | undefined {
  const envModel = process.env.PULLFROG_MODEL?.trim();
  if (envModel) {
    return envModel;
  }

  if (ctx.slug) {
    const resolved = resolveCliModel(ctx.slug);
    if (resolved) {
      return resolved;
    }
    log.warning(`» unknown model slug "${ctx.slug}" — agent will auto-select`);
  }

  return undefined;
}

export function resolveAgent(ctx: { model?: string | undefined }): Agent {
  // 1. explicit env var override (escape hatch)
  const envAgent = process.env.PULLFROG_AGENT?.trim();
  if (envAgent) {
    if (envAgent in agents) {
      return agents[envAgent as keyof typeof agents];
    }
    log.warning(`» unknown PULLFROG_AGENT="${envAgent}" — falling through to auto-select`);
  }

  // 2. if model is Anthropic and Claude Code credentials are available, use Claude Code
  if (ctx.model) {
    try {
      const provider = getModelProvider(ctx.model);
      if (provider === "anthropic" && hasClaudeCodeAuth()) {
        return agents.claude;
      }
    } catch {
      // invalid model format — fall through
    }
  }

  // 3. default: OpenCode (universal, supports all providers)
  return agents.opencode;
}
