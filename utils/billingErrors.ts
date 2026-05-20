/**
 * Billing-error classification + user-facing copy for `/api/proxy-token`
 * failures and OpenRouter mid-run exhaustion. Two error classes (Billing vs.
 * Transient) keep the framing honest: a card decline is *not* the same UX as
 * a 503 from the proxy service. Both originate in `utils/proxy.ts` (mint
 * failures) and `utils/runErrorRenderer.ts` (mid-run keylimit reclassify).
 *
 * Renderers return markdown bodies that are written into both the GitHub
 * Actions job summary and the PR progress comment.
 *
 * Lives outside `main.ts` so adding a new error `code` branch is a one-file
 * edit that does not retrigger the full LLM CI matrix (`action/main.ts` is
 * in `action/test/coverage.ts::ALWAYS_RUN_ALL`).
 */

/**
 * Billing-layer error surfaced from `/api/proxy-token` as a 402. User-actionable
 * — distinct from TransientError (503 / transient sync issue) so the job
 * summary + PR comment can use affirmative "you need to do X" copy rather than
 * the ambiguous "billing error" label that makes transient outages look like
 * the user's fault.
 *
 * `code` is a server-side discriminator: `router_requires_card` (no card + no
 * wallet balance on Router), or null for unclassified. `declineCode` is
 * Stripe's more specific sub-reason on `card_declined` (e.g.
 * `insufficient_funds`, `lost_card`). `needsReauthentication` is the 3DS case
 * broken out for convenience.
 */
export class BillingError extends Error {
  code: string | null;
  declineCode: string | null;
  needsReauthentication: boolean;

  constructor(
    message: string,
    opts: {
      code?: string | null;
      declineCode?: string | null;
      needsReauthentication?: boolean;
    } = {}
  ) {
    super(message);
    this.name = "BillingError";
    this.code = opts.code ?? null;
    this.declineCode = opts.declineCode ?? null;
    this.needsReauthentication = opts.needsReauthentication ?? false;
  }
}

/**
 * Transient service failures from `/api/proxy-token` (503: partial OpenRouter
 * usage sync, DB flake, in-flight payment intent). Not the user's fault — the
 * summary uses "temporarily unavailable" framing, and the non-zero exit lets
 * GH Actions apply whatever retry policy the workflow has configured.
 */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

/**
 * Deep link into the right console section for the failing account. Anchors
 * are defined in `app/console/[owner]/page.tsx` (`#billing`, `#model-access`).
 * `owner` is the GitHub login of the repo's account — i.e. the org or user
 * that pays for this repo's runs, which is the right scope for billing.
 */
function billingConsoleUrl(owner: string, anchor: "billing" | "model-access"): string {
  return `https://pullfrog.com/console/${encodeURIComponent(owner)}#${anchor}`;
}

/**
 * Render a BillingError as user-facing markdown (shared between GH job summary
 * and the PR progress comment). Goals:
 *
 *   - quiet, not alarmist — bold first line instead of an `### ❌` H3, since
 *     the comment already has Pullfrog branding in the footer
 *   - actionable — every branch ends in a single CTA deep-linked to the
 *     correct section of the owner's console
 *   - honest — say what actually went wrong (card declined vs. balance
 *     empty vs. 3DS required), don't lump them under "billing error"
 *
 * Branches:
 *   - `router_requires_card`: user is on Router mode with no card AND no
 *     wallet balance (signup credit exhausted or not granted). Frame as
 *     "add a card to continue", link to `#model-access` where the Add
 *     Card flow lives.
 *   - `router_balance_exhausted`: user has a card on file but auto-reload is
 *     disabled and they've spent past their $5 overdraft buffer. Frame as
 *     "balance ran out" and surface both remediation paths (top up, or flip
 *     on auto-reload).
 *   - `router_keylimit_exhausted`: OpenRouter rejected mid-run because the
 *     per-run key budget was exhausted while the agent was working. The
 *     wallet is now negative; same remediation as `router_balance_exhausted`
 *     but framed for the after-the-fact case ("this run was cut short").
 *   - `needsReauthentication`: issuer requires 3DS on every off-session
 *     charge. Re-adding the card won't help — the only escape is a manual
 *     top-up where 3DS runs interactively in Stripe Checkout.
 *   - `declineCode` set: Stripe declined a real charge. Show the sub-code
 *     so support can act on it; tell the user we'll retry on next dispatch.
 *   - default: balance hit zero with no in-flight charge (auto-reload off
 *     or amount below threshold). Direct them to top up or enable auto-reload.
 */
export function formatBillingErrorSummary(error: BillingError, owner: string): string {
  if (error.code === "router_requires_card") {
    return [
      "**Add a card to start using Pullfrog Router.**",
      "",
      "Router proxies OpenRouter at raw cost — no platform markup. Add a card and we'll auto-reload your wallet so runs keep flowing.",
      "",
      `[Add a card →](${billingConsoleUrl(owner, "model-access")})`,
    ].join("\n");
  }

  if (error.code === "router_balance_exhausted") {
    return [
      "**Your Pullfrog Router balance is exhausted.**",
      "",
      "You have a card on file but auto-reload is disabled, so runs paused once your balance went past the overdraft buffer.",
      "",
      `[Top up balance →](${billingConsoleUrl(owner, "billing")}) · [Enable auto-reload →](${billingConsoleUrl(owner, "model-access")})`,
    ].join("\n");
  }

  if (error.code === "router_keylimit_exhausted") {
    return [
      "**This run was cut short — your Pullfrog Router balance ran out mid-run.**",
      "",
      "OpenRouter stopped the agent because the per-run budget was exhausted. Your wallet is now negative; top up or enable auto-reload to keep runs flowing.",
      "",
      `[Top up balance →](${billingConsoleUrl(owner, "billing")}) · [Enable auto-reload →](${billingConsoleUrl(owner, "model-access")})`,
    ].join("\n");
  }

  if (error.code === "router_monthly_limit") {
    return [
      "**Pullfrog Router hit its monthly spend limit.**",
      "",
      "Auto-reloads are paused for the rest of this UTC month. Ask your admin to raise the cap, or wait for it to reset at 00:00 UTC on the 1st.",
      "",
      `[Adjust limit →](${billingConsoleUrl(owner, "model-access")})`,
    ].join("\n");
  }

  if (error.needsReauthentication) {
    const code = error.declineCode ?? "authentication_required";
    return [
      `**Your card issuer requires 3D Secure on every charge** (\`${code}\`).`,
      "",
      "Pullfrog can't complete a 3DS challenge from inside a workflow. Top up your Router balance once in Stripe Checkout — subsequent runs draw from the prepaid balance without re-triggering 3DS.",
      "",
      `[Top up balance →](${billingConsoleUrl(owner, "billing")})`,
    ].join("\n");
  }

  if (error.declineCode) {
    return [
      `**Your card was declined** (\`${error.declineCode}\`).`,
      "",
      "Update your payment method and Pullfrog will retry on the next run.",
      "",
      `[Update payment method →](${billingConsoleUrl(owner, "billing")})`,
    ].join("\n");
  }

  return [
    "**Your Pullfrog balance is empty.**",
    "",
    "Top up your balance or enable auto-reload to keep runs flowing.",
    "",
    `[Manage billing →](${billingConsoleUrl(owner, "billing")})`,
  ].join("\n");
}

/**
 * Render a TransientError as user-facing markdown. Distinct framing from
 * BillingError so the user doesn't read an alarm and assume their card
 * failed — this branch is "our fault, retry shortly", not theirs.
 */
export function formatTransientErrorSummary(error: TransientError, owner: string): string {
  return [
    "**Pullfrog billing is temporarily unavailable.**",
    "",
    error.message,
    "",
    `Usually transient — the next dispatch should succeed. If it persists, check [status.pullfrog.com](https://status.pullfrog.com) or [your console](${billingConsoleUrl(owner, "billing")}).`,
  ].join("\n");
}
