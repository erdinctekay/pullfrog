import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getAgentOutput } from "../utils.ts";

/**
 * BYOK missing-key error test — proves that an account configured for a
 * BYOK model (here: `moonshotai/kimi-k2`) but with no provider API keys
 * present in the runner env fails fast with an actionable error instead
 * of silently downgrading to a free model.
 *
 * The env block below empty-strings every known provider key — that's
 * exactly what GitHub Actions does when a `${{ secrets.X }}` reference
 * resolves to a missing secret. We verify:
 *   1. the run failed (no silent fallback)
 *   2. the error names the configured model and the exact env var to set,
 *      so the user knows precisely how to fix the misconfiguration
 */
const fixture = defineFixture(
  {
    prompt: "Reply with exactly the single character: 4",
    timeout: "5m",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getAgentOutput(result);
  return [
    { name: "error_has_marker", passed: output.includes("no API key found") },
    { name: "error_names_model", passed: output.includes("moonshotai/kimi-k2") },
    { name: "error_names_env_var", passed: output.includes("MOONSHOT_API_KEY") },
  ];
}

export const test: TestRunnerOptions = {
  name: "byok-missing-key-error",
  fixture,
  validator,
  expectFailure: true,
  env: {
    // simulate every BYOK provider's secret being absent — same shape as
    // a fresh-install account whose user never configured any keys.
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    OPENAI_API_KEY: "",
    OPENROUTER_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_GENERATIVE_AI_API_KEY: "",
    XAI_API_KEY: "",
    DEEPSEEK_API_KEY: "",
    MOONSHOT_API_KEY: "",
    OPENCODE_API_KEY: "",
    AWS_BEARER_TOKEN_BEDROCK: "",
    AWS_ACCESS_KEY_ID: "",
    AWS_SECRET_ACCESS_KEY: "",
    BEDROCK_MODEL_ID: "",
    // configure a model that requires a BYOK key — the validation only
    // throws when there's a configured model whose provider key is
    // absent, so we have to pin one.
    PULLFROG_MODEL: "moonshotai/kimi-k2",
  },
  tags: ["agnostic"],
  coverage: [
    "action/utils/apiKeys.ts",
    "action/utils/agent.ts",
    "action/utils/openCodeModels.ts",
    "action/utils/runErrorRenderer.ts",
    "action/main.ts",
    "action/models.ts",
  ],
};
