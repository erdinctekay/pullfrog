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

  // IncrementalReview's non-substantive path exits cleanly without
  // submitting any review, so no MCP write tool flips wasUpdated and the
  // strict completion check below would otherwise fail the run. The
  // isReviewMode skip is load-bearing for that path: the agent's exit
  // code is the completion signal, not a progress-comment write.
  // (Review mode that submits a real review now flips wasUpdated via
  // create_pull_request_review, so the skip is redundant for the
  // substantive-review path but kept for symmetry with IncrementalReview.)
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
