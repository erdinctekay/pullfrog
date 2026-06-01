/**
 * Single source of truth for MCP tools subagents are forbidden from calling.
 *
 * Subagents share the orchestrator's in-process git working tree, `toolState`,
 * progress comment, and run-scoped pr/branch context. A subagent that calls
 * `checkout_pr` switches the orchestrator's HEAD; one that calls `push_branch`
 * pushes whatever the orchestrator happens to have committed. The 2026-05-18
 * `zed-industries/cloud` incident hit exactly this: a `reviewfrog` lens
 * dispatched `checkout_pr({2582})` mid-review, the orchestrator's next push
 * clobbered an unrelated engineer's branch. PR #796 added runtime backstops
 * inside `checkout_pr`/`push_branch`; this list is the upstream gate that
 * stops the call from ever reaching MCP when it originates from a subagent.
 *
 * The gate is enforced at two pre-tool hooks:
 *   - opencode: `tool.execute.before` (action/agents/opencodePlugin.ts)
 *   - claude:   `PreToolUse` settings hook (action/agents/claudePretoolGate.ts)
 *
 * Names are stored in their canonical bare form (the FastMCP tool `name`
 * field). Each runtime presents them with a different prefix:
 *   - claude:   `mcp__pullfrog__<name>`
 *   - opencode: `pullfrog_<name>`
 * The hooks strip those prefixes before comparing.
 *
 * Read-only MCP tools (`get_*`, `list_*`, `git_fetch`, `get_check_suite_logs`,
 * `await_dependency_installation`, etc.) and the `git`/`shell` tools stay off
 * this list — denying them would make review work impossible. The reviewer system prompt
 * (`action/agents/reviewer.ts`) already forbids state-changing shell/git
 * subcommands as a prose constraint; this list is the belt-and-suspenders
 * machine fence for the high-stakes mutations we can identify by name alone.
 *
 * When adding a state-changing MCP tool to `action/mcp/server.ts`, add its
 * canonical name here too. Inclusions justified inline.
 */
export const SUBAGENT_DENIED_TOOLS = [
  // working-tree mutation: switches HEAD onto pr-N and registers a push remote
  "checkout_pr",

  // remote mutation: pushes commits / branches / tags / deletes a branch
  "push_branch",
  "push_tags",
  "delete_branch",

  // GitHub PR state mutation
  "create_pull_request",
  "update_pull_request_body",

  // GitHub comment / issue mutation
  "create_issue",
  "create_issue_comment",
  "edit_issue_comment",
  "reply_to_review_comment",

  // GitHub review state mutation
  "create_pull_request_review",
  "resolve_review_thread",

  // GitHub label mutation
  "add_labels",

  // run-state mutation: workflow output, progress comment, run mode select
  "set_output",
  "report_progress",
  "select_mode",

  // process / filesystem mutation outside the agent's intended scope
  "start_dependency_installation",
  "kill_background",
  "upload_file",
] as const;

export type SubagentDeniedTool = (typeof SUBAGENT_DENIED_TOOLS)[number];

/**
 * Strip the runtime-specific MCP prefix from a tool name and return the
 * canonical bare name (matching FastMCP's `name:` field). Returns the input
 * unchanged if it doesn't carry a known prefix — keeping comparison simple
 * for native (non-MCP) tools, which never appear on the deny list anyway.
 */
export function stripMcpPrefix(toolName: string): string {
  // claude: `mcp__pullfrog__checkout_pr` → `checkout_pr`
  if (toolName.startsWith("mcp__pullfrog__")) return toolName.slice("mcp__pullfrog__".length);
  // opencode: `pullfrog_checkout_pr` → `checkout_pr`
  if (toolName.startsWith("pullfrog_")) return toolName.slice("pullfrog_".length);
  return toolName;
}

/**
 * Whether `toolName` (in any runtime's prefix style) names a tool that
 * subagents must not call.
 */
export function isSubagentDeniedTool(toolName: string): boolean {
  const bare = stripMcpPrefix(toolName);
  return (SUBAGENT_DENIED_TOOLS as readonly string[]).includes(bare);
}

/**
 * Human-readable refusal surfaced to the model when a denied tool is gated.
 * Phrased so a halfway-attentive subagent realises (a) the tool is denied to
 * it specifically, (b) why (shared in-process state with the orchestrator),
 * and (c) what to do instead (report findings; the orchestrator can call the
 * tool directly).
 */
export function buildSubagentDenyMessage(toolName: string): string {
  const bare = stripMcpPrefix(toolName);
  return (
    `subagent attempted to call denied tool '${bare}'. ` +
    `subagents share the orchestrator's in-process working tree and toolState; ` +
    `state-changing MCP tools (checkout_pr, push_branch, create_pull_request_review, ` +
    `report_progress, etc.) are reserved for the orchestrator. ` +
    `report findings back to the orchestrator and let it perform the mutation.`
  );
}
