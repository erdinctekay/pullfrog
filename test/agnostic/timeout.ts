import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture } from "../utils.ts";

/**
 * timeout test - validates timeout enforcement works correctly.
 * sets a very short timeout (5s) and gives the agent a task that takes longer.
 * the run should fail with a timeout error.
 */

const fixture = defineFixture(
  {
    prompt: `Call the select_mode tool with modeName "Build", then analyze the mode instructions.
Then call select_mode with modeName "Review" and compare the two modes in detail.
Finally say "TIMEOUT TEST COMPLETED".`,
    timeout: "5s",
    effort: "mini",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  // run should have failed due to timeout
  const timedOut = !result.success && /timed out/i.test(result.output);
  return [{ name: "timeout_triggered", passed: timedOut }];
}

export const test: TestRunnerOptions = {
  name: "timeout tests",
  fixture,
  validator,
  expectFailure: true,
  agnostic: true,
};
