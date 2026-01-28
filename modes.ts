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

const reportProgressInstruction = `Use ${ghPullfrogMcpName}/report_progress to share progress and results. Continue calling it as you make progress - it will update the same comment. Never create additional comments manually.`;

const dependencyInstallationStep = `If this task will require running tests, builds, linters, or CLI commands that need installed packages, call \`${ghPullfrogMcpName}/start_dependency_installation\` NOW. This is non-blocking and allows dependencies to install in the background while you continue. Later, call \`${ghPullfrogMcpName}/await_dependency_installation\` before running commands that need them. Skip this step if only reading code or answering questions.`;

const permalinkTip = `**TIP**: To reference specific code, use GitHub permalinks: \`https://github.com/{owner}/{repo}/blob/{commit_sha}/{path}#L{start}-L{end}\`. GitHub renders these as expandable code blocks.`;

export function computeModes(): Mode[] {
  return [
    {
      name: "Build",
      description:
        "Implement, build, create, or develop code changes; make specific changes to files or features; execute a plan; or handle tasks with specific implementation details",
      prompt: `Follow these steps exactly.
1. Determine whether to work on the current branch or create a new one:
   - **PR event, modifying the existing PR**: The PR branch is probably already checked out. Continue on this branch.
   - **PR event, but user wants a NEW branch/PR**: Use \`${ghPullfrogMcpName}/create_branch\` to create a new branch from the current HEAD.
   - As needed use \`${ghPullfrogMcpName}/create_branch\` to create new branches. Always check your current branch status first.
   
   Branch names must be prefixed with "pullfrog/" and be specific enough to avoid collisions. Never commit directly to main/master/production. Do NOT use git commands directly (\`git branch\`, \`git status\`, \`git log\`, etc.) - always use ${ghPullfrogMcpName} MCP tools.

2. ${dependencyInstallationStep}

3. If the request requires understanding the codebase structure or conventions, gather relevant context. Read AGENTS.md if it exists. Skip this step if the prompt is trivial and self-contained.

4. Understand the requirements and any existing plan

5. Make the necessary code changes using file operations. You should change the minimum amount of code necessary to accomplish your task. Emphasize code quality and elegance. 

6. Then use ${ghPullfrogMcpName}/commit_files to commit your changes, and ${ghPullfrogMcpName}/push_branch to push the branch. Do NOT use git commands like \`git commit\` or \`git push\` directly.

7. Test your changes to ensure they work correctly

8. ${reportProgressInstruction}

9. Determine whether to create a PR (if not already on a PR branch):
   - **Default behavior**: Create a PR using ${ghPullfrogMcpName}/create_pull_request with an informative title and body. If relevant, indicate which issue the PR addresses (e.g. "Fixes #123").
   - **Branch-only request**: If the user explicitly asks for a branch without a PR (e.g. "don't create a PR", "branch only", "just create a branch"), do NOT create a PR. Simply push the branch and report the branch link.

10. Call report_progress one final time ONLY if you haven't already included all the important information (PR links, branch links, summary) in a previous report_progress call. If you already called report_progress with complete information including PR links after creating the PR, you do NOT need to call it again. Only make a final call if you need to add missing information. When making the final call, ensure it includes:
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
  
  **IMPORTANT**: Do NOT overwrite a good comment with links/details with a generic message like "I have completed the task. Please review the PR." If your previous report_progress call already contains all the necessary information and links, skip the final call entirely.
`,
    },
    {
      name: "AddressReviews",
      description:
        "Address PR review feedback; respond to reviewer comments; make requested changes to an existing PR",
      prompt: `Follow these steps. THINK HARDER.
1. Checkout the PR using ${ghPullfrogMcpName}/checkout_pr with the PR number. This fetches the PR branch and configures push settings (including for fork PRs).

2. ${dependencyInstallationStep}

3. Fetch review comments using ${ghPullfrogMcpName}/get_review_comments with \`pull_number\` and \`review_id\` from EVENT DATA. This returns \`commentsPath\` - read that file for full comment details with diff context. If EVENT DATA contains a \`triggerer\` field (indicating who requested fixes), you can pass \`approved_by\` to filter to only comments they approved with 👍.

4. Review the feedback provided. Understand each review comment and what changes are being requested.    

5. If the request requires understanding the codebase structure or conventions, gather relevant context. Read AGENTS.md if it exists.

6. Make the necessary code changes to address the feedback. Work through each review comment systematically.

7. **CRITICAL: Reply to EACH review comment individually.** After fixing each comment, use ${ghPullfrogMcpName}/reply_to_review_comment to reply directly to that comment thread. Keep replies extremely brief (1 sentence max, e.g., "Fixed by renaming to X" or "Added null check"). If suggesting a small, specific, self-contained code change, use GitHub's suggestion format with \`\`\`suggestion blocks.

8. Test your changes to ensure they work correctly.

9. When done, commit your changes with ${ghPullfrogMcpName}/commit_files, then push with ${ghPullfrogMcpName}/push_branch. The push will automatically go to the correct remote (including fork repos). Do not create a new branch or PR - you are updating an existing one.

10. ${reportProgressInstruction}

**CRITICAL: Keep the progress comment extremely brief.** The summary should be 1-2 sentences max (e.g., "Fixed 3 review comments and pushed changes."). Almost all detail belongs in the individual reply_to_review_comment calls, NOT in the progress comment.`,
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
   - Do NOT stop at "this looks reasonable." Dig until you either find a problem or have concrete evidence there isn't one.

4. **DRAFT** - For each issue found, create an inline comment. Use the NEW line number from the diff (second column: \`| OLD | NEW | TYPE | CODE\`).

5. **FILTER** - Remove noise, keep substance:
   - Remove style-only comments (formatting, naming conventions) unless they cause real confusion
   - Remove compliments that aren't actionable
   - Keep: bugs, logic errors, missing error handling, security issues, race conditions, resource leaks, incorrect assumptions

6. **SUBMIT** — Use ${ghPullfrogMcpName}/create_pull_request_review:
   - \`comments\`: Inline feedback on specific diff lines
   - \`body\`: 1-3 sentence summary with urgency level and any concerns about code outside the diff
   - If no issues found, submit with empty comments and a brief approving body

${permalinkTip}
`,
    },
    {
      name: "Plan",
      description:
        "Create plans, break down tasks, outline steps, analyze requirements, understand scope of work, or provide task breakdowns",
      prompt: `Follow these steps. THINK HARDER.
1. If the request requires understanding the codebase structure or conventions, gather relevant context (read AGENTS.md if it exists). Skip this step if the prompt is trivial and self-contained.

2. Analyze the request and break it down into clear, actionable tasks

3. Consider dependencies, potential challenges, and implementation order

4. Create a structured plan with clear milestones

5. ${reportProgressInstruction}

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

4. ${dependencyInstallationStep}

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

9. **COMMIT AND PUSH** - Use ${ghPullfrogMcpName}/commit_files and ${ghPullfrogMcpName}/push_branch

10. ${reportProgressInstruction}

**REMEMBER**: Your job is to fix issues THIS PR introduced, not to fix all CI failures. If in doubt about causation, abort and explain rather than making speculative changes.`,
    },
    {
      name: "Prompt",
      description:
        "Fallback for tasks that don't fit other workflows, e.g. direct prompts via comments, or requests requiring general assistance",
      prompt: `Follow these steps. THINK HARDER.
1. Perform the requested task. Only take action if you have high confidence that you understand what is being asked. If you are not sure, ask for clarification. Take stock of the tools at your disposal. When creating comments, always use report_progress. Do not use create_issue_comment.

2. If the task involves making code changes:
   - Create a branch using ${ghPullfrogMcpName}/create_branch. Branch names should be prefixed with "pullfrog/" and reflect the exact changes you are making. Never commit directly to main, master, or production.
   - ${dependencyInstallationStep}
   - Use file operations to create/modify files with your changes.
   - Use ${ghPullfrogMcpName}/commit_files to commit your changes, then ${ghPullfrogMcpName}/push_branch to push the branch. Do NOT use git commands directly (\`git commit\`, \`git push\`, \`git checkout\`, \`git branch\`) as these will use incorrect credentials.
   - Test your changes to ensure they work correctly.
   - Determine whether to create a PR:
     - **Default behavior**: Create a PR using ${ghPullfrogMcpName}/create_pull_request with an informative title and body. If relevant, indicate which issue the PR addresses (e.g. "Fixes #123"). Include links to the issue or comment that triggered the PR in the PR body.
     - **Branch-only request**: If the user explicitly asks for a branch without a PR (e.g. "don't create a PR", "branch only", "just create a branch"), do NOT create a PR. Simply push the branch and report the branch link.

3. ${reportProgressInstruction}

4. When finished with the task, use report_progress one final time ONLY if you haven't already included all the important information (summary, links to PRs/issues) in a previous report_progress call. If you already called report_progress with complete information including links after creating artifacts, you do NOT need to call it again. **IMPORTANT**: Do NOT overwrite a good comment with links/details with a generic message like "I have completed the task."`,
    },
  ];
}

export const modes: Mode[] = computeModes();
