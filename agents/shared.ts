import { log } from "../utils/cli.ts";
import type { ResolvedInstructions } from "../utils/instructions.ts";
import type { ResolvedPayload } from "../utils/payload.ts";

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
  mcpServerUrl: string;
  tmpdir: string;
  instructions: ResolvedInstructions;
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
      log.info(`» agent:   ${input.name}`);
      if (ctx.payload.model) log.info(`» model:   ${ctx.payload.model}`);
      if (ctx.payload.timeout) log.info(`» timeout: ${ctx.payload.timeout}`);
      log.info(`» push:    ${ctx.payload.push}`);
      log.info(`» shell:   ${ctx.payload.shell}`);
      log.debug(`» payload: ${JSON.stringify(ctx.payload, null, 2)}`);

      return input.run(ctx);
    },
  };
};
