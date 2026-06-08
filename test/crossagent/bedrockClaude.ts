import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture } from "../utils.ts";

const fixture = defineFixture(
  {
    prompt: `Call set_output with "BEDROCK CLAUDE SMOKE PASSED".`,
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = result.structuredOutput;
  const setOutputCalled = output !== null;
  const correctValue = setOutputCalled && /BEDROCK CLAUDE SMOKE PASSED/i.test(output);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "correct_value", passed: correctValue },
  ];
}

export const test: TestRunnerOptions = {
  name: "bedrock-claude",
  agents: ["claude"],
  fixture,
  validator,
  env: {
    PULLFROG_DISABLE_SECURITY_INSTRUCTIONS: "1",
    PULLFROG_MODEL: "bedrock/byok",
    BEDROCK_MODEL_ID: "us.anthropic.claude-sonnet-4-6",
    AWS_REGION: "us-east-1",
  },
  coverage: [
    "action/models.ts",
    "action/main.ts",
    "action/agents/claude.ts",
    "action/utils/{agent,apiKeys}.ts",
  ],
};
