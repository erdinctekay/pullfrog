/**
 * emits a JSON array of { slug, agent, name } entries for one of two CI matrix
 * jobs. `agent` mirrors the harness the runtime would pick in production
 * (anthropic/* → claude-code, everything else → opencode).
 *
 * MODE=aliases (default) — every alias minus pruned passthroughs. consumed by
 *   `models-live`, which runs the cheap top-level CLI smoke per alias
 *   (`action/test/model-smoke.ts`) to validate resolution + auth.
 *
 * MODE=flagships — one standard-tier model per provider. consumed by
 *   `providers-live`, which runs the full harness smoke
 *   (`pnpm runtest smoke <agent>`) to validate provider-class tool-calling
 *   (e.g. Gemini schema sanitizer, OpenAI tool-call format).
 *
 * passthrough pruning (aliases mode): openrouter/* aliases and keyed opencode/*
 * aliases are routing-layer wrappers around models we already smoke-test
 * directly. running every passthrough burns CI minutes without catching
 * anything new — slug-drift is covered by the `models-catalog` job. one canary
 * per routing layer proves the routing surface (auth, tool-call translation)
 * is alive; set INCLUDE_PASSTHROUGHS=1 to bypass for full validation.
 *
 * usage:
 *   node action/test/list-aliases.ts
 *   MODE=flagships node action/test/list-aliases.ts
 *   MATRIX_FILTER=gemini node action/test/list-aliases.ts
 *   INCLUDE_PASSTHROUGHS=1 node action/test/list-aliases.ts
 */
import { modelAliases } from "../models.ts";

const ROUTING_CANARIES = new Set(["openrouter/claude-sonnet", "opencode/claude-sonnet"]);

// hand-picked "standard good model" per provider — not the pro/opus tier (too
// expensive for per-push) and not the free/experimental tier (too flaky). these
// aliases anchor the harness smoke job that catches provider-class regressions
// like Gemini schema sanitization or OpenAI tool-call format drift. the
// assertion below catches slug-drift loudly, but adding a NEW provider without
// an entry here silently omits it from `providers-live` — see
// wiki/models-catalog.md "To add a provider".
const FLAGSHIPS = [
  "anthropic/claude-sonnet",
  "openai/gpt",
  "google/gemini-pro",
  "xai/grok",
  "deepseek/deepseek-pro",
  "moonshotai/kimi-k2",
  "opencode/big-pickle",
  "openrouter/claude-sonnet",
];

function isPrunablePassthrough(alias: (typeof modelAliases)[number]): boolean {
  if (ROUTING_CANARIES.has(alias.slug)) return false;
  if (alias.provider === "openrouter") return true;
  // routing slugs (bedrock/byok) need a per-run env var to pick the actual
  // model — there's no generic smoke test, so prune from both matrices.
  if (alias.routing) return true;
  // opencode FREE models (big-pickle, mimo-v2-pro-free, minimax-m2.5-free)
  // are unique to opencode and used in prod — keep them. only prune the keyed
  // mirrors.
  return alias.provider === "opencode" && !alias.isFree;
}

function toMatrixEntry(alias: (typeof modelAliases)[number]) {
  return {
    slug: alias.slug,
    agent: alias.slug.startsWith("anthropic/") ? "claude" : "opencode",
    // readable display name (GHA renders slashes awkwardly in matrix job titles)
    name: alias.slug.replace("/", "-"),
  };
}

const mode = process.env.MODE === "flagships" ? "flagships" : "aliases";
const filter = process.env.MATRIX_FILTER?.trim().toLowerCase() ?? "";
const includePassthroughs = process.env.INCLUDE_PASSTHROUGHS === "1";

const aliasBySlug = new Map(modelAliases.map((a) => [a.slug, a]));
const matrix = (() => {
  if (mode === "flagships") {
    return FLAGSHIPS.map((slug) => {
      const alias = aliasBySlug.get(slug);
      if (!alias) {
        throw new Error(
          `list-aliases: flagship "${slug}" missing from modelAliases — update FLAGSHIPS`
        );
      }
      return alias;
    })
      .filter((alias) => !filter || alias.slug.toLowerCase().includes(filter))
      .map(toMatrixEntry);
  }
  return modelAliases
    .filter((alias) => {
      if (filter && !alias.slug.toLowerCase().includes(filter)) return false;
      if (!includePassthroughs && isPrunablePassthrough(alias)) return false;
      return true;
    })
    .map(toMatrixEntry);
})();

process.stdout.write(JSON.stringify(matrix));
