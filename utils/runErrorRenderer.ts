/**
 * Classify + render the error thrown out of the main run try-block into a
 * pair of user-facing markdown bodies — one for the GitHub Actions job
 * summary tab, one for the PR progress comment.
 *
 * Classifications, in dispatch order (first match wins; the api-key
 * branch additionally folds in the activity-timeout hang body as a
 * sub-source so a hang masking an api-key error still surfaces the api-key
 * CTA):
 *
 *   1. `BillingError` — either the proxy-token mint already threw one (402
 *      handled inline) or the agent runtime surfaced an OpenRouter
 *      "key budget exhausted" string mid-run. Both render via
 *      `formatBillingErrorSummary` so the user sees actionable copy.
 *
 *   2. BYOK provider billing-exhausted (#835) — DeepSeek "Insufficient
 *      Balance", Anthropic "credit balance is too low", OpenCode Zen
 *      `CreditsError`, Gemini "spending cap". Checked before api-key auth
 *      because billing-exhausted responses often carry 401 status codes
 *      that `isApiKeyAuthError` would otherwise mis-classify.
 *
 *   3. API-key auth error — `isApiKeyAuthError` sniffs the raw error string
 *      (or the activity-timeout hang body when present, since that's where
 *      the underlying provider error often lands); `formatApiKeyErrorSummary`
 *      renders provider + console-link copy.
 *
 *   4. ProviderModelNotFoundError — configured model id no longer in the
 *      OpenCode catalog; renders a nudge to pick a different model.
 *
 *   5. Activity-timeout hang — `errorMessage` starts with
 *      `"activity timeout"` or `"agent still pending"` AND none of the
 *      above matched. The harness keeps structured diagnostic state on
 *      `toolState.agentDiagnostic`; `formatAgentHangBody` renders that into
 *      the job summary. The PR comment instead collapses to a one-line
 *      `**Run failed.** [View the logs →]` — the watchdog jargon, event
 *      counts, and benign stderr tail are operator-grade detail that only
 *      alarm the average user. The one exception is a hang masking billing
 *      exhaustion (#778), where `formatAgentHangBody` emits an actionable
 *      top-up CTA that the comment keeps verbatim.
 *
 *   6. Default — the job summary gets a plain-English lead sentence plus the
 *      raw error in a fenced code block under the `### ❌ Pullfrog failed`
 *      banner; the PR comment collapses to the same one-line logs link as
 *      the hang case, since the raw internal string helps nobody on the PR.
 *
 * Net: the actionable classifications (billing, API-key, model-not-found)
 * render identical bodies on both surfaces; the non-actionable ones (hang,
 * generic) keep the forensics in the Actions job summary and show a calm
 * one-liner in the PR comment, whose footer already carries Pullfrog
 * branding + rerun links.
 */

import type { AgentDiagnostic } from "./agentHangReport.ts";
import { formatAgentHangBody } from "./agentHangReport.ts";
import { formatApiKeyErrorSummary, isApiKeyAuthError } from "./apiKeys.ts";
import { BillingError, formatBillingErrorSummary } from "./billingErrors.ts";
import { MODEL_ACCESS_MARKER } from "./modelAccess.ts";
import {
  extractProviderId,
  isProviderBillingExhausted,
  isRouterKeylimitExhaustedError,
} from "./providerErrors.ts";

export type RenderedRunError = {
  summary: string;
  comment: string;
};

function isProviderModelNotFoundError(message: string): boolean {
  return message.includes("ProviderModelNotFoundError");
}

/**
 * Generic failure copy for any shape not caught by a more specific classifier
 * (billing / api-key / hang / model-not-found). A plain-English lead sentence
 * so the user isn't staring at a raw internal string like
 * `opencode prompt failed: fetch failed`, followed by the actual error in a
 * fenced code block for anyone who needs the detail. Shared by both surfaces;
 * the job summary adds the `### ❌ Pullfrog failed` banner on top.
 */
function formatGenericFailure(errorMessage: string): string {
  return [
    "Pullfrog ran into an unexpected error and couldn't finish this run. The underlying error is below — re-trigger Pullfrog to try again, and reach out to support if it keeps happening.",
    "",
    "```",
    errorMessage,
    "```",
  ].join("\n");
}

/**
 * Minimal PR-comment body for non-actionable failures (hangs, unexpected
 * errors). The forensic detail (event counts, stderr tail, raw error) stays
 * in the Actions job summary; the comment the average user sees is one calm
 * line plus a link to the logs. The footer appended by `reportErrorToComment`
 * already carries rerun / model context.
 */
function formatMinimalFailureComment(repo: { owner: string; name: string }): string {
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId) return "**Run failed.**";
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const url = `${server}/${repo.owner}/${repo.name}/actions/runs/${runId}`;
  return `**Run failed.** [View the logs →](${url})`;
}

/**
 * Best-known billing top-up URL per provider. Conservative list: only
 * providers we've actually classified billing-exhaustion shapes for in
 * `providerErrors.ts`. Unknown providers fall through to a generic CTA.
 */
const PROVIDER_BILLING_URLS: Record<string, string> = {
  deepseek: "https://platform.deepseek.com/top_up",
  anthropic: "https://console.anthropic.com/settings/billing",
  openai: "https://platform.openai.com/account/billing",
  google: "https://aistudio.google.com/usage",
  opencode: "https://opencode.ai/zen",
};

/**
 * `extractProviderId` only fires when the harness emits `providerID=...`
 * (OpenCode log shape). Direct-provider errors (e.g. Anthropic SDK throwing
 * `"Your credit balance is too low to access the Anthropic API"`) carry no
 * such tag, so map their distinctive copy to a provider id here so the
 * dashboard link is reachable.
 *
 * Pattern is intentionally tight (Anthropic-specific phrasing only) to
 * avoid mis-tagging non-Anthropic billing-exhausted errors that happen to
 * mention `"Anthropic API"` in passing — the broader phrase appears in
 * fallback-chain agent prompt text and OpenCode harness logs.
 */
function detectProviderId(message: string): string | null {
  const harnessId = extractProviderId(message);
  if (harnessId) return harnessId;
  if (/credit balance is too low/i.test(message)) return "anthropic";
  return null;
}

function formatProviderBillingExhausted(input: { errorMessage: string }): string {
  const providerId = detectProviderId(input.errorMessage);
  const dashboardUrl = providerId ? PROVIDER_BILLING_URLS[providerId] : undefined;

  const headline = providerId
    ? `**Your \`${providerId}\` account is out of credit.**`
    : "**Your provider account is out of credit.**";
  const cta = dashboardUrl
    ? `[Top up \`${providerId}\` →](${dashboardUrl})`
    : "Top up your provider account, then re-trigger Pullfrog.";

  return [
    headline,
    "",
    "Pullfrog detected a billing-exhausted response from your provider — the agent stopped before completing this run.",
    "",
    cta,
    "",
    `\`\`\`\n${input.errorMessage}\n\`\`\``,
  ].join("\n");
}

function formatProviderModelNotFoundSummary(input: {
  owner: string;
  name: string;
  raw: string;
}): string {
  return (
    `The configured model is no longer available in OpenCode's catalog. ` +
    `Pick a different model in the Pullfrog console for \`${input.owner}/${input.name}\`, ` +
    `or contact support if this persists.\n\n` +
    `\`\`\`\n${input.raw}\n\`\`\``
  );
}

export function renderRunError(input: {
  errorMessage: string;
  repo: { owner: string; name: string };
  agentDiagnostic: AgentDiagnostic | undefined;
}): RenderedRunError {
  // reclassify mid-run OpenRouter "key budget exhausted" as BillingError so
  // the user gets the same actionable copy as a /api/proxy-token 402.
  const billingError = isRouterKeylimitExhaustedError(input.errorMessage)
    ? new BillingError(input.errorMessage, { code: "router_keylimit_exhausted" })
    : null;

  if (billingError) {
    const body = formatBillingErrorSummary(billingError, input.repo.owner);
    return { summary: body, comment: body };
  }

  // model-access gate (explicit `--model`/family flag the run can't serve):
  // the thrown message already IS the rendered markdown body (built by
  // `buildModelAccessError`), so surface it verbatim on both surfaces.
  if (input.errorMessage.includes(MODEL_ACCESS_MARKER)) {
    return { summary: input.errorMessage, comment: input.errorMessage };
  }

  // gated on isHang because the harness sets `agentDiagnostic` on entry, so
  // any non-hang throw that hits the outer catch (e.g. post-success
  // output_schema validator, or a late cleanup throw after the run already
  // succeeded) would otherwise render "Pullfrog failed" with stale event
  // counts and silently drop the real errorMessage.
  const isHang =
    input.errorMessage.startsWith("activity timeout") ||
    input.errorMessage.startsWith("agent still pending");
  const hangBody = isHang
    ? formatAgentHangBody({
        diagnostic: input.agentDiagnostic,
        isHang: true,
        errorMessage: input.errorMessage,
      })
    : null;

  // BYOK provider billing-exhausted (DeepSeek "Insufficient Balance",
  // Anthropic "credit balance is too low", OpenCode Zen `CreditsError` /
  // `FreeUsageLimitError`, Gemini "spending cap"). distinct from the Router
  // billing branches above — Router uses `BillingError`, this uses the agent
  // log payload classified by `isProviderBillingExhausted`. see #835.
  //
  // checked BEFORE api-key auth: providers commonly return 401 (DeepSeek,
  // Gemini) or include `"API Error: 401"` in the error body for billing
  // exhaustion, which `isApiKeyAuthError` would otherwise match — surfacing
  // a "rotate your key" CTA when the actual fix is "top up credits".
  if (isProviderBillingExhausted(input.errorMessage)) {
    const body = formatProviderBillingExhausted({ errorMessage: input.errorMessage });
    return { summary: `### ❌ Pullfrog failed\n\n${body}`, comment: body };
  }

  const apiKeySource = hangBody ?? input.errorMessage;
  const apiKeyErrorSummary = isApiKeyAuthError(apiKeySource)
    ? formatApiKeyErrorSummary({
        owner: input.repo.owner,
        name: input.repo.name,
        raw: apiKeySource,
      })
    : null;

  if (apiKeyErrorSummary) {
    return { summary: apiKeyErrorSummary, comment: apiKeyErrorSummary };
  }

  if (isProviderModelNotFoundError(input.errorMessage)) {
    const body = formatProviderModelNotFoundSummary({
      owner: input.repo.owner,
      name: input.repo.name,
      raw: input.errorMessage,
    });
    return { summary: body, comment: body };
  }

  if (hangBody) {
    // a hang masking billing exhaustion (#778) renders an actionable top-up
    // CTA inside `hangBody` — keep that in the comment. every other hang is
    // non-actionable noise for the average user, so the comment collapses to
    // a one-liner and the diagnostic stays in the Actions job summary.
    const isBillingExhausted =
      input.agentDiagnostic?.lastProviderError === "provider billing exhausted";
    return {
      summary: `### ❌ Pullfrog failed\n\n${hangBody}`,
      comment: isBillingExhausted ? hangBody : formatMinimalFailureComment(input.repo),
    };
  }

  const genericBody = formatGenericFailure(input.errorMessage);
  return {
    summary: `### ❌ Pullfrog failed\n\n${genericBody}`,
    comment: formatMinimalFailureComment(input.repo),
  };
}
