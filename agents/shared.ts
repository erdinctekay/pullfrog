import { execFileSync } from "node:child_process";
import type { AgentId } from "../external.ts";
import { log } from "../utils/cli.ts";
import type { ResolvedInstructions } from "../utils/instructions.ts";
import type { ResolvedPayload } from "../utils/payload.ts";
import type { TodoTracker } from "../utils/todoTracking.ts";

// maximum number of stderr lines to keep in the rolling buffer during agent execution
export const MAX_STDERR_LINES = 20;

// ── post-run retry loop ────────────────────────────────────────────────────────

/**
 * how many times the post-run loop may resume the agent to fix a dirty tree
 * or a failing stop hook before giving up.
 */
export const MAX_POST_RUN_RETRIES = 3;

export function getGitStatus(): string {
  try {
    return execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  } catch {
    return "";
  }
}

export function buildCommitPrompt(status: string): string {
  return [
    `UNCOMMITTED CHANGES — the working tree is dirty. push all changes to a pull request (new or existing). \`git status\` must be clean before you finish.`,
    "",
    "```",
    status,
    "```",
  ].join("\n");
}

export interface StopHookFailure {
  exitCode: number;
  output: string;
}

export interface SummaryStale {
  /** absolute path to the seeded snapshot file the agent was meant to edit. */
  filePath: string;
}

export interface PostRunIssues {
  stopHook?: StopHookFailure;
  dirtyTree?: string;
  /** populated when the rolling PR summary file is byte-identical to its
   * seed, i.e. the agent never touched it. soft gate — nudges once via a
   * resume turn but never fails the run, parallel to dirtyTree semantics. */
  summaryStale?: SummaryStale;
  /**
   * populated when the agent selected a review mode but the post-run check
   * over toolState shows neither a `create_pull_request_review` submission
   * nor a final `report_progress` write happened. derived inline from
   * `toolState.selectedMode` + `toolState.review` + `toolState.finalSummaryWritten`
   * — no parallel toolState flag is stored. carries the mode name so the
   * resume prompt can reference it. handled like `stopHook`: nudge via
   * resume, hard-fail if still unsatisfied after `MAX_POST_RUN_RETRIES`.
   */
  unsubmittedReview?: "Review" | "IncrementalReview";
}

export function hasPostRunIssues(issues: PostRunIssues): boolean {
  return (
    issues.stopHook !== undefined ||
    issues.dirtyTree !== undefined ||
    issues.summaryStale !== undefined ||
    issues.unsubmittedReview !== undefined
  );
}

/**
 * token/cost usage data from a single agent run.
 *
 * NOTE on semantics: `inputTokens` here is the *total* billable input for the
 * run — non-cached input + cache read + cache write — matching the per-agent
 * SDK conventions. This is what gets persisted to `WorkflowRun.inputTokens`.
 *
 * The stdout token table and markdown step summary display a different "Input"
 * column that shows only the non-cached portion (derivable as
 * `inputTokens - cacheReadTokens - cacheWriteTokens`) so humans can see the
 * cache hit ratio at a glance. Dashboards that query `WorkflowRun.inputTokens`
 * directly are seeing the full total, not the log column.
 */
export interface AgentUsage {
  agent: string;
  /** full billable input: non-cached + cache read + cache write */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  costUsd?: number | undefined;
}

export interface AgentToolUseEvent {
  toolName: string;
  input: unknown;
}

/**
 * Result returned by agent execution
 */
export interface AgentResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  metadata?: Record<string, unknown>;
  usage?: AgentUsage | undefined;
}

/**
 * Minimal context passed to agent.run()
 */
export interface AgentRunContext {
  payload: ResolvedPayload;
  resolvedModel?: string | undefined;
  mcpServerUrl: string;
  tmpdir: string;
  instructions: ResolvedInstructions;
  todoTracker?: TodoTracker | undefined;
  /**
   * user-configured stop hook script. runs after the agent finishes each
   * attempt; non-zero exit resumes the agent with the hook output as
   * guidance. null when the repo has no stop hook configured.
   */
  stopScript?: string | null | undefined;
  /**
   * absolute path to the rolling PR summary tmpfile, when one was seeded
   * for this run (Review / IncrementalReview / pr-summary Task). enables
   * a post-run sanity nudge that prompts the agent if the file is still
   * byte-identical to its seed.
   */
  summaryFilePath?: string | undefined;
  /**
   * exact bytes of the seeded summary file. compared against the current
   * file content after each agent attempt to detect "agent forgot to edit
   * the summary" — particularly common with smaller models that lose
   * track of multi-step instructions.
   */
  summarySeed?: string | undefined;
  /**
   * absolute path to the rolling repo-level learnings tmpfile. seeded for
   * every run from `Repo.learnings`. used by the post-run reflection turn
   * so the prompt can point the agent at a concrete path to edit; the
   * file's content is read back and persisted by main.ts after the run.
   */
  learningsFilePath?: string | undefined;
  /**
   * called synchronously when the agent subprocess is killed for inner
   * activity timeout. lets main.ts tear down shared resources (MCP HTTP
   * server) so lingering SSE reconnects don't keep the outer timer alive.
   */
  onActivityTimeout?: (() => void) | undefined;
  onToolUse?: ((event: AgentToolUseEvent) => void) | undefined;
  /**
   * post-run check derived from toolState: returns the selected mode when
   * the agent picked Review / IncrementalReview but neither submitted a
   * review nor wrote a final progress comment, otherwise `null`. main.ts
   * supplies the closure so the agent harness has no direct toolState
   * dependency; the closure fires synchronously after each agent attempt
   * so it sees the latest mutations from any MCP tool calls.
   */
  getUnsubmittedReview?: (() => "Review" | "IncrementalReview" | null) | undefined;
}

export interface Agent {
  name: AgentId;
  install: (token?: string) => Promise<string>;
  run: (ctx: AgentRunContext) => Promise<AgentResult>;
}

export const agent = (input: Agent): Agent => {
  return {
    ...input,
    run: async (ctx: AgentRunContext): Promise<AgentResult> => {
      log.debug(`» payload: ${JSON.stringify(ctx.payload, null, 2)}`);
      return input.run(ctx);
    },
  };
};

/** format a USD cost to 4 decimal places, always showing the leading zero */
export function formatCostUsd(costUsd: number): string {
  return costUsd.toFixed(4);
}

/**
 * merge two AgentUsage snapshots into one running total.
 *
 * both agent harnesses invoke their runner multiple times per `run()` when the
 * post-run retry loop kicks in (MAX_POST_RUN_RETRIES). each invocation
 * produces its own AgentUsage; we sum them so downstream callers (usage
 * summary, WorkflowRun persistence) see the whole session — not just the
 * final retry's slice.
 *
 * returns `undefined` when both sides are empty so callers can short-circuit
 * without a special case. zero-valued cache / cost fields are dropped to
 * `undefined` for symmetry with each harness's `buildUsage`.
 */
export function mergeAgentUsage(
  a: AgentUsage | undefined,
  b: AgentUsage | undefined
): AgentUsage | undefined {
  // always return a fresh object — callers treat AgentUsage as immutable, and
  // returning `a` / `b` directly would leak that invariant to future callers
  if (!a && !b) return undefined;
  if (!a) return { ...(b as AgentUsage) };
  if (!b) return { ...a };
  const cacheRead = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0);
  const cacheWrite = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0);
  const cost = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    agent: a.agent,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: cacheRead > 0 ? cacheRead : undefined,
    cacheWriteTokens: cacheWrite > 0 ? cacheWrite : undefined,
    costUsd: cost > 0 ? cost : undefined,
  };
}

/**
 * unified per-run token table used by every agent harness.
 *
 * columns are kept stable across agents and models so downstream log parsers
 * (scripts/token-usage.ts, cost dashboards) only have to understand one format:
 *
 *   Input       non-cached input tokens sent this run
 *   Cache Read  input tokens served from prompt cache (Anthropic, etc.)
 *   Cache Write input tokens written to prompt cache this run
 *   Output      assistant output tokens
 *   Total       sum of the four columns — the real billable quantity
 *   Cost ($)    USD cost reported by the provider (only rendered when known)
 *
 * models that don't report prompt caching leave Cache Read / Write at 0.
 * OpenCode emits per-step `part.cost` sourced from models.dev (works across
 * Anthropic, OpenAI, Google, xAI, DeepSeek, Moonshot, OpenRouter, etc.);
 * Claude CLI emits `total_cost_usd` on its final `result` event. pass the
 * accumulated value via `costUsd` to render the Cost column.
 */
export function logTokenTable(t: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  costUsd?: number | undefined;
}): void {
  const total = t.input + t.cacheRead + t.cacheWrite + t.output;
  // narrow costUsd to a concrete number so the render path doesn't need a cast
  const costUsd = typeof t.costUsd === "number" && t.costUsd > 0 ? t.costUsd : undefined;

  const headerRow: Array<{ data: string; header: true }> = [
    { data: "Input", header: true },
    { data: "Cache Read", header: true },
    { data: "Cache Write", header: true },
    { data: "Output", header: true },
    { data: "Total", header: true },
  ];
  const dataRow: string[] = [
    String(t.input),
    String(t.cacheRead),
    String(t.cacheWrite),
    String(t.output),
    String(total),
  ];

  if (costUsd !== undefined) {
    headerRow.push({ data: "Cost ($)", header: true });
    dataRow.push(formatCostUsd(costUsd));
  }

  log.table([headerRow, dataRow]);
}
