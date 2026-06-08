import type { AgentId } from "../external.ts";

/**
 * Slug we fall back to when a BYOK-required model is configured but the
 * runner has no provider key in env. Picked because it's free, stable, and
 * currently served by OpenCode Zen without a key.
 *
 * The slug is intentionally hard-coded and not a config knob — the
 * fallback is a safety net, not a user-facing preference, and adding a
 * config surface here would just push the same "what to fall back to"
 * decision into another setting that goes stale the same way.
 */
export const FREE_FALLBACK_SLUG = "opencode/big-pickle";

export type FallbackDecision = { fallback: false } | { fallback: true; from: string; to: string };

/**
 * If the resolved model is NOT in OpenCode's `authorized` set (the
 * authoritative "what can OpenCode route right now" snapshot captured
 * after dbSecrets + Codex auth.json are in place), swap to a free
 * OpenCode slug so the run can still produce value. Caller is responsible
 * for surfacing the swap (log line + run summary).
 *
 * Skip cases (return `fallback: false` without consulting `authorized`):
 *   - Router / proxy runs (`proxyModel` set): Pullfrog mints the key.
 *   - No resolved model: auto-select handles it downstream.
 *   - Resolved model is the free fallback already.
 *   - Resolved model is a raw Bedrock / Vertex ID (no `/`): the routing
 *     validators (`validateBedrockSetup` / `validateVertexSetup`) cover
 *     auth + region/location/model-id; `opencode models` does not.
 *   - The selected agent is `claude`: the Claude Code harness brings its own
 *     auth and `resolveAgent` only returns it when that auth is present.
 *     `opencode models` can't see `CLAUDE_CODE_OAUTH_TOKEN`, so without this
 *     an OAuth-subscription run on an Anthropic model would wrongly fall back.
 */
export function selectFallbackModelIfNeeded(input: {
  resolvedModel: string | undefined;
  proxyModel: string | undefined;
  authorized: Set<string>;
  agentName: AgentId;
}): FallbackDecision {
  if (input.proxyModel) return { fallback: false };
  if (!input.resolvedModel) return { fallback: false };
  if (input.resolvedModel === FREE_FALLBACK_SLUG) return { fallback: false };
  if (!input.resolvedModel.includes("/")) return { fallback: false };
  if (input.agentName === "claude") return { fallback: false };
  if (input.authorized.has(input.resolvedModel)) return { fallback: false };
  return {
    fallback: true,
    from: input.resolvedModel,
    to: FREE_FALLBACK_SLUG,
  };
}
