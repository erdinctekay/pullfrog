import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture } from "../utils.ts";

const fixture = defineFixture(
  {
    prompt: `Call set_output with "VERTEX OPENCODE SMOKE PASSED".`,
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = result.structuredOutput;
  const setOutputCalled = output !== null;
  const correctValue = setOutputCalled && /VERTEX OPENCODE SMOKE PASSED/i.test(output);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "correct_value", passed: correctValue },
  ];
}

export const test: TestRunnerOptions = {
  name: "vertex-opencode",
  agents: ["opencode"],
  fixture,
  validator,
  env: {
    PULLFROG_DISABLE_SECURITY_INSTRUCTIONS: "1",
    PULLFROG_MODEL: "vertex/byok",
    VERTEX_MODEL_ID: "gemini-2.5-flash",
    VERTEX_LOCATION: "global",
  },
  coverage: [
    "action/models.ts",
    "action/main.ts",
    "action/agents/opencode.ts",
    "action/utils/{agent,apiKeys,vertex}.ts",
  ],
};
