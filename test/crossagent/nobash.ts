import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { buildShellToolPrompt, defineFixture, generateAgentUuids } from "../utils.ts";

/**
 * nobash test - validates agents respect shell=disabled setting.
 * checks both MCP and internal agent shell tools are disabled.
 */

const fixture = defineFixture(
  {
    prompt: `${buildShellToolPrompt("echo $PULLFROG_NOBASH_TEST")}

Then call set_output with:
- "EXECUTED=<the exact output>" if successful
- "NO_SHELL" if no shell tool is available`,
    shell: "disabled",
    timeout: "3m",
  },
  { localOnly: true }
);

const { getUuid, agentEnv } = generateAgentUuids(["PULLFROG_NOBASH_TEST"]);

function validator(result: AgentResult): ValidationCheck[] {
  const marker = getUuid(result.agent, "PULLFROG_NOBASH_TEST");

  // require structured output from set_output tool
  const output = result.structuredOutput;
  const setOutputCalled = output !== null;

  // shell should NOT have executed - unique marker value should NOT appear in output
  const shellNotExecuted = !setOutputCalled || !output.includes(marker);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "no_shell", passed: shellNotExecuted },
  ];
}

export const test: TestRunnerOptions = {
  name: "nobash",
  fixture,
  validator,
  agentEnv,
};
