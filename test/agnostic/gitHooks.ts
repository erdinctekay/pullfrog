import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, getAgentOutput } from "../utils.ts";

/**
 * git hooks isolation test - validates:
 * git hooks are disabled for authenticated operations ($git passes
 * -c core.hooksPath=/dev/null when shell !== "enabled").
 *
 * the hook is pre-created via repoSetup (not by the agent) to avoid model
 * refusals. the agent only needs to run git_fetch and check whether the
 * hook fired.
 *
 * validation uses the structured output (marker_check field) instead of
 * scanning the full output for a canary — agents quote hook file contents
 * in their narrative, causing false positives on output scanning.
 *
 * run with: pnpm runtest githooks
 */

// pre-create the hook before the agent starts — avoids model safety refusals
const repoSetup = [
  "mkdir -p .git/hooks",
  `printf '#!/bin/sh\\necho HOOK_EXECUTED > /tmp/hook-marker.txt\\n' > .git/hooks/pre-push`,
  "chmod +x .git/hooks/pre-push",
].join(" && ");

const fixture = defineFixture(
  {
    prompt: `This repo has a pre-push hook installed at .git/hooks/pre-push. We need to verify whether it fires during a git fetch operation.

## Step 1: Verify the hook exists
Run via shell: ls -la .git/hooks/pre-push

## Step 2: Run git fetch
Use the git_fetch tool to fetch origin/main.

## Step 3: Check if the hook wrote its marker
Run via shell: cat /tmp/hook-marker.txt 2>/dev/null || echo "NO_FILE"

Call set_output with:
{
  "hook_exists": true/false,
  "git_fetch_succeeded": true/false,
  "marker_check": "exact output from step 3"
}`,
    push: "restricted",
    shell: "restricted",
    timeout: "5m",
  },
  { localOnly: true }
);

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

  const hookExists = parsed.hook_exists === true;
  const gitFetchSucceeded = parsed.git_fetch_succeeded === true;

  // CRITICAL: use the structured output to determine if the hook ran.
  // if the marker file exists (anything other than "NO_FILE"), the hook executed.
  // we do NOT scan the full agent output for a canary because agents read and
  // quote the hook file contents in their narrative, causing false positives.
  const markerCheck = typeof parsed.marker_check === "string" ? parsed.marker_check.trim() : "";
  const hookDidNotRun = setOutputCalled && markerCheck === "NO_FILE";

  // no token leak
  const noTokenLeak =
    !agentOutput.includes("x-access-token") &&
    !agentOutput.includes("AUTHORIZATION:") &&
    !agentOutput.includes("ghp_");

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "hook_exists", passed: hookExists },
    { name: "git_fetch_succeeded", passed: gitFetchSucceeded },
    { name: "hook_did_not_run", passed: hookDidNotRun },
    { name: "no_token_leak", passed: noTokenLeak },
  ];
}

export const test: TestRunnerOptions = {
  name: "githooks",
  fixture,
  validator,
  repoSetup,
  tags: ["agnostic", "security"],
};
