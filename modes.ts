// changes to mode definitions should be reflected in docs/modes.mdx
import { type } from "arktype";
import { ghPullfrogMcpName } from "./external.ts";

export interface Mode {
  name: string;
  description: string;
  prompt: string;
}

// arktype schema for Mode validation
export const ModeSchema = type({
  name: "string",
  description: "string",
  prompt: "string",
});

const reportProgressInstruction = `Use ${ghPullfrogMcpName}/report_progress to share progress and results. Continue calling it as you make progress — it will update the same comment. Never create additional comments manually.`;

const dependencyInstallationStep = `If this task will require running tests, builds, linters, or CLI commands that need installed packages, call \`${ghPullfrogMcpName}/start_dependency_installation\` NOW. This is non-blocking and allows dependencies to install in the background while you continue. Later, call \`${ghPullfrogMcpName}/await_dependency_installation\` before running commands that need them. Skip this step if only reading code or answering questions.`;

const permalinkTip = `**TIP**: To reference specific code, use GitHub permalinks: \`https://github.com/{owner}/{repo}/blob/{commit_sha}/{path}#L{start}-L{end}\`. GitHub renders these as expandable code blocks.`;

export function computeModes(): Mode[] {
  return [
    {
      name: "Build",
      description:
        "Implement, build, create, or develop code changes; make specific changes to files or features; execute a plan; or handle tasks with specific implementation details",
      prompt: `Follow these steps exactly.

1. **CHECKOUT** - Determine whether to checkout the existing PR branch or create a new one:
   - **PR event, modifying the existing PR**: Call \`${ghPullfrogMcpName}/checkout_pr\` with the PR number to checkout the PR branch.
   - **PR event, but user wants a NEW branch/PR**: Create a new branch with \`git checkout -b pullfrog/branch-name\` via the \`${ghPullfrogMcpName}/git\` tool.

   Branch names must be prefixed with "pullfrog/" and be specific enough to avoid collisions. Never commit directly to main/master/production.

2. **DEPENDENCIES** - ${dependencyInstallationStep}

3. **CONTEXT** - If the request requires understanding the codebase structure or conventions, gather relevant context. Read AGENTS.md if it exists. Skip this step if the prompt is trivial and self-contained.

4. **REQUIREMENTS** - Understand the requirements and any existing plan.

5. **IMPLEMENT** - Make the necessary code changes using file operations. You should change the minimum amount of code necessary to accomplish your task. Emphasize code quality and elegance.

6. **TEST** - Test your changes to ensure they work correctly. Run relevant tests, builds, or linters BEFORE committing. If tests fail, fix the issues and repeat this step until everything passes.

7. **COMMIT** - Commit your changes using \`${ghPullfrogMcpName}/git\` (e.g., \`git add .\` then \`git commit -m "message"\`), then push with \`${ghPullfrogMcpName}/push_branch\`. Do NOT use \`git push\` directly - it requires credentials that only the MCP tool provides.

8. **PROGRESS** - ${reportProgressInstruction}

9. **PR** - Determine whether to create a PR (if not already on a PR branch):
   - **Default behavior**: Create a PR using ${ghPullfrogMcpName}/create_pull_request with an informative title and body. If you are working in the context of an issue (check EVENT DATA for \`issue_number\` where \`is_pr\` is not true), include "Closes #<issue_number>" in the PR body to auto-close the issue when merged.
   - **Draft PR request**: If the user explicitly asks for a draft PR (e.g. "draft PR", "create as draft", "WIP"), create a PR with \`draft: true\`.
   - **Branch-only request**: If the user explicitly asks for a branch without a PR (e.g. "don't create a PR", "branch only", "just create a branch"), do NOT create a PR. Simply push the branch and report the branch link.

10. **FINAL REPORT** - Call report_progress one final time ONLY if you haven't already included all the important information (PR links, branch links, summary) in a previous report_progress call. If you already called report_progress with complete information including PR links after creating the PR, you do NOT need to call it again. Only make a final call if you need to add missing information. When making the final call, ensure it includes:
   - A summary of what was accomplished
   - Links to any artifacts created (PRs, branches, issues)
   - If you created a PR, ALWAYS include the PR link. e.g.:
     \`\`\`md
     [View PR ➔](https://github.com/org/repo/pull/123)
     \`\`\`
   - If you created a branch without a PR, ALWAYS include a "Create PR" link and a link to the branch. e.g.:
     \`\`\`md
     [\`pullfrog/branch-name\`](https://github.com/pullfrog/scratch/tree/pullfrog/branch-name) • [Create PR ➔](https://github.com/pullfrog/scratch/compare/main...pullfrog/branch-name?quick_pull=1&title=<informative_title>&body=<informative_body>)
     \`\`\`

   Do NOT overwrite a good comment with links/details with a generic message like "I have completed the task. Please review the PR." If your previous report_progress call already contains all the necessary information and links, skip the final call entirely.
`,
    },
    {
      name: "AddressReviews",
      description:
        "Address PR review feedback; respond to reviewer comments; make requested changes to an existing PR",
      prompt: `Follow these steps. THINK HARDER.

1. **CHECKOUT** - Checkout the PR using ${ghPullfrogMcpName}/checkout_pr with the PR number. This fetches the PR branch and configures push settings (including for fork PRs).

2. **DEPENDENCIES** - ${dependencyInstallationStep}

3. **FETCH COMMENTS** - Fetch review comments using ${ghPullfrogMcpName}/get_review_comments with \`pull_number\` and \`review_id\` from EVENT DATA. This returns \`commentsPath\` - read that file for full comment details with diff context. When \`approved_only\` is set in EVENT DATA, only approved comments are returned automatically.

4. **UNDERSTAND** - Review the feedback provided. Understand each review comment and what changes are being requested.

5. **CONTEXT** - If the request requires understanding the codebase structure or conventions, gather relevant context. Read AGENTS.md if it exists.

6. **IMPLEMENT** - Make the necessary code changes to address the feedback. Work through each review comment systematically.

7. **REPLY** - Reply to EACH review comment individually. After fixing each comment, use ${ghPullfrogMcpName}/reply_to_review_comment to reply directly to that comment thread. Keep replies extremely brief (1 sentence max, e.g., "Fixed by renaming to X" or "Added null check"). If suggesting a small, specific, self-contained code change, use GitHub's suggestion format with \`\`\`suggestion blocks. After addressing a comment and posting your reply, use ${ghPullfrogMcpName}/resolve_review_thread with the thread_id to mark it as resolved. Only resolve threads where you made code changes to address the feedback — don't resolve threads that are already resolved, threads where no action was taken, or threads where you disagree with the feedback.

8. **TEST** - Test your changes to ensure they work correctly. Run relevant tests, builds, or linters BEFORE committing. If tests fail, fix the issues and repeat until everything passes.

9. **COMMIT** - Commit your changes with \`${ghPullfrogMcpName}/git\` (\`git add .\` then \`git commit -m "message"\`), then push with \`${ghPullfrogMcpName}/push_branch\`. The push will automatically go to the correct remote (including fork repos). Do not create a new branch or PR - you are updating an existing one.

10. **PROGRESS** - ${reportProgressInstruction}

Keep the progress comment extremely brief. The summary should be 1-2 sentences max (e.g., "Fixed 3 review comments and pushed changes."). Almost all detail belongs in the individual reply_to_review_comment calls, NOT in the progress comment.`,
    },
    {
      name: "Review",
      description:
        "Review code, PRs, or implementations; provide feedback or suggestions; identify issues; or check code quality, style, and correctness",
      prompt: `Follow these steps to review the PR. Your job is to find problems—assume they exist until you've proven otherwise. Do not submit a clean review without thorough investigation.

1. **CHECKOUT** - Call ${ghPullfrogMcpName}/checkout_pr with the PR number. This should give you all PR metadata you need, including a \`diffPath\`: a path to a temp file containing the PR diff.

2. **ANALYZE** - Read the modified files to understand the changes in context.
   - **Understand the change**: What is being modified and why? What's the before/after behavior?
   - **Evaluate the approach**: Is it sound? If not, focus on approach before implementation details.

3. **INVESTIGATE** - Actively hunt for problems. Use these techniques:
   - **Trace data flow**: Use grep to follow how data moves through the system. How is state passed? Where could it get lost?
   - **Check boundaries**: What happens across process boundaries, module boundaries, async boundaries? State that exists in one context may not exist in another.
   - **Explore failure modes**: What if this throws? What if that returns null? What if the network fails? What if this runs twice?
   - **Verify assumptions**: If the code assumes X, verify X is actually true. Use grep, read related files, check documentation.
   - **Consider lifecycle**: Initialization, cleanup, error recovery. Are resources acquired before use? Released after? What happens on cancellation?
   - **Spot performance issues**: Nested loops over large collections, blocking I/O, memory leaks, excessive object creation in hot paths, inefficient array operations (e.g., repeated \`.find()\` in a loop).
   - **Check PR consistency**: Does the PR title/description match the actual code changes? Flag significant discrepancies.
   - **Impact analysis**: Identify what was removed, renamed, or deprecated in the PR. Use grep to search the broader codebase for remaining references to those things in code, tests, docs, comments, and configs. Report stale references in the review body.
   - Do NOT stop at "this looks reasonable." Dig until you either find a problem or have concrete evidence there isn't one.

4. **DRAFT LINE-BY-LINE COMMENTS** - Every comment must be actionable: the author should need to change something in response. 2-3 sentences max. Use the NEW line number from the diff (second column: \`| OLD | NEW | TYPE | CODE\`). If no issues found, skip to step 5. NO COMPLIMENTS. NO NITPICKING ABOUT CHANGES UNRELATED TO THE MAIN CHANGE. Non-actionable comments (praise, style preferences, minor optimizatfixons, documentation nits) must not be drafted.

5. **WRITE SUMMARY** - Draft a 1-3 sentence summary for the review body. If issues were found, include urgency level and any concerns about code outside the diff. If no issues were found, write a brief approval summary (e.g., "Changes look good. No issues found.").

6. **SUBMIT** — Always submit a review via ${ghPullfrogMcpName}/create_pull_request_review:
   - \`body\`: The summary from step 5
   - \`comments\`: The inline comments from step 4
   - \`approved\`: Set to \`true\` ONLY if the review contains no actionable feedback — neither inline comments nor actionable content in the body. An approval signals "no changes needed."

${permalinkTip}
`,
    },
    {
      name: "IncrementalReview",
      description:
        "Re-review a PR after new commits are pushed; focus on new changes since the last review",
      prompt: `Follow these steps to incrementally re-review the PR after new commits were pushed. Focus on what changed since the last review.

1. **CHECKOUT** - Call ${ghPullfrogMcpName}/checkout_pr with the PR number. This gives you the full PR diff via \`diffPath\`.

2. **INCREMENTAL DIFF** - EVENT DATA contains \`before_sha\` (the HEAD before this push). Generate the incremental diff:
   \`git diff <before_sha>...HEAD\`
   This shows the changes introduced by this push. Cross-reference with previous reviews (step 3) to confirm coverage of all unreviewed changes — the full PR diff fills any gaps.
   **If the diff command fails** (e.g., force-push rewrote history), fall back to reviewing the full PR diff from step 1.

3. **FETCH PREVIOUS REVIEWS** - Use ${ghPullfrogMcpName}/list_pull_request_reviews to find previous Pullfrog reviews. For the most recent one, call ${ghPullfrogMcpName}/get_review_comments with the review ID to see specific line-level feedback. This lets you understand what feedback was already given.

4. **ANALYZE** - Read the incremental diff to understand the new changes. Use the full PR diff for surrounding context and to catch any changes not covered by the incremental diff.
   - **Understand the change**: What is new or modified since the last review?
   - **Evaluate the approach**: Are the new changes sound? Do they address prior feedback?

5. **INVESTIGATE** - Hunt for problems in the new code using the same techniques as a full review:
   - Trace data flow, check boundaries, explore failure modes, verify assumptions, consider lifecycle, spot performance issues.
   - Focus investigation on code that changed in the incremental diff, but trace its effects through the broader codebase.
   - **Impact analysis**: If the new commits remove, rename, or deprecate anything, use grep to search the broader codebase for stale references in code, tests, docs, comments, and configs. Report these in the review body.
   - **NEVER repeat feedback from previous reviews.** If a prior issue was not addressed, assume it was intentionally declined. Only comment on genuinely new issues introduced by the new commits.

6. **DRAFT LINE-BY-LINE COMMENTS** - Every comment must be actionable. 2-3 sentences max. Use the NEW line number from the full PR diff. NO COMPLIMENTS. NO NITPICKING.

7. **WRITE SUMMARY** - Draft a 1-3 sentence summary for the review body. Focus on what changed since the last review and whether the new changes are sound. If issues were found, include urgency level. If no issues were found, write a brief approval summary.

8. **SUBMIT** — Use ${ghPullfrogMcpName}/create_pull_request_review:
   - \`body\`: The summary from step 7
   - \`comments\`: The inline comments from step 6
   - \`approved\`: Set to \`true\` ONLY if the review contains no actionable feedback — neither inline comments nor actionable content in the body. An approval signals "no changes needed."

${permalinkTip}
`,
    },
    {
      name: "Plan",
      description:
        "Create plans, break down tasks, outline steps, analyze requirements, understand scope of work, or provide task breakdowns",
      prompt: `Follow these steps. THINK HARDER.

1. **CONTEXT** - If the request requires understanding the codebase structure or conventions, gather relevant context (read AGENTS.md if it exists). Skip this step if the prompt is trivial and self-contained.

2. **ANALYZE** - Analyze the request and break it down into clear, actionable tasks.

3. **DEPENDENCIES** - Consider dependencies, potential challenges, and implementation order.

4. **PLAN** - Create a structured plan with clear milestones.

5. **PROGRESS** - ${reportProgressInstruction}

${permalinkTip}`,
    },
    {
      name: "Fix",
      description:
        "Fix CI failures; debug failing tests or builds; investigate and resolve check suite failures",
      prompt: `Follow these steps to fix CI failures. THINK HARDER.

**CRITICAL RULE**: Only fix issues that were INTRODUCED BY THIS PR. If the CI failure is unrelated to the PR's changes, you MUST abort without committing anything and report why.

1. **GET FAILURE INFO** - Call ${ghPullfrogMcpName}/get_check_suite_logs with the check_suite_id from EVENT DATA. This returns:
   - \`log_index\`: array of interesting lines (errors, warnings, failures) with line numbers - scan this first
   - \`excerpt\`: curated ~80 lines around the main error - read this for immediate context
   - \`full_log_path\`: path to complete log file - read specific line ranges if needed
   - \`failed_steps\`: which CI steps failed (e.g., "Step 6: Run tests")

2. **CHECKOUT AND ASSESS CAUSATION** - Use ${ghPullfrogMcpName}/checkout_pr to get the PR diff. BEFORE attempting any fix, you MUST determine if this PR caused the failure:

   **Ask yourself**: "Could the changes in this PR have caused this failure?"

   - Read the PR diff carefully - what files were modified?
   - What is failing? (test file, module, assertion)
   - Is there a PLAUSIBLE CONNECTION between the PR changes and the failure?

   **ABORT immediately if any of these are true:**
   - The failing test/file was NOT touched by this PR AND doesn't depend on changed code
   - The error is infrastructure-related (network timeout, runner OOM, service unavailable)
   - The error is a flaky test that passes/fails randomly
   - The error existed before this PR (pre-existing bug in main branch)
   - The error is in a dependency update not introduced by this PR

   **When aborting**, use ${ghPullfrogMcpName}/report_progress to explain:
   "This CI failure appears unrelated to the PR's changes. [Describe the failure]. [Explain why it's not caused by the PR]. No changes made."

   **Only proceed** if there's a clear, logical connection between the PR changes and the failure.

3. **UNDERSTAND HOW CI RUNS** - Read the workflow file to understand exactly what commands CI runs:
   - Look at \`.github/workflows/*.yml\` files
   - Find the job/step that failed (from \`failed_steps\`)
   - Note the EXACT command (e.g., \`pnpm -r test --filter=action\`, not just \`pnpm test\`)
   - Check for any CI-specific environment variables or setup steps

4. **DEPENDENCIES** - ${dependencyInstallationStep}

5. **REPRODUCE LOCALLY** - Run the EXACT same command that CI runs:
   - Do NOT simplify (e.g., don't run \`pnpm test\` if CI runs \`pnpm -r test --filter=action\`)
   - Check if CI uses specific flags, filters, or environment variables
   - If CI runs multiple test suites, run them all

6. **ANALYZE THE FAILURE** - Use the log_index and excerpt to understand:
   - What exactly failed (test name, file, assertion)
   - Are there earlier warnings that might explain the failure?
   - Is the failure flaky or deterministic?

7. **FIX THE ISSUE** - Make the necessary code changes. Common patterns:
   - Test assertion failures: fix the code or update the test expectation
   - Build failures: fix type errors, missing imports, syntax issues
   - Lint failures: fix code style issues
   - Timeout/flaky tests: investigate race conditions or increase timeouts

8. **VERIFY THE FIX** - Run the EXACT same CI command again to confirm the fix works

9. **COMMIT AND PUSH** - Use \`${ghPullfrogMcpName}/git\` for add/commit, then \`${ghPullfrogMcpName}/push_branch\` to push

10. **PROGRESS** - ${reportProgressInstruction}

Your job is to fix issues THIS PR introduced, not to fix all CI failures. If in doubt about causation, abort and explain rather than making speculative changes.`,
    },
    {
      name: "ResolveConflicts",
      description: "Resolve merge conflicts in a PR branch against the base branch",
      prompt: `Follow these steps to resolve merge conflicts.

1. **CHECKOUT** - Call ${ghPullfrogMcpName}/checkout_pr with the PR number. This fetches the PR branch.

2. **FETCH BASE** - Identify the base branch (usually main or master) and fetch it using ${ghPullfrogMcpName}/git_fetch (e.g., ref: "main").

3. **ATTEMPT MERGE** - Use ${ghPullfrogMcpName}/shell to run \`git merge origin/<base_branch>\`.
   - If the merge succeeds (exit code 0), the branch is up to date. Push it and you're done.
   - If the merge fails, you have conflicts to resolve.

4. **IDENTIFY CONFLICTS** - Run \`git status\` to see which files are conflicting (modified by both).

5. **RESOLVE** - For each conflicting file:
   - Read the file to see the conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`).
   - Determine the correct content. You may need to keep changes from both sides, or choose one.
   - Edit the file to apply the resolution and remove the markers.

6. **VERIFY** - ${dependencyInstallationStep}
   - Run tests/builds to ensure the resolution is correct.

7. **COMMIT** - Once all conflicts are resolved:
   - \`git add .\`
   - \`git commit -m "Merge branch <base_branch> into <pr_branch>"\` (or similar).

8. **PUSH** - Call ${ghPullfrogMcpName}/push_branch.

9. **PROGRESS** - ${reportProgressInstruction}
`,
    },
    {
      name: "Task",
      description:
        "General-purpose tasks that don't fit other modes: answering questions, adding comments, labeling, running ad-hoc commands, or any direct request",
      prompt: `Follow these steps. THINK HARDER.

1. **UNDERSTAND** - Read the request carefully. Only take action if you have high confidence that you understand what is being asked. Take stock of the tools at your disposal.

2. **CONTEXT** - If the request requires understanding the codebase structure or conventions, gather relevant context. Read AGENTS.md if it exists. Skip this step if the prompt is trivial and self-contained.

3. **EXECUTE** - Perform the requested task.

4. **CODE CHANGES** - If the task involves making code changes:
   - Create a branch using \`${ghPullfrogMcpName}/git\` (\`git checkout -b pullfrog/branch-name\`). Branch names should be prefixed with "pullfrog/" and reflect the exact changes you are making. Never commit directly to main, master, or production.
   - ${dependencyInstallationStep}
   - Use file operations to create/modify files with your changes.
   - Test your changes to ensure they work correctly. Run relevant tests, builds, or linters BEFORE committing. If tests fail, fix the issues and repeat until everything passes.
   - Commit your changes with \`${ghPullfrogMcpName}/git\` (\`git add .\` then \`git commit -m "message"\`), then push with \`${ghPullfrogMcpName}/push_branch\`. Do NOT use \`git push\` directly - it requires credentials that only the MCP tool provides.
   - Determine whether to create a PR:
     - **Default behavior**: Create a PR using ${ghPullfrogMcpName}/create_pull_request with an informative title and body. If you are working in the context of an issue (check EVENT DATA for \`issue_number\` where \`is_pr\` is not true), include "Closes #<issue_number>" in the PR body to auto-close the issue when merged.
     - **Draft PR request**: If the user explicitly asks for a draft PR (e.g. "draft PR", "create as draft", "WIP"), create a PR with \`draft: true\`.
     - **Branch-only request**: If the user explicitly asks for a branch without a PR (e.g. "don't create a PR", "branch only", "just create a branch"), do NOT create a PR. Simply push the branch and report the branch link.

5. **PROGRESS** - ${reportProgressInstruction}

Do NOT overwrite a good comment with links/details with a generic message like "I have completed the task." If your previous report_progress call already contains all the necessary information and links, skip the final call entirely.`,
    },
  ];
}

export const modes: Mode[] = computeModes();
