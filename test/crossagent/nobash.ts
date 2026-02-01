import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { buildBashToolPrompt, defineFixture, generateAgentUuids, getStructuredOutput } from "../utils.ts";

/**
 * nobash test - validates agents respect bash=disabled setting.
 * checks both MCP and internal agent bash tools are disabled.
 */

const fixture = defineFixture(
  {
    prompt: `${buildBashToolPrompt("echo $PULLFROG_NOBASH_TEST")}

Then call set_output with:
- "EXECUTED=<the exact output>" if successful
- "NO_BASH" if no bash tool is available`,
    bash: "disabled",
    effort: "mini",
    timeout: "3m",
  },
  { localOnly: true }
);

const { getUuid, agentEnv } = generateAgentUuids(["PULLFROG_NOBASH_TEST"]);

function validator(result: AgentResult): ValidationCheck[] {
  const marker = getUuid(result.agent, "PULLFROG_NOBASH_TEST");

  // require structured output from set_output tool
  const output = getStructuredOutput(result);
  const setOutputCalled = output !== null;

  // bash should NOT have executed - unique marker value should NOT appear in output
  const bashNotExecuted = !setOutputCalled || !output.includes(marker);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "no_bash", passed: bashNotExecuted },
  ];
}

export const test: TestRunnerOptions = {
  name: "nobash tests",
  fixture,
  validator,
  agentEnv,
};
