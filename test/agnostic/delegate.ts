import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getAgentOutput, getStructuredOutput } from "../utils.ts";

/**
 * delegate test - validates core end-to-end delegation flow.
 *
 * the orchestrator selects Plan mode, then delegates with mini effort, passing
 * instructions that tell the subagent to call set_output with a specific value.
 * validates that the subagent executed and the result flows back.
 */

const fixture = defineFixture(
  {
    prompt: `Select the Plan mode via select_mode, then delegate with mini effort. Your subagent instructions should be:
"This is a delegation test. Your only task is to call set_output with the value 'DELEGATE_BASIC_PASSED'. Do not create plans, branches, or PRs. Just call set_output."

When all delegations are complete, call set_output with the final result. This makes it available as the GitHub Action output.`,
    effort: "mini",
    timeout: "5m",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getStructuredOutput(result);
  const agentOutput = getAgentOutput(result);

  const setOutputCalled = output !== null;
  const correctValue = setOutputCalled && /DELEGATE_BASIC_PASSED/i.test(output);
  const delegationOccurred = /» delegating \d+ task/i.test(agentOutput);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "correct_value", passed: correctValue },
    { name: "delegation_occurred", passed: delegationOccurred },
  ];
}

export const test: TestRunnerOptions = {
  name: "delegate",
  fixture,
  validator,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  tags: ["agnostic"],
};
