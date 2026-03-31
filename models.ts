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
        resolve: "anthropic/claude-opus-4-6",
        openRouterResolve: "openrouter/anthropic/claude-opus-4.6",
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
      "gpt-codex": {
        displayName: "GPT Codex",
        resolve: "openai/gpt-5.3-codex",
        openRouterResolve: "openrouter/openai/gpt-5.3-codex",
        preferred: true,
      },
      "gpt-codex-mini": {
        displayName: "GPT Codex Mini",
        resolve: "openai/codex-mini-latest",
        openRouterResolve: "openrouter/openai/gpt-5.1-codex-mini",
      },
      o3: {
        displayName: "O3",
        resolve: "openai/o3",
      },
    },
  }),
  google: provider({
    displayName: "Google",
    envVars: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
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
        resolve: "xai/grok-4",
        openRouterResolve: "openrouter/x-ai/grok-4",
        preferred: true,
      },
      "grok-fast": {
        displayName: "Grok Fast",
        resolve: "xai/grok-4-fast",
        openRouterResolve: "openrouter/x-ai/grok-4-fast",
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
      "deepseek-reasoner": {
        displayName: "DeepSeek Reasoner",
        resolve: "deepseek/deepseek-reasoner",
        openRouterResolve: "openrouter/deepseek/deepseek-v3.2",
        preferred: true,
      },
      "deepseek-chat": {
        displayName: "DeepSeek Chat",
        resolve: "deepseek/deepseek-chat",
        openRouterResolve: "openrouter/deepseek/deepseek-v3.2",
      },
    },
  }),
  moonshotai: provider({
    displayName: "Moonshot AI",
    envVars: ["MOONSHOT_API_KEY"],
    models: {
      "kimi-k2": {
        displayName: "Kimi K2",
        resolve: "moonshotai/kimi-k2.5",
        openRouterResolve: "openrouter/moonshotai/kimi-k2.5",
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
        resolve: "opencode/claude-opus-4-6",
        openRouterResolve: "openrouter/anthropic/claude-opus-4.6",
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
      "gpt-codex": {
        displayName: "GPT Codex",
        resolve: "opencode/gpt-5.3-codex",
        openRouterResolve: "openrouter/openai/gpt-5.3-codex",
      },
      "gpt-codex-mini": {
        displayName: "GPT Codex Mini",
        resolve: "opencode/gpt-5.1-codex-mini",
        openRouterResolve: "openrouter/openai/gpt-5.1-codex-mini",
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
        resolve: "opencode/kimi-k2.5",
        openRouterResolve: "openrouter/moonshotai/kimi-k2.5",
      },
      "gpt-5-nano": {
        displayName: "GPT Nano",
        resolve: "opencode/gpt-5-nano",
        envVars: [],
        isFree: true,
      },
      "mimo-v2-pro-free": {
        displayName: "MiMo V2 Pro",
        resolve: "opencode/mimo-v2-pro-free",
        envVars: [],
        isFree: true,
      },
      "minimax-m2.5-free": {
        displayName: "MiniMax M2.5",
        resolve: "opencode/minimax-m2.5-free",
        envVars: [],
        isFree: true,
      },
      "nemotron-3-super-free": {
        displayName: "Nemotron 3 Super",
        resolve: "opencode/nemotron-3-super-free",
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
        resolve: "openrouter/anthropic/claude-opus-4.6",
        openRouterResolve: "openrouter/anthropic/claude-opus-4.6",
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
      "gpt-codex": {
        displayName: "GPT Codex",
        resolve: "openrouter/openai/gpt-5.3-codex",
        openRouterResolve: "openrouter/openai/gpt-5.3-codex",
      },
      "gpt-codex-mini": {
        displayName: "GPT Codex Mini",
        resolve: "openrouter/openai/gpt-5.1-codex-mini",
        openRouterResolve: "openrouter/openai/gpt-5.1-codex-mini",
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
        resolve: "openrouter/x-ai/grok-4",
        openRouterResolve: "openrouter/x-ai/grok-4",
      },
      "deepseek-chat": {
        displayName: "DeepSeek Chat",
        resolve: "openrouter/deepseek/deepseek-v3.2",
        openRouterResolve: "openrouter/deepseek/deepseek-v3.2",
      },
      "kimi-k2": {
        displayName: "Kimi K2",
        resolve: "openrouter/moonshotai/kimi-k2.5",
        openRouterResolve: "openrouter/moonshotai/kimi-k2.5",
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
    }))
);

// ── resolution ─────────────────────────────────────────────────────────────────

/** resolve a model slug to its concrete models.dev specifier (e.g. "anthropic/claude-opus-4-6") */
export function resolveModelSlug(slug: string): string | undefined {
  return modelAliases.find((a) => a.slug === slug)?.resolve;
}

/** resolve a model slug to the CLI-ready model string (full models.dev specifier) */
export function resolveCliModel(slug: string): string | undefined {
  return resolveModelSlug(slug);
}
