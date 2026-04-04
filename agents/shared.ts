import { execFileSync } from "node:child_process";
import type { AgentId } from "../external.ts";
import { log } from "../utils/cli.ts";
import type { ResolvedInstructions } from "../utils/instructions.ts";
import type { ResolvedPayload } from "../utils/payload.ts";
import type { TodoTracker } from "../utils/todoTracking.ts";

// maximum number of stderr lines to keep in the rolling buffer during agent execution
export const MAX_STDERR_LINES = 20;

// ── post-run commit enforcement ─────────────────────────────────────────────────

export const MAX_COMMIT_RETRIES = 3;

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

export function buildCommitPrompt(_agentId: AgentId, status: string): string {
  return [
    `UNCOMMITTED CHANGES — the working tree is dirty. push all changes to a pull request (new or existing). \`git status\` must be clean before you finish.`,
    "",
    "```",
    status,
    "```",
  ].join("\n");
}

/**
 * token/cost usage data from a single agent run
 */
export interface AgentUsage {
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  costUsd?: number | undefined;
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
