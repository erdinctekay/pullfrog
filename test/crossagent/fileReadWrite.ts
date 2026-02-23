import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, generateAgentUuids, getStructuredOutput } from "../utils.ts";

/**
 * fileReadWrite test - validates MCP file_read, file_write, file_edit, and
 * file_delete work for all agents and that modifications to .git/ are blocked.
 */

const PROMPT = `First run: echo $PULLFROG_FILE_TEST
Use that exact output as your marker.

1. Use gh_pullfrog/file_write to write test-file.txt with content "BEFORE:<marker>" (replace <marker> with the actual marker value).
2. Use gh_pullfrog/file_edit to replace "BEFORE:" with "AFTER:" in test-file.txt.
3. Use gh_pullfrog/file_read to read test-file.txt back. Verify it starts with "AFTER:".
4. Use gh_pullfrog/file_delete to delete test-file.txt.
5. Try gh_pullfrog/file_read on test-file.txt again — it should fail (file was deleted).
6. Try gh_pullfrog/file_edit on .git/config with old_string "x" and new_string "y" (should fail — .git is protected).
7. Try gh_pullfrog/file_delete on .git/config (should fail — .git is protected).
8. Call set_output with: READ=<content you read in step 3>,DELETED=true or DELETED=false (step 5 failed = file gone),GIT_BLOCKED=true or GIT_BLOCKED=false (steps 6 and 7 both rejected).`;

const fixture = defineFixture(
  {
    prompt: PROMPT,
    shell: "enabled",
    effort: "mini",
    timeout: "3m",
  },
  { localOnly: true }
);

const { getUuid, agentEnv } = generateAgentUuids(["PULLFROG_FILE_TEST"]);

function validator(result: AgentResult): ValidationCheck[] {
  const marker = getUuid(result.agent, "PULLFROG_FILE_TEST");
  const output = getStructuredOutput(result);
  const setOutputCalled = output !== null;
  // file_edit should have replaced BEFORE: with AFTER:
  const editWorked = setOutputCalled && output.includes(`AFTER:${marker}`);
  const deleteWorked = setOutputCalled && /DELETED=true/i.test(output);
  const gitBlocked = setOutputCalled && /GIT_BLOCKED=true/i.test(output);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "edit_worked", passed: editWorked },
    { name: "delete_worked", passed: deleteWorked },
    { name: "git_blocked", passed: gitBlocked },
  ];
}

export const test: TestRunnerOptions = {
  name: "file-read-write",
  fixture,
  validator,
  agentEnv,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  tags: ["fs"],
};
