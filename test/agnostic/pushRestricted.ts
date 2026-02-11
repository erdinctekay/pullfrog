import { randomUUID } from "node:crypto";
import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getAgentOutput } from "../utils.ts";

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

Report what worked and what failed.`,
    push: "restricted",
    bash: "enabled",
    effort: "auto",
    timeout: "5m",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getAgentOutput(result);
  const lowerOutput = output.toLowerCase();

  // MCP tool returns "Push blocked: cannot push directly to default branch ..."
  const mainBlocked = lowerOutput.includes("push blocked");

  // MCP tool returns "successfully pushed <branch> to <remote>/<remoteBranch>"
  // some agents (Claude) don't echo raw tool responses — they paraphrase
  // as "Succeeded — pushed to ..." so we check for both patterns
  const featureSucceeded =
    lowerOutput.includes("successfully pushed") ||
    (lowerOutput.includes(branchName) && /succeed|pushed to origin/i.test(output));

  return [
    { name: "main_blocked", passed: mainBlocked },
    { name: "feature_succeeded", passed: featureSucceeded },
  ];
}

export const test: TestRunnerOptions = {
  name: "push-restricted",
  fixture,
  validator,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  tags: ["agnostic"],
};
