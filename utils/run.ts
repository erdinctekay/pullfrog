import type { AgentResult } from "../agents/shared.ts";
import type { MainResult } from "../main.ts";
import type { ToolState } from "../mcp/server.ts";
import { log } from "./cli.ts";
import { reportErrorToComment } from "./errorReport.ts";

export interface HandleAgentResultParams {
  result: AgentResult;
  toolState: ToolState;
  silent: boolean | undefined;
}

export async function handleAgentResult(ctx: HandleAgentResultParams): Promise<MainResult> {
  if (!ctx.result.success) {
    return {
      success: false,
      error: ctx.result.error || "Agent execution failed",
      output: ctx.result.output!,
    };
  }

  // Review and IncrementalReview modes intentionally never set wasUpdated:
  // the prompt forbids report_progress (the review IS the durable record),
  // and IncrementalReview's non-substantive path produces no review at
  // all by design. wasUpdated staying false is also load-bearing for the
  // stranded-comment cleanup in main.ts which deletes the "Leaping into
  // action" orphan via `(!wasUpdated || trackerWasLastWriter)`. Skip the
  // strict completion check for these modes — the agent's exit code is
  // the completion signal, not a progress-comment write.
  // See plans/review_progress_comment_cleanup_b0120f6c.plan.md.
  const mode = ctx.toolState.selectedMode;
  const isReviewMode = mode === "Review" || mode === "IncrementalReview";
  if (
    !isReviewMode &&
    !ctx.toolState.wasUpdated &&
    ctx.toolState.hadProgressComment &&
    !ctx.silent
  ) {
    const error = ctx.result.error || "agent completed without reporting progress";
    try {
      await reportErrorToComment({
        toolState: ctx.toolState,
        error,
        title: "Error",
      });
    } catch {}
    return {
      success: false,
      error,
      output: ctx.result.output || "",
    };
  }

  log.success("Task complete.");

  return {
    success: true,
    output: ctx.result.output || "",
  };
}
