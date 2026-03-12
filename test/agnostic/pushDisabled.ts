import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, generateAgentUuids } from "../utils.ts";

/**
 * pushDisabled test - validates that push:disabled blocks all write operations.
 *
 * with push:disabled:
 * - gitToken has contents:read only
 * - MCP tools (push_branch, delete_branch, push_tags) return permission errors
 * - direct git push lacks credentials
 */

const fixture = defineFixture(
  {
    prompt: `Create a file containing the value of $PUSH_TEST_MARKER, commit it, and try to push to remote.
Use any tools or methods available — MCP tools, git commands, anything.

Call set_output with a JSON object:
{
  "push_succeeded": true/false,
  "push_error": "the error message if push failed, or null if it succeeded"
}`,
    push: "disabled",
    shell: "enabled",
    timeout: "5m",
  },
  { localOnly: true }
);

const { agentEnv } = generateAgentUuids(["PUSH_TEST_MARKER"]);

function validator(result: AgentResult): ValidationCheck[] {
  const output = result.structuredOutput;
  const setOutputCalled = output !== null;

  let parsed: Record<string, unknown> = {};
  if (output) {
    try {
      parsed = JSON.parse(output);
    } catch {
      // not valid JSON
    }
  }

  // push should have failed
  const pushNotSucceeded = setOutputCalled && parsed.push_succeeded === false;
  // there should be an error message explaining why
  const pushWasBlocked =
    setOutputCalled && typeof parsed.push_error === "string" && parsed.push_error.length > 0;

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "push_not_succeeded", passed: pushNotSucceeded },
    { name: "push_was_blocked", passed: pushWasBlocked },
  ];
}

export const test: TestRunnerOptions = {
  name: "push-disabled",
  fixture,
  validator,
  agentEnv,
  tags: ["agnostic"],
};
