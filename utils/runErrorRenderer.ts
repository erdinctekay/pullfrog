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
 *   4. ProviderModelNotFoundError — stale free-fallback model id no longer
 *      in the OpenCode catalog; renders a nudge to add a BYOK key.
 *
 *   5. Activity-timeout hang — `errorMessage` starts with
 *      `"activity timeout"` or `"agent still pending"` AND none of the
 *      above matched. The harness keeps structured diagnostic state on
 *      `toolState.agentDiagnostic`; `formatAgentHangBody` renders that as
 *      a markdown block.
 *
 *   6. Default — a generic `❌ Pullfrog failed` block with the raw error
 *      message in a fenced code block. Same body for both surfaces.
 *
 * The hang body and the API-key body diverge between the two surfaces only
 * in that the job summary wraps them in the `### ❌ Pullfrog failed` H3
 * banner; the PR comment uses the bare body since it already has Pullfrog
 * branding in its footer.
 */

import type { AgentDiagnostic } from "./agentHangReport.ts";
import { formatAgentHangBody } from "./agentHangReport.ts";
import { formatApiKeyErrorSummary, isApiKeyAuthError } from "./apiKeys.ts";
import { BillingError, formatBillingErrorSummary } from "./billingErrors.ts";
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
    `Pullfrog's free fallback model is no longer available in OpenCode's catalog. ` +
    `Add an API key for your configured model in the Pullfrog console for \`${input.owner}/${input.name}\`, ` +
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
    return {
      summary: `### ❌ Pullfrog failed\n\n${hangBody}`,
      comment: hangBody,
    };
  }

  return {
    summary: `### ❌ Pullfrog failed\n\n\`\`\`\n${input.errorMessage}\n\`\`\``,
    comment: input.errorMessage,
  };
}
