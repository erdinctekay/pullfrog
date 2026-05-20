import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture } from "../utils.ts";

/**
 * smoke test — validates agent can connect to the API and call MCP tools.
 *
 * two tool calls (not one) on purpose: this is the canary that exercises the
 * 2nd model→agent round-trip across every providers-live flagship. bugs like
 * the Gemini `thought_signature` echo only fire after the first tool result
 * comes back. do not collapse to a single tool call.
 */
const fixture = defineFixture(
  {
    prompt: `First call the git tool with command "status" to confirm the repo is reachable. Then call set_output with exactly the literal string "SMOKE TEST PASSED".`,
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
  coverage: ["action/agents/{claude,opencode,opencode_v2}.ts", "action/mcp/output.ts"],
};
