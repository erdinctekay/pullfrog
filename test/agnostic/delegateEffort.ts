import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getAgentOutput, getStructuredOutput } from "../utils.ts";

/**
 * delegateEffort test - validates effort selection for delegation.
 *
 * the orchestrator selects Plan mode, then delegates with mini effort.
 * validates that the subagent runs at mini effort (visible in agent logs
 * as "effort=mini" or sonnet model selection for claude).
 */

// orchestrator runs at "auto" (opus) while delegating with "mini" (sonnet).
// this tests that the delegate tool's effort parameter actually overrides
// the model selection — if it were ignored, the subagent would also run at auto.
const fixture = defineFixture(
  {
    prompt: `This is a simple task. Select the Plan mode via select_mode, then delegate with MINI effort (this is a trivial task).
Your subagent instructions should be:
"Call set_output with the value 'EFFORT_TEST_PASSED'. Do not create plans or PRs. Just call set_output."

When all delegations are complete, call set_output with the final result. This makes it available as the GitHub Action output.`,
    effort: "auto",
    timeout: "5m",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getStructuredOutput(result);
  const agentOutput = getAgentOutput(result);

  const setOutputCalled = output !== null;
  const correctValue = setOutputCalled && /EFFORT_TEST_PASSED/i.test(output);

  // the orchestrator runs at auto (» effort:  auto in its log line).
  // the delegate tool should spawn the subagent at mini (» effort:  mini in its log line).
  // if effort override works, we should see BOTH effort values in the output.
  const orchestratorEffort = /» effort:\s+auto/i.test(agentOutput);
  const subagentEffort = /» effort:\s+mini/i.test(agentOutput);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "correct_value", passed: correctValue },
    { name: "orchestrator_auto", passed: orchestratorEffort },
    { name: "subagent_mini", passed: subagentEffort },
  ];
}

export const test: TestRunnerOptions = {
  name: "delegate-effort",
  fixture,
  validator,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  tags: ["agnostic"],
};
