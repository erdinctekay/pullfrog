/**
 * Mint an OpenRouter proxy key via `/api/proxy-token` and inject it as
 * `OPENROUTER_API_KEY` for runs that route through Pullfrog Router (managed
 * billing accounts) or OSS-grant paths.
 *
 * Authenticates one of two ways:
 *   - production: GitHub Actions OIDC token minted from the stashed
 *     credentials via `fetchIdTokenFromStash` (env-free)
 *   - local dev (`API_URL` is localhost): `x-dev-repo` header bypass
 *
 * `runProxyResolution` is the entrypoint `main.ts` calls. It wraps
 * `resolveProxyModel` and renders the user-facing copy itself (job summary
 * + PR progress comment) before rethrowing the structured error — handled
 * here, not in the outer `main()` catch, because `toolContext` doesn't
 * exist yet at this point in the pipeline.
 *
 *   - 402 → `BillingError` (card declined, balance empty, 3DS, etc.)
 *   - 503 → `TransientError` (transient sync issue — retry next dispatch)
 */

import * as core from "@actions/core";
import type { ToolState } from "../toolState.ts";
import { apiFetch } from "./apiFetch.ts";
import { isLocalApiUrl } from "./apiUrl.ts";
import {
  BillingError,
  formatBillingErrorSummary,
  formatTransientErrorSummary,
  TransientError,
} from "./billingErrors.ts";
import { log, writeSummary } from "./cli.ts";
import { reportErrorToComment } from "./errorReport.ts";
import { fetchIdTokenFromStash, isTransientTokenError, type OidcCredentials } from "./github.ts";
import type { ResolvedPayload } from "./payload.ts";
import { retry } from "./retry.ts";

async function mintProxyKey(ctx: {
  oidcCredentials: OidcCredentials | null;
  repo: { owner: string; name: string };
}): Promise<string | null> {
  try {
    const headers = await buildProxyTokenHeaders(ctx);
    if (!headers) return null;

    const response = await apiFetch({
      path: "/api/proxy-token",
      method: "POST",
      headers,
    });

    if (response.status === 402) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        code?: string;
        declineCode?: string;
        needsReauthentication?: boolean;
      } | null;
      throw new BillingError(body?.error ?? "insufficient balance", {
        code: body?.code ?? null,
        declineCode: body?.declineCode ?? null,
        needsReauthentication: body?.needsReauthentication ?? false,
      });
    }

    // 503 = transient sync issue (partial OpenRouter failure, DB flake,
    // in-flight top-up). Not the user's fault — TransientError renders a
    // "temporarily unavailable" summary instead of the "billing error"
    // label that BillingError uses.
    if (response.status === 503) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new TransientError(
        body?.error ?? "billing service temporarily unavailable — retry shortly"
      );
    }

    if (!response.ok) {
      log.warning(`proxy key mint failed (${response.status})`);
      return null;
    }

    const data = (await response.json()) as { key: string };
    return data.key;
  } catch (error) {
    if (error instanceof BillingError) throw error;
    if (error instanceof TransientError) throw error;
    log.warning(`proxy key mint error: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * choose how to authenticate the `/api/proxy-token` request:
 *
 * - production: mint a fresh OIDC token from the stashed credentials and
 *   send as `Authorization: Bearer …` (the server verifies it
 *   cryptographically). env-free, so the agent never sees the credentials
 *   even transiently.
 * - local dev (no OIDC + `API_URL` is localhost): send `x-dev-repo:
 *   owner/repo` instead. the server-side route only honors this header
 *   when `NODE_ENV === "development"`, so prod is never reachable through
 *   this branch even if the action is misconfigured.
 *
 * returns null when neither path is available — caller treats as soft skip.
 */
async function buildProxyTokenHeaders(ctx: {
  oidcCredentials: OidcCredentials | null;
  repo: { owner: string; name: string };
}): Promise<Record<string, string> | null> {
  if (ctx.oidcCredentials) {
    // retry transients — core.getIDToken (the previous mint path) retried
    // 5xx internally, and a soft-skip here degrades the run to BYOK
    const creds = ctx.oidcCredentials;
    const oidcToken = await retry(() => fetchIdTokenFromStash(creds), {
      label: "ID token mint",
      shouldRetry: isTransientTokenError,
    });
    return { Authorization: `Bearer ${oidcToken}` };
  }
  if (isLocalApiUrl()) {
    log.info(`» proxy: dev bypass (x-dev-repo) for ${ctx.repo.owner}/${ctx.repo.name}`);
    return { "x-dev-repo": `${ctx.repo.owner}/${ctx.repo.name}` };
  }
  return null;
}

/**
 * Decide whether this run needs a minted proxy key and, if so, mint and
 * inject it as `OPENROUTER_API_KEY`. Mutates `payload.proxyModel` on success.
 *
 * `ctx.proxyModel` IS the signal — the server (`run-context/route.ts`) is
 * the authority on "should this run use the Router". It already knows the
 * full picture (OSS, plan, wallet balance, modelAccessMode) and only sets
 * `proxyModel` when the gate passes. The action just trusts that signal
 * and mints. Re-deriving the gate locally was redundant and was strictly
 * more restrictive (no balance check), which made signup-credit runs on
 * no-card private repos silently fall through to BYOK.
 *
 * Skipped when:
 *   - `PULLFROG_MODEL` env override is set (BYOK escape hatch)
 *   - `proxyModel` is not set on the run context
 *   - no OIDC credentials available and not talking to a localhost API
 *
 * Throws `BillingError` (402) or `TransientError` (503); caller renders.
 */
async function resolveProxyModel(ctx: {
  payload: ResolvedPayload;
  oss: boolean;
  proxyModel?: string | undefined;
  oidcCredentials: OidcCredentials | null;
  repo: { owner: string; name: string };
}): Promise<void> {
  // env override = BYOK escape hatch, don't proxy
  if (process.env.PULLFROG_MODEL?.trim()) return;

  if (!ctx.proxyModel) return;

  // dev affordance: when talking to a localhost API, the server-side
  // x-dev-repo bypass replaces OIDC verification, so a play run can
  // exercise the proxy/router/oss path without GitHub Actions OIDC.
  if (!ctx.oidcCredentials && !isLocalApiUrl()) {
    log.warning("» proxy requested but no OIDC credentials available — skipping");
    return;
  }

  const key = await mintProxyKey({ oidcCredentials: ctx.oidcCredentials, repo: ctx.repo });
  if (!key) return;

  process.env.OPENROUTER_API_KEY = key;
  core.setSecret(key);
  ctx.payload.proxyModel = ctx.proxyModel;
  const label = ctx.oss ? "oss" : "router";
  log.info(`» proxy: ${label} → ${ctx.proxyModel}`);
}

/**
 * Run `resolveProxyModel`; if it throws a Billing or Transient error, render
 * the user-facing summary, mirror it to the PR progress comment, and rethrow.
 *
 * The rethrow is intentional: these errors are terminal for the run, and
 * letting them surface lets `runMain` exit non-zero so GH Actions applies
 * the workflow's retry policy. We catch them *here* (before the main try)
 * because the outer catch needs `toolContext` (which isn't built yet) for
 * its general-purpose rendering path — a BillingError landing in the outer
 * catch would get rendered with `core.setFailed` only, losing the
 * actionable copy + the PR-comment mirror.
 */
export async function runProxyResolution(ctx: {
  payload: ResolvedPayload;
  oss: boolean;
  proxyModel?: string | undefined;
  oidcCredentials: OidcCredentials | null;
  repo: { owner: string; name: string };
  toolState: ToolState;
}): Promise<void> {
  try {
    await resolveProxyModel({
      payload: ctx.payload,
      oss: ctx.oss,
      proxyModel: ctx.proxyModel,
      oidcCredentials: ctx.oidcCredentials,
      repo: ctx.repo,
    });
  } catch (error) {
    if (error instanceof BillingError) {
      const summary = formatBillingErrorSummary(error, ctx.repo.owner);
      await writeSummary(summary).catch(() => {});
      // Mirror to the PR progress comment if the trigger created one (mention /
      // PR event). When the trigger is silent (IncrementalReview on
      // pull_request_synchronize), no progress comment exists; fall through to
      // creating a fresh issue comment so the user actually sees the
      // billing-exhaustion remediation copy. Without `createIfMissing`,
      // auto-reload declines on silent triggers are visible only in the GH job
      // summary, which most users never open — so back-to-back pushes silently
      // burn through dispatches with no PR-side signal. see #775.
      await reportErrorToComment({
        toolState: ctx.toolState,
        error: summary,
        createIfMissing: true,
      }).catch(() => {});
      throw error;
    }
    if (error instanceof TransientError) {
      const summary = formatTransientErrorSummary(error, ctx.repo.owner);
      await writeSummary(summary).catch(() => {});
      await reportErrorToComment({
        toolState: ctx.toolState,
        error: summary,
        createIfMissing: true,
      }).catch(() => {});
      throw error;
    }
    throw error;
  }
}
