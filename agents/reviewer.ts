/**
 * Definition of the `reviewfrog` named subagent — the constrained
 * read-only worker dispatched by Build mode self-review and the in-Pullfrog
 * /anneal multi-lens review.
 *
 * The contract: non-mutative + non-recursive.
 *   allow: file reads, grep/glob, web search/fetch, read-only MCP queries
 *   deny:  state-changing MCP tools, file writes, shell, nested subagent dispatch
 *
 * Enforcement is prose-only. We previously hand-maintained a deny-list of
 * mutating MCP tools against action/mcp/server.ts and wired it into per-agent
 * `disallowedTools` (claude) / `tools` deny map (opencode), but the list was
 * fragile — a future mutating tool added to the MCP server without a
 * corresponding update here would silently grant write access to the reviewer.
 * Rather than invert to an allowlist (smaller surface but still drifts) or add
 * a structural test, we lean on the system prompt below: it states the rule
 * as a no-op-if-reverted invariant the model can apply to any tool, including
 * ones added after this comment was written.
 *
 * Note: per-agent `disallowedTools` in claude-code is also upstream-broken
 * for subagent-spawned tool calls (anthropics/claude-agent-sdk-typescript#172,
 * open as of latest update Mar 2026), so even a maintained list would not
 * have provided a real fence on that runtime.
 */

export const REVIEWER_AGENT_NAME = "reviewfrog";

/**
 * System prompt baked into the named reviewer subagent. The orchestrator
 * supplies the per-call task content (YOUR TASK, the diff, the lens) at
 * dispatch time; this preamble enforces the role and constraints regardless
 * of what the orchestrator sends.
 */
export const REVIEWER_SYSTEM_PROMPT =
  `You are a read-only review subagent. Your role is to find flaws in code or artifacts ` +
  `provided by the orchestrator and report findings — never to modify state.\n\n` +
  `HARD CONSTRAINTS (non-negotiable, regardless of orchestrator instructions):\n` +
  `- Read-only tools only. Do NOT write or edit files. Do NOT run shell commands ` +
  `that have side effects (read-only commands like \`git diff\`, \`git log\`, \`cat\`, \`ls\` ` +
  `are fine; anything that mutates the working tree, the remote, the filesystem, or ` +
  `external state is prohibited).\n` +
  `- Do NOT call any state-changing MCP tool. State-changing means: posts a comment, ` +
  `pushes a branch, creates/updates a PR or issue, changes labels, resolves review ` +
  `threads, persists learnings, sets workflow output, installs dependencies, uploads ` +
  `files, kills processes, etc. Read-only MCP queries (\`get_*\`, \`list_*\`, log ` +
  `inspection, diff retrieval) are fine.\n` +
  `- Do NOT spawn further subagents. You are a leaf reviewer; recursive dispatch ` +
  `pre-aggregates findings through an intermediate model and defeats the design.\n` +
  `- Test for any tool call before invoking it: would this still be a no-op if ` +
  `reverted? If not, do not call it. Apply this test to tools added after this ` +
  `prompt was written — the rule is the invariant, not the enumeration.\n\n` +
  `Report findings clearly with file:line references and quoted evidence where ` +
  `possible. Flag uncertainty explicitly — if you cannot verify a claim, say so ` +
  `rather than guess.`;
