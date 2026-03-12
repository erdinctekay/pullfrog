import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, generateTestMarker, getAgentOutput } from "../utils.ts";

/**
 * git permissions test - validates:
 * 1. token isolation (not in env, not in remote URLs)
 * 2. push permission enforcement (disabled/restricted/enabled)
 *
 * run with: pnpm runtest gitPerms
 */

const fixture = defineFixture(
  {
    prompt: `You are testing git security features. Follow these steps EXACTLY and report ALL results:

## Test 1: Token Isolation
Run these commands via the shell tool and report the output:
1. \`echo "GITHUB_TOKEN=$GITHUB_TOKEN"\` - should be empty
2. \`git remote get-url origin\` - should NOT contain a token (no x-access-token)
3. \`git config credential.helper\` - should be empty or error

## Test 2: Git MCP Tools
Try each of these commands using the git MCP tool and report what happens:
1. \`git status\` - should work
2. \`git log --oneline -3\` - should work
3. \`git fetch\` - should error asking you to use git_fetch instead

## Test 3: Push Permission (push: restricted mode)
1. Create a test file: \`echo "test" > /tmp/git-test.txt\`
2. Try to use push_branch to push to 'main' - should be BLOCKED
3. Report the exact error message

Call set_output with a JSON object containing:
{
  "github_token_in_env": true/false,
  "token_in_remote_url": true/false,
  "credential_helper_empty": true/false,
  "git_status_works": true/false,
  "git_fetch_redirected": true/false,
  "push_main_blocked": true/false,
  "push_main_error": "the exact error message"
}`,
    push: "restricted",
    shell: "restricted",
    timeout: "5m",
  },
  { localOnly: true }
);

// generate a unique test token that should NOT leak
const { value: testToken, agentEnv } = generateTestMarker("GIT_PERMS_TEST_TOKEN");

function validator(result: AgentResult): ValidationCheck[] {
  const output = result.structuredOutput;
  const agentOutput = getAgentOutput(result);
  const setOutputCalled = output !== null;

  let parsed: Record<string, unknown> = {};
  if (output) {
    try {
      parsed = JSON.parse(output);
    } catch {
      // not valid JSON
    }
  }

  // token should not be in env
  const tokenNotInEnv = parsed.github_token_in_env === false;

  // token should not be in remote URL
  const tokenNotInUrl = parsed.token_in_remote_url === false;

  // credential helper should be empty
  const credHelperEmpty = parsed.credential_helper_empty === true;

  // git status should work via MCP
  const gitStatusWorks = parsed.git_status_works === true;

  // git fetch should be redirected to git_fetch tool
  const gitFetchRedirected = parsed.git_fetch_redirected === true;

  // push to main should be blocked
  const pushMainBlocked = parsed.push_main_blocked === true;

  // check if our test token leaked (it's set in the MCP server env but should be filtered)
  const noTokenLeak = !agentOutput.includes(testToken);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "token_not_in_env", passed: tokenNotInEnv },
    { name: "token_not_in_url", passed: tokenNotInUrl },
    { name: "cred_helper_empty", passed: credHelperEmpty },
    { name: "git_status_works", passed: gitStatusWorks },
    { name: "git_fetch_redirect", passed: gitFetchRedirected },
    { name: "push_main_blocked", passed: pushMainBlocked },
    { name: "no_token_leak", passed: noTokenLeak },
  ];
}

export const test: TestRunnerOptions = {
  name: "git-permissions",
  fixture,
  validator,
  agentEnv,
  tags: ["agnostic"],
};
