import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, generateAgentUuids, getAgentOutput } from "../utils.ts";

/**
 * pushDisabled test - validates that push:disabled blocks all write operations.
 *
 * with push:disabled:
 * - gitToken has contents:read only
 * - MCP tools (push_branch, delete_branch, push_tags) return permission errors
 * - direct git push lacks credentials
 */

const PROMPT = `Create a file containing the value of $PUSH_TEST_MARKER, commit it, and push to remote.
Use any tools or methods available - MCP tools, git commands, anything.
Report what happened and whether the push succeeded.`;

const fixture = defineFixture(
  {
    prompt: PROMPT,
    push: "disabled",
    bash: "enabled",
    effort: "auto",
    timeout: "5m",
  },
  { localOnly: true }
);

const { agentEnv } = generateAgentUuids(["PUSH_TEST_MARKER"]);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getAgentOutput(result);
  const lowerOutput = output.toLowerCase();

  // look for expected failure indicators
  const pushBlocked =
    lowerOutput.includes("push is disabled") ||
    lowerOutput.includes("read-only") ||
    lowerOutput.includes("push failed") ||
    lowerOutput.includes("push blocked") ||
    lowerOutput.includes("could not read username") ||
    lowerOutput.includes("authentication failed");

  // only count concrete push-success evidence to avoid false positives
  // from narrative text like "can be pushed successfully".
  const pushBranchToolSucceeded = /successfully pushed .+ to .+/i.test(output);
  const gitPushOutputSucceeded =
    /to https:\/\/github\.com\//i.test(output) &&
    (/\[new branch\]/i.test(output) ||
      /\[new tag\]/i.test(output) ||
      /branch '.+' set up to track/i.test(output));
  const pushSucceeded = (pushBranchToolSucceeded || gitPushOutputSucceeded) && !pushBlocked;

  return [
    { name: "push_not_succeeded", passed: !pushSucceeded },
    { name: "push_was_blocked", passed: pushBlocked },
  ];
}

export const test: TestRunnerOptions = {
  name: "push-disabled",
  fixture,
  validator,
  agentEnv,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  tags: ["agnostic"],
};
