import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import {
  defineFixture,
  generateTestMarker,
  getAgentOutput,
  getStructuredOutput,
} from "../utils.ts";

/**
 * delegate-two-phase — orchestrator runs two sequential delegations where
 * the second phase depends on state created by the first.
 *
 * phase 1: subagent writes a file with a unique marker.
 * phase 2: subagent reads the file and reports its content.
 *
 * tests that file state persists across delegation phases (both subagents
 * run in the same working directory) and that the orchestrator correctly
 * chains phases by passing context from phase 1 into phase 2's instructions.
 */

const marker = generateTestMarker("PULLFROG_PHASE_MARKER");

const fixture = defineFixture(
  {
    prompt: `You are an orchestrator. You must run TWO sequential delegation phases.

First, read the marker value: run echo $PULLFROG_PHASE_MARKER

PHASE 1 — WRITE:
Select Plan mode via select_mode, then delegate with mini effort.
Subagent instructions: "Use gh_pullfrog/file_write to write a file called 'delegation-test.txt' with the content '<MARKER_VALUE>'. Then call gh_pullfrog/set_output with 'PHASE1_DONE'. Do not create branches or PRs."
(Replace <MARKER_VALUE> with the actual marker value you read.)

PHASE 2 — READ AND VERIFY:
After Phase 1 completes, select Plan mode again and delegate with mini effort.
Subagent instructions: "Use gh_pullfrog/file_read to read the file 'delegation-test.txt'. Call gh_pullfrog/set_output with the EXACT content of the file. Do not create branches or PRs."

After both phases complete, call set_output with: "WRITTEN=<marker>,READ=<what_phase2_returned>"`,
    effort: "auto",
    timeout: "10m",
    shell: "enabled",
  },
  { localOnly: true }
);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getStructuredOutput(result);
  const agentOutput = getAgentOutput(result);
  const secret = marker.value;

  const setOutputCalled = output !== null;

  // two delegation calls should appear in logs
  const delegationMatches = agentOutput.match(/» delegating subagent=/g);
  const twoDelegations = delegationMatches !== null && delegationMatches.length >= 2;

  // the marker should appear in both WRITTEN= and READ= sections.
  // use greedy match for READ= since subagents may prefix with "content:" etc.
  const writtenMatch = output ? /WRITTEN=([^\s,]+)/i.exec(output) : null;
  const markerWritten = writtenMatch?.[1].includes(secret) ?? false;
  const readSection = output ? /READ=(.+)/i.exec(output) : null;
  const markerRead = readSection?.[1].includes(secret) ?? false;

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "two_delegations", passed: twoDelegations },
    { name: "marker_written", passed: markerWritten },
    { name: "marker_read_back", passed: markerRead },
  ];
}

export const test: TestRunnerOptions = {
  name: "delegate-two-phase",
  fixture,
  validator,
  agentEnv: marker.agentEnv,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  tags: ["adhoc"],
};
