import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getStructuredOutput } from "../utils.ts";

/**
 * fileTraversal test - validates path traversal is blocked by all MCP file tools.
 *
 * agent tries to read/write/edit/delete/list outside repo via gh_pullfrog file tools.
 * all out-of-repo operations should fail; in-repo operations should succeed.
 */

const PROMPT = `Use only gh_pullfrog MCP file tools (file_read, file_write, file_edit, file_delete, list_directory).

1. Try gh_pullfrog/file_read with path "../../etc/hostname" (traversal above repo).
2. Try gh_pullfrog/file_read with path "/etc/hostname" (absolute path outside repo).
3. Try gh_pullfrog/file_write with path "../outside-repo.txt" and content "x" (write outside repo).
4. Try gh_pullfrog/file_edit with path "../../etc/hostname" old_string "a" new_string "b" (edit outside repo).
5. Try gh_pullfrog/file_delete with path "../../etc/hostname" (delete outside repo).
6. Try gh_pullfrog/list_directory with path "../../etc" (list outside repo).
7. Use gh_pullfrog/file_write to write test-file.txt with content "ok", then file_read test-file.txt (valid, within repo).

Report which operations succeeded vs failed. Call set_output with TRAVERSAL_BLOCKED=true if all out-of-repo operations (1–6) failed, or TRAVERSAL_BLOCKED=false if any of them succeeded.`;

const fixture = defineFixture(
  {
    prompt: PROMPT,
    shell: "restricted",
    effort: "auto",
    timeout: "5m",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getStructuredOutput(result);
  const setOutputCalled = output !== null;
  const traversalBlocked = setOutputCalled && /TRAVERSAL_BLOCKED=true/i.test(output);
  // extra safety: structured output should not be exactly a hostname (leaked from /etc/hostname)
  const trimmed = output?.trim() ?? "";
  const noLeakedContent =
    !setOutputCalled ||
    trimmed.includes("TRAVERSAL_BLOCKED") ||
    trimmed.includes(" ") ||
    trimmed.length > 40;

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "traversal_blocked", passed: traversalBlocked },
    { name: "no_leaked_content", passed: noLeakedContent },
  ];
}

export const test: TestRunnerOptions = {
  name: "file-traversal",
  fixture,
  validator,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  tags: ["agnostic", "fs"],
};
