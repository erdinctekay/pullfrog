/**
 * model alias registry.
 *
 * slugs use the format `provider/model-id` (e.g. "anthropic/claude-opus").
 * bump `resolve` when a new model generation ships — the alias (slug) stays stable.
 */

// ── types ──────────────────────────────────────────────────────────────────────

export interface ModelAlias {
  /** stable alias stored in DB, e.g. "anthropic/claude-opus" */
  slug: string;
  /** provider key (matches providers keys) */
  provider: string;
  /** human-readable name shown in dropdowns */
  displayName: string;
  /** concrete models.dev specifier, e.g. "anthropic/claude-opus-4-6" */
  resolve: string;
  /** full models.dev specifier for the OpenRouter equivalent (undefined for free models) */
  openRouterResolve: string | undefined;
  /** top-tier pick for this provider — preferred during auto-select */
  preferred: boolean;
  /** whether this alias is free and requires no API key */
  isFree: boolean;
  /** slug of a replacement model — presence implies this model is deprecated */
  fallback: string | undefined;
}

interface ModelDef {
  displayName: string;
  /** concrete models.dev specifier, e.g. "anthropic/claude-opus-4-6" */
  resolve: string;
  /** full models.dev specifier for the OpenRouter equivalent, e.g. "openrouter/anthropic/claude-opus-4.6" */
  openRouterResolve?: string;
  preferred?: boolean;
  envVars?: readonly string[];
  isFree?: boolean;
  /** slug of a replacement model — presence implies this model is deprecated */
  fallback?: string;
}

export interface ProviderConfig {
  displayName: string;
  envVars: readonly string[];
  models: Record<string, ModelDef>;
}

// ── provider + model definitions ────────────────────────────────────────────────

function provider(config: ProviderConfig): ProviderConfig {
  return config;
}

export const providers = {
  anthropic: provider({
    displayName: "Anthropic",
    envVars: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    models: {
      "claude-opus": {
        displayName: "Claude Opus",
        resolve: "anthropic/claude-opus-4-7",
        openRouterResolve: "openrouter/anthropic/claude-opus-4.7",
        preferred: true,
      },
      "claude-sonnet": {
        displayName: "Claude Sonnet",
        resolve: "anthropic/claude-sonnet-4-6",
        openRouterResolve: "openrouter/anthropic/claude-sonnet-4.6",
      },
      "claude-haiku": {
        displayName: "Claude Haiku",
        resolve: "anthropic/claude-haiku-4-5",
        openRouterResolve: "openrouter/anthropic/claude-haiku-4.5",
      },
    },
  }),
  openai: provider({
    displayName: "OpenAI",
    envVars: ["OPENAI_API_KEY"],
    models: {
      gpt: {
        displayName: "GPT",
        resolve: "openai/gpt-5.5",
        openRouterResolve: "openrouter/openai/gpt-5.5",
        preferred: true,
      },
      "gpt-pro": {
        displayName: "GPT Pro",
        resolve: "openai/gpt-5.5-pro",
        openRouterResolve: "openrouter/openai/gpt-5.5-pro",
      },
      "gpt-mini": {
        displayName: "GPT Mini",
        resolve: "openai/gpt-5.4-mini",
        openRouterResolve: "openrouter/openai/gpt-5.4-mini",
      },
      // legacy aliases — openai unified the codex line into the main GPT family
      // and is shutting down every "-codex" snapshot on 2026-07-23. transparently
      // upgrade existing users via the fallback chain. UI display sites resolve
      // to the terminal alias's label (so dropdown trigger + PR footers show
      // "GPT" / "GPT Mini", not the historical name).
      "gpt-codex": {
        displayName: "GPT Codex",
        resolve: "openai/gpt-5.3-codex",
        openRouterResolve: "openrouter/openai/gpt-5.3-codex",
        fallback: "openai/gpt",
      },
      "gpt-codex-mini": {
        displayName: "GPT Codex Mini",
        resolve: "openai/gpt-5.1-codex-mini",
        openRouterResolve: "openrouter/openai/gpt-5.1-codex-mini",
        fallback: "openai/gpt-mini",
      },
      o3: {
        displayName: "O3",
        resolve: "openai/o3",
      },
    },
  }),
  google: provider({
    displayName: "Google",
    envVars: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    models: {
      "gemini-pro": {
        displayName: "Gemini Pro",
        resolve: "google/gemini-3.1-pro-preview",
        openRouterResolve: "openrouter/google/gemini-3.1-pro-preview",
        preferred: true,
      },
      "gemini-flash": {
        displayName: "Gemini Flash",
        resolve: "google/gemini-3-flash-preview",
        openRouterResolve: "openrouter/google/gemini-3-flash-preview",
      },
    },
  }),
  xai: provider({
    displayName: "xAI",
    envVars: ["XAI_API_KEY"],
    models: {
      grok: {
        displayName: "Grok",
        resolve: "xai/grok-4.3",
        openRouterResolve: "openrouter/x-ai/grok-4.3",
        preferred: true,
      },
      "grok-fast": {
        displayName: "Grok Fast",
        resolve: "xai/grok-4-1-fast",
        openRouterResolve: "openrouter/x-ai/grok-4.1-fast",
      },
      "grok-code-fast": {
        displayName: "Grok Code Fast",
        resolve: "xai/grok-code-fast-1",
        openRouterResolve: "openrouter/x-ai/grok-code-fast-1",
      },
    },
  }),
  deepseek: provider({
    displayName: "DeepSeek",
    envVars: ["DEEPSEEK_API_KEY"],
    models: {
      "deepseek-pro": {
        displayName: "DeepSeek Pro",
        resolve: "deepseek/deepseek-v4-pro",
        openRouterResolve: "openrouter/deepseek/deepseek-v4-pro",
        preferred: true,
      },
      "deepseek-flash": {
        displayName: "DeepSeek Flash",
        resolve: "deepseek/deepseek-v4-flash",
        openRouterResolve: "openrouter/deepseek/deepseek-v4-flash",
      },
      // legacy aliases — deepseek retires these on 2026-07-24; transparently
      // upgrade existing users to the v4 family via the fallback chain.
      "deepseek-reasoner": {
        displayName: "DeepSeek Reasoner",
        resolve: "deepseek/deepseek-reasoner",
        openRouterResolve: "openrouter/deepseek/deepseek-v3.2",
        fallback: "deepseek/deepseek-pro",
      },
      "deepseek-chat": {
        displayName: "DeepSeek Chat",
        resolve: "deepseek/deepseek-chat",
        openRouterResolve: "openrouter/deepseek/deepseek-v3.2",
        fallback: "deepseek/deepseek-flash",
      },
    },
  }),
  moonshotai: provider({
    displayName: "Moonshot AI",
    envVars: ["MOONSHOT_API_KEY"],
    models: {
      "kimi-k2": {
        displayName: "Kimi K2",
        resolve: "moonshotai/kimi-k2.6",
        openRouterResolve: "openrouter/moonshotai/kimi-k2.6",
        preferred: true,
      },
    },
  }),
  opencode: provider({
    displayName: "OpenCode",
    envVars: ["OPENCODE_API_KEY"],
    models: {
      "big-pickle": {
        displayName: "Big Pickle",
        resolve: "opencode/big-pickle",
        preferred: true,
        envVars: [],
        isFree: true,
      },
      "claude-opus": {
        displayName: "Claude Opus",
        resolve: "opencode/claude-opus-4-7",
        openRouterResolve: "openrouter/anthropic/claude-opus-4.7",
      },
      "claude-sonnet": {
        displayName: "Claude Sonnet",
        resolve: "opencode/claude-sonnet-4-6",
        openRouterResolve: "openrouter/anthropic/claude-sonnet-4.6",
      },
      "claude-haiku": {
        displayName: "Claude Haiku",
        resolve: "opencode/claude-haiku-4-5",
        openRouterResolve: "openrouter/anthropic/claude-haiku-4.5",
      },
      gpt: {
        displayName: "GPT",
        resolve: "opencode/gpt-5.5",
        openRouterResolve: "openrouter/openai/gpt-5.5",
      },
      "gpt-pro": {
        displayName: "GPT Pro",
        resolve: "opencode/gpt-5.5-pro",
        openRouterResolve: "openrouter/openai/gpt-5.5-pro",
      },
      "gpt-mini": {
        displayName: "GPT Mini",
        resolve: "opencode/gpt-5.4-mini",
        openRouterResolve: "openrouter/openai/gpt-5.4-mini",
      },
      // legacy aliases — see openai provider above for context.
      "gpt-codex": {
        displayName: "GPT Codex",
        resolve: "opencode/gpt-5.3-codex",
        openRouterResolve: "openrouter/openai/gpt-5.3-codex",
        fallback: "opencode/gpt",
      },
      "gpt-codex-mini": {
        displayName: "GPT Codex Mini",
        resolve: "opencode/gpt-5.1-codex-mini",
        openRouterResolve: "openrouter/openai/gpt-5.1-codex-mini",
        fallback: "opencode/gpt-mini",
      },
      "gemini-pro": {
        displayName: "Gemini Pro",
        resolve: "opencode/gemini-3.1-pro",
        openRouterResolve: "openrouter/google/gemini-3.1-pro-preview",
      },
      "gemini-flash": {
        displayName: "Gemini Flash",
        resolve: "opencode/gemini-3-flash",
        openRouterResolve: "openrouter/google/gemini-3-flash-preview",
      },
      "kimi-k2": {
        displayName: "Kimi K2",
        resolve: "opencode/kimi-k2.6",
        openRouterResolve: "openrouter/moonshotai/kimi-k2.6",
      },
      "gpt-5-nano": {
        displayName: "GPT Nano",
        resolve: "opencode/gpt-5-nano",
        openRouterResolve: "openrouter/openai/gpt-5-nano",
      },
      "mimo-v2-pro-free": {
        displayName: "MiMo V2 Pro",
        resolve: "opencode/mimo-v2-pro-free",
        envVars: [],
        isFree: true,
        fallback: "opencode/big-pickle",
      },
      "minimax-m2.5-free": {
        displayName: "MiniMax M2.5",
        resolve: "opencode/minimax-m2.5-free",
        envVars: [],
        isFree: true,
      },
    },
  }),
  openrouter: provider({
    displayName: "OpenRouter",
    envVars: ["OPENROUTER_API_KEY"],
    models: {
      "claude-opus": {
        displayName: "Claude Opus",
        resolve: "openrouter/anthropic/claude-opus-4.7",
        openRouterResolve: "openrouter/anthropic/claude-opus-4.7",
        preferred: true,
      },
      "claude-sonnet": {
        displayName: "Claude Sonnet",
        resolve: "openrouter/anthropic/claude-sonnet-4.6",
        openRouterResolve: "openrouter/anthropic/claude-sonnet-4.6",
      },
      "claude-haiku": {
        displayName: "Claude Haiku",
        resolve: "openrouter/anthropic/claude-haiku-4.5",
        openRouterResolve: "openrouter/anthropic/claude-haiku-4.5",
      },
      gpt: {
        displayName: "GPT",
        resolve: "openrouter/openai/gpt-5.5",
        openRouterResolve: "openrouter/openai/gpt-5.5",
      },
      "gpt-pro": {
        displayName: "GPT Pro",
        resolve: "openrouter/openai/gpt-5.5-pro",
        openRouterResolve: "openrouter/openai/gpt-5.5-pro",
      },
      "gpt-mini": {
        displayName: "GPT Mini",
        resolve: "openrouter/openai/gpt-5.4-mini",
        openRouterResolve: "openrouter/openai/gpt-5.4-mini",
      },
      // legacy aliases — see openai provider for context.
      "gpt-codex": {
        displayName: "GPT Codex",
        resolve: "openrouter/openai/gpt-5.3-codex",
        openRouterResolve: "openrouter/openai/gpt-5.3-codex",
        fallback: "openrouter/gpt",
      },
      "gpt-codex-mini": {
        displayName: "GPT Codex Mini",
        resolve: "openrouter/openai/gpt-5.1-codex-mini",
        openRouterResolve: "openrouter/openai/gpt-5.1-codex-mini",
        fallback: "openrouter/gpt-mini",
      },
      "o4-mini": {
        displayName: "O4 Mini",
        resolve: "openrouter/openai/o4-mini",
        openRouterResolve: "openrouter/openai/o4-mini",
      },
      "gemini-pro": {
        displayName: "Gemini Pro",
        resolve: "openrouter/google/gemini-3.1-pro-preview",
        openRouterResolve: "openrouter/google/gemini-3.1-pro-preview",
      },
      "gemini-flash": {
        displayName: "Gemini Flash",
        resolve: "openrouter/google/gemini-3-flash-preview",
        openRouterResolve: "openrouter/google/gemini-3-flash-preview",
      },
      grok: {
        displayName: "Grok",
        resolve: "openrouter/x-ai/grok-4.3",
        openRouterResolve: "openrouter/x-ai/grok-4.3",
      },
      "deepseek-pro": {
        displayName: "DeepSeek Pro",
        resolve: "openrouter/deepseek/deepseek-v4-pro",
        openRouterResolve: "openrouter/deepseek/deepseek-v4-pro",
      },
      "deepseek-flash": {
        displayName: "DeepSeek Flash",
        resolve: "openrouter/deepseek/deepseek-v4-flash",
        openRouterResolve: "openrouter/deepseek/deepseek-v4-flash",
      },
      // legacy alias — deepseek retires this on 2026-07-24; transparently
      // upgrade existing users to the v4 family via the fallback chain.
      "deepseek-chat": {
        displayName: "DeepSeek Chat",
        resolve: "openrouter/deepseek/deepseek-v3.2",
        openRouterResolve: "openrouter/deepseek/deepseek-v3.2",
        fallback: "openrouter/deepseek-flash",
      },
      "kimi-k2": {
        displayName: "Kimi K2",
        resolve: "openrouter/moonshotai/kimi-k2.6",
        openRouterResolve: "openrouter/moonshotai/kimi-k2.6",
      },
    },
  }),
} satisfies Record<string, ProviderConfig>;

export type ModelProvider = keyof typeof providers;

// ── slug parsing ───────────────────────────────────────────────────────────────

export function parseModel(slug: string): { provider: string; model: string } {
  const slashIdx = slug.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(`invalid model slug "${slug}" — expected "provider/model"`);
  }
  return { provider: slug.slice(0, slashIdx), model: slug.slice(slashIdx + 1) };
}

export function getModelProvider(slug: string): string {
  return parseModel(slug).provider;
}

export function getProviderDisplayName(slug: string): string | undefined {
  const parsed = parseModel(slug);
  return (providers as Record<string, ProviderConfig>)[parsed.provider]?.displayName;
}

export function getModelEnvVars(slug: string): string[] {
  const parsed = parseModel(slug);
  const providerConfig = (providers as Record<string, ProviderConfig>)[parsed.provider];
  if (!providerConfig) {
    return [];
  }

  const modelConfig = providerConfig.models[parsed.model];
  if (modelConfig?.envVars) {
    return modelConfig.envVars.slice();
  }

  return providerConfig.envVars.slice();
}

// ── derived flat list ──────────────────────────────────────────────────────────

export const modelAliases: ModelAlias[] = Object.entries(providers).flatMap(
  ([providerKey, config]) =>
    Object.entries(config.models).map(([modelId, def]) => ({
      slug: `${providerKey}/${modelId}`,
      provider: providerKey,
      displayName: def.displayName,
      resolve: def.resolve,
      openRouterResolve: def.openRouterResolve,
      preferred: def.preferred ?? false,
      isFree: def.isFree ?? false,
      fallback: def.fallback,
    }))
);

// ── resolution ─────────────────────────────────────────────────────────────────

/** resolve a model slug to its concrete models.dev specifier (e.g. "anthropic/claude-opus-4-6") */
export function resolveModelSlug(slug: string): string | undefined {
  return modelAliases.find((a) => a.slug === slug)?.resolve;
}

const MAX_FALLBACK_DEPTH = 10;

/**
 * walk the fallback chain to the terminal (non-deprecated) alias.
 * returns undefined if the chain is broken, exhausted, or cyclic.
 *
 * use this in UI display sites (dropdown trigger labels, PR-comment footers,
 * etc.) so a deprecated stored slug renders as the model the user actually
 * runs against — not the historical name. selectable lists should still hide
 * deprecated aliases by filtering on `!a.fallback`.
 */
export function resolveDisplayAlias(slug: string): ModelAlias | undefined {
  let current = slug;
  const visited = new Set<string>();
  for (let i = 0; i < MAX_FALLBACK_DEPTH; i++) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const alias = modelAliases.find((a) => a.slug === current);
    if (!alias) return undefined;
    if (!alias.fallback) return alias;
    current = alias.fallback;
  }
  return undefined;
}

/**
 * resolve a model slug to the CLI-ready model string, following the fallback
 * chain when a model is deprecated. returns the first non-deprecated resolve
 * target, or undefined if the chain is exhausted or broken.
 */
export function resolveCliModel(slug: string): string | undefined {
  return resolveDisplayAlias(slug)?.resolve;
}

/**
 * resolve a model slug to the OpenRouter-ready model string, following the
 * fallback chain when a model is deprecated. returns undefined if the chain
 * is exhausted/broken or the terminal alias has no openrouter equivalent
 * (e.g. free opencode models).
 */
export function resolveOpenRouterModel(slug: string): string | undefined {
  return resolveDisplayAlias(slug)?.openRouterResolve;
}
