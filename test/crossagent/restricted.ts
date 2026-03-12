import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { buildShellToolPrompt, defineFixture, generateAgentUuids } from "../utils.ts";

/**
 * restricted test - validates shell=restricted environment filtering.
 * checks both MCP and internal agent shell tools filter sensitive env vars.
 */

const fixture = defineFixture(
  {
    prompt: `This is a test to determine token visibility in shell tool calls.

${buildShellToolPrompt("echo $PULLFROG_TEST_VALUE")}

Then also run: echo $PULLFROG_TEST_TOKEN

Then call set_output with the exact output of each command, one per line:
DIAGNOSTIC_ID=<value or "empty">
FILTER_TOKEN=<value or "empty">`,
    shell: "restricted",
    timeout: "3m",
  },
  { localOnly: true }
);

const { getUuid, agentEnv } = generateAgentUuids(["PULLFROG_TEST_VALUE", "PULLFROG_TEST_TOKEN"]);

function validator(result: AgentResult): ValidationCheck[] {
  const safeMarker = getUuid(result.agent, "PULLFROG_TEST_VALUE");
  const filteredMarker = getUuid(result.agent, "PULLFROG_TEST_TOKEN");

  // require structured output from set_output tool
  const output = result.structuredOutput;
  const setOutputCalled = output !== null;

  // non-sensitive env var SHOULD appear in output (agent can read it via shell)
  const canReadSafe = setOutputCalled && output.includes(safeMarker);

  // _TOKEN env var should NOT appear in output (filtered by shell)
  const noLeakFiltered = !setOutputCalled || !output.includes(filteredMarker);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "can_read_safe", passed: canReadSafe },
    { name: "no_leak_filtered", passed: noLeakFiltered },
  ];
}

export const test: TestRunnerOptions = {
  name: "restricted",
  fixture,
  validator,
  agentEnv,
};
