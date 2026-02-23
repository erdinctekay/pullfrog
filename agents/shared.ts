import type { show } from "@ark/util";
import { type AgentManifest, type AgentName, agentsManifest } from "../external.ts";
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

export const agent = <const input extends AgentInput>(input: input): defineAgent<input> => {
  return {
    ...input,
    run: async (ctx: AgentRunContext): Promise<AgentResult> => {
      log.info(`» agent:   ${input.name}`);
      log.info(`» effort:  ${ctx.payload.effort}`);
      if (ctx.payload.timeout) log.info(`» timeout: ${ctx.payload.timeout}`);
      log.info(`» web:     ${ctx.payload.web}`);
      log.info(`» search:  ${ctx.payload.search}`);
      log.info(`» push:    ${ctx.payload.push}`);
      log.info(`» shell:   ${ctx.payload.shell}`);
      log.debug(`» payload: ${JSON.stringify(ctx.payload, null, 2)}`);

      return input.run(ctx);
    },
    ...agentsManifest[input.name],
  } as never;
};

export interface AgentInput {
  name: AgentName;
  install: (token?: string) => Promise<string>;
  run: (ctx: AgentRunContext) => Promise<AgentResult>;
}

export interface Agent extends AgentInput, AgentManifest {}

type agentManifest<name extends AgentName> = (typeof agentsManifest)[name];

type defineAgent<input extends AgentInput> = show<input & agentManifest<input["name"]>>;
