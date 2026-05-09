/**
 * emits a JSON array of { slug, agent, name } entries for the `models-live`
 * matrix job. `agent` is auto-derived from the alias provider and matches the
 * harness the runtime would pick in production.
 *
 * set MATRIX_FILTER to a substring to restrict the matrix to matching aliases
 * — useful for iterating on a single provider without paying for every model.
 *
 * passthrough pruning: openrouter/* aliases and keyed opencode/* aliases are
 * just routing-layer wrappers around models we already smoke-test directly
 * (anthropic/*, openai/*, google/*, etc). running every passthrough burns CI
 * minutes without catching anything the direct smoke doesn't. we keep one
 * canary per routing layer to validate the routing layer itself is alive;
 * slug-drift is caught separately by the `models-catalog` job. set
 * INCLUDE_ALL_PASSTHROUGHS=1 to bypass this for full validation.
 *
 * usage:
 *   node action/test/list-aliases.ts
 *   MATRIX_FILTER=gemini node action/test/list-aliases.ts
 *   INCLUDE_ALL_PASSTHROUGHS=1 node action/test/list-aliases.ts
 *   INCLUDE_EXPENSIVE=1 node action/test/list-aliases.ts
 */
import { modelAliases } from "../models.ts";

function agentForSlug(slug: string): "claude" | "opencode" {
  return slug.startsWith("anthropic/") ? "claude" : "opencode";
}

// one canary per routing layer — proves the routing surface (auth, tool-call
// translation) is alive without re-testing every underlying model.
const ROUTING_CANARIES = new Set(["openrouter/claude-sonnet", "opencode/claude-sonnet"]);

// pruned by default; opt back in with INCLUDE_EXPENSIVE=1 or MATRIX_FILTER.
// matched against `alias.resolve` so every routing layer (openai/, opencode/,
// openrouter/) is covered without enumerating each slug separately.
// gpt-5.5-pro burns ~$2.40/run on this fixture — too expensive per-push.
const EXPENSIVE_RESOLVE_SUBSTRINGS = ["gpt-5.5-pro"];

function isExpensive(alias: (typeof modelAliases)[number]): boolean {
  return EXPENSIVE_RESOLVE_SUBSTRINGS.some((s) => alias.resolve.includes(s));
}

function isPrunablePassthrough(alias: (typeof modelAliases)[number]): boolean {
  if (ROUTING_CANARIES.has(alias.slug)) return false;
  if (alias.provider === "openrouter") return true;
  // opencode FREE models (big-pickle, mimo, minimax, gpt-5-nano) are unique
  // to opencode and used in prod — keep them. only prune the keyed mirrors.
  if (alias.provider === "opencode" && !alias.isFree) return true;
  return false;
}

const filter = process.env.MATRIX_FILTER?.trim() ?? "";
const includeAllPassthroughs = process.env.INCLUDE_ALL_PASSTHROUGHS === "1";
const includeExpensive = process.env.INCLUDE_EXPENSIVE === "1" || filter !== "";

const matrix = modelAliases
  .filter((alias) => (filter ? alias.slug.toLowerCase().includes(filter.toLowerCase()) : true))
  .filter((alias) => includeAllPassthroughs || !isPrunablePassthrough(alias))
  .filter((alias) => includeExpensive || !isExpensive(alias))
  .map((alias) => ({
    slug: alias.slug,
    agent: agentForSlug(alias.slug),
    // readable display name (GHA renders slashes awkwardly in matrix job titles)
    name: alias.slug.replace("/", "-"),
  }));

process.stdout.write(JSON.stringify(matrix));
