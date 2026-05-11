// changes to mode definitions should be reflected in docs/modes.mdx
import { REVIEWER_AGENT_NAME } from "./agents/reviewer.ts";
import { type AgentId, formatMcpToolRef, pullfrogMcpName } from "./external.ts";

export interface Mode {
  name: string;
  description: string;
  // step-by-step guidance returned when the agent calls select_mode.
  // custom user-defined modes supply this; built-in modes define it here.
  prompt?: string | undefined;
}

// Default user-facing summary format embedded in Review mode review bodies.
// Deliberately scoped to Review (initial PR review). IncrementalReview keeps
// its own terser bullet-list "Reviewed changes" shape since re-review bodies
// are deltas, not introductions. Distinct from the agent-internal snapshot
// (action/utils/prSummary.ts) which has its own stable scaffold and is never
// shaped by user instructions — see selectMode.ts for the firewall.
export const PR_SUMMARY_FORMAT = `### Default format

Follow this structure exactly:

<b>TL;DR</b> — 1-3 sentences on what the PR does and why. Focus on intent, not mechanics.
NOTE: use HTML bold <b>TL;DR</b>, NOT markdown bold **TL;DR**.

### Key changes

- **Short human-readable title** — 1 sentence per change. Write a short prose phrase (title case or sentence case); when you name a file, type, or function, put that name in backticks (e.g. **Add \`TodoTracker\` for live checklists**). A reviewer should understand the full PR from this list alone.

<sub><b>Summary</b> ｜ {file_count} files ｜ {commit_count} commits ｜ base: \`{base}\` ← \`{head}\`</sub>
NOTE: the metadata line goes AFTER the bullet list, not before it.

Then for each key change, a ## section with a short descriptive title that reads like a documentation heading (e.g. ## Live todo checklist tracking).

<br/>

## Example readable section title

> **Before:** [old behavior/state]<br/>**After:** [new behavior/state]
IMPORTANT: Before and After MUST be on a SINGLE blockquote line with an inline <br/> between them. Two separate \`>\` lines creates a double line break.

1-2 sentences of explanation. Break up text with tables, blockquotes, or lists — NEVER 3+ plain paragraphs in a row.

If a change warrants deeper explanation, use a blockquoted details/summary framed as a question:
> <details><summary>How does X work?</summary>
> Extended explanation here.
> </details>

End each section with a file links trail (3-4 key files max):
[\`file.ts\`](https://github.com/{owner}/{repo}/pull/{number}/files#diff-{sha256hex_of_filepath}) · ...

Single-feature PRs: skip the ## sections. Fold before/after and explanation into the header after key changes.

CRITICAL — GitHub markdown rendering rule:
GitHub's markdown parser requires a blank line between ALL block-level elements. This includes transitions between: HTML tags (<br/>, <sub>, <details>, <b>, etc.) and markdown syntax (headings, lists, blockquotes, paragraphs). Without a blank line, GitHub treats the following content as a continuation of the HTML block and renders markdown syntax as literal text. ALWAYS separate block-level elements with a blank line.

Rules:
- \`##\` titles and key-change bullet lead-ins are plain-language summaries; backtick only actual code tokens (files, types, functions) where they appear in the title
- ALL variable names, identifiers, and file names in body text must be in backticks
- ALL file references MUST link to the PR Files Changed view. Use the \`diff-<hex>\` anchor precomputed next to each filename in the \`checkout_pr\` TOC — do NOT run \`sha256sum\` or any other shell command to compute anchors. NEVER fabricate hex strings. If a file is not in the TOC, omit the \`#diff-\` anchor rather than guessing.
- Add <br/> before each ## heading for visual spacing. Do NOT use horizontal rules (---)
- Do NOT include raw diff stats like '+123 / -45' or line counts
- Do NOT include code blocks or repeat diff contents
- Do NOT include a changelog section — the key changes list serves this purpose
- Focus on *intent*, not *what* — the diff already shows what changed
- Get the file count and commit count from the checkout_pr metadata, not by counting manually`;

export function computeModes(agentId: AgentId): Mode[] {
  const t = (toolName: string) => formatMcpToolRef(agentId, toolName);
  return [
    {
      name: "Build",
      description:
        "Implement, build, create, or develop code changes; make specific changes to files or features; execute a plan; or handle tasks with specific implementation details",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. **plan** (optional, for complex tasks): analyze requirements, read AGENTS.md and relevant code, produce a step-by-step implementation plan.

3. **setup**: checkout or create the branch:
   - **PR event, modifying the existing PR**: call \`${t("checkout_pr")}\`
   - **new branch**: use \`${t("git")}\` to create a branch (\`git checkout -b pullfrog/branch-name\`)

4. **build**: implement changes using your native file and shell tools:
   - follow the plan (if you ran a plan phase)
   - plan your approach before writing code: identify which files need to change, key design decisions, and edge cases. for non-trivial changes, consider whether there's a more elegant approach.
   - run relevant tests/lints before committing

5. **self-review**: judgment call — does YOUR diff warrant a fresh-eyes pass?

   Skip self-review (commit directly) when the diff is **genuinely trivial**:
   - doc typos, comment-only edits, whitespace/format-only, import reordering
   - lockfile or generated-code regeneration, mechanical rename whose only effect is import-path updates (size of diff is irrelevant — read the *shape*, not the line count)
   - low-risk dep patch bump from a trusted source

   Run self-review when the diff has **any behavioral surface, however small**:
   - 1-line changes to SQL operators / comparison logic / regexes / redirects / HTTP methods / response codes
   - any change to money / tax / currency / billing / fee / refund / payout calculations or constants
   - any change to auth / permissions / roles / sessions / tokens / signature verification
   - any change to feature-flag defaults, retry counts, timeouts, rate limits, batch sizes
   - new endpoints, new code paths, new error branches — even small ones
   - mixed diffs (whitespace + a single semantic line) — the semantic line still triggers self-review
   - anything you're uncertain about

   Tie-breaker: when in doubt, run self-review. One false-positive subagent dispatch costs cents; one false-negative shipped bug costs much more. There's no value in dispatching for a typo, but there's also no excuse for skipping on a 1-line change to a billing path.

   Otherwise delegate the \`${REVIEWER_AGENT_NAME}\` subagent to review your diff with fresh eyes against YOUR TASK. The subagent's baked-in system prompt enforces a non-mutative + non-recursive contract: read-only file/search/web tools and read-only MCP queries only; no writes, shell side effects, state-changing MCP calls, or nested subagent dispatch. Enforcement is prose-only — restate the constraint in your dispatch instructions and do not relax it.

   Provide the subagent with YOUR TASK, the output of \`git diff\`, and a tight summary (not raw output) of any lint/typecheck/test failures you fixed during build — what broke, root cause, the fix — so it can check that fixes addressed root causes rather than suppressed symptoms; say "no build-phase failures" if the build path was clean. Instruct it to flag bugs, logic errors, missing edge cases, gaps between request and diff, and unintended changes.

   Delegation + research discipline (distilled from \`/anneal\` canonical — these are codified learnings from many review rounds, not theoretical best practices):
   - Do NOT summarize what you implemented — that biases the subagent toward validating the shape of your solution rather than questioning it.
   - Do NOT curate a reading list of files. Let the subagent discover scope from the diff and codebase.
   - Do NOT pre-shape output with a severity / category schema. That leaks your hypotheses; severity is your call during evaluation.
   - Do NOT defect-hunt the diff yourself in parallel with the subagent. Your role is dispatch + evaluation; doing the review yourself reintroduces the implementation bias the subagent is meant to mitigate.
   - For diffs that rely on third-party API contracts, SDK semantics, framework directives, or DB engine specifics, instruct the subagent to verify load-bearing claims via web search and quote source URLs rather than trust training data — this is the single most common review-quality failure mode.

   Review the findings, address valid points, and discard nitpicks or false positives. The reviewer is fallible — it biases toward *recommending additions* (defensive checks for impossible cases, extra logging, new abstractions used once, comments restating code, tests asserting tautologies, "just-in-case" guards). For each finding, ask: would applying it leave the code more sound, correct, AND elegant? Two-out-of-three is usually a signal to look harder for a fix that gets all three before settling for one that trades elegance for correctness. Reject bloat-shaped findings without applying them, and after applying the rest re-read your diff and be discerning about what *you just changed*: if any fix turned out to be bloat in context, revert it. The goal is code that is sound and correct *while remaining elegant*; the smallest diff that fixes the real defect almost always wins. Then verify only intended changes are present, no debug artifacts or commented-out code remain, no unrelated files were modified. Commit locally via shell (\`git add . && git commit -m "..."\`).

6. **finalize**:
   - confirm a clean working tree, then push via \`${t("push_branch")}\` (see *SYSTEM* Git rules if this fails — prepush errors are usually the repo's tests/lint, not infra timeouts)
   - create a PR via \`${t("create_pull_request")}\`
   - call \`${t("report_progress")}\` with the PR link or the exact error if push/PR failed

### Notes

For simple, well-defined tasks, skip the plan phase and go straight to build.`,
    },
    {
      name: "AddressReviews",
      description:
        "Address PR review feedback; respond to reviewer comments; make requested changes to an existing PR",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. Checkout the PR branch via \`${t("checkout_pr")}\`.

3. Fetch review comments via \`${t("get_review_comments")}\`.

4. For each comment:
   - understand the feedback
   - evaluate whether applying it would leave the code more **sound, correct, AND elegant**. reviewers are fallible and bias toward *recommending additions* (defensive checks for impossible cases, extra abstractions, comments restating obvious code, tests asserting tautologies, "just-in-case" guards). if a request would add bloat — ceremony without commensurate correctness benefit — push back in your reply rather than mechanically applying it. two-out-of-three is usually a signal to look harder for a fix that gets all three before settling.
   - if the request stands, make the code change using your native tools; otherwise reply explaining why
   - record what was done (or why nothing was done)

5. Quality check:
   - test changes, then review the diff before committing — verify only intended changes are present, no debug artifacts remain, no fix turned out to be bloat in context (revert any that did), and the changes are clean enough that a senior engineer would approve without hesitation
   - commit locally via shell (\`git add . && git commit -m "..."\`)

6. Finalize:
   - confirm a clean working tree, then push via \`${t("push_branch")}\` (same push/prepush guidance as Build mode in *SYSTEM*)
   - reply to each comment **exactly once** using \`${t("reply_to_review_comment")}\` — do not re-emit the same call (the runtime dedupes identical bodies and the second call is wasted)
   - resolve addressed threads via \`${t("resolve_review_thread")}\`
   - call \`${t("report_progress")}\` with a brief summary (or the exact push error if push failed)`,
    },
    // Review and IncrementalReview use the multi-lens orchestrator pattern
    // (canonical source: .claude/commands/anneal.md). The orchestrator does
    // triage → parallel read-only subagent fan-out → aggregate → draft comments
    // → submit. For someone else's PR, parallel lenses (correctness, security,
    // research-validated claims, user-journey, etc.) provide breadth across
    // angles that a single subagent can't carry coherently. Build mode keeps
    // a single fresh-eyes subagent (different problem shape — orchestrator
    // wrote the code and bias-mitigation comes from delegating to one
    // subagent that doesn't share the implementation context).
    // Deliberate omission vs canonical /anneal: severity categorization in the
    // final message (the review body has its own CAUTION/IMPORTANT framing
    // instead of a severity table).
    {
      name: "Review",
      description:
        "Review code, PRs, or implementations; provide feedback or suggestions; identify issues; or check code quality, style, and correctness",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. **checkout**: call \`${t("checkout_pr")}\` — this returns PR metadata and a \`diffPath\`. read the diff TOC end-to-end and treat its file line ranges as your coverage checklist.

3. **triage**: orient yourself on the PR — identify *what kind of thing this is* (domain it touches, seams it crosses, external contracts it depends on, user-facing surfaces it changes). orientation only — defer specific defect-hunting to the subagents; pre-reviewing biases the lenses you pick. use \`${t("get_pull_request")}\` and other read-only GitHub tools for additional context if needed.

   if the PR is **genuinely trivial**, skip steps 4–5 entirely and submit a \`No new issues found.\` review per step 6. there's no value in dispatching even one lens for a typo.

   "Genuinely trivial" (skip):
   - single-word doc typo, whitespace/format-only, comment-only across any number of files
   - lockfile or generated-code regeneration (size of diff is irrelevant — read the *shape*)
   - mechanical rename whose only effect is import-path updates
   - low-risk dep patch bump

   "Looks trivial but isn't" (do **NOT** skip — small diff, big blast radius):
   - any 1-line change to SQL / regex / auth / billing / permission / signature-verification code
   - flipping a feature-flag default, default config value, or retry/timeout constant
   - changing a money/tax/currency/fee constant by any amount
   - changing an HTTP method, redirect URL, response code, or status enum
   - tightening or loosening a comparison operator (\`<\` ↔ \`<=\`, \`==\` ↔ \`!=\`)
   - renaming a public API surface (still trivial in shape, but needs an impact lens)
   - adding a new direct dependency (supply-chain surface)
   - any "typo fix" in user-facing copy that changes meaning ("approved" → "denied")
   - mixed diffs where a semantic 1-liner is buried in whitespace/formatting changes

   When unsure, treat as non-trivial. The cost of one extra subagent is cents; the cost of a missed billing/auth/data bug is much more.

   otherwise pick lenses by where the PR concentrates risk — **there's no fixed count**. lens count is judgment, not a formula. concrete shapes to anchor against:

   - **1 lens** — pure refactor / mechanical rename across many files (impact); new test file with no source change (test-integrity); small isolated bug fix (correctness); doc-only PR with non-trivial technical content (research-validated or holistic)
   - **2–3 lenses (most PRs land here)** — new CRUD endpoint (correctness + security + test-integrity); new UI flow (user-journey + correctness); a single bug fix in a non-critical subsystem (correctness + test-integrity); design doc covering one domain (research-validated + correctness or holistic)
   - **4–5 lenses (high-stakes subsystem touches)** — any billing/payments change (billing-subsystem + correctness + security + operational-readiness); new auth flow (auth-subsystem + correctness + security + test-integrity); schema migration (schema-migration-subsystem + correctness + operational-readiness + impact); cross-subsystem PR that touches billing AND auth AND schema (one subsystem lens per domain + correctness)
   - **6+ lenses** — almost always a smell; you're either covering overlapping ground or this PR should have been split. push back via the review body rather than expanding lens count.

   lenses come in two flavors, and you can mix them:
   - **themed lenses** — a perspective applied across the whole diff (correctness, security, user-journey, performance, etc.).
   - **subsystem lenses** — a domain-scoped frame for high-stakes subsystems the PR touches (e.g. "the auth lens", "the billing lens", "the schema-migration lens"). a subsystem lens is "review the PR specifically for what could go wrong in this subsystem" and naturally combines theme + scope. **for high-stakes domains, lead with the subsystem lens rather than the generic themed equivalent** — "billing-subsystem" outperforms "correctness on billing code" because the framing primes the subagent to remember domain-specific failure modes (double-charges, refund races, currency rounding, dispute flows) the generic lens misses.

   starter menu (combine, omit, or invent your own):
   - **correctness & invariants** — bugs, races, error handling, edge cases, state-machine boundaries
   - **impact** — when the PR removes features, deletes exports, renames identifiers, or changes architectural patterns: stale references in code, tests, docs (\`docs/\`, \`wiki/\`), comments, configs, UI
   - **research-validated assumptions** — third-party API contracts, SDK semantics, framework directives, version-gated behavior. the subagent must verify load-bearing claims via web search and quote source URLs.
   - **security** — new endpoints, authZ, input validation, secrets handling, replay/CSRF/injection, cross-tenant isolation
   - **user-journey** — UX-touching flows: walk through happy path and failure modes as a user
   - **operational readiness** — observability, alerting, migrations (forward + rollback), feature flags, on-call burden
   - **integration & cross-cutting** — API contracts between modules, backward-compat of public surfaces, multi-service ordering
   - **test integrity** — meaningful coverage for the changed behavior; deterministic; no shared-state pollution
   - **performance** — N+1 queries, hot-path allocation, latency budgets, index coverage
   - **holistic** — does the PR make sense as a whole? symmetric flows (delete for every create, rollback for every migration)?
   - **subsystem lenses** (invent as the PR demands) — auth, billing, payments, schema migration, webhooks, secrets, RBAC, multi-tenant isolation, cron/scheduling, etc.

4. **fan out**: dispatch one \`${REVIEWER_AGENT_NAME}\` subagent per lens — its baked-in system prompt enforces the non-mutative + non-recursive contract (read-only file/search/web tools and read-only MCP queries; no writes, shell side effects, state-changing MCP calls, or nested subagent dispatch). when picking 2+ lenses, dispatch them in a **single assistant turn with multiple parallel subagent calls**; issuing one and awaiting reply before the next collapses the fan-out into a serial review. if a subagent errors out, times out, or returns nothing usable, retry once with the same lens; if it still fails, proceed with partial coverage and note the missing lens in the review body — do not skip step 4 entirely on a single subagent failure. each subagent gets:
   - the diff path / target — reading the diff and the codebase is its job
   - **only one lens** — never a multi-section "review for X, Y, and Z" prompt
   - **a Task \`description\` set to the lens name** (e.g. \`"security"\`, \`"correctness"\`, \`"billing-subsystem"\`) — the harness reads this field to label the subagent's log lines so parallel runs can be told apart in CI output. without it, every subagent shows up as \`subagent#N\`.
   - the read-only contract restated in your dispatch instructions so the rule is present twice (the subagent's system prompt also enforces it). The test: would this call still be a no-op if reverted? If not (PR comments, branch pushes, issue updates, set_output, label changes, dependency installs, etc.), don't make it.
   - if the lens touches external contracts, instruct the subagent to verify load-bearing claims via web search rather than trust training data, and to quote source URLs in its reasoning. action runs are non-interactive — there's no human in the loop to catch "I'm pretty sure Stripe does X."
   - ask the subagent to report findings with file paths and NEW line numbers from the diff so you can anchor inline comments without re-reading the entire diff.

   delegation discipline:
   - do NOT lens-review the diff yourself in parallel with the subagents (your job is dispatch + comment-drafting; doing the lens work yourself reintroduces the bias the fan-out avoids)
   - do NOT summarize the PR for them (biases toward a validation frame)
   - do NOT hand them a curated reading list (let them discover scope)
   - do NOT pre-shape their output with a finding schema
   - do NOT mention the other lenses (independence is the point — overlapping findings are a strong signal)

5. **aggregate & draft**: merge findings; de-dup overlaps (two lenses catching the same issue = higher-confidence signal); trace each finding yourself before accepting it. drop praise, style preferences, speculative/unverified claims, findings about pre-existing code unrelated to the PR (heuristic: if the finding's root cause lives in lines this PR added or modified, it's in scope; otherwise drop unless the PR plausibly introduced or amplified the regression), and anything not actionable. also drop **bloat-shaped findings** — proposed fixes that would add defensive checks for cases that can't happen, abstractions used once, comments restating obvious code, tests asserting tautologies, or "just-in-case" guards. subagents are fallible and bias toward recommending changes; the bar for an actionable inline comment is sound + correct + elegant. recommending a change that improves only one of the three (or worse, degrades elegance to nominally improve correctness) makes the codebase worse, not better.

   for surviving findings, draft inline comments with NEW line numbers from the diff. every comment must be actionable, 2-3 sentences max. use GitHub permalink format for code references. for impact-analysis findings (stale references after rename/remove), report them in the review body ordered by severity (runtime breakage > incorrect docs > stale comments) rather than as inline comments unless they're anchored to a specific line.

6. **submit**: ALWAYS submit exactly one review via \`${t("create_pull_request_review")}\`. Do NOT call \`report_progress\` — the review is the final record and the progress comment will be cleaned up automatically.

   note: the first create_pull_request_review submission may error with a one-time diff-coverage nudge listing unread TOC regions. retry the same call to proceed — optionally after reading the listed ranges. the pre-flight will not block again this session.

   The review body is structured as: \`[optional alert blockquote]\` → \`[PR summary using the default format below]\`. Inline comments are passed via the \`comments\` parameter, not in the body.

   GitHub alert blockquotes render at four visual intensities — the callout is what the author sees first, so pick the one that matches what you want them to do:

   - \`[!CAUTION]\` — large red banner. Reads as "this will break something."
   - \`[!IMPORTANT]\` — large purple banner. Reads as "you need to look at this before merging."
   - \`[!NOTE]\` — small blue inline callout. Reads as "FYI, here's something worth noting."
   - no callout — plain text. Reads as routine review output.

   Two reinforcing levers: callout intensity (above) and \`approved\` (which gates the footer Fix-button affordance — Fix renders on every non-approving review, so \`approved: true\` suppresses it). Wrapping mergeable feedback in \`[!IMPORTANT]\` trains users to click Fix on reviews that don't need fixing. Pick the tier the author's actual next action justifies.

   - **critical issues** (blocks merge — bugs, security, data loss, broken core flows):
     \`approved: false\`. Body opens with \`> [!CAUTION]\\n> This PR introduces ...\`, followed by the PR summary. Include all inline comments via \`comments\`.
   - **must-address non-critical findings** (real consequences if shipped — incorrect behavior in non-critical paths, missing validation on user input, regressions the author should fix before merge):
     \`approved: false\`. Body opens with \`> [!IMPORTANT]\\n> ...\`, followed by the PR summary. Reserve this tier for findings with concrete fallout — do NOT use \`[!IMPORTANT]\` for nits, style preferences, or "consider also" suggestions. Include all inline comments via \`comments\`.
   - **minor suggestions only** (single-line nits, doc/comment polish, defer-able observations, "rough edges"):
     \`approved: false\`. NO alert blockquote. Body opens directly with the PR summary. Include all inline comments via \`comments\`.
   - **informational observations** (mergeable as-is, nothing actionable — e.g. prior feedback addressed cleanly, surfacing a minor stale doc reference, calling out something noteworthy without recommending a change):
     \`approved: true\`. Body opens with \`> [!NOTE]\\n> ...\`, followed by the PR summary. Do NOT include inline \`comments\` — \`[!NOTE]\` signals "no action needed", which contradicts an actionable anchor; if a point is concrete enough to anchor to a line, downgrade the whole review to "minor suggestions only" (\`approved: false\`) instead.
   - **no actionable issues**:
     \`approved: true\`. Body opens with \`No new issues found.\` followed by the PR summary.

${PR_SUMMARY_FORMAT}`,
    },
    // IncrementalReview shares Review's multi-lens orchestrator pattern but
    // scopes the target to the incremental diff. The "issues must be NEW
    // since the last Pullfrog review" filter lives at aggregation time
    // (step 6), NOT in the subagent prompt — pushing the filter into
    // subagents matches the canonical anneal anti-pattern of "list known
    // pre-existing failures — don't flag these" and suppresses signal on
    // regressions the new commits amplified. The review body is just
    // "Reviewed changes" — a separate "Prior review feedback" checklist
    // would duplicate the rolling PR summary snapshot's record of what
    // earlier runs already addressed and add noise to the user-facing
    // body. Same severity-table omission as Review.
    {
      name: "IncrementalReview",
      description:
        "Re-review a PR after new commits are pushed; focus on new changes since the last review",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. **checkout**: call \`${t("checkout_pr")}\` — this returns PR metadata, \`diffPath\` (full diff), and \`incrementalDiffPath\` (changes since last reviewed version, if available). read the diff TOC first and use its line ranges as your coverage checklist.

3. **incremental scope**: if \`incrementalDiffPath\` is present, read it to see what changed since the last review. this is a range-diff that isolates the net changes, filtering out base branch noise. if not present, fall back to reviewing the full PR diff and determine what changed since Pullfrog's most recent review.

4. **prior feedback**: fetch previous reviews via \`${t("list_pull_request_reviews")}\`. for the most recent Pullfrog review, call \`${t("get_review_comments")}\` with the review ID to retrieve specific prior line-level feedback. you'll use this to filter your aggregation in step 6 — anything already flagged in a prior review and not changed by the new commits should not be re-raised. you do NOT need to render this in the review body; the rolling PR summary snapshot is the durable record of what's been addressed.

5. **triage & fan out**: orient on the *incremental* changes — domain, seams, external contracts, user-facing surfaces.

   if the incremental changes are **genuinely trivial**, skip the fan-out entirely and jump to step 8's non-substantive path (do NOT submit a review).

   "Genuinely trivial" (skip): formatting/comment tweaks, import reordering, lockfile regen, mechanical rename of import paths, whitespace-only.
   "Looks trivial but isn't" (do NOT skip — same anti-patterns as Review mode): 1-line changes to SQL/regex/auth/billing/permissions/signature-verification code; flipping feature-flag defaults or retry/timeout constants; money/tax/HTTP-method/redirect changes; tightening or loosening a comparison operator; mixed diffs with a semantic line buried in formatting.
   When unsure, treat as non-trivial.

   otherwise pick lenses by where the new commits concentrate risk — **there's no fixed count**, same calibration as Review mode (1 lens for pure refactor / isolated fix; 2–3 for typical features; 4–5 for high-stakes subsystem touches; 6+ is a smell). lens framing follows Review mode: themed lenses (correctness & invariants, impact when new commits remove/rename/deprecate things, research-validated assumptions, security, user-journey, operational readiness, integration & cross-cutting, test integrity, performance, holistic) and subsystem lenses (auth, billing, schema migration, etc.) — for high-stakes domains lead with the subsystem lens rather than the generic themed equivalent.

   dispatch one \`${REVIEWER_AGENT_NAME}\` subagent per lens — its baked-in system prompt enforces the non-mutative + non-recursive contract (read-only file/search/web tools and read-only MCP queries; no writes, shell side effects, state-changing MCP calls, or nested subagent dispatch). dispatch them in a **single assistant turn with multiple parallel subagent calls** (serial dispatch collapses the fan-out). if a subagent errors out, times out, or returns nothing usable, retry once with the same lens; if it still fails, proceed with partial coverage and note the missing lens in the review body — do not skip step 5 entirely on a single subagent failure. each subagent gets:
   - the diff scope (incremental diff path if available, full diff otherwise). do NOT tell them to skip pre-existing issues — that suppresses regressions the new commits amplified; the "issues must be NEW" filter lives at aggregation time (step 6), not in the subagent prompt
   - **only one lens** — never a multi-section "review for X, Y, and Z" prompt
   - **a Task \`description\` set to the lens name** (e.g. \`"security"\`, \`"correctness"\`, \`"billing-subsystem"\`) — the harness reads this field to label the subagent's log lines so parallel runs can be told apart in CI output. without it, every subagent shows up as \`subagent#N\`.
   - the read-only contract restated in your dispatch instructions so the rule is present twice (the subagent's system prompt also enforces it). The test: would this call still be a no-op if reverted? If not (PR comments, branch pushes, issue updates, set_output, label changes, dependency installs, etc.), don't make it.
   - if the lens touches external contracts, instruct the subagent to verify load-bearing claims via web search and quote source URLs. action runs are non-interactive — there's no human to catch "I'm pretty sure Stripe does X."
   - ask the subagent to report findings with file paths and NEW line numbers from the full PR diff so you can anchor inline comments.

   delegation discipline:
   - do NOT lens-review the diff yourself in parallel with the subagents
   - do NOT summarize the changes for them (biases toward validation frame)
   - do NOT hand them a curated reading list (let them discover scope)
   - do NOT pre-shape their output with a finding schema
   - do NOT mention the other lenses (independence is the point)

6. **aggregate, draft, self-critique**: merge findings; de-dup overlaps; trace each finding yourself. drop praise, style preferences, speculative/unverified claims, findings about pre-existing code unrelated to the new commits, anything not actionable, and anything that re-states prior review feedback (heuristic: if the finding's root cause lives in lines the *new commits* added or modified, it's in scope; otherwise drop). also drop **bloat-shaped findings** — proposed fixes that would add defensive checks for cases that can't happen, abstractions used once, comments restating obvious code, tests asserting tautologies, or "just-in-case" guards. subagents are fallible and bias toward recommending changes; the bar for an actionable inline comment is sound + correct + elegant. recommending a change that improves only one of the three (or degrades elegance to nominally improve correctness) makes the codebase worse, not better. To compute "lines the new commits added or modified": if \`incrementalDiffPath\` from step 2 is present, use it directly. Otherwise, take the prior Pullfrog review's \`commit_id\` (returned alongside each entry from \`${t("list_pull_request_reviews")}\` in step 4) and run \`git diff <prior-review-sha>..HEAD\` to isolate the lines added since that review. draft inline comments with NEW line numbers from the full PR diff — every comment must be actionable, 2-3 sentences max.

7. **build the review body** — a single "Reviewed changes" section: summarize at the logical-change level, not per-file. each bullet starts with a past-tense verb (e.g. \`- Extracted shared CLI runtime into a single module\`, \`- Renamed package to pullfrog\`). avoid file paths unless they add clarity. if the changes can be described in one sentence, use one sentence — no bullets needed. do NOT include a separate "Prior review feedback" checklist; that's tracked in the rolling PR summary snapshot for the next agent run, and surfacing it in the user-facing body is noise (changes that addressed prior feedback are already covered by the Reviewed-changes bullets). in some cases you may receive a complete diff for the whole pull request instead of an incremental one — when this happens, you will need to determine what changes have happened since Pullfrog's most recent review.

8. Submit — every run must end with EXACTLY ONE of \`${t("create_pull_request_review")}\` (substantive review) or \`${t("report_progress")}\` (no-review acknowledgement). do NOT call \`create_issue_comment\` for review output.

   Same callout-intensity ladder as Review mode — \`[!CAUTION]\` (large red, "will break") → \`[!IMPORTANT]\` (large purple, "must address before merging") → \`[!NOTE]\` (small blue, "FYI") → no callout (plain text). And the same Fix-button lever: the footer renders a Fix button on every non-approving review, so \`approved: true\` suppresses it. Wrapping mergeable feedback in \`[!IMPORTANT]\` trains users to click Fix on reviews that don't need fixing — pick the tier the author's actual next action justifies.

   Follow these rules:
   - note: the first create_pull_request_review submission may error with a one-time diff-coverage nudge listing unread TOC regions. retry the same call to proceed — optionally after reading the listed ranges. the pre-flight will not block again this session.
   - IF NO NEW ISSUES, NON-SUBSTANTIVE CHANGES ONLY (trivial formatting, import reordering, comment tweaks): do NOT submit a review. Instead call \`${t("report_progress")}\` with a 1-2 sentence note explaining no review was warranted (e.g. "No new issues. Changes since last review are formatting-only."). this leaves a visible signal that the run completed.
   - ELSE IF NEW CRITICAL ISSUES (blocks merge — bugs, security, data loss, broken core flows): call \`${t("create_pull_request_review")}\` with \`approved: false\`, all comments, and the review body. body opens with \`> [!CAUTION]\\n> This PR introduces ...\`, then the Reviewed-changes summary.
   - ELSE IF NEW MUST-ADDRESS NON-CRITICAL FINDINGS (real consequences if shipped — incorrect behavior, missing validation, regressions the author should fix before merge): call \`${t("create_pull_request_review")}\` with \`approved: false\`, all comments, and the review body. body opens with \`> [!IMPORTANT]\\n> ...\`, then the Reviewed-changes summary. Do NOT use this tier for nits, style preferences, or "consider also" suggestions.
   - ELSE IF NEW MINOR SUGGESTIONS ONLY (single-line nits, doc/comment polish, defer-able observations, "rough edges"): call \`${t("create_pull_request_review")}\` with \`approved: false\`, all comments, and the review body. body opens directly with \`Reviewed the following changes:\\n\` (NO alert blockquote), then the Reviewed-changes summary.
   - ELSE IF INFORMATIONAL OBSERVATIONS (mergeable as-is, but worth surfacing — e.g. prior feedback addressed cleanly with one minor stale doc reference, or a noteworthy positive observation): call \`${t("create_pull_request_review")}\` with \`approved: true\`, NO inline comments, and the review body. body opens with \`> [!NOTE]\\n> ...\` alert, then the Reviewed-changes summary. If a point is concrete enough to anchor to a line, downgrade the whole review to "minor suggestions only" (\`approved: false\`) instead — \`[!NOTE]\` and inline comments don't mix.
   - ELSE IF NO NEW ISSUES, SUBSTANTIVE CHANGES (new functionality, behavior changes, or fixes to prior review feedback): call \`${t("create_pull_request_review")}\` to create a PR review. If all previous reviews have been properly addressed and no new issues were discovered, you can set \`approved: true\`. body opens with \`No new issues. Reviewed the following changes:\\n\`, then the Reviewed-changes summary.`,
    },
    {
      name: "Plan",
      description:
        "Create plans, break down tasks, outline steps, analyze requirements, understand scope of work, or provide task breakdowns",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. Analyze the task and gather context:
   - read AGENTS.md and relevant codebase files
   - understand the architecture and constraints

3. Produce a structured, actionable plan with clear milestones.

4. Call \`${t("report_progress")}\` with the plan.`,
    },
    {
      name: "Fix",
      description:
        "Fix CI failures; debug failing tests or builds; investigate and resolve check suite failures",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. Checkout the PR branch via \`${t("checkout_pr")}\`.

3. Fetch check suite logs via \`${t("get_check_suite_logs")}\`.

4. **CRITICAL**: verify the failure was INTRODUCED BY THIS PR before fixing. If unrelated, abort and report.

5. Diagnose and fix:
   - read the workflow file, reproduce locally with the EXACT same commands CI runs
   - fix the issue using your native file and shell tools
   - verify the fix by re-running the exact CI command
   - review the diff before committing — verify only the fix is present, no debug artifacts, no unrelated changes. the fix should be clean enough that a senior engineer would approve without hesitation.
   - commit locally via shell (\`git add . && git commit -m "..."\`)

6. Finalize:
   - confirm a clean working tree, then push via \`${t("push_branch")}\` (same push/prepush guidance as Build mode in *SYSTEM*)
   - call \`${t("report_progress")}\` with the diagnosis and fix summary (or the exact push error if push failed)`,
    },
    {
      name: "ResolveConflicts",
      description: "Resolve merge conflicts in a PR branch against the base branch",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. **Setup**:
   - Call \`${t("checkout_pr")}\` to get the PR branch.
   - Call \`${t("get_pull_request")}\` to identify the base branch (e.g., 'main').
   - Call \`${t("git_fetch")}\` to fetch the base branch.

3. **Merge Attempt**:
   - Run \`git merge origin/<base_branch>\` via shell.
   - If it succeeds automatically, confirm a clean working tree, push via \`${t("push_branch")}\` (same push/prepush guidance as Build mode in *SYSTEM*), and call \`${t("report_progress")}\` with a brief success note or the exact push error if push failed — **then stop; do not run steps 4–5.**
   - If it fails (conflicts), resolve them manually (continue to steps 4–5).

4. **Resolve Conflicts**:
   - Run \`git status\` or parse the merge output to find the list of conflicting files.
   - For each conflicting file: read it, find the conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`), understand the code context, and rewrite the file with the correct resolution. Remove all markers.
   - Verify the file syntax is correct after resolution.

5. **Finalize**:
   - Run a final verification (build/test) to ensure the resolution works.
   - \`git add . && git commit -m "resolve merge conflicts"\`
   - confirm a clean working tree, then push via \`${t("push_branch")}\` (same push/prepush guidance as Build mode in *SYSTEM*)
   - Call \`${t("report_progress")}\` with a summary of what was resolved (or the exact push error if push failed)`,
    },
    {
      name: "Task",
      description:
        "General-purpose tasks that don't fit other modes: answering questions, adding comments, labeling, running ad-hoc commands, or any direct request",
      prompt: `### Checklist

1. **task list**: create your task list for this run as your first action.

2. Analyze the task. For simple operations (labeling, commenting, answering questions, running a single command), handle directly.

3. For substantial work — code changes across multiple files, multi-step investigations:
   - plan your approach before starting
   - use native file and shell tools for local operations
   - use ${pullfrogMcpName} MCP tools for GitHub/git operations
   - if code changes are needed: review your own diff before committing — verify only intended changes are present, no debug artifacts remain, and the changes are clean enough that a senior engineer would approve without hesitation

4. Finalize:
   - if code changes were made, push to a pull request (new or existing) using \`${t("push_branch")}\` and \`${t("create_pull_request")}\` as needed. \`git status\` must be clean before you finish (see *SYSTEM* Git rules if push fails).
   - call \`${t("report_progress")}\` once with results — include exact tool errors if push or PR creation failed
   - if the task involved labeling, commenting, or other GitHub operations, perform those directly`,
    },
  ];
}

// static export for UI display — uses opencode format as the readable default
export const modes: Mode[] = computeModes("opencode");
