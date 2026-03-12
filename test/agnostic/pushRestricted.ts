import { randomUUID } from "node:crypto";
import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture } from "../utils.ts";

/**
 * pushRestricted test - validates push:restricted blocks main but allows feature branches.
 *
 * with push:restricted:
 * - pushes to default branch (main/master) are blocked by MCP tool
 * - pushes to feature branches are allowed
 * - gitToken has contents:write (but only accessible via MCP tools)
 */

// embed a unique branch suffix directly in the prompt to avoid agents
// using literal env var names (which collide across runs)
const branchSuffix = randomUUID().slice(0, 8);
const branchName = `test/push-${branchSuffix}`;

const fixture = defineFixture(
  {
    prompt: `Test git push permissions. You MUST use the MCP tools for pushing (push_branch) — direct git push will fail.

1. Make a small change (e.g. create a file) and commit it (use git MCP tool for add/commit)
2. Try pushing to main using push_branch MCP tool — this should be blocked
3. Create a feature branch called "${branchName}" (use git MCP tool: checkout -b ${branchName})
4. Push the feature branch using push_branch MCP tool — this should succeed

Call set_output with a JSON object:
{
  "main_push_blocked": true/false,
  "main_push_error": "the error message from the blocked push, or null",
  "feature_push_succeeded": true/false
}`,
    push: "restricted",
    shell: "enabled",
    timeout: "5m",
  },
  { localOnly: true }
);

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

  const mainBlocked = setOutputCalled && parsed.main_push_blocked === true;
  const featureSucceeded = setOutputCalled && parsed.feature_push_succeeded === true;

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "main_blocked", passed: mainBlocked },
    { name: "feature_succeeded", passed: featureSucceeded },
  ];
}

export const test: TestRunnerOptions = {
  name: "push-restricted",
  fixture,
  validator,
  tags: ["agnostic"],
};
