import { log } from "../utils/cli.ts";
import type { ResolvedInstructions } from "../utils/instructions.ts";
import type { ResolvedPayload } from "../utils/payload.ts";
import type { TodoTracker } from "../utils/todoTracking.ts";

// maximum number of stderr lines to keep in the rolling buffer during agent execution
export const MAX_STDERR_LINES = 20;

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
  name: string;
  install: (token?: string) => Promise<string>;
  run: (ctx: AgentRunContext) => Promise<AgentResult>;
}

export const agent = (input: Agent): Agent => {
  return {
    ...input,
    run: async (ctx: AgentRunContext): Promise<AgentResult> => {
      if (ctx.payload.model) log.info(`» model:   ${ctx.payload.model}`);
      if (ctx.payload.timeout) log.info(`» timeout: ${ctx.payload.timeout}`);
      log.info(`» push:    ${ctx.payload.push}`);
      log.info(`» shell:   ${ctx.payload.shell}`);
      log.debug(`» payload: ${JSON.stringify(ctx.payload, null, 2)}`);

      return input.run(ctx);
    },
  };
};
