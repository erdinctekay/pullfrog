import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture } from "../utils.ts";

/**
 * smoke test - validates agent can connect to API and call MCP tools.
 * verifies set_output tool is called with correct value.
 */

const fixture = defineFixture(
  {
    prompt: `Call set_output with "SMOKE TEST PASSED".`,
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = result.structuredOutput;
  const setOutputCalled = output !== null;
  const correctValue = setOutputCalled && /SMOKE TEST PASSED/i.test(output);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "correct_value", passed: correctValue },
  ];
}

export const test: TestRunnerOptions = {
  name: "smoke",
  fixture,
  validator,
  env: { PULLFROG_DISABLE_SECURITY_INSTRUCTIONS: "1" },
  // canary: any agent harness change runs the smoke. shared MCP set_output
  // surface is also captured.
  coverage: ["action/agents/{claude,opencode}.ts", "action/mcp/output.ts"],
};
