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

const modeGuidance: Record<string, string> = {
  Build: `### Checklist

1. **plan** (optional, for complex tasks): analyze requirements, read AGENTS.md and relevant code, produce a step-by-step implementation plan.

2. **setup**: checkout or create the branch:
   - **PR event, modifying the existing PR**: call \`${ghPullfrogMcpName}/checkout_pr\`
   - **new branch**: use \`${ghPullfrogMcpName}/git\` to create a branch (\`git checkout -b pullfrog/branch-name\`)

3. **build**: implement changes using your native file and shell tools:
   - follow the plan (if you ran a plan phase)
   - plan your approach before writing code: identify which files need to change, key design decisions, and edge cases. for non-trivial changes, consider whether there's a more elegant approach.
   - run relevant tests/lints before committing
   - review your own diff before committing — verify only intended changes are present, no debug artifacts or commented-out code remain, and no unrelated files were modified. the change should be clean enough that a senior engineer would approve it without hesitation.
   - commit locally via shell (\`git add . && git commit -m "..."\`)

4. **finalize**:
   - push the branch via \`${ghPullfrogMcpName}/push_branch\`
   - create a PR via \`${ghPullfrogMcpName}/create_pull_request\`
   - call \`${ghPullfrogMcpName}/report_progress\` with the final summary including PR link

### Notes

For simple, well-defined tasks, skip the plan phase and go straight to build.`,

  ResolveConflicts: `### Checklist

1. **Setup**:
   - Call \`${ghPullfrogMcpName}/checkout_pr\` to get the PR branch.
   - Call \`${ghPullfrogMcpName}/get_pull_request\` to identify the base branch (e.g., 'main').
   - Call \`${ghPullfrogMcpName}/git_fetch\` to fetch the base branch.

2. **Merge Attempt**:
   - Run \`git merge origin/<base_branch>\` via shell.
   - If it succeeds automatically, push via \`${ghPullfrogMcpName}/push_branch\` and report success.
   - If it fails (conflicts), resolve them manually.

3. **Resolve Conflicts**:
   - Run \`git status\` or parse the merge output to find the list of conflicting files.
   - For each conflicting file: read it, find the conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`), understand the code context, and rewrite the file with the correct resolution. Remove all markers.
   - Verify the file syntax is correct after resolution.

4. **Finalize**:
   - Run a final verification (build/test) to ensure the resolution works.
   - \`git add . && git commit -m "resolve merge conflicts"\`
   - Push via \`${ghPullfrogMcpName}/push_branch\`
   - Call \`${ghPullfrogMcpName}/report_progress\` with a summary of what was resolved`,

  AddressReviews: `### Checklist

1. Checkout the PR branch via \`${ghPullfrogMcpName}/checkout_pr\`.

2. Fetch review comments via \`${ghPullfrogMcpName}/get_review_comments\`.

3. For each comment:
   - understand the feedback
   - make the code change using your native tools
   - record what was done

4. Quality check:
   - test changes, then review the diff before committing — verify only intended changes are present, no debug artifacts remain, and the changes are clean enough that a senior engineer would approve without hesitation
   - commit locally via shell (\`git add . && git commit -m "..."\`)

5. Finalize:
   - push changes via \`${ghPullfrogMcpName}/push_branch\`
   - reply to each comment using \`${ghPullfrogMcpName}/reply_to_review_comment\`
   - resolve addressed threads via \`${ghPullfrogMcpName}/resolve_review_thread\`
   - call \`${ghPullfrogMcpName}/report_progress\` with a brief summary`,

  Review: `### Checklist

1. Checkout the PR via \`${ghPullfrogMcpName}/checkout_pr\` — this returns PR metadata and a \`diffPath\`. Read the diff to identify the major areas of change.

2. For each area of change:
   - read the diff and trace data flow, check boundaries, and verify assumptions
   - plan your investigation: identify the highest-risk areas (tricky state transitions, boundary crossings, assumption chains) and prioritize depth over breadth
   - use \`${ghPullfrogMcpName}/get_pull_request\` and other read-only GitHub tools for additional context
   - if the PR removes features, deletes exports, renames concepts, or changes architectural patterns, run a dedicated impact analysis: list what changed, then use grep across code, tests, docs (\`docs/\`, \`wiki/\`), comments, configs, and UI to find stale references
   - report impact-analysis findings in the summary body, ordered by severity (runtime breakage > incorrect docs > stale comments)
   - draft inline comments with NEW line numbers from the diff — every comment must be actionable (2-3 sentences max)
   - use GitHub permalink format for code references

3. Self-critique: review all drafted comments and drop any that are praise, style preferences, speculative/unverified claims, about pre-existing code unrelated to the PR, or not actionable.

4. Submit a **single** review:
   - call \`${ghPullfrogMcpName}/create_pull_request_review\` with all comments and a unified summary body
   - call \`${ghPullfrogMcpName}/report_progress\` with the summary
   - if no actionable issues found, skip the review — just call \`report_progress\` noting the PR was reviewed`,

  IncrementalReview: `### Checklist

1. Checkout the PR via \`${ghPullfrogMcpName}/checkout_pr\` — this returns PR metadata and a \`diffPath\`. Read the diff to identify the major areas of change.

2. Generate the incremental diff using the \`before_sha\` from EVENT DATA: \`git diff <before_sha>...HEAD\`. This isolates only the new commits. If the command fails (e.g., force-push rewrote history), fall back to reviewing the full PR diff.

3. Fetch previous reviews via \`${ghPullfrogMcpName}/list_pull_request_reviews\`. For the most recent Pullfrog review, call \`${ghPullfrogMcpName}/get_review_comments\` with the review ID to retrieve specific prior line-level feedback.

4. For each area of the new changes:
   - review the incremental diff while using the full diff for context
   - check whether prior review feedback was addressed by the new commits
   - trace data flow, check boundaries, verify assumptions, consider lifecycle, spot performance issues
   - if the new commits remove, rename, or deprecate anything, run impact analysis with grep across code/tests/docs/comments/configs to find stale references and include those findings in the summary body
   - never repeat prior feedback. if the author did not address an earlier comment, assume it was intentionally declined; only comment on genuinely new issues introduced by the new commits
   - draft inline comments with NEW line numbers from the full PR diff — every comment must be actionable (2-3 sentences max)

5. Self-critique: drop any comments that are praise, style preferences, speculative, about pre-existing code, or not actionable.

6. Submit a **single** review:
   - if actionable issues found: call \`${ghPullfrogMcpName}/create_pull_request_review\` with \`approved: false\`, all comments, and an **empty body** (do NOT include a summary — inline comments speak for themselves and a top-level comment clutters the PR conversation on every re-review)
   - if no actionable issues found: submit with \`approved: true\` and an **empty body** (no inline comments, no summary)
   - do NOT call \`${ghPullfrogMcpName}/report_progress\` — incremental reviews should be silent`,

  Plan: `### Checklist

1. Analyze the task and gather context:
   - read AGENTS.md and relevant codebase files
   - understand the architecture and constraints

2. Produce a structured, actionable plan with clear milestones.

3. Call \`${ghPullfrogMcpName}/report_progress\` with the plan.`,

  PlanEdit: `### Checklist (editing existing plan)

An existing plan comment was found for this issue. Update that comment with the revised plan — do not create a new plan comment.

1. Use \`previousPlanBody\` from this response as the plan to revise; do not call \`get_issue\` or \`get_issue_comments\`.
2. Revise the plan based on the user's request:
   - incorporate the current plan (\`previousPlanBody\`) and the user's revision request
   - gather relevant codebase context (file paths, architecture notes from AGENTS.md)
   - produce a structured plan with clear milestones
3. Call \`${ghPullfrogMcpName}/report_progress\` with the full revised plan text and \`{ target_plan_comment: true }\` so it updates the existing plan comment (not the progress comment).
4. Then post a short note to the progress comment (e.g. "Plan has been updated in the comment above.") via \`${ghPullfrogMcpName}/report_progress\` so it is not left as "Leaping...".`,

  Fix: `### Checklist

1. Checkout the PR branch via \`${ghPullfrogMcpName}/checkout_pr\`.

2. Fetch check suite logs via \`${ghPullfrogMcpName}/get_check_suite_logs\`.

3. **CRITICAL**: verify the failure was INTRODUCED BY THIS PR before fixing. If unrelated, abort and report.

4. Diagnose and fix:
   - read the workflow file, reproduce locally with the EXACT same commands CI runs
   - fix the issue using your native file and shell tools
   - verify the fix by re-running the exact CI command
   - review the diff before committing — verify only the fix is present, no debug artifacts, no unrelated changes. the fix should be clean enough that a senior engineer would approve without hesitation.
   - commit locally via shell (\`git add . && git commit -m "..."\`)

5. Finalize:
   - push changes via \`${ghPullfrogMcpName}/push_branch\`
   - call \`${ghPullfrogMcpName}/report_progress\` with the diagnosis and fix summary`,

  Task: `### Checklist

1. Analyze the task. For simple operations (labeling, commenting, answering questions, running a single command), handle directly.

2. For substantial work — code changes across multiple files, multi-step investigations:
   - plan your approach before starting
   - use native file and shell tools for local operations
   - use ${ghPullfrogMcpName} MCP tools for GitHub/git operations
   - if code changes are needed: review your own diff before committing — verify only intended changes are present, no debug artifacts remain, and the changes are clean enough that a senior engineer would approve without hesitation

3. Finalize:
   - call \`${ghPullfrogMcpName}/report_progress\` with results
   - if the task involved code changes, push via \`${ghPullfrogMcpName}/push_branch\` and create a PR via \`${ghPullfrogMcpName}/create_pull_request\`
   - if the task involved labeling, commenting, or other GitHub operations, perform those directly`,

  Summarize: `### Checklist

1. Checkout the PR via \`${ghPullfrogMcpName}/checkout_pr\` — this returns PR metadata and a \`diffPath\`.
2. Delegate a subagent to analyze the diff and produce a structured summary. Include in its prompt:
   - the diff file path
   - PR metadata (title, file count, commit count, base/head branches)
   - format instructions from EVENT INSTRUCTIONS (if any); otherwise use default format: TL;DR, key changes list, per-change sections with plain-language \`##\` titles and before/after framing
   - instruct it to use the TOC to selectively read relevant diff sections, not the entire file
   - instruct it to return the full summary markdown via \`${ghPullfrogMcpName}/set_output\`
3. After the subagent completes, call \`${ghPullfrogMcpName}/create_issue_comment\` with \`type: "Summary"\` and the summary body.

### Effort

Use mini or auto effort.`,

  SummaryUpdate: `### Checklist (updating existing summary)

An existing summary comment was found for this PR. Update it rather than creating a new one.

1. Use \`previousSummaryBody\` from this response as the current summary to revise.
2. Checkout the PR via \`${ghPullfrogMcpName}/checkout_pr\` — this returns PR metadata and a \`diffPath\`.
3. Delegate a subagent with:
   - the diff file path and PR metadata
   - the existing summary body (\`previousSummaryBody\`) so it can update rather than rewrite from scratch
   - format instructions from EVENT INSTRUCTIONS (if any)
   - instruct it to produce an updated summary reflecting the current state of the PR and return via \`${ghPullfrogMcpName}/set_output\`
4. After the subagent completes, call \`${ghPullfrogMcpName}/edit_issue_comment\` with \`commentId: existingSummaryCommentId\` (from this response) and the updated summary body.

### Effort

Use mini or auto effort.`,
};

type OrchestratorGuidance = {
  modeName: string;
  description: string;
  orchestratorGuidance: string;
};

const modeInstructionParent: Record<string, string> = {
  IncrementalReview: "Review",
  Fix: "Build",
};

type BuildGuidanceOpts = {
  modeInstructions?: Record<string, string>;
  overrideGuidance?: string;
};

function buildOrchestratorGuidance(mode: Mode, opts: BuildGuidanceOpts = {}): OrchestratorGuidance {
  const hardcoded = opts.overrideGuidance ?? modeGuidance[mode.name] ?? mode.prompt ?? "";
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
                overrideGuidance: modeGuidance.PlanEdit,
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
                overrideGuidance: modeGuidance.SummaryUpdate,
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
