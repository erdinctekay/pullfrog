import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Octokit, RestEndpointMethodTypes } from "@octokit/rest";
import { type } from "arktype";
import { log } from "../utils/cli.ts";
import { $git } from "../utils/gitAuth.ts";
import { executeLifecycleHook } from "../utils/lifecycle.ts";
import { computeIncrementalDiff } from "../utils/rangeDiff.ts";
import { $ } from "../utils/shell.ts";
import type { ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";

type PullFile = RestEndpointMethodTypes["pulls"]["listFiles"]["response"]["data"][number];

export type FormatFilesResult = {
  content: string;
  toc: string;
};

/**
 * formats PR files with explicit line numbers for each code line.
 * preserves all original diff info (file headers, hunk headers) and adds:
 * | OLD | NEW | TYPE | code
 * returns both the formatted content and a TOC with line ranges per file.
 */
export function formatFilesWithLineNumbers(files: PullFile[]): FormatFilesResult {
  const output: string[] = [];
  const tocEntries: Array<{ filename: string; startLine: number; endLine: number }> = [];

  // calculate TOC header size: "## Files (N)\n" + N entries + "\n---\n\n"
  const tocHeaderSize = 1 + files.length + 2;
  let currentLine = tocHeaderSize + 1;

  for (const file of files) {
    const fileStartLine = currentLine;

    // file header
    output.push(`diff --git a/${file.filename} b/${file.filename}`);
    output.push(`--- a/${file.filename}`);
    output.push(`+++ b/${file.filename}`);
    currentLine += 3;

    if (!file.patch) {
      output.push("(binary file or no changes)");
      output.push("");
      currentLine += 2;
      tocEntries.push({
        filename: file.filename,
        startLine: fileStartLine,
        endLine: currentLine - 1,
      });
      continue;
    }

    // parse and format the patch with line numbers
    const lines = file.patch.split("\n");
    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
      // hunk header: @@ -OLD,COUNT +NEW,COUNT @@ optional context
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        oldLine = parseInt(hunkMatch[1], 10);
        newLine = parseInt(hunkMatch[2], 10);
        output.push(line); // pass through unchanged
        currentLine++;
        continue;
      }

      // code lines within hunks
      const changeType = line[0] || " ";
      const code = line.slice(1);

      if (changeType === "-") {
        // removed line: show old line number, no new line number
        output.push(`| ${padNum(oldLine)} |      | - | ${code}`);
        oldLine++;
      } else if (changeType === "+") {
        // added line: no old line number, show new line number
        output.push(`|      | ${padNum(newLine)} | + | ${code}`);
        newLine++;
      } else if (changeType === " " || changeType === "\\") {
        // context line or "\ No newline at end of file"
        if (changeType === "\\") {
          output.push(line); // pass through as-is
        } else {
          output.push(`| ${padNum(oldLine)} | ${padNum(newLine)} |   | ${code}`);
          oldLine++;
          newLine++;
        }
      } else {
        // unknown line type, pass through
        output.push(line);
      }
      currentLine++;
    }
    output.push(""); // blank line between files
    currentLine++;

    tocEntries.push({
      filename: file.filename,
      startLine: fileStartLine,
      endLine: currentLine - 1,
    });
  }

  // build TOC
  const tocLines = [`## Files (${files.length})`];
  for (const entry of tocEntries) {
    tocLines.push(`- ${entry.filename} → lines ${entry.startLine}-${entry.endLine}`);
  }
  tocLines.push("");
  tocLines.push("---");
  tocLines.push("");

  const toc = tocLines.join("\n");
  const content = toc + output.join("\n");

  return { content, toc };
}

function padNum(n: number): string {
  return n.toString().padStart(4, " ");
}

export const CheckoutPr = type({
  pull_number: type.number.describe("the pull request number to checkout"),
});

export type CheckoutPrResult = {
  success: true;
  number: number;
  title: string;
  base: string;
  localBranch: string;
  remoteBranch: string;
  isFork: boolean;
  maintainerCanModify: boolean;
  url: string;
  headRepo: string;
  diffPath: string;
  incrementalDiffPath?: string | undefined;
  toc: string;
  instructions: string;
};

type FetchPrDiffParams = {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
};

/**
 * fetches PR files from GitHub and formats them with line numbers and TOC.
 * this is the core diff formatting logic, extracted for testability.
 */
export async function fetchAndFormatPrDiff(params: FetchPrDiffParams): Promise<FormatFilesResult> {
  const files = await params.octokit.paginate(params.octokit.rest.pulls.listFiles, {
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    per_page: 100,
  });
  return formatFilesWithLineNumbers(files);
}

import type { GitContext } from "../utils/setup.ts";

export type PrData = {
  number: number;
  headSha: string;
  headRef: string;
  headRepoFullName: string;
  baseRef: string;
  baseRepoFullName: string;
  maintainerCanModify: boolean;
};

type EnsureBeforeShaParams = {
  sha: string;
  octokit: Octokit;
  owner: string;
  repo: string;
  gitToken: string;
  isShallow: boolean;
};

type CreateTempBranchParams = {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
  sha: string;
};

async function createTempBranch(params: CreateTempBranchParams) {
  const response = await params.octokit.rest.git.createRef({
    owner: params.owner,
    repo: params.repo,
    ref: `refs/heads/${params.ref}`,
    sha: params.sha,
  });
  return {
    data: response.data,
    async [Symbol.asyncDispose]() {
      try {
        await params.octokit.rest.git.deleteRef({
          owner: params.owner,
          repo: params.repo,
          ref: `heads/${params.ref}`,
        });
        log.debug(`» deleted temp branch ${params.ref}`);
      } catch (e) {
        log.debug(
          `» failed to delete temp branch ${params.ref}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    },
  };
}

async function ensureBeforeShaReachable(params: EnsureBeforeShaParams): Promise<boolean> {
  try {
    $("git", ["cat-file", "-t", params.sha], { log: false });
    log.debug(`» before_sha ${params.sha.slice(0, 7)} is reachable`);
    return true;
  } catch {
    // not available locally — create a temporary branch to fetch it
  }

  const tempBranch = `pullfrog/tmp/${params.sha.slice(0, 12)}`;
  try {
    log.debug(`» before_sha ${params.sha.slice(0, 7)} not reachable, creating temp branch...`);
    await using _ref = await createTempBranch({
      octokit: params.octokit,
      owner: params.owner,
      repo: params.repo,
      sha: params.sha,
      ref: tempBranch,
    });
    await $git(
      "fetch",
      ["--no-tags", ...(params.isShallow ? ["--depth=1"] : []), "origin", tempBranch],
      { token: params.gitToken }
    );
    log.debug(`» fetched before_sha via temp branch ${tempBranch}`);
    return true;
  } catch (e) {
    log.debug(`» failed to fetch before_sha: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

type CheckoutPrBranchParams = GitContext & {
  beforeSha?: string | undefined;
};

/**
 * Shared helper to checkout a PR branch and configure fork remotes.
 * Assumes origin remote is already configured with authentication.
 * Updates toolState.issueNumber, toolState.checkoutSha, and toolState.pushUrl (for fork PRs).
 */
export async function checkoutPrBranch(pr: PrData, params: CheckoutPrBranchParams): Promise<void> {
  const { octokit, owner, name, gitToken, toolState, beforeSha } = params;
  log.info(`» checking out PR #${pr.number}...`);

  const isFork = pr.headRepoFullName !== pr.baseRepoFullName;

  // always use pr-{number} as local branch name for consistency
  // this avoids naming conflicts and makes push config simpler
  const localBranch = `pr-${pr.number}`;

  const isShallow =
    $("git", ["rev-parse", "--is-shallow-repository"], { log: false }).trim() === "true";

  toolState.checkoutSha = $("git", ["rev-parse", "HEAD"], { log: false }).trim();
  const alreadyOnBranch = toolState.checkoutSha === pr.headSha;

  // fetch base branch so origin/<base> exists for diff operations
  log.debug(`» fetching base branch (${pr.baseRef})...`);
  await $git("fetch", ["--no-tags", "origin", pr.baseRef], { token: gitToken });

  // alreadyOnBranch only matches for repeated checkout_pr calls for the same PR in one session
  // (without the tip moving), or if an external setup already checked out the PR head.
  // normal PR-triggered runs won't match here — actions/checkout lands on a synthesized
  // merge commit whose SHA differs from pr.headSha.
  //
  // so the fetch+checkout block below will almost always execute, and the fetched HEAD
  // might differ from pr.headSha. toolState.checkoutSha is set after to capture the actual SHA.
  if (!alreadyOnBranch) {
    // checkout base branch first to avoid "refusing to fetch into current branch" error
    // -B creates or resets the branch to match origin/baseBranch
    $("git", ["checkout", "-B", pr.baseRef, `origin/${pr.baseRef}`], { log: false });

    // fetch PR branch using pull/{n}/head refspec (works for both fork and same-repo PRs)
    log.debug(`» fetching PR #${pr.number} (${localBranch})...`);
    await $git("fetch", ["--no-tags", "origin", `pull/${pr.number}/head:${localBranch}`], {
      token: gitToken,
    });

    // checkout the branch
    $("git", ["checkout", localBranch], { log: false });
    log.debug(`» checked out PR #${pr.number}`);
    // make sure toolState.checkoutSha is set to the actual checked-out SHA (which might be different from pr.headSha)
    toolState.checkoutSha = $("git", ["rev-parse", "HEAD"], { log: false }).trim();
  }

  const beforeShaReachable = beforeSha
    ? await ensureBeforeShaReachable({
        sha: beforeSha,
        octokit,
        owner,
        repo: name,
        gitToken,
        isShallow,
      })
    : false;

  // compute deepen depth for shallow clones. actions/checkout uses depth=1
  // by default, which breaks rebase/log because git can't find the merge base.
  // use the GitHub compare API to fetch exactly enough history.
  // computed after checkout so compareCommits uses the actual checked-out SHA.
  if (isShallow) {
    let deepenDepth = 0;
    try {
      // ahead_by = PR commits past merge base, behind_by = base commits past merge base.
      // --deepen extends ALL shallow roots equally (can't deepen a single branch),
      // so we need the max across both the PR head and before_sha to ensure all
      // three points (base, head, before_sha) reach the merge base in a single deepen call.
      const [prComparison, beforeShaComparison] = await Promise.all([
        octokit.rest.repos.compareCommits({
          owner,
          repo: name,
          base: pr.baseRef,
          head: toolState.checkoutSha,
        }),
        beforeSha && beforeShaReachable
          ? octokit.rest.repos.compareCommits({
              owner,
              repo: name,
              base: pr.baseRef,
              head: beforeSha,
            })
          : undefined,
      ]);
      deepenDepth =
        Math.max(
          prComparison.data.ahead_by,
          prComparison.data.behind_by,
          beforeShaComparison?.data.ahead_by ?? 0,
          beforeShaComparison?.data.behind_by ?? 0
        ) + 10;
      log.debug(
        `» PR: ${prComparison.data.ahead_by} ahead / ${prComparison.data.behind_by} behind` +
          (beforeShaComparison
            ? `, before_sha: ${beforeShaComparison.data.ahead_by} ahead / ${beforeShaComparison.data.behind_by} behind`
            : "") +
          `, deepen by ${deepenDepth}`
      );
    } catch {
      deepenDepth = 1000;
      log.debug(`» compare API failed, falling back to --deepen=${deepenDepth}`);
    }
    // deepen after both branches are fetched so the merge base is reachable from both sides
    if (deepenDepth) {
      log.debug(`» deepening by ${deepenDepth} to reach merge base...`);
      await $git("fetch", [`--deepen=${deepenDepth}`, "--no-tags", "origin"], {
        token: gitToken,
      });
    }
  }

  // configure push remote for this branch
  // NOTE: This always runs regardless of alreadyOnBranch, because setupGit doesn't configure
  // fork remotes. This ensures fork PRs can push even when checkout_pr is called after setupGit.
  if (isFork) {
    const remoteName = `pr-${pr.number}`;
    // SECURITY: fork URL without token - auth is injected via GIT_ASKPASS in $git()
    const forkUrl = `https://github.com/${pr.headRepoFullName}.git`;

    // add fork as a named remote (suppress logging to avoid "error: remote already exists" spam)
    try {
      $("git", ["remote", "add", remoteName, forkUrl], { log: false });
      log.debug(`» added remote '${remoteName}' for fork ${pr.headRepoFullName}`);
    } catch {
      // remote already exists, update its URL
      $("git", ["remote", "set-url", remoteName, forkUrl], { log: false });
      log.debug(`» updated remote '${remoteName}' for fork ${pr.headRepoFullName}`);
    }

    // set branch push config so `git push` knows where to push
    $("git", ["config", `branch.${localBranch}.pushRemote`, remoteName], { log: false });
    // set merge ref so git knows the remote branch name (may differ from local)
    $("git", ["config", `branch.${localBranch}.merge`, `refs/heads/${pr.headRef}`], { log: false });
    log.debug(`» configured branch '${localBranch}' to push to '${remoteName}/${pr.headRef}'`);

    // warn if maintainer can't modify (push will likely fail)
    if (!pr.maintainerCanModify) {
      log.warning(
        `» fork PR has maintainer_can_modify=false - push operations will fail. ` +
          `ask the PR author to enable "Allow edits from maintainers" or the fork may be owned by an organization.`
      );
    }
  } else {
    // for same-repo PRs, push to origin
    $("git", ["config", `branch.${localBranch}.pushRemote`, "origin"], { log: false });
    $("git", ["config", `branch.${localBranch}.merge`, `refs/heads/${pr.headRef}`], { log: false });
  }

  // update toolState
  toolState.issueNumber = pr.number;
  if (isFork) {
    toolState.pushUrl = `https://github.com/${pr.headRepoFullName}.git`;
  }

  // store push destination so push_branch can use it directly
  // git config is the primary mechanism, but toolState serves as a reliable fallback
  // in case git config reads fail in certain environments
  toolState.pushDest = {
    remoteName: isFork ? `pr-${pr.number}` : "origin",
    remoteBranch: pr.headRef,
    localBranch,
  };

  // execute post-checkout lifecycle hook
  await executeLifecycleHook({
    event: "post-checkout",
    script: params.postCheckoutScript,
  });
}

export function CheckoutPrTool(ctx: ToolContext) {
  return tool({
    name: "checkout_pr",
    description:
      "Checkout a pull request branch locally. This fetches the PR branch and sets up push configuration for fork PRs. " +
      "Returns diffPath pointing to the formatted diff file.",
    parameters: CheckoutPr,
    execute: execute(async ({ pull_number }) => {
      const prResponse = await ctx.octokit.rest.pulls.get({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        pull_number,
      });

      const headRepo = prResponse.data.head.repo;
      if (!headRepo) {
        throw new Error(`PR #${pull_number} source repository was deleted`);
      }

      const pr: PrData = {
        number: pull_number,
        headSha: prResponse.data.head.sha,
        headRef: prResponse.data.head.ref,
        headRepoFullName: headRepo.full_name,
        baseRef: prResponse.data.base.ref,
        baseRepoFullName: prResponse.data.base.repo.full_name,
        maintainerCanModify: prResponse.data.maintainer_can_modify,
      };

      await checkoutPrBranch(pr, {
        octokit: ctx.octokit,
        owner: ctx.repo.owner,
        name: ctx.repo.name,
        gitToken: ctx.gitToken,
        toolState: ctx.toolState,
        shell: ctx.payload.shell,
        postCheckoutScript: ctx.postCheckoutScript,
        beforeSha: ctx.toolState.beforeSha,
      });

      const tempDir = process.env.PULLFROG_TEMP_DIR;
      if (!tempDir) {
        throw new Error(
          "PULLFROG_TEMP_DIR not set - checkout_pr must run in pullfrog action context"
        );
      }

      const headShort = ctx.toolState.checkoutSha!.slice(0, 7);

      // compute incremental diff if we have a beforeSha to compare against
      let incrementalDiffPath: string | undefined;
      if (ctx.toolState.beforeSha && ctx.toolState.checkoutSha) {
        const beforeShort = ctx.toolState.beforeSha.slice(0, 7);
        const incremental = computeIncrementalDiff({
          baseBranch: pr.baseRef,
          beforeSha: ctx.toolState.beforeSha,
          headSha: ctx.toolState.checkoutSha,
        });
        if (incremental) {
          incrementalDiffPath = join(
            tempDir,
            `pr-${pull_number}-${beforeShort}-${headShort}-incremental.diff`
          );
          writeFileSync(incrementalDiffPath, incremental);
          log.info(
            `» incremental diff computed (${incremental.length} bytes) → ${incrementalDiffPath}`
          );
        }
      }

      // fetch PR files and format with line numbers
      const formatResult = await fetchAndFormatPrDiff({
        octokit: ctx.octokit,
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        pullNumber: pull_number,
      });
      const diffPreview = formatResult.content.split("\n").slice(0, 100).join("\n");
      log.debug(`formatted diff preview (first 100 lines):\n${diffPreview}`);
      const diffPath = join(tempDir, `pr-${pull_number}-${headShort}.diff`);
      writeFileSync(diffPath, formatResult.content);
      log.debug(`wrote diff to ${diffPath} (${formatResult.content.length} bytes)`);

      const incrementalInstructions = incrementalDiffPath
        ? ` IMPORTANT: incrementalDiffPath contains ONLY the changes since the last reviewed version ` +
          `(computed via range-diff). you MUST read incrementalDiffPath FIRST to understand what changed, ` +
          `then use diffPath for full PR context. do NOT skip the incremental diff.`
        : "";

      return {
        success: true,
        number: prResponse.data.number,
        title: prResponse.data.title,
        base: pr.baseRef,
        localBranch: `pr-${pull_number}`,
        remoteBranch: `refs/heads/${pr.headRef}`,
        isFork: pr.headRepoFullName !== pr.baseRepoFullName,
        maintainerCanModify: pr.maintainerCanModify,
        url: prResponse.data.html_url,
        headRepo: pr.headRepoFullName,
        diffPath,
        incrementalDiffPath,
        toc: formatResult.toc,
        instructions:
          `the diff file at diffPath contains a table of contents (TOC) at the top listing every changed file with its line range. ` +
          `use the line ranges to read specific files from the diff instead of reading the entire file. ` +
          `for example, if the TOC says "src/foo.ts → lines 5-42", read lines 5-42 from diffPath to see that file's changes. ` +
          `review files selectively based on relevance rather than reading everything sequentially. ` +
          `the local branch is 'localBranch' (pr-{number}), not the remote branch name. ` +
          `when pushing, omit branchName to use the current branch. do not use remoteBranch as a local branch name.` +
          incrementalInstructions,
      } satisfies CheckoutPrResult;
    }),
  });
}
