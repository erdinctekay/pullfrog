import { type } from "arktype";
import { ghPullfrogMcpName } from "../external.ts";
import type { Mode } from "../modes.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

export const SelectModeParams = type({
  mode: type.string.describe(
    "the name of the mode to select (e.g., 'Build', 'Plan', 'Review', 'IncrementalReview', 'Fix', 'AddressReviews', 'Task')"
  ),
});

function resolveMode(modes: Mode[], modeName: string): Mode | null {
  return modes.find((m) => m.name.toLowerCase() === modeName.toLowerCase()) ?? null;
}

const modeGuidance: Record<string, string> = {
  Build: `### Checklist

1. **plan phase** (optional, for complex tasks): delegate a subagent to analyze the requirements, read AGENTS.md and relevant code, and produce a step-by-step implementation plan. Include \`${ghPullfrogMcpName}/set_output\` with the plan so it returns to you. Use mini or auto effort. You can also use \`ask_question\` for codebase questions/investigations.

2. **setup** (your responsibility as orchestrator): before the build phase, checkout or create the branch:
   - **PR event, modifying the existing PR**: call \`${ghPullfrogMcpName}/checkout_pr\`
   - **new branch**: use \`${ghPullfrogMcpName}/git\` to create a branch (\`git checkout -b pullfrog/branch-name\`)
   Subagents have no git/checkout tools — the working tree must be ready before delegation.

3. **build phase**: delegate a subagent with the implementation task. Include in its prompt:
   - the plan (if you ran a plan phase)
   - specific files to modify and why
   - instruct the subagent to plan its approach before writing code: identify which files need to change, key design decisions, and edge cases. for non-trivial changes, consider whether there's a more elegant approach before committing to implementation.
   - testing expectations: run relevant tests/lints before committing
   - pre-commit quality check: instruct the subagent to review its own diff before committing — verify only intended changes are present, no debug artifacts or commented-out code remain, and no unrelated files were modified. the change should be clean enough that a senior engineer would approve it without hesitation. for non-trivial changes, ask whether there's a simpler way to achieve the same result.
   - commit locally via shell (\`git add . && git commit -m "..."\`)
   - call \`${ghPullfrogMcpName}/set_output\` with a concise summary including the branch name (this is how results get back to you)

4. **review phase** (optional, for non-trivial changes): before pushing, delegate a review subagent to check the pending diff. Use \`ask_question\` for quick spot-checks, or delegate a full Review subagent for high-stakes changes. This catches issues before they're public.

5. **finalize** (your responsibility as orchestrator): after the build (and optional review) completes:
   - push the branch via \`${ghPullfrogMcpName}/push_branch\`
   - create a PR via \`${ghPullfrogMcpName}/create_pull_request\`
   - call \`${ghPullfrogMcpName}/report_progress\` with the final summary including PR link

### Notes

For simple, well-defined tasks, a single build subagent is sufficient — skip the plan and review phases.

Your subagent receives ONLY what you write. Include file paths, constraints, conventions, and any context from AGENTS.md or the codebase directly in the prompt. Subagents have file ops, shell, and read-only GitHub tools — but NO git/checkout, dependency, GitHub-write, or remote-mutating tools.`,

  AddressReviews: `### Checklist

1. Before delegating, checkout the PR branch yourself via \`${ghPullfrogMcpName}/checkout_pr\` — subagents have no git/checkout tools.

2. Include in its prompt:
- instruct it to fetch review comments via \`${ghPullfrogMcpName}/get_review_comments\` (subagents have read-only GitHub tools)
- for each comment: understand the feedback, make the code change, and record what was done
- test changes, then review the diff before committing — verify only intended changes are present, no debug artifacts remain, and the changes are clean enough that a senior engineer would approve without hesitation
- commit locally via shell (\`git add . && git commit -m "..."\`)
- call \`${ghPullfrogMcpName}/set_output\` with a JSON object: \`{ "summary": "...", "replies": [{ "comment_id": 123, "thread_id": "...", "reply": "Fixed by ..." }, ...] }\` — this is how results get back to you

3. After the subagent completes:
- push changes via \`${ghPullfrogMcpName}/push_branch\`
- reply to each comment using \`${ghPullfrogMcpName}/reply_to_review_comment\` with the subagent's suggested replies
- resolve addressed threads via \`${ghPullfrogMcpName}/resolve_review_thread\`
- call \`${ghPullfrogMcpName}/report_progress\` with a brief summary

### Effort

Use auto or max effort depending on review complexity.`,

  Review: `### Checklist

1. Checkout the PR via \`${ghPullfrogMcpName}/checkout_pr\` — this returns PR metadata and a \`diffPath\`. Read the diff to identify the major areas of change.
2. Delegate multiple subagents in a single \`${ghPullfrogMcpName}/delegate\` call, each focused on a specific area. For example, a PR touching action/, components/, and prisma/ might get three subagents: "action-review", "frontend-review", "schema-review".
3. After all subagents return, consolidate their findings into a single review.

### Crafting each task

Each task in the \`tasks\` array should include:
- the diff file path so the subagent can read it
- what specific area/aspect to focus on (e.g., "review the database migration and schema changes in prisma/")
- instruct it to read the diff, trace data flow, check boundaries, and verify assumptions within its area. subagents have read-only GitHub tools (\`${ghPullfrogMcpName}/get_pull_request\`, etc.) for fetching additional context.
- instruct it to plan its investigation before diving in: identify the highest-risk areas (tricky state transitions, boundary crossings, assumption chains) and prioritize depth over breadth
- draft inline comments with NEW line numbers from the diff — every comment must be actionable (2-3 sentences max)
- after drafting, instruct it to critique its own comments: drop any that are praise, style preferences, speculative/unverified claims, about pre-existing code unrelated to the PR, or not actionable
- use GitHub permalink format for code references
- call \`${ghPullfrogMcpName}/set_output\` with a JSON object: \`{ "summary": "...", "comments": [{ "path": "file.ts", "line": 42, "body": "..." }, ...] }\` — this is how findings get back to you

### Post-delegation

After all tasks complete, consolidate into a **single** review:
- merge the \`comments\` arrays from all subagent outputs
- if subagents found actionable issues: submit one \`${ghPullfrogMcpName}/create_pull_request_review\` with \`approved: false\`, the merged comments, and a unified summary body
- if no subagent found actionable issues: submit with \`approved: true\` and a brief positive summary (no inline comments)
- call \`${ghPullfrogMcpName}/report_progress\` with the summary

Use max effort for thorough reviews.`,

  IncrementalReview: `### Checklist

1. Checkout the PR via \`${ghPullfrogMcpName}/checkout_pr\` — this returns PR metadata and a \`diffPath\`. Read the diff to identify the major areas of change.
2. Generate the incremental diff using the \`before_sha\` from EVENT DATA: \`git diff <before_sha>...HEAD\`. This isolates only the new commits. If the command fails (e.g., force-push rewrote history), fall back to reviewing the full PR diff.
3. Fetch previous reviews via \`${ghPullfrogMcpName}/list_pull_request_reviews\`. For the most recent Pullfrog review, call \`${ghPullfrogMcpName}/get_review_comments\` with the review ID to retrieve specific prior line-level feedback. Include the prior review summary and comment details when crafting subagent tasks.
4. Delegate multiple subagents in a single \`${ghPullfrogMcpName}/delegate\` call, each focused on a specific area of the new changes. Provide both the full diff path and the incremental diff.
5. After all subagents return, consolidate their findings into a single review.

### Crafting each task

Each task in the \`tasks\` array should include:
- the full diff file path AND the incremental diff (so the subagent can see both new changes and full context)
- what specific area/aspect to focus on
- instruct it to prioritize reviewing code in the incremental diff while using the full diff for context and to catch any changes not covered by the incremental diff
- include the prior review comments (from step 3) so the subagent knows what feedback was already given — instruct it to avoid repeating prior issues and to note whether prior feedback was addressed by the new commits
- instruct it to actively hunt for problems: trace data flow, check boundaries, explore failure modes, verify assumptions, consider lifecycle, spot performance issues
- draft inline comments with NEW line numbers from the full PR diff — every comment must be actionable (2-3 sentences max)
- call \`${ghPullfrogMcpName}/set_output\` with a JSON object: \`{ "summary": "...", "comments": [{ "path": "file.ts", "line": 42, "body": "..." }, ...] }\`

### Post-delegation

After all tasks complete, consolidate into a **single** review:
- merge the \`comments\` arrays from all subagent outputs
- if subagents found actionable issues: submit one \`${ghPullfrogMcpName}/create_pull_request_review\` with \`approved: false\`, the merged comments, and a unified summary body
- if no subagent found actionable issues: submit with \`approved: true\` and a brief positive summary (no inline comments)
- call \`${ghPullfrogMcpName}/report_progress\` with the summary

Use max effort for thorough reviews.`,

  Plan: `### Checklist

1. Include in its prompt:
   - the task to plan for
   - relevant codebase context (file paths, architecture notes from AGENTS.md)
   - instruct it to produce a structured, actionable plan with clear milestones
   - IMPORTANT: instruct it to return the full plan text via \`${ghPullfrogMcpName}/set_output\` as well-structured markdown — do NOT create plan files, do NOT save to disk
2. After the subagent completes, call \`${ghPullfrogMcpName}/report_progress\` with the full plan text from the subagent's output. The progress comment must contain the complete plan — not a file path or summary.

### Effort

Use mini or auto effort. After receiving the plan, you may delegate a Build subagent to implement it.`,

  Fix: `### Checklist

1. Before delegating, checkout the PR branch yourself via \`${ghPullfrogMcpName}/checkout_pr\` — subagents have no git/checkout tools.

2. Delegate a single fix subagent with:
- the check_suite_id to fetch logs via \`${ghPullfrogMcpName}/get_check_suite_logs\` (subagents have read-only GitHub tools)
- the PR diff file path (from checkout_pr result) so it can understand what the PR changed
- CRITICAL: instruct it to verify the failure was INTRODUCED BY THIS PR before fixing. If unrelated, abort and report.
- instruct it to read the workflow file, reproduce locally with the EXACT same commands CI runs
- fix the issue, then verify the fix by re-running the exact CI command
- pre-commit quality check: review the diff before committing — verify only the fix is present, no debug artifacts, no unrelated changes. the fix should be clean enough that a senior engineer would approve it without hesitation.
- commit locally via shell (\`git add . && git commit -m "..."\`)
- call \`${ghPullfrogMcpName}/set_output\` with a concise summary: what failed, why, and the fix applied (this is how results get back to you)

3. After the subagent completes:
- push changes via \`${ghPullfrogMcpName}/push_branch\`
- call \`${ghPullfrogMcpName}/report_progress\` with the diagnosis and fix summary

### Effort

Use auto effort.`,

  Task: `### Checklist

1. Handle this general-purpose task. For simple operations (labeling, commenting, answering questions, running a single command), you can often handle it directly without delegation.
2. When the task involves **substantial work** — code changes across multiple files, multi-step investigations, or tasks that benefit from focused context — use \`delegate\` and \`ask_question\` liberally:
   - \`ask_question\`: quick codebase research, finding files, understanding architecture. Use freely — multiple calls in sequence is fine.
   - \`delegate\`: research, local coding tasks, and codebase investigations. Each subagent gets dedicated context, so break complex work into focused subtasks and delegate each one. For independent subtasks, batch them in a single \`${ghPullfrogMcpName}/delegate\` call to run in parallel.
3. Include in each task's prompt:
   - the full subtask description with all relevant context
   - exactly what information to return. the subagent's output is your only way to get results back — be precise about what you need.
   - if code changes are needed: branch naming, testing, commit instructions (do NOT instruct to push or create PR)
   - if code changes are needed: instruct it to review its own diff before committing — verify only intended changes are present, no debug artifacts remain, and the changes are clean enough that a senior engineer would approve without hesitation
4. Post-delegation:
   - call \`${ghPullfrogMcpName}/report_progress\` with results
   - if the task involved code changes, push via \`${ghPullfrogMcpName}/push_branch\` and create a PR via \`${ghPullfrogMcpName}/create_pull_request\`
   - if the task involved labeling, commenting, or other GitHub operations, perform those directly
5. Use mini effort for simple research tasks, auto for typical tasks, max for complex multi-file changes.`,
};

type OrchestratorGuidance = {
  modeName: string;
  description: string;
  orchestratorGuidance: string;
};

function buildOrchestratorGuidance(mode: Mode): OrchestratorGuidance {
  const guidance = modeGuidance[mode.name] ?? "";
  return {
    modeName: mode.name,
    description: mode.description,
    orchestratorGuidance: guidance,
  };
}

export function SelectModeTool(ctx: ToolContext) {
  return tool({
    name: "select_mode",
    description:
      "Select a mode and receive orchestrator-level guidance on how to handle it, including suggested delegation flows and prompt-crafting tips. Call this before delegating to understand the best approach for the task.",
    parameters: SelectModeParams,
    execute: execute(async (params) => {
      const selectedMode = resolveMode(ctx.modes, params.mode);

      if (!selectedMode) {
        const availableModes = ctx.modes.map((m) => m.name).join(", ");
        return {
          error: `mode "${params.mode}" not found. available modes: ${availableModes}`,
          availableModes: ctx.modes.map((m) => ({
            name: m.name,
            description: m.description,
          })),
        };
      }

      ctx.toolState.selectedMode = selectedMode.name;
      return buildOrchestratorGuidance(selectedMode);
    }),
  });
}
