import { type } from "arktype";
import { ghPullfrogMcpName } from "../external.ts";
import type { Mode } from "../modes.ts";
import { apiFetch } from "../utils/apiFetch.ts";
import { log } from "../utils/log.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const SelectModeParams = type({
  mode: type.string.describe(
    "the name of the mode to select (e.g., 'Build', 'Plan', 'Review', 'IncrementalReview', 'Fix', 'AddressReviews', 'Task', 'ResolveConflicts', 'Summarize')"
  ),
  "issue_number?": type("number").describe(
    "optional issue number; when provided with Plan mode, used to look up an existing plan comment for this issue (edit vs create)"
  ),
});

function resolveMode(modes: Mode[], modeName: string): Mode | null {
  return modes.find((m) => m.name.toLowerCase() === modeName.toLowerCase()) ?? null;
}

// override guidance for contextual variants that aren't standalone modes
const modeOverrides: Record<string, string> = {
  PlanEdit: `### Checklist (editing existing plan)

An existing plan comment was found for this issue. Update that comment with the revised plan — do not create a new plan comment.

1. Use \`previousPlanBody\` from this response as the plan to revise; do not call \`get_issue\` or \`get_issue_comments\`.
2. Revise the plan based on the user's request:
   - incorporate the current plan (\`previousPlanBody\`) and the user's revision request
   - gather relevant codebase context (file paths, architecture notes from AGENTS.md)
   - produce a structured plan with clear milestones
3. Call \`${ghPullfrogMcpName}/report_progress\` with the full revised plan text and \`{ target_plan_comment: true }\` so it updates the existing plan comment (not the progress comment).
4. Then post a short note to the progress comment (e.g. "Plan has been updated in the comment above.") via \`${ghPullfrogMcpName}/report_progress\` so it is not left as "Leaping...".`,

  SummaryUpdate: `### Checklist (updating existing summary)

An existing summary comment was found for this PR. Update it rather than creating a new one.

1. Use \`previousSummaryBody\` from this response as the current summary to revise.
2. Checkout the PR via \`${ghPullfrogMcpName}/checkout_pr\` — this returns PR metadata and a \`diffPath\`.
3. Delegate a subagent with:
   - the diff file path and PR metadata
   - the existing summary body (\`previousSummaryBody\`) so it can update rather than rewrite from scratch
   - format instructions from EVENT INSTRUCTIONS (if any)
   - instruct it to produce an updated summary reflecting the current state of the PR and return it as its final response
4. After the subagent completes, call \`${ghPullfrogMcpName}/edit_issue_comment\` with \`commentId: existingSummaryCommentId\` (from this response) and the updated summary body.
5. Call \`${ghPullfrogMcpName}/report_progress\` with a brief note (e.g., "Updated PR summary.").

### Effort

Use mini or auto effort.`,
};

type OrchestratorGuidance = {
  modeName: string;
  description: string;
  orchestratorGuidance: string;
};

// IncrementalReview inherits Review's user instructions, Fix inherits Build's
const modeInstructionParent: Record<string, string> = {
  IncrementalReview: "Review",
  Fix: "Build",
};

type BuildGuidanceOpts = {
  modeInstructions?: Record<string, string>;
  overrideGuidance?: string;
};

function buildOrchestratorGuidance(mode: Mode, opts: BuildGuidanceOpts = {}): OrchestratorGuidance {
  const hardcoded = opts.overrideGuidance ?? mode.prompt ?? "";
  const lookupKey = modeInstructionParent[mode.name] ?? mode.name;
  const userInstructions = opts.modeInstructions?.[lookupKey] ?? "";
  const guidance = [hardcoded, userInstructions].filter(Boolean).join("\n\n");
  return {
    modeName: mode.name,
    description: mode.description,
    orchestratorGuidance: guidance,
  };
}

// matches the API response for /repo/[owner]/[repo]/issue/[issueNumber]/plan-comment
export type PlanCommentResponsePayload = { error: string } | { commentId: number; body: string };

// matches the API response for /repo/[owner]/[repo]/pr/[prNumber]/summary-comment
export type SummaryCommentResponsePayload = { error: string } | { commentId: number; body: string };

// IMPORTANT: these routes authenticate via GitHub installation token (getEnrichedRepo),
// NOT the Pullfrog API JWT (ctx.apiToken). use ctx.githubInstallationToken here.
// see wiki/api-auth.md for the two auth patterns.
async function fetchExistingPlanComment(
  ctx: ToolContext,
  issueNumber: number
): Promise<Extract<PlanCommentResponsePayload, { commentId: number }> | null> {
  if (!ctx.githubInstallationToken) return null;
  try {
    const response = await apiFetch({
      path: `/api/repo/${ctx.repo.owner}/${ctx.repo.name}/issue/${issueNumber}/plan-comment`,
      method: "GET",
      headers: { authorization: `Bearer ${ctx.githubInstallationToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json()) as PlanCommentResponsePayload;
    return response.ok && "commentId" in data ? data : null;
  } catch {
    return null;
  }
}

async function fetchExistingSummaryComment(
  ctx: ToolContext,
  prNumber: number
): Promise<Extract<SummaryCommentResponsePayload, { commentId: number }> | null> {
  if (!ctx.githubInstallationToken) {
    log.warning("fetchExistingSummaryComment: no token, skipping");
    return null;
  }
  const path = `/api/repo/${ctx.repo.owner}/${ctx.repo.name}/pr/${prNumber}/summary-comment`;
  try {
    const response = await apiFetch({
      path,
      method: "GET",
      headers: { authorization: `Bearer ${ctx.githubInstallationToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json()) as SummaryCommentResponsePayload;
    if (response.ok && "commentId" in data) {
      return data;
    }
    const errMsg = "error" in data ? data.error : "(no error body)";
    log.warning(`fetchExistingSummaryComment: ${response.status} ${path} — ${errMsg}`);
    return null;
  } catch (error) {
    log.warning("fetchExistingSummaryComment failed:", error);
    return null;
  }
}

export function SelectModeTool(ctx: ToolContext) {
  return tool({
    name: "select_mode",
    description:
      "Select a mode and receive step-by-step guidance on how to handle the task. Call this to understand the best workflow for the current mode.",
    parameters: SelectModeParams,
    execute: execute(async (params) => {
      if (ctx.toolState.selectedMode) {
        return {
          error: `mode already selected: "${ctx.toolState.selectedMode}". mode selection is final and cannot be changed. complete your current workflow within this mode.`,
        };
      }

      const modeName = params.mode;

      const selectedMode = resolveMode(ctx.modes, modeName);

      if (!selectedMode) {
        const availableModes = ctx.modes.map((m) => m.name).join(", ");
        return {
          error: `mode "${modeName}" not found. available modes: ${availableModes}`,
          availableModes: ctx.modes.map((m) => ({
            name: m.name,
            description: m.description,
          })),
        };
      }

      ctx.toolState.selectedMode = selectedMode.name;

      const guidanceOpts: BuildGuidanceOpts = { modeInstructions: ctx.modeInstructions };

      if (selectedMode.name === "Plan") {
        const issueNumber = params.issue_number ?? ctx.payload.event.issue_number;
        if (issueNumber !== undefined) {
          const existing = await fetchExistingPlanComment(ctx, issueNumber);
          if (existing !== null) {
            ctx.toolState.existingPlanCommentId = existing.commentId;
            ctx.toolState.previousPlanBody = existing.body;
            return {
              ...buildOrchestratorGuidance(selectedMode, {
                ...guidanceOpts,
                overrideGuidance: modeOverrides.PlanEdit,
              }),
              previousPlanBody: existing.body,
            };
          }
        }
      }

      if (selectedMode.name === "Summarize") {
        const prNumber = ctx.payload.event.issue_number;
        if (prNumber !== undefined) {
          const existing = await fetchExistingSummaryComment(ctx, prNumber);
          if (existing !== null) {
            ctx.toolState.existingSummaryCommentId = existing.commentId;
            return {
              ...buildOrchestratorGuidance(selectedMode, {
                ...guidanceOpts,
                overrideGuidance: modeOverrides.SummaryUpdate,
              }),
              existingSummaryCommentId: existing.commentId,
              previousSummaryBody: existing.body,
            };
          }
        }
      }

      return buildOrchestratorGuidance(selectedMode, guidanceOpts);
    }),
  });
}
