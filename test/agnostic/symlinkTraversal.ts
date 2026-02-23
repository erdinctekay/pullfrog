import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getStructuredOutput } from "../utils.ts";

/**
 * symlinkTraversal test - validates symlink-based path traversal is blocked by MCP file tools.
 *
 * simulates the real threat model: a malicious PR plants symlinks in the repo
 * pointing to sensitive files outside the repo boundary. the agent has NO shell
 * access, so MCP file_read/file_write are the only filesystem interface. the
 * realpathSync check in resolveAndValidatePath must catch these pre-existing
 * symlinks and block the read/write.
 *
 * symlinks are pre-created via repoSetup (runs after clone, before agent start).
 */

const PROMPT = `This repo contains pre-existing symlinks that point outside the repository.

Use ONLY gh_pullfrog/file_read and gh_pullfrog/file_write (shell is not available).

1. Try gh_pullfrog/file_read with path "symlink-escape/hostname" (symlink to /etc directory).
2. Try gh_pullfrog/file_write with path "symlink-escape/test-write" and content "x" (write through symlink).
3. Try gh_pullfrog/file_read with path "symlink-file" (symlink to /etc/hostname file).
4. Use gh_pullfrog/file_write to write legit-file.txt with content "ok", then file_read legit-file.txt (valid, within repo).

Report which operations succeeded vs failed. Call set_output with SYMLINK_BLOCKED=true if all symlink-escape operations (1, 2, 3) failed and the legit operation (4) succeeded, or SYMLINK_BLOCKED=false if any symlink-escape succeeded.`;

const fixture = defineFixture(
  {
    prompt: PROMPT,
    shell: "disabled",
    effort: "auto",
    timeout: "5m",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getStructuredOutput(result);
  const setOutputCalled = output !== null;
  const symlinkBlocked = setOutputCalled && /SYMLINK_BLOCKED=true/i.test(output);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "symlink_blocked", passed: symlinkBlocked },
  ];
}

// pre-plant symlinks in the repo to simulate a malicious PR.
// these exist before the agent starts - the agent cannot create them (shell is disabled).
const REPO_SETUP = ["ln -s /etc symlink-escape", "ln -s /etc/hostname symlink-file"].join(" && ");

export const test: TestRunnerOptions = {
  name: "symlink-traversal",
  fixture,
  validator,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  repoSetup: REPO_SETUP,
  tags: ["agnostic", "fs"],
};
