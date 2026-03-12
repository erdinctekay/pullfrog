import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture } from "../utils.ts";

/**
 * timeout test - validates timeout enforcement works correctly.
 * sets a very short timeout (5s) and gives the agent a task that takes longer.
 * the run should fail with a timeout error.
 */

const fixture = defineFixture(
  {
    prompt: `Select the Build mode via select_mode. Then select Review mode via select_mode. Then read every file in the repository recursively.
Finally call set_output with "TIMEOUT TEST COMPLETED".`,
    timeout: "5s",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  // run should have failed due to timeout
  const timedOut = !result.success && /timed out/i.test(result.output);
  return [{ name: "timeout_triggered", passed: timedOut }];
}

export const test: TestRunnerOptions = {
  name: "timeout",
  fixture,
  validator,
  expectFailure: true,
  tags: ["agnostic"],
};
