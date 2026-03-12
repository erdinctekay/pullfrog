import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture } from "../utils.ts";

/**
 * push enabled test - validates full push access.
 * NOTE: This actually pushes to the test repo - use with caution!
 *
 * run with: pnpm runtest pushEnabled
 */

const fixture = defineFixture(
  {
    prompt: `You are testing git permissions with push: enabled (full access).

## Test 1: Create and Push a Branch
1. Create a new local branch called "test-push-enabled-\${RANDOM}" using the git MCP tool (git checkout -b)
2. Push it using push_branch
3. Report if it succeeded

## Test 2: Tag Operations
1. Create a local tag using the git MCP tool: git tag -a test-tag-enabled -m "test tag"
2. Try push_tags tool with tag "test-tag-enabled"
3. Report if tag push succeeded

## Test 3: Branch Deletion (cleanup)
1. Try delete_branch on the branch you created
2. Report if deletion succeeded

DO NOT push to main or delete important branches!

Call set_output with a JSON object containing:
{
  "branch_push_worked": true/false,
  "branch_name": "the branch you created",
  "push_tags_worked": true/false,
  "delete_branch_worked": true/false
}`,
    push: "enabled",
    shell: "restricted",
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

  // all operations should work with push: enabled
  const branchPushWorked = parsed.branch_push_worked === true;
  const pushTagsWorked = parsed.push_tags_worked === true;
  const deleteBranchWorked = parsed.delete_branch_worked === true;

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "branch_push", passed: branchPushWorked },
    { name: "push_tags", passed: pushTagsWorked },
    { name: "delete_branch", passed: deleteBranchWorked },
  ];
}

export const test: TestRunnerOptions = {
  name: "push-enabled",
  fixture,
  validator,
  tags: ["agnostic"],
};
