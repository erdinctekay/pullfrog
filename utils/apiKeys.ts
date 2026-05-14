import {
  BEDROCK_MODEL_ID_ENV,
  getModelEnvVars,
  providers,
  resolveDisplayAlias,
} from "../models.ts";
import { getApiUrl } from "./apiUrl.ts";

const knownApiKeys: Set<string> = new Set(Object.values(providers).flatMap((p) => [...p.envVars]));

/** marker prefix on the throw message for the catch-side reclassification path */
const MISSING_KEY_MARKER = "no API key found";

/** Markdown body used for both the thrown error and the formatted PR comment summary. */
function buildMissingApiKeyError(params: { owner: string; name: string }): string {
  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;
  const settingsUrl = `${getApiUrl()}/console/${params.owner}/${params.name}`;

  return [
    `**${MISSING_KEY_MARKER}** — Pullfrog needs at least one LLM provider API key (e.g. \`ANTHROPIC_API_KEY\`, \`OPENAI_API_KEY\`, \`GEMINI_API_KEY\`) configured as a GitHub Actions secret.`,
    "",
    `[Open repo secrets →](${githubSecretsUrl}) · [Configure model →](${settingsUrl}) · [Setup docs →](https://docs.pullfrog.com/keys)`,
  ].join("\n");
}

function buildBedrockSetupError(params: {
  owner: string;
  name: string;
  missing: string[];
}): string {
  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;

  return `Bedrock model selected but required configuration is missing: ${params.missing.join(", ")}.

add the missing secret(s) to your GitHub repository at ${githubSecretsUrl}, then reference them in your workflow's \`env:\` block:

  AWS_BEARER_TOKEN_BEDROCK: \${{ secrets.AWS_BEARER_TOKEN_BEDROCK }}
  AWS_REGION: \${{ secrets.AWS_REGION }}
  ${BEDROCK_MODEL_ID_ENV}: \${{ secrets.${BEDROCK_MODEL_ID_ENV} }}

\`AWS_BEARER_TOKEN_BEDROCK\` may be substituted with \`AWS_ACCESS_KEY_ID\` + \`AWS_SECRET_ACCESS_KEY\` (and optional \`AWS_SESSION_TOKEN\`) if you prefer access keys.

for full setup instructions, see https://docs.pullfrog.com/bedrock`;
}

function hasEnvVar(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

/** check if the user has a BYOK key for the given model's provider (does not throw) */
export function hasProviderKey(model: string): boolean {
  const requiredVars = getModelEnvVars(model);
  if (requiredVars.length === 0) return true;
  return requiredVars.some((v) => hasEnvVar(v));
}

function validateBedrockSetup(params: { owner: string; name: string }): void {
  const hasAuth =
    hasEnvVar("AWS_BEARER_TOKEN_BEDROCK") ||
    (hasEnvVar("AWS_ACCESS_KEY_ID") && hasEnvVar("AWS_SECRET_ACCESS_KEY"));

  const missing: string[] = [];
  if (!hasAuth)
    missing.push("AWS_BEARER_TOKEN_BEDROCK (or AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)");
  if (!hasEnvVar("AWS_REGION")) missing.push("AWS_REGION");
  if (!hasEnvVar(BEDROCK_MODEL_ID_ENV)) missing.push(BEDROCK_MODEL_ID_ENV);

  if (missing.length > 0) {
    throw new Error(buildBedrockSetupError({ owner: params.owner, name: params.name, missing }));
  }
}

export function validateAgentApiKey(params: {
  agent: { name: string };
  model: string | undefined;
  owner: string;
  name: string;
}): void {
  // if a specific model is configured, only check that model's required env vars
  if (params.model) {
    // routing slugs (e.g. bedrock) get a tailored validation path because
    // their auth shape doesn't match the standard "any one envVar present"
    // rule (Bedrock needs auth + region + model-id, with auth being either
    // a bearer token OR an access-key pair).
    const alias = resolveDisplayAlias(params.model);
    if (alias?.routing === "bedrock") {
      validateBedrockSetup({ owner: params.owner, name: params.name });
      return;
    }

    // upstream `resolveModel` translates `bedrock/byok` into the raw Bedrock
    // model ID (e.g. `us.anthropic.claude-opus-4-6-v1`), which has no `/`
    // and so isn't parseable as `provider/model`. these IDs only reach this
    // function via routing aliases, so re-run the bedrock setup check rather
    // than falling through to `getModelEnvVars` (which would throw inside
    // parseModel). resolveModel itself already enforced BEDROCK_MODEL_ID,
    // but auth + region are still validated here.
    if (!params.model.includes("/")) {
      validateBedrockSetup({ owner: params.owner, name: params.name });
      return;
    }

    const requiredVars = getModelEnvVars(params.model);
    // free models have no required env vars — skip validation entirely
    if (requiredVars.length === 0) return;
    if (requiredVars.some((v) => hasEnvVar(v))) return;

    throw new Error(buildMissingApiKeyError({ owner: params.owner, name: params.name }));
  }

  // no model configured — auto-select requires at least one known provider key
  const hasAnyKey = [...knownApiKeys].some((k) => hasEnvVar(k));
  if (!hasAnyKey) {
    throw new Error(buildMissingApiKeyError({ owner: params.owner, name: params.name }));
  }
}

/**
 * Detect agent-runtime auth failures that should be reformatted as an actionable
 * key-fix CTA before being shown to the user. Covers the two shapes we see:
 *   - missing key (validateAgentApiKey throw): contains MISSING_KEY_MARKER
 *   - revoked / invalid key (Claude CLI 401 surfaced via api_error_status):
 *     "Invalid API key · Fix external API key" + similar provider variants
 */
export function isApiKeyAuthError(text: string): boolean {
  if (!text) return false;
  return (
    text.includes(MISSING_KEY_MARKER) ||
    /Invalid API key/i.test(text) ||
    /\bUser not found\b/i.test(text) ||
    /\bInvalid authentication\b/i.test(text)
  );
}

/**
 * Friendly Markdown summary for both the missing-key and invalid-key cases.
 * Used in the catch / result-failure paths in `main.ts` to overwrite the raw
 * agent error before it's posted to the PR progress comment.
 */
export function formatApiKeyErrorSummary(params: {
  owner: string;
  name: string;
  raw: string;
}): string {
  if (params.raw.includes(MISSING_KEY_MARKER)) {
    return buildMissingApiKeyError({ owner: params.owner, name: params.name });
  }

  const githubSecretsUrl = `https://github.com/${params.owner}/${params.name}/settings/secrets/actions`;
  const settingsUrl = `${getApiUrl()}/console/${params.owner}/${params.name}`;

  return [
    `**Your LLM provider API key was rejected (401).** Rotate the key in your provider dashboard, then update the matching GitHub Actions secret.`,
    "",
    `[Update repo secret →](${githubSecretsUrl}) · [Model settings →](${settingsUrl}) · [Setup docs →](https://docs.pullfrog.com/keys)`,
  ].join("\n");
}
