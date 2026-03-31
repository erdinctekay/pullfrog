import { claude } from "./claude.ts";
import { opentoad } from "./opentoad.ts";
import type { Agent } from "./shared.ts";

export type { Agent, AgentUsage } from "./shared.ts";

export const agents = { claude, opentoad } satisfies Record<string, Agent>;
