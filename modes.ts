// changes to mode definitions should be reflected in docs/modes.mdx
import { ghPullfrogMcpName } from "./external.ts";

export interface Mode {
  name: string;
  description: string;
  // step-by-step guidance returned when the agent calls select_mode.
  // custom user-defined modes supply this; built-in modes define it here.
  prompt?: string | undefined;
}

function learningsStep(n: number): string {
  return `${n}. **learnings** (only if high confidence): if you discovered something about repo setup, test commands, conventions, or patterns that you are confident is correct and would reliably help future runs, call \`${ghPullfrogMcpName}/update_learnings\` to persist it. skip this step if you are unsure or the finding is speculative/one-off. format as a flat bullet list (\`- \` per line, one fact per bullet). merge with existing learnings from the prompt — pass the FULL merged list. deduplicate, and drop bullets that are clearly wrong or no longer relevant to the current codebase.`;
}

export function computeModes(): Mode[] {
  return [
    {
      name: "Build",
      description:
        "Implement, build, create, or develop code changes; make specific changes to files or features; execute a plan; or handle tasks with specific implementation details",
      prompt: `### Checklist

1. **plan** (optional, for complex tasks): analyze requirements, read AGENTS.md and relevant code, produce a step-by-step implementation plan.

2. **setup**: checkout or create the branch:
   - **PR event, modifying the existing PR**: call \`${ghPullfrogMcpName}/checkout_pr\`
   - **new branch**: use \`${ghPullfrogMcpName}/git\` to create a branch (\`git checkout -b pullfrog/branch-name\`)

3. **build**: implement changes using your native file and shell tools:
   - follow the plan (if you ran a plan phase)
   - plan your approach before writing code: identify which files need to change, key design decisions, and edge cases. for non-trivial changes, consider whether there's a more elegant approach.
   - run relevant tests/lints before committing

4. **self-review**: delegate a read-only subagent to review your diff. the subagent must ONLY read files, grep, and search — no MCP tools, no writes, no shell commands, no side effects. provide it with the output of \`git diff\` and instruct it to look for bugs, logic errors, missing edge cases, and unintended changes. review its findings, address any valid points, and discard nitpicks or false positives. then:
   - verify only intended changes are present, no debug artifacts or commented-out code remain, and no unrelated files were modified
   - commit locally via shell (\`git add . && git commit -m "..."\`)

5. **finalize**:
   - push the branch via \`${ghPullfrogMcpName}/push_branch\`
   - create a PR via \`${ghPullfrogMcpName}/create_pull_request\`
   - call \`${ghPullfrogMcpName}/report_progress\` with the final summary including PR link

${learningsStep(6)}

### Notes

For simple, well-defined tasks, skip the plan phase and go straight to build.`,
    },
    {
      name: "AddressReviews",
      description:
        "Address PR review feedback; respond to reviewer comments; make requested changes to an existing PR",
      prompt: `### Checklist

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
   - call \`${ghPullfrogMcpName}/report_progress\` with a brief summary

${learningsStep(6)}`,
    },
    {
      name: "Review",
      description:
        "Review code, PRs, or implementations; provide feedback or suggestions; identify issues; or check code quality, style, and correctness",
      prompt: `### Checklist

1. Checkout the PR via \`${ghPullfrogMcpName}/checkout_pr\` — this returns PR metadata and a \`diffPath\`. Read the diff to identify the major areas of change.

2. For each area of change:
   - read the diff and trace data flow, check boundaries, and verify assumptions
   - plan your investigation: identify the highest-risk areas (tricky state transitions, boundary crossings, assumption chains) and prioritize depth over breadth
   - use \`${ghPullfrogMcpName}/get_pull_request\` and other read-only GitHub tools for additional context
   - if the PR removes features, deletes exports, renames identifiers, or changes architectural patterns, run a dedicated impact analysis: list what changed, then use grep across code, tests, docs (\`docs/\`, \`wiki/\`), comments, configs, and UI to find stale references
   - report impact-analysis findings in the summary body, ordered by severity (runtime breakage > incorrect docs > stale comments)
   - draft inline comments with NEW line numbers from the diff — every comment must be actionable (2-3 sentences max)
   - use GitHub permalink format for code references
   - for large or cross-cutting PRs that touch disparate subsystems, consider delegating read-only subagents to investigate areas in parallel. subagents must ONLY read files, grep, and search — no MCP tools, no writes, no shell commands, no side effects. collect their findings and use them to draft comments.

3. Self-critique: review all drafted comments and drop any that are praise, style preferences, speculative/unverified claims, about pre-existing code unrelated to the PR, or not actionable.

4. Submit:
   - **actionable issues found**: call \`${ghPullfrogMcpName}/create_pull_request_review\` with all comments, a 1-3 sentence summary body, and \`approved: false\`. Then call \`report_progress\` with a 1-sentence summary.
   - **no actionable issues found**: do NOT submit a review. Call \`${ghPullfrogMcpName}/report_progress\` with a brief note (e.g., "Reviewed — no issues found.").`,
    },
    {
      name: "IncrementalReview",
      description:
        "Re-review a PR after new commits are pushed; focus on new changes since the last review",
      prompt: `### Checklist

1. Checkout the PR via \`${ghPullfrogMcpName}/checkout_pr\` — this returns PR metadata, \`diffPath\` (full diff), and \`incrementalDiffPath\` (changes since last reviewed version, if available).

2. If \`incrementalDiffPath\` is present, read it to see what changed since the last review. This is a range-diff that isolates the net changes, filtering out base branch noise. If not present, fall back to reviewing the full PR diff.

3. Fetch previous reviews via \`${ghPullfrogMcpName}/list_pull_request_reviews\`. For the most recent Pullfrog review, call \`${ghPullfrogMcpName}/get_review_comments\` with the review ID to retrieve specific prior line-level feedback.

4. For each area of the new changes:
   - review the incremental diff while using the full diff for context
   - check whether prior review feedback was addressed by the new commits
   - trace data flow, check boundaries, verify assumptions, consider lifecycle, spot performance issues
   - if the new commits remove, rename, or deprecate anything, run impact analysis with grep across code/tests/docs/comments/configs to find stale references and include those findings in the summary body
   - never repeat prior feedback. if the author did not address an earlier comment, assume it was intentionally declined; only comment on genuinely new issues introduced by the new commits
   - draft inline comments with NEW line numbers from the full PR diff — every comment must be actionable (2-3 sentences max)
   - for large or cross-cutting PRs, consider delegating read-only subagents for parallel investigation. subagents must ONLY read files, grep, and search — no MCP tools, no writes, no shell commands, no side effects. collect their findings and use them to draft comments.

5. Self-critique: drop any comments that are praise, style preferences, speculative, about pre-existing code, or not actionable.

6. Submit:
   - **actionable issues found**: call \`${ghPullfrogMcpName}/create_pull_request_review\` with \`approved: false\`, all comments, and an **empty body** — inline comments speak for themselves, and a top-level body clutters the PR conversation on every re-review cycle. Then call \`report_progress\` with a 1-sentence summary.
   - **no actionable issues, but substantive changes or prior fixes confirmed**: post a brief comment (1-3 sentences) via \`${ghPullfrogMcpName}/create_issue_comment\` confirming the review happened and listing which prior review issues were resolved. Substantive = new functionality, behavior changes, architectural changes, or fixes to previously flagged issues.
   - **no actionable issues, non-substantive changes only** (e.g., trivial formatting, import reordering, comment tweaks with no functional impact): do NOT submit a review. Call \`${ghPullfrogMcpName}/report_progress\` with a brief note (e.g., "Re-reviewed — no new issues found.").`,
    },
    {
      name: "Plan",
      description:
        "Create plans, break down tasks, outline steps, analyze requirements, understand scope of work, or provide task breakdowns",
      prompt: `### Checklist

1. Analyze the task and gather context:
   - read AGENTS.md and relevant codebase files
   - understand the architecture and constraints

2. Produce a structured, actionable plan with clear milestones.

3. Call \`${ghPullfrogMcpName}/report_progress\` with the plan.

${learningsStep(4)}`,
    },
    {
      name: "Fix",
      description:
        "Fix CI failures; debug failing tests or builds; investigate and resolve check suite failures",
      prompt: `### Checklist

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
   - call \`${ghPullfrogMcpName}/report_progress\` with the diagnosis and fix summary

${learningsStep(6)}`,
    },
    {
      name: "ResolveConflicts",
      description: "Resolve merge conflicts in a PR branch against the base branch",
      prompt: `### Checklist

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
    },
    {
      name: "Task",
      description:
        "General-purpose tasks that don't fit other modes: answering questions, adding comments, labeling, running ad-hoc commands, or any direct request",
      prompt: `### Checklist

1. Analyze the task. For simple operations (labeling, commenting, answering questions, running a single command), handle directly.

2. For substantial work — code changes across multiple files, multi-step investigations:
   - plan your approach before starting
   - use native file and shell tools for local operations
   - use ${ghPullfrogMcpName} MCP tools for GitHub/git operations
   - if code changes are needed: review your own diff before committing — verify only intended changes are present, no debug artifacts remain, and the changes are clean enough that a senior engineer would approve without hesitation

3. Finalize:
   - call \`${ghPullfrogMcpName}/report_progress\` with results
   - if the task involved code changes, push via \`${ghPullfrogMcpName}/push_branch\` and create a PR via \`${ghPullfrogMcpName}/create_pull_request\`
   - if the task involved labeling, commenting, or other GitHub operations, perform those directly

${learningsStep(4)}`,
    },
    {
      name: "Summarize",
      description:
        "Summarize a PR with a structured comment that is updated in place on subsequent pushes",
      prompt: `### Checklist

1. Checkout the PR via \`${ghPullfrogMcpName}/checkout_pr\` — this returns PR metadata and a \`diffPath\`.
2. Delegate a subagent to analyze the diff and produce a structured summary. Include in its prompt:
   - the diff file path
   - PR metadata (title, file count, commit count, base/head branches)
   - format instructions from EVENT INSTRUCTIONS (if any); otherwise use default format: TL;DR, key changes list, per-change sections with plain-language \`##\` titles and before/after framing
   - instruct it to use the TOC to selectively read relevant diff sections, not the entire file
   - instruct it to return the full summary markdown as its final response
3. After the subagent completes, call \`${ghPullfrogMcpName}/create_issue_comment\` with \`type: "Summary"\` and the summary body.
4. Call \`${ghPullfrogMcpName}/report_progress\` with a brief note (e.g., "Posted PR summary.").

### Effort

Use mini or auto effort.`,
    },
  ];
}

export const modes: Mode[] = computeModes();
