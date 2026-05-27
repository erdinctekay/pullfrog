import { regex } from "arkregex";
import { type } from "arktype";
import type { StoredPushDest } from "../toolState.ts";
import { log } from "../utils/cli.ts";
import { $git, $gitFetchWithDeepen } from "../utils/gitAuth.ts";
import { executeLifecycleHook, type LifecycleHookFailure } from "../utils/lifecycle.ts";
import { $ } from "../utils/shell.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

type PushDestination = {
  remoteName: string;
  remoteBranch: string;
  url: string;
};

/**
 * get where git would actually push this branch.
 * prefers the stored destination from toolState (set by checkout_pr) when it
 * matches the current branch, because git config reads can silently fail in
 * certain environments causing pushes to the wrong remote branch.
 *
 * falls back to reading branch.X.pushRemote and branch.X.merge from git config,
 * and finally to origin/<branch> for branches created without checkout_pr.
 */
function getPushDestination(
  branch: string,
  storedDest: StoredPushDest | undefined
): PushDestination {
  // prefer stored destination from checkout_pr when it matches the current branch
  if (storedDest && storedDest.localBranch === branch) {
    log.debug(`using stored push destination: ${storedDest.remoteName}/${storedDest.remoteBranch}`);
    const url = $("git", ["remote", "get-url", "--push", storedDest.remoteName], {
      log: false,
    }).trim();
    return { remoteName: storedDest.remoteName, remoteBranch: storedDest.remoteBranch, url };
  }

  // fall back to git config (for branches not created by checkout_pr)
  try {
    const pushRemote = $("git", ["config", `branch.${branch}.pushRemote`], { log: false }).trim();
    const merge = $("git", ["config", `branch.${branch}.merge`], { log: false }).trim();
    const remoteBranch = merge.replace(/^refs\/heads\//, "");
    const url = $("git", ["remote", "get-url", "--push", pushRemote], { log: false }).trim();
    return { remoteName: pushRemote, remoteBranch, url };
  } catch {
    // no push config - branch was created locally without checkout_pr
    log.debug(`no push config for ${branch}, falling back to origin/${branch}`);
    const url = $("git", ["remote", "get-url", "--push", "origin"], { log: false }).trim();
    return { remoteName: "origin", remoteBranch: branch, url };
  }
}

/**
 * normalize URL for comparison (handle .git suffix, case)
 */
function normalizeUrl(url: string): string {
  return url.replace(/\.git$/, "").toLowerCase();
}

// SECURITY: reject refs/branch names that begin with "-". git's parseopt
// accepts options intermixed with positional args, so a ref like
// "--upload-pack=evil" could be interpreted as a flag rather than a refspec.
export function rejectIfLeadingDash(value: string, kind: string): void {
  if (value.startsWith("-")) {
    throw new Error(`Blocked: ${kind} '${value}' starts with '-' — git could parse it as a flag.`);
  }
}

// SECURITY: branch inputs to push/delete must be bare branch names. a branch
// name like "refs/heads/main" bypasses the restricted-mode default-branch
// check below (which does exact-string compare against "main"), and symbolic
// refs (HEAD / FETCH_HEAD / ORIG_HEAD / MERGE_HEAD) would resolve to
// whatever commit those refs point at — both routes let an agent push to
// protected branches even under push: restricted. checkout_pr only ever
// stores bare names like "pr-123", so nothing legitimate relies on the
// refs/... form here.
const SYMBOLIC_REFS = new Set(["HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD"]);
export function rejectSpecialRef(value: string, kind: string): void {
  rejectIfLeadingDash(value, kind);
  if (value.startsWith("refs/")) {
    throw new Error(
      `Blocked: ${kind} '${value}' is a fully-qualified ref path. Use a bare branch name (e.g. 'feature/foo' or 'main'), not a 'refs/heads/...' form.`
    );
  }
  if (SYMBOLIC_REFS.has(value)) {
    throw new Error(
      `Blocked: ${kind} '${value}' is a git symbolic ref, not a branch name. Pass the resolved branch name (e.g. 'main'), or omit branchName to push the current branch.`
    );
  }
  // SECURITY: git interprets ':' and leading '+' as refspec syntax, not as
  // part of a branch name. without this check, an agent under push:restricted
  // can smuggle a full refspec through branchName:
  //   - "evil:refs/heads/main"  → pushes local 'evil' to remote main
  //   - ":refs/heads/main"      → deletes remote main
  //   - ":other"                → deletes remote 'other' under push:restricted
  //   - "+main"                 → force-push refspec
  // the default-branch guard downstream is an exact-string compare, so any
  // character that lets git parse the value as <src>:<dst> (or as a force
  // prefix) bypasses it. git's own check-ref-format forbids ':', '+', '^',
  // '~', '?', '*', '[', '\\', and whitespace in branch names, so rejecting
  // them here cannot false-positive against a legitimate branch name.
  const BAD = /[:+^~?*[\\\s]/;
  const badMatch = value.match(BAD);
  if (badMatch) {
    throw new Error(
      `Blocked: ${kind} '${value}' contains '${badMatch[0]}', which git interprets as refspec/revision syntax, not as part of a branch name.`
    );
  }
}

// SECURITY: validate tag names so the push_tags refspec can't be split into
// a <src>:<dst> refspec that targets a non-tag ref. without this, a tag like
// "foo:refs/heads/main" becomes "refs/tags/foo:refs/heads/main" and git
// pushes the local tag's commit to remote main — a back door around the
// branch-push rules in push_branch. keep the allow-list conservative (git's
// own check-ref-format forbids far more, but we only need enough to block
// refspec injection).
export function validateTagName(tag: string): void {
  rejectIfLeadingDash(tag, "tag");
  if (!/^[A-Za-z0-9._/-]+$/.test(tag)) {
    throw new Error(
      `Blocked: tag '${tag}' contains characters that could be parsed as a refspec or flag. Tags must match [A-Za-z0-9._/-]+.`
    );
  }
}

/**
 * validate that the push destination matches expected URL.
 * pushUrl is set by setupGit (base repo) and updated by checkout_pr (fork repo).
 */
function validatePushDestination(ctx: ToolContext, branch: string): PushDestination {
  const pushUrl = ctx.toolState.pushUrl;
  if (!pushUrl) throw new Error("pushUrl not set - setupGit must run before push_branch");

  const dest = getPushDestination(branch, ctx.toolState.pushDest);

  if (normalizeUrl(dest.url) !== normalizeUrl(pushUrl)) {
    throw new Error(
      `Push blocked: destination does not match expected repository.\n` +
        `Expected: ${pushUrl}\n` +
        `Actual: ${dest.url}\n` +
        `Git configuration may have been tampered with.`
    );
  }

  return dest;
}

export const PushBranch = type({
  branchName: type.string
    .describe("The branch name to push (defaults to current branch)")
    .optional(),
  force: type.boolean.describe("Force push (use with caution)").default(false),
});

// classify an error from `$git("push", ...)` to decide retry vs. recovery
// vs. rethrow. exported for tests.
//
// - `concurrent-push`: server-side compare-and-swap failed because the ref
//   advanced between fetch and push. recovery is fetch + integrate + retry.
//   matches both the client-side detection (`fetch first` /
//   `non-fast-forward`) and the server-side detection (`cannot lock ref`
//   with `is at <SHA1> but expected <SHA2>`).
// - `transient`: network or upstream server hiccup (RPC failed mid-stream,
//   HTTP 5xx, early EOF, reset, timeout, dns flake). push is idempotent so
//   verbatim retry with backoff is safe.
// - `unknown`: anything else (including auth/permission/protected-branch
//   rejections). retrying these wastes time; surface to the caller.
//
// kept conservative: a misclassification of `unknown` -> `transient` would
// cause two extra round-trips on a permanently-failing push, while the
// reverse (true transient labeled `unknown`) just falls back to current
// behavior. so we only mark as transient when the error string is
// unambiguously a network/server-side fault, not a refusal.
export type PushErrorKind = "concurrent-push" | "transient" | "unknown";

const CONCURRENT_PUSH_PATTERNS = ["fetch first", "non-fast-forward", "cannot lock ref"] as const;

const TRANSIENT_PATTERNS: RegExp[] = [
  /RPC failed/i,
  /early EOF/,
  /the remote end hung up unexpectedly/,
  /Connection reset/i,
  /Could not resolve host/i,
  /Operation timed out/i,
  /HTTP\/2 stream \d+ was not closed cleanly/i,
  /unexpected disconnect while reading sideband packet/i,
  // libcurl HTTP 5xx surfaced by git over https. matches both the
  // libcurl-style "The requested URL returned error: 502" and the more
  // recent "HTTP 502" wording. most 4xx is intentionally excluded —
  // 401/403/404 indicate auth/permission problems that are not
  // retry-safe — but 429 (rate-limited / abuse detection) IS retry-safe
  // and GitHub occasionally surfaces it on git push, so it's included
  // explicitly below.
  /HTTP 5\d\d/,
  /returned error: 5\d\d/i,
  /HTTP 429/,
  /returned error: 429/i,
  // github installation tokens can 401 for seconds after minting while
  // replicating (@octokit/auth-app retries the same class). git push
  // surfaces it as "Invalid username or token", distinct from 403
  // permission denied — safe to backoff-retry with the same token.
  /Invalid username or token/,
  /Authentication failed for 'https:\/\/github\.com\//,
];

export function classifyPushError(msg: string): PushErrorKind {
  if (CONCURRENT_PUSH_PATTERNS.some((p) => msg.includes(p))) return "concurrent-push";
  if (TRANSIENT_PATTERNS.some((p) => p.test(msg))) return "transient";
  return "unknown";
}

// backoff delays before retry attempts 2 and 3. attempt 1 is the original
// push. total worst-case added latency: ~7s. small enough that the agent
// rarely notices, large enough to ride out most upstream hiccups.
const TRANSIENT_RETRY_DELAYS_MS = [2000, 5000];

export function PushBranchTool(ctx: ToolContext) {
  const defaultBranch = ctx.repo.data.default_branch || "main";
  const pushPermission = ctx.payload.push;

  return tool({
    name: "push_branch",
    description:
      "Push the current branch to the remote repository. Omit branchName to push the current branch (recommended). " +
      'Example: `push_branch({})` to push the current branch. Example: `push_branch({ branchName: "pr-1" })` to push a specific local branch. ' +
      "If specifying branchName, use the LOCAL branch name (e.g., 'pr-1'), not the remote branch name. " +
      "The correct remote and remote branch are determined automatically from branch config set by checkout_pr. " +
      "Requires a clean working tree. Runs the repository prepush hook (if configured) — best-effort. If the hook fails, the tool returns the failure output and every subsequent call this run skips the hook. " +
      "Never force push unless explicitly requested. Pushes to the default branch are blocked in restricted mode. " +
      "If the response reports a timeout, the underlying push may have actually succeeded — verify with `git log origin/<branch>` (or this tool with command 'log') before retrying, otherwise you'll push a duplicate.",
    parameters: PushBranch,
    execute: execute(async ({ branchName, force }) => {
      // permission check
      if (pushPermission === "disabled") {
        throw new Error("Push is disabled. This repository is configured for read-only access.");
      }

      const branch = branchName || $("git", ["rev-parse", "--abbrev-ref", "HEAD"], { log: false });
      // check the resolved branch too — rev-parse could surface a weird current
      // branch name that would otherwise bypass the user-facing check. use
      // rejectSpecialRef so "refs/heads/main" and symbolic refs like HEAD
      // can't slip past the default-branch guard below.
      rejectSpecialRef(branch, "branch");

      // reject push if working tree is dirty — forces agent to commit or discard before pushing
      const status = $("git", ["status", "--porcelain"], { log: false });
      if (status) {
        throw new Error(
          `push blocked: working tree is not clean (tracked changes and/or untracked files). commit, discard, or remove stray artifacts before pushing.\n\n` +
            `git status:\n${status}` +
            (ctx.toolState.prepushFailureCount > 0
              ? "\n\nnote: the prepush hook failed earlier this run — once the working tree is clean, push_branch will skip the hook."
              : "")
        );
      }

      // validate push destination matches expected URL
      const pushDest = validatePushDestination(ctx, branch);

      // backstop against subagent-induced cross-PR clobbers: a subagent
      // shares cwd + toolState with the orchestrator, so its `checkout_pr(N)`
      // moves HEAD to pr-N and persists pushDest pointing at the foreign
      // PR's remote branch. refuse pr-N → origin/<other> pushes unless this
      // run is itself scoped to PR N (zed-industries/cloud, 2026-05-18).
      const prBranchMatch = branch.match(/^pr-(\d+)$/);
      if (prBranchMatch && pushDest.remoteBranch !== branch) {
        const prNumber = Number(prBranchMatch[1]);
        const event = ctx.payload.event;
        const runScoped = event.is_pr === true && event.issue_number === prNumber;
        if (!runScoped) {
          throw new Error(
            `push blocked: local branch '${branch}' would push to '${pushDest.remoteName}/${pushDest.remoteBranch}', ` +
              `but this run is not scoped to PR #${prNumber}. ` +
              `the 'pr-${prNumber}' branch was created by a prior checkout_pr call (likely from a subagent — subagents share the working tree and toolState with the orchestrator). ` +
              `you have probably landed your commit on the wrong branch. ` +
              `switch to your own feature branch first (e.g. 'git checkout <feature-branch>') and then push. ` +
              `if the push to PR #${prNumber} is intentional, this run needs to be triggered against that PR.`
          );
        }
      }

      // block pushes to default branch in restricted mode
      if (pushPermission === "restricted" && pushDest.remoteBranch === defaultBranch) {
        throw new Error(
          `Push blocked: cannot push directly to default branch '${pushDest.remoteBranch}'. ` +
            `Create a feature branch and open a PR instead.`
        );
      }

      // use refspec when local and remote branch names differ
      const refspec =
        branch === pushDest.remoteBranch ? branch : `${branch}:${pushDest.remoteBranch}`;
      const pushArgs = force
        ? ["--force", "-u", pushDest.remoteName, refspec]
        : ["-u", pushDest.remoteName, refspec];

      const prepushSkipped = ctx.toolState.prepushFailureCount > 0;
      if (prepushSkipped) {
        log.info(`» skipping prepush hook (failed earlier this run)`);
      } else if (ctx.prepushScript) {
        const prepushHook = await executeLifecycleHook({
          event: "prepush",
          script: ctx.prepushScript,
        });
        if (prepushHook.failure) {
          ctx.toolState.prepushFailureCount += 1;
          throw new Error(buildPrepushFailureMessage(prepushHook.failure, ctx.payload.shell));
        }

        // re-verify clean working tree after prepush. a hook that writes tracked
        // files (formatter, type generator, build artifacts) would leave those
        // changes uncommitted — pushing now would silently drop them, and the
        // agent would report a "successful push" of code the hook had expected
        // to be included.
        const postHookStatus = $("git", ["status", "--porcelain"], { log: false });
        if (postHookStatus) {
          throw new Error(
            `push blocked: the prepush hook modified the working tree. those changes are not included in the push. commit or discard them (or change the hook to not mutate tracked files) before retrying.\n\n` +
              `git status:\n${postHookStatus}`
          );
        }
      }

      log.debug(`pushing ${branch} to ${pushDest.remoteName}/${pushDest.remoteBranch}`);
      if (force) {
        log.warning(`force pushing - this will overwrite remote history`);
      }

      // retry transient network/server errors (RPC failed, early EOF, 5xx,
      // connection reset, etc) with backoff. push is idempotent: if the remote
      // never received the pack, retry creates the ref; if it did, the retry
      // is a no-op fast-forward to the same SHA. concurrent-push rejections
      // and permission errors are NOT retried — they need user intervention.
      let lastErr: unknown;
      let pushed = false;
      for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt++) {
        try {
          await $git("push", pushArgs, {
            token: ctx.gitToken,
          });
          if (attempt > 0) {
            log.info(`push succeeded on attempt ${attempt + 1}`);
          }
          pushed = true;
          break;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          const kind = classifyPushError(msg);

          if (kind === "concurrent-push") {
            // git rebase is blocked through the MCP tool when shell is disabled
            // (rebase --exec can execute arbitrary code). merge always works and
            // integrates remote changes cleanly, so suggest it as the default.
            const integrateStep =
              ctx.payload.shell === "disabled"
                ? `2. use the git tool to merge the remote branch into yours: git({ command: "merge", args: ["origin/${pushDest.remoteBranch}"] })`
                : `2. use the git tool to rebase or merge your changes on top: git({ command: "merge", args: ["origin/${pushDest.remoteBranch}"] }) (or 'rebase')`;
            throw new Error(
              `push rejected: the remote branch '${pushDest.remoteBranch}' has new commits you don't have locally (often a concurrent push to the same branch).\n\n` +
                `to resolve this:\n` +
                `1. use git_fetch to fetch the remote branch: git_fetch({ ref: "${pushDest.remoteBranch}" })\n` +
                `${integrateStep}\n` +
                `3. resolve any merge conflicts if needed\n` +
                `4. retry push_branch`
            );
          }

          if (kind === "transient" && attempt < TRANSIENT_RETRY_DELAYS_MS.length) {
            // jitter avoids lockstep retries when several agents are hit by the
            // same upstream blip simultaneously — without it, all retries land
            // on the same recovering server at the same instant.
            const baseDelay = TRANSIENT_RETRY_DELAYS_MS[attempt] ?? 5000;
            const delay = Math.round(baseDelay * (0.75 + Math.random() * 0.5));
            log.info(
              `push attempt ${attempt + 1} failed (transient), retrying in ${delay}ms: ${msg.slice(0, 300)}`
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }

          throw err;
        }
      }
      if (!pushed) {
        // safety net — loop should always either break with success or throw.
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      }

      const pushedSha = $("git", ["rev-parse", "HEAD"], { log: false }).trim();
      log.info(
        `» pushed branch ${branch} to ${pushDest.remoteName}/${pushDest.remoteBranch} (sha ${pushedSha})`
      );

      const baseMsg = `successfully pushed ${branch} to ${pushDest.remoteName}/${pushDest.remoteBranch}`;
      const message = prepushSkipped
        ? `${baseMsg} (prepush hook skipped — failed earlier this run).`
        : baseMsg;

      return {
        success: true,
        branch,
        remoteBranch: pushDest.remoteBranch,
        remote: pushDest.remoteName,
        force,
        prepushSkipped,
        message,
      };
    }),
  });
}

/** agent-facing prepush failure message: script output + bypass guidance,
 * with no generic lifecycle retry advice (which would conflict). */
function buildPrepushFailureMessage(
  failure: LifecycleHookFailure,
  shell: ToolContext["payload"]["shell"]
): string {
  const header =
    failure.kind === "exit"
      ? `prepush hook failed with exit code ${failure.exitCode}.\n\nscript output:\n${failure.output || "(empty)"}`
      : failure.kind === "timeout"
        ? `prepush hook timed out — the script is hung or doing too much work.`
        : `prepush hook failed to spawn: ${failure.spawnError}.`;

  const ifRealBug =
    shell === "disabled"
      ? `fix it before pushing again — shell access is disabled in this run, so you can't re-run the hook command yourself.`
      : `run the hook command yourself via the shell tool to iterate (push_branch will NOT re-run it).`;

  return (
    `${header}\n\n` +
    `this repo's prepush hook is best-effort: the next push_branch call will SKIP the hook and proceed. ` +
    `if the failure is unrelated to your changes (pre-existing breakage, flaky check), just call push_branch again. ` +
    `if it could be a real bug in your code, ${ifRealBug}`
  );
}

// commands that require authentication - redirect to dedicated tools.
// exported so tests can exercise the same table the runtime uses.
//
// note: the `pull` redirect intentionally does not mention `rebase` — under
// shell=disabled rebase is itself blocked by NOSHELL_BLOCKED_SUBCOMMANDS, so
// advertising it here would just send the agent into a second block. agents
// under shell=restricted/enabled who prefer rebase can invoke it directly;
// the redirect's job is to name the canonical alternative (merge), which
// works in all modes.
export const AUTH_REQUIRED_REDIRECT: Record<string, string> = {
  push: "use the push_branch tool instead — it handles authentication and permission checks.",
  fetch: "use the git_fetch tool instead — it handles authentication.",
  pull: "use git_fetch to fetch the remote ref, then call this git tool with command 'merge' locally.",
  clone: "the repository is already cloned. use checkout_pr for PR branches.",
};

// SECURITY: subcommands blocked when shell is disabled.
// in disabled mode the agent has no shell access, so these subcommands are the
// primary escape vectors for arbitrary code execution. in restricted mode the
// agent already has shell in a stripped sandbox, so blocking these is redundant.
// exported so tests stay in sync with the runtime table.
export const NOSHELL_BLOCKED_SUBCOMMANDS: Record<string, string> = {
  config: "Blocked: git config can set up filter drivers or hooks that execute arbitrary code.",
  submodule:
    "Blocked: git submodule can reference malicious repositories and execute code on update.",
  "update-index":
    "Blocked: git update-index can modify index entries in ways that bypass file protections.",
  "filter-branch": "Blocked: git filter-branch executes arbitrary code on repository history.",
  replace: "Blocked: git replace can redirect object lookups.",
  // subcommands that accept --exec or similar flags for arbitrary code execution
  rebase:
    "Blocked: git rebase --exec can execute arbitrary shell commands. Use 'merge' instead to integrate remote changes.",
  bisect:
    "Blocked: git bisect run can execute arbitrary shell commands. Bisect by hand (bisect start/good/bad/reset) is not available through this tool either — ask the user to run the bisect if needed.",
  // difftool/mergetool exist to shell out to external diff/merge programs.
  // both accept `--extcmd` / `-x` (difftool) or configured tool commands
  // (mergetool) that run arbitrary code. NOSHELL_BLOCKED_ARGS catches the
  // long `--extcmd` form, but not the `-x` short form — and globally blocking
  // `-x` would false-positive on `git cherry-pick -x`. block the subcommands
  // wholesale instead; neither has a meaningful use in an automated agent
  // workflow (agents use `git diff` / `git show` for diffs and resolve
  // conflicts via file edits, not a TUI merge tool).
  difftool:
    "Blocked: git difftool runs an external diff program via --extcmd/-x or configured tool and can execute arbitrary shell commands. Use 'diff' (or 'show' for single commits) to inspect changes — those output directly and don't invoke an external tool.",
  mergetool:
    "Blocked: git mergetool runs an external merge program configured via mergetool.<name>.cmd and can execute arbitrary shell commands. Resolve conflicts by editing the files directly (conflict markers are written into the working tree) and then commit.",
};

// SECURITY: subcommand-specific arg flags that execute code.
// only blocked when shell is disabled — in restricted mode the agent already
// has shell access in a stripped sandbox, so these provide no additional security.
//
// NOTE: global git flags like -c and --config-env are NOT included here
// because they only work before the subcommand. in the MCP tool, the
// subcommand is always first, so -c in args is parsed as a subcommand flag
// (e.g., git log -c = combined diff format), not config injection.
// the subcommand check (rejecting "-" prefix) already blocks that attack.
//
// matched as: arg === flag OR arg starts with flag + "="
// (avoids false positives like --exclude matching --exec).
// exported so tests stay in sync with the runtime flag set.
export const NOSHELL_BLOCKED_ARGS = ["--exec", "--extcmd", "--upload-pack", "--receive-pack"];

const COLLAPSE_THRESHOLD = 200;

// SECURITY: subcommand must match [a-z][a-z0-9-]* to reject flags passed as the subcommand.
// this blocks injection of global git options like -c, -C, --exec-path, --config-env, etc.
//
// critical attack: git -c "alias.x=!evil-command" x
//   -> sets alias "x" to a shell command via -c config injection, then runs it
//   -> achieves arbitrary code execution even with shell=disabled
const subcommandPattern = regex("^[a-z][a-z0-9-]*$");

const Git = type({
  command: type(subcommandPattern).describe("Git command (e.g., 'status', 'log', 'diff')"),
  args: type.string.array().describe("Additional arguments for the git command").optional(),
});

export function GitTool(ctx: ToolContext) {
  return tool({
    name: "git",
    description:
      "Run a git subcommand. `command` is the subcommand ONLY — never repeat it inside `args`. " +
      "`args` is optional; omit it entirely for no-flag invocations like plain `git status`. " +
      'Example: `git({ command: "status" })` for plain `git status`. ' +
      'Example: `git({ command: "log", args: ["--oneline", "-n", "20"] })`. ' +
      'Example: `git({ command: "diff", args: ["origin/main..HEAD"] })`. ' +
      "For push/fetch, use the dedicated MCP tools (push_branch, git_fetch). " +
      "git pull is not available — use git_fetch then this tool with command 'merge'.",
    parameters: Git,
    execute: execute(async (params) => {
      const command = params.command;
      const args = params.args ?? [];

      // guard: {command:"status",args:["status"]} → `git status status`, where
      // git silently treats args[0] as a pathspec. when nothing matches the
      // path, status prints "nothing to commit, working tree clean" even on a
      // dirty tree — a real model failure mode that burned a ~$3 run before
      // self-correction. generalises to every subcommand (`diff diff`,
      // `log log`, etc.).
      if (args[0]?.toLowerCase() === command.toLowerCase()) {
        throw new Error(
          `git ${command}: '${args[0]}' duplicates the subcommand — drop args[0] ` +
            `(the subcommand only belongs in 'command'). git would otherwise parse it as ` +
            `a pathspec and silently return empty/clean output when nothing matches. ` +
            `if you really meant a pathspec named '${args[0]}', use args: ["--", "${args[0]}"].`
        );
      }

      const redirect = AUTH_REQUIRED_REDIRECT[command];
      if (redirect) {
        throw new Error(`git ${command} is not available through this tool — ${redirect}`);
      }

      // SECURITY: block dangerous subcommands when shell is disabled.
      // in restricted mode the agent has shell in a stripped sandbox, so blocking
      // these through the MCP tool is redundant (agent can do it via shell).
      if (ctx.payload.shell === "disabled") {
        const blocked = NOSHELL_BLOCKED_SUBCOMMANDS[command];
        if (blocked) {
          throw new Error(blocked);
        }

        // block subcommand-specific flags that execute arbitrary code
        for (const arg of args) {
          const isBlocked = NOSHELL_BLOCKED_ARGS.some(
            (flag) => arg === flag || arg.startsWith(flag + "=")
          );
          if (isBlocked) {
            throw new Error(
              `Blocked: '${arg}' flag can execute arbitrary code and is not allowed.`
            );
          }
        }
      }

      // `git merge-base --is-ancestor` uses exit codes as data: 0 = ancestor,
      // 1 = not-an-ancestor, >1 = real error. Surface the binary answer
      // instead of throwing on exit 1. see #766.
      if (command === "merge-base" && args.includes("--is-ancestor")) {
        let isAncestor = true;
        $("git", [command, ...args], {
          log: false,
          onError: (r) => {
            if (r.status === 1) {
              isAncestor = false;
              return;
            }
            const detail = [r.stderr, r.stdout]
              .map((s) => s.trim())
              .filter(Boolean)
              .join("\n");
            throw new Error(
              `git merge-base --is-ancestor failed (exit ${r.status}): ${detail || "Unknown error"}`
            );
          },
        });
        return { success: true, isAncestor };
      }

      const output = $("git", [command, ...args], { log: false });
      const lineCount = output.split("\n").length;
      if (lineCount > COLLAPSE_THRESHOLD) {
        log.group(`git ${command} output (${lineCount} lines)`, () => {
          log.info(output);
        });
      } else if (output) {
        log.info(output);
      }

      return { success: true, output };
    }),
  });
}

const GitFetch = type({
  ref: type.string.describe("Ref to fetch: branch name, tag, or 'pull/N/head' for PRs"),
  depth: type.number.describe("Fetch depth (for shallow clones)").optional(),
});

export function GitFetchTool(ctx: ToolContext) {
  return tool({
    name: "git_fetch",
    description:
      "Fetch refs from remote repository. Use this instead of git fetch directly. " +
      'Example: `git_fetch({ ref: "main" })`. With depth: `git_fetch({ ref: "pull/1234/head", depth: 1 })`.',
    parameters: GitFetch,
    execute: execute(async (params) => {
      rejectIfLeadingDash(params.ref, "ref");
      const fetchArgs = ["--no-tags", "origin", params.ref];
      if (params.depth !== undefined) {
        fetchArgs.push(`--depth=${params.depth}`);
      }
      await $gitFetchWithDeepen(fetchArgs, { token: ctx.gitToken }, "git_fetch");
      return { success: true, ref: params.ref };
    }),
  });
}

const DeleteBranch = type({
  branchName: type.string.describe("Remote branch to delete"),
});

export function DeleteBranchTool(ctx: ToolContext) {
  const pushPermission = ctx.payload.push;
  const defaultBranch = ctx.repo.data.default_branch || "main";

  return tool({
    name: "delete_branch",
    description:
      "Delete a remote branch. Requires push: enabled permission. " +
      "Deletion of the repository's default branch is always blocked regardless of permission mode.",
    parameters: DeleteBranch,
    execute: execute(async (params) => {
      if (pushPermission !== "enabled") {
        throw new Error(
          "Branch deletion requires push: enabled permission. " +
            "Current mode only allows pushing to non-protected branches."
        );
      }

      // delete_branch is already gated on push: enabled, but also block the
      // refs/heads/... and symbolic-ref forms so this tool can't be tricked
      // into deleting a protected ref that wouldn't match a bare-name check.
      rejectSpecialRef(params.branchName, "branchName");

      // defense-in-depth: deleting the default branch is catastrophic and
      // unlike pushing to main it has no easy revert path (GitHub retains
      // refs for 30 days but restoring requires the reflog or a direct SHA).
      // push: enabled authorizes pushes, not wholesale removal of the
      // repository's primary branch. block it locally even if GitHub branch
      // protection would also reject — some repos disable protection on
      // default branches and we should not rely on that config for safety.
      if (params.branchName === defaultBranch) {
        throw new Error(
          `Blocked: cannot delete the default branch '${defaultBranch}'. ` +
            `If you really need to delete or rename it, do it manually via the repository settings.`
        );
      }

      // use refs/heads/<name> explicitly so a same-named tag can't be deleted
      // by accident. `push --delete <bare-name>` resolves against both remote
      // branches and tags; a tag-only match would silently remove the tag.
      // rejectSpecialRef guarantees branchName is a bare name, so the
      // branchName construction here can't collide with user-supplied refs.
      await $git("push", ["origin", "--delete", `refs/heads/${params.branchName}`], {
        token: ctx.gitToken,
      });
      log.info(`» deleted branch ${params.branchName}`);
      return { success: true, deleted: params.branchName };
    }),
  });
}

const PushTags = type({
  tag: type.string.describe("Tag name to push"),
  force: type.boolean.describe("Force push the tag").default(false),
});

export function PushTagsTool(ctx: ToolContext) {
  const pushPermission = ctx.payload.push;

  return tool({
    name: "push_tags",
    description: "Push a tag to remote. Requires push: enabled permission.",
    parameters: PushTags,
    execute: execute(async (params) => {
      if (pushPermission !== "enabled") {
        throw new Error(
          "Tag pushing requires push: enabled permission. " +
            "Current mode only allows pushing branches."
        );
      }

      validateTagName(params.tag);
      const pushArgs = [...(params.force ? ["-f"] : []), "origin", `refs/tags/${params.tag}`];
      await $git("push", pushArgs, {
        token: ctx.gitToken,
      });
      log.info(`» pushed tag ${params.tag}`);
      return { success: true, tag: params.tag };
    }),
  });
}
