/**
 * emits a JSON array of { slug, agent, name } entries for one of two CI matrix
 * jobs. `agent` mirrors the harness the runtime would pick in production
 * (anthropic/* → claude, everything else → opencode).
 *
 * MODE=aliases (default) — every alias minus pruned passthroughs. consumed by
 *   `models-live`, which runs the cheap top-level CLI smoke per alias
 *   (`action/test/model-smoke.ts`) to validate resolution + auth.
 *
 * MODE=flagships — one standard-tier model per provider. consumed by
 *   `providers-live`, which runs the full harness smoke
 *   (`pnpm runtest smoke <agent>`) to validate provider-class tool-calling
 *   (e.g. Gemini schema sanitizer, OpenAI tool-call format). flagship slugs
 *   live in `providers.ts` alongside their per-provider coverage globs.
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
 *
 * NOTE: the per-PR-precision matrix lives in `matrix.ts`, which calls into
 * this file. raw invocation here emits the unfiltered matrix.
 */
import { modelAliases } from "../models.ts";
import { providers } from "./providers.ts";

const ROUTING_CANARIES = new Set(["openrouter/claude-sonnet", "opencode/claude-sonnet"]);

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

export type MatrixEntry = {
  slug: string;
  agent: string;
  name: string;
};

function toMatrixEntry(alias: (typeof modelAliases)[number]): MatrixEntry {
  return {
    slug: alias.slug,
    agent: alias.slug.startsWith("anthropic/") ? "claude" : "opencode",
    // readable display name (GHA renders slashes awkwardly in matrix job titles)
    name: alias.slug.replace("/", "-"),
  };
}

const aliasBySlug = new Map(modelAliases.map((a) => [a.slug, a]));

export function buildAliasMatrix(opts: {
  filter?: string;
  includePassthroughs?: boolean;
}): MatrixEntry[] {
  const filter = opts.filter ?? "";
  const includePassthroughs = opts.includePassthroughs ?? false;
  return modelAliases
    .filter((alias) => {
      if (filter && !alias.slug.toLowerCase().includes(filter)) return false;
      if (!includePassthroughs && isPrunablePassthrough(alias)) return false;
      return true;
    })
    .map(toMatrixEntry);
}

export function buildFlagshipMatrix(opts: { filter?: string }): MatrixEntry[] {
  const filter = opts.filter ?? "";
  return providers
    .map((p) => {
      const alias = aliasBySlug.get(p.flagship);
      if (!alias) {
        throw new Error(
          `list-aliases: flagship "${p.flagship}" missing from modelAliases — update providers.ts`
        );
      }
      return alias;
    })
    .filter((alias) => !filter || alias.slug.toLowerCase().includes(filter))
    .map(toMatrixEntry);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.env.MODE === "flagships" ? "flagships" : "aliases";
  const filter = process.env.MATRIX_FILTER?.trim().toLowerCase() ?? "";
  const includePassthroughs = process.env.INCLUDE_PASSTHROUGHS === "1";
  const matrix =
    mode === "flagships"
      ? buildFlagshipMatrix({ filter })
      : buildAliasMatrix({ filter, includePassthroughs });
  process.stdout.write(JSON.stringify(matrix));
}
