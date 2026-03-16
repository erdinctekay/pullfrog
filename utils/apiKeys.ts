import { getModelEnvVars, providers } from "../models.ts";
import { getApiUrl } from "./apiUrl.ts";

const knownApiKeys: Set<string> = new Set(Object.values(providers).flatMap((p) => [...p.envVars]));

function buildMissingApiKeyError(params: { owner: string; name: string }): string {
  const apiUrl = getApiUrl();
  const settingsUrl = `${apiUrl}/console/${params.owner}/${params.name}`;

  const githubRepoUrl = `https://github.com/${params.owner}/${params.name}`;
  const githubSecretsUrl = `${githubRepoUrl}/settings/secrets/actions`;

  return `no API key found. Pullfrog requires at least one LLM provider API key.

to fix this, add the required secret to your GitHub repository:

1. go to: ${githubSecretsUrl}
2. click "New repository secret"
3. set the name to your provider's key (e.g., \`ANTHROPIC_API_KEY\`, \`OPENAI_API_KEY\`, \`GEMINI_API_KEY\`)
4. set the value to your API key
5. click "Add secret"

configure your model at ${settingsUrl}`;
}

function hasEnvVar(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

export function validateAgentApiKey(params: {
  agent: { name: string };
  model: string | undefined;
  owner: string;
  name: string;
}): void {
  // if a specific model is configured, only check that model's required env vars
  if (params.model) {
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
