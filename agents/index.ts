import { claude } from "./claude.ts";
// v2 harness — adapted to opencode-ai >=1.14.x SDK-v2 / Effect-ts CLI rewrite.
// The legacy v1 module (`./opencode.ts`) is kept around for reference + fast
// revert; the active runner is the v2 module below.
import { opencode } from "./opencode_v2.ts";
import type { Agent } from "./shared.ts";

export type { Agent, AgentUsage } from "./shared.ts";

export const agents = { claude, opencode } satisfies Record<string, Agent>;
