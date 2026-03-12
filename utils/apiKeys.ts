import { providers } from "../models.ts";
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

export function validateAgentApiKey(params: {
  agent: { name: string };
  owner: string;
  name: string;
}): void {
  const hasAnyKey = Object.entries(process.env).some(
    ([key, value]) => value && typeof value === "string" && knownApiKeys.has(key)
  );

  if (!hasAnyKey) {
    throw new Error(buildMissingApiKeyError({ owner: params.owner, name: params.name }));
  }
}
