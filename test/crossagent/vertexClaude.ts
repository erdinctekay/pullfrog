import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture } from "../utils.ts";

const fixture = defineFixture(
  {
    prompt: `Call set_output with "VERTEX CLAUDE SMOKE PASSED".`,
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = result.structuredOutput;
  const setOutputCalled = output !== null;
  const correctValue = setOutputCalled && /VERTEX CLAUDE SMOKE PASSED/i.test(output);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "correct_value", passed: correctValue },
  ];
}

export const test: TestRunnerOptions = {
  name: "vertex-claude",
  agents: ["claude"],
  fixture,
  validator,
  env: {
    PULLFROG_DISABLE_SECURITY_INSTRUCTIONS: "1",
    PULLFROG_MODEL: "vertex/byok",
    VERTEX_MODEL_ID: "claude-haiku-4-5@20251001",
    VERTEX_LOCATION: "global",
  },
  coverage: [
    "action/models.ts",
    "action/main.ts",
    "action/agents/claude.ts",
    "action/utils/{agent,apiKeys,vertex}.ts",
  ],
};
