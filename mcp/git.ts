import { regex } from "arkregex";
import { type } from "arktype";
import { log } from "../utils/cli.ts";
import { $git } from "../utils/gitAuth.ts";
import { executeLifecycleHook } from "../utils/lifecycle.ts";
import { $ } from "../utils/shell.ts";
import type { StoredPushDest, ToolContext } from "./server.ts";
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

type ValidatePushParams = {
  branch: string;
  pushUrl: string;
  storedDest: StoredPushDest | undefined;
};

/**
 * validate that the push destination matches expected URL.
 * pushUrl is set by setupGit (base repo) and updated by checkout_pr (fork repo).
 */
function validatePushDestination(params: ValidatePushParams): PushDestination {
  const dest = getPushDestination(params.branch, params.storedDest);

  if (normalizeUrl(dest.url) !== normalizeUrl(params.pushUrl)) {
    throw new Error(
      `Push blocked: destination does not match expected repository.\n` +
        `Expected: ${params.pushUrl}\n` +
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

export function PushBranchTool(ctx: ToolContext) {
  const defaultBranch = ctx.repo.data.default_branch || "main";
  const pushPermission = ctx.payload.push;

  return tool({
    name: "push_branch",
    description:
      "Push the current branch to the remote repository. Omit branchName to push the current branch (recommended). " +
      "If specifying branchName, use the LOCAL branch name (e.g., 'pr-1'), not the remote branch name. " +
      "The correct remote and remote branch are determined automatically from branch config set by checkout_pr. " +
      "Never force push unless explicitly requested. Pushes to the default branch are blocked in restricted mode.",
    parameters: PushBranch,
    execute: execute(async ({ branchName, force }) => {
      // permission check
      if (pushPermission === "disabled") {
        throw new Error("Push is disabled. This repository is configured for read-only access.");
      }

      const branch = branchName || $("git", ["rev-parse", "--abbrev-ref", "HEAD"], { log: false });

      // reject push if working tree is dirty — forces agent to commit or discard before pushing
      const status = $("git", ["status", "--porcelain"], { log: false });
      if (status) {
        throw new Error(
          `push blocked: working tree has uncommitted changes. commit or discard them before pushing.\n\n` +
            `git status:\n${status}`
        );
      }

      // validate push destination matches expected URL
      const pushUrl = ctx.toolState.pushUrl;
      if (!pushUrl) {
        throw new Error("pushUrl not set - setupGit must run before push_branch");
      }
      const pushDest = validatePushDestination({
        branch,
        pushUrl,
        storedDest: ctx.toolState.pushDest,
      });

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

      await executeLifecycleHook({ event: "prepush", script: ctx.prepushScript });

      log.debug(`pushing ${branch} to ${pushDest.remoteName}/${pushDest.remoteBranch}`);
      if (force) {
        log.warning(`force pushing - this will overwrite remote history`);
      }

      try {
        await $git("push", pushArgs, {
          token: ctx.gitToken,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("fetch first") || msg.includes("non-fast-forward")) {
          throw new Error(
            `push rejected: the remote branch '${pushDest.remoteBranch}' has new commits you don't have locally.\n\n` +
              `to resolve this:\n` +
              `1. use git_fetch to fetch the remote branch: git_fetch({ ref: "${pushDest.remoteBranch}" })\n` +
              `2. use the git tool to rebase your changes: git({ subcommand: "rebase", args: ["origin/${pushDest.remoteBranch}"] })\n` +
              `3. resolve any merge conflicts if needed\n` +
              `4. retry push_branch`
          );
        }
        throw err;
      }

      return {
        success: true,
        branch,
        remoteBranch: pushDest.remoteBranch,
        remote: pushDest.remoteName,
        force,
        message: `successfully pushed ${branch} to ${pushDest.remoteName}/${pushDest.remoteBranch}`,
      };
    }),
  });
}

// commands that require authentication - redirect to dedicated tools
const AUTH_REQUIRED_REDIRECT: Record<string, string> = {
  push: "use the push_branch tool instead — it handles authentication and permission checks.",
  fetch: "use the git_fetch tool instead — it handles authentication.",
  pull: "use git_fetch to fetch the remote ref, then use this git tool with subcommand 'merge' or 'rebase' locally.",
  clone: "the repository is already cloned. use checkout_pr for PR branches.",
};

// SECURITY: subcommands blocked when shell is disabled.
// in disabled mode the agent has no shell access, so these subcommands are the
// primary escape vectors for arbitrary code execution. in restricted mode the
// agent already has shell in a stripped sandbox, so blocking these is redundant.
const NOSHELL_BLOCKED_SUBCOMMANDS: Record<string, string> = {
  config: "Blocked: git config can set up filter drivers or hooks that execute arbitrary code.",
  submodule:
    "Blocked: git submodule can reference malicious repositories and execute code on update.",
  "update-index":
    "Blocked: git update-index can modify index entries in ways that bypass file protections.",
  "filter-branch": "Blocked: git filter-branch executes arbitrary code on repository history.",
  replace: "Blocked: git replace can redirect object lookups.",
  // subcommands that accept --exec or similar flags for arbitrary code execution
  rebase: "Blocked: git rebase --exec can execute arbitrary shell commands.",
  bisect: "Blocked: git bisect run can execute arbitrary shell commands.",
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
// (avoids false positives like --exclude matching --exec)
const NOSHELL_BLOCKED_ARGS = ["--exec", "--extcmd", "--upload-pack", "--receive-pack"];

const COLLAPSE_THRESHOLD = 200;

// SECURITY: subcommand must match [a-z][a-z0-9-]* to reject flags passed as the subcommand.
// this blocks injection of global git options like -c, -C, --exec-path, --config-env, etc.
//
// critical attack: git -c "alias.x=!evil-command" x
//   -> sets alias "x" to a shell command via -c config injection, then runs it
//   -> achieves arbitrary code execution even with shell=disabled
const subcommandPattern = regex("^[a-z][a-z0-9-]*$");

const Git = type({
  subcommand: type(subcommandPattern).describe("Git subcommand (e.g., 'status', 'log', 'diff')"),
  args: type.string.array().describe("Additional arguments for the git command").optional(),
});

export function GitTool(ctx: ToolContext) {
  return tool({
    name: "git",
    description:
      "Run git commands. For push/fetch/pull, use the dedicated MCP tools instead (push_branch, git_fetch).",
    parameters: Git,
    execute: execute(async (params) => {
      const subcommand = params.subcommand;
      const args = params.args ?? [];

      const redirect = AUTH_REQUIRED_REDIRECT[subcommand];
      if (redirect) {
        throw new Error(`git ${subcommand} is not available through this tool — ${redirect}`);
      }

      // SECURITY: block dangerous subcommands when shell is disabled.
      // in restricted mode the agent has shell in a stripped sandbox, so blocking
      // these through the MCP tool is redundant (agent can do it via shell).
      if (ctx.payload.shell === "disabled") {
        const blocked = NOSHELL_BLOCKED_SUBCOMMANDS[subcommand];
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

      const output = $("git", [subcommand, ...args], { log: false });
      const lineCount = output.split("\n").length;
      if (lineCount > COLLAPSE_THRESHOLD) {
        log.group(`git ${subcommand} output (${lineCount} lines)`, () => {
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
    description: "Fetch refs from remote repository. Use this instead of git fetch directly.",
    parameters: GitFetch,
    execute: execute(async (params) => {
      const fetchArgs = ["--no-tags", "origin", params.ref];
      if (params.depth !== undefined) {
        fetchArgs.push(`--depth=${params.depth}`);
      }
      await $git("fetch", fetchArgs, {
        token: ctx.gitToken,
      });
      return { success: true, ref: params.ref };
    }),
  });
}

const DeleteBranch = type({
  branchName: type.string.describe("Remote branch to delete"),
});

export function DeleteBranchTool(ctx: ToolContext) {
  const pushPermission = ctx.payload.push;

  return tool({
    name: "delete_branch",
    description: "Delete a remote branch. Requires push: enabled permission.",
    parameters: DeleteBranch,
    execute: execute(async (params) => {
      if (pushPermission !== "enabled") {
        throw new Error(
          "Branch deletion requires push: enabled permission. " +
            "Current mode only allows pushing to non-protected branches."
        );
      }

      await $git("push", ["origin", "--delete", params.branchName], {
        token: ctx.gitToken,
      });
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

      const pushArgs = [...(params.force ? ["-f"] : []), "origin", `refs/tags/${params.tag}`];
      await $git("push", pushArgs, {
        token: ctx.gitToken,
      });
      return { success: true, tag: params.tag };
    }),
  });
}
