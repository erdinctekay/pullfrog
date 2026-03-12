import type { Agent } from "../agents/index.ts";
import { agents } from "../agents/index.ts";

export function resolveAgent(): Agent {
  return agents.opentoad;
}
