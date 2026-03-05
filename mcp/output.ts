import { type } from "arktype";
import { log } from "../utils/cli.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const SetOutputParams = type({
  value: type.string.describe("the output value to expose as a GitHub Action output"),
});

export function SetOutputTool(ctx: ToolContext) {
  return tool({
    name: "set_output",
    description:
      "Set the action output. When called by a subagent, returns a summary result to the orchestrator — this is the ONLY way to pass results back. When called by the orchestrator in standalone mode (trigger: unknown), exposes the value as the 'result' GitHub Action output for downstream workflow steps. Do NOT use this for progress reporting — use report_progress instead.",
    parameters: SetOutputParams,
    execute: execute(async (params) => {
      const selfId = ctx.toolState.selfSubagentId;
      if (selfId) {
        const subagent = ctx.toolState.subagents.get(selfId);
        if (subagent) {
          subagent.output = params.value;
          log.debug(
            `set_output: routed to subagent ${selfId} (value=${params.value.slice(0, 80)})`
          );
          return { success: true, routed: "subagent" };
        }
        log.warning(
          `set_output: selfSubagentId=${selfId} but subagent not found in map — routing to action output`
        );
      }
      ctx.toolState.output = params.value;
      return { success: true, routed: "action_output" };
    }),
  });
}
