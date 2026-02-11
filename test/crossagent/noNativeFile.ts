import type { AgentResult, TestRunnerOptions, ValidationCheck } from "../utils.ts";
import { defineFixture, generateAgentUuids, getStructuredOutput } from "../utils.ts";

/**
 * noNativeFile test - validates native file read/write tools are disabled.
 * agent must use MCP file_write; native tools should be unavailable.
 *
 * push is disabled so codex runs in read-only sandbox, which blocks its native
 * apply_patch tool (there is no feature flag to disable it). MCP file_write
 * still works because it runs server-side outside the sandbox.
 */

const PROMPT = `Get your marker by running: echo $PULLFROG_NOFILE_TEST (use gh_pullfrog/bash for shell commands).

1. Try to call a NATIVE (non-MCP) file tool to write a file. Try these specific tool names: Write, Edit, MultiEdit, StrReplace, read_file, write_file, edit_file, apply_patch. These are agent-native tools, NOT MCP tools. Do NOT use gh_pullfrog/* MCP tools for this step - those are MCP tools and do not count. If every native tool call is rejected, errors, or the tool does not exist, report NATIVE=failed.
2. Use the MCP tool gh_pullfrog/file_write to write mcp-worked.txt with your marker.
3. Call set_output with: NATIVE=succeeded or NATIVE=failed, MCP=succeeded or MCP=failed.

IMPORTANT: step 1 is about native/built-in tools only (NOT gh_pullfrog/* MCP tools). step 2 is about MCP tools only.`;

const fixture = defineFixture(
  {
    prompt: PROMPT,
    bash: "restricted",
    push: "disabled",
    effort: "mini",
    timeout: "3m",
  },
  { localOnly: true }
);

const { agentEnv } = generateAgentUuids(["PULLFROG_NOFILE_TEST"]);

function validator(result: AgentResult): ValidationCheck[] {
  const output = getStructuredOutput(result);
  const fullOutput = result.output;
  const setOutputCalled = output !== null;

  // handle both key=value format (NATIVE=succeeded) and JSON format ("NATIVE":"succeeded")
  const reportedNativeSucceeded = setOutputCalled && /NATIVE.{0,3}succeeded/i.test(output);

  // some agents expose tool-availability metadata in logs; treat that as
  // definitive evidence that native file tools are blocked.
  const nativeFileToolsUnavailable =
    fullOutput.includes("Model tried to call unavailable tool") ||
    (fullOutput.includes("excluded tools:") &&
      (fullOutput.includes("read_file") ||
        fullOutput.includes("write_file") ||
        fullOutput.includes("edit_file"))) ||
    (fullOutput.includes("disallowed tools:") &&
      (fullOutput.includes("Read") ||
        fullOutput.includes("Write") ||
        fullOutput.includes("Edit") ||
        fullOutput.includes("MultiEdit")));

  // if an agent claims native success but the trace shows MCP file tools,
  // treat it as native blocked (instruction-following drift, not bypass).
  const nativeAttemptReroutedToMcp =
    (fullOutput.includes("delegated to") && fullOutput.includes("file_write")) ||
    fullOutput.includes("mcp__gh_pullfrog__file_write") ||
    fullOutput.includes("gh_pullfrog_file_write");

  const nativeBlocked =
    !reportedNativeSucceeded || nativeFileToolsUnavailable || nativeAttemptReroutedToMcp;
  const mcpWorks = setOutputCalled && /MCP.{0,3}succeeded/i.test(output);

  return [
    { name: "set_output", passed: setOutputCalled },
    { name: "native_blocked", passed: nativeBlocked },
    { name: "mcp_works", passed: mcpWorks },
  ];
}

export const test: TestRunnerOptions = {
  name: "no-native-file",
  fixture,
  validator,
  agentEnv,
  env: { GITHUB_REPOSITORY: "pullfrog/test-repo" },
  tags: ["fs"],
};
