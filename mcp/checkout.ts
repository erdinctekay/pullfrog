import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Octokit, RestEndpointMethodTypes } from "@octokit/rest";
import { type } from "arktype";
import { log } from "../utils/cli.ts";
import { $git } from "../utils/gitAuth.ts";
import { executeLifecycleHook } from "../utils/lifecycle.ts";
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
  const filesResponse = await params.octokit.rest.pulls.listFiles({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    per_page: 100,
  });
  return formatFilesWithLineNumbers(filesResponse.data);
}

import type { GitContext } from "../utils/setup.ts";

type CheckoutPrBranchParams = GitContext;

interface CheckoutPrBranchResult {
  prNumber: number;
  isFork: boolean;
  forkUrl?: string | undefined; // only set when isFork is true
}

/**
 * Shared helper to checkout a PR branch and configure fork remotes.
 * Assumes origin remote is already configured with authentication.
 * Updates toolState.issueNumber and toolState.pushUrl (for fork PRs).
 */
export async function checkoutPrBranch(
  pullNumber: number,
  params: CheckoutPrBranchParams
): Promise<CheckoutPrBranchResult> {
  const { octokit, owner, name, gitToken, toolState, bash } = params;
  log.info(`» checking out PR #${pullNumber}...`);

  // fetch PR metadata
  const pr = await octokit.rest.pulls.get({
    owner,
    repo: name,
    pull_number: pullNumber,
  });

  const headRepo = pr.data.head.repo;
  if (!headRepo) {
    throw new Error(`PR #${pullNumber} source repository was deleted`);
  }

  const isFork = headRepo.full_name !== pr.data.base.repo.full_name;
  const baseBranch = pr.data.base.ref;
  const headBranch = pr.data.head.ref;

  // always use pr-{number} as local branch name for consistency
  // this avoids naming conflicts and makes push config simpler
  const localBranch = `pr-${pullNumber}`;

  // check if we're already on the correct commit (not just branch name)
  // this handles fork PRs where head branch name might match base branch name
  const currentSha = $("git", ["rev-parse", "HEAD"], { log: false }).trim();
  const alreadyOnBranch = currentSha === pr.data.head.sha;

  if (alreadyOnBranch) {
    log.debug(`already on PR branch ${localBranch}, skipping checkout`);
  } else {
    // fetch base branch so origin/<base> exists for diff operations
    log.debug(`» fetching base branch (${baseBranch})...`);
    $git("fetch", ["--no-tags", "origin", baseBranch], {
      token: gitToken,
      restricted: bash !== "enabled",
    });

    // checkout base branch first to avoid "refusing to fetch into current branch" error
    // -B creates or resets the branch to match origin/baseBranch
    $("git", ["checkout", "-B", baseBranch, `origin/${baseBranch}`]);

    // fetch PR branch using pull/{n}/head refspec (works for both fork and same-repo PRs)
    log.debug(`» fetching PR #${pullNumber} (${localBranch})...`);
    $git("fetch", ["--no-tags", "origin", `pull/${pullNumber}/head:${localBranch}`], {
      token: gitToken,
      restricted: bash !== "enabled",
    });

    // checkout the branch
    $("git", ["checkout", localBranch]);
    log.debug(`» checked out PR #${pullNumber}`);
  }

  // ensure base branch is fetched (needed for diff operations)
  // fetch if we skipped checkout (already on branch) - otherwise already fetched above
  if (alreadyOnBranch) {
    log.debug(`» fetching base branch (${baseBranch})...`);
    $git("fetch", ["--no-tags", "origin", baseBranch], {
      token: gitToken,
      restricted: bash !== "enabled",
    });
  }

  // configure push remote for this branch
  // NOTE: This always runs regardless of alreadyOnBranch, because setupGit doesn't configure
  // fork remotes. This ensures fork PRs can push even when checkout_pr is called after setupGit.
  if (isFork) {
    const remoteName = `pr-${pullNumber}`;
    // SECURITY: fork URL without token - auth is injected via GIT_CONFIG_PARAMETERS in $git()
    const forkUrl = `https://github.com/${headRepo.full_name}.git`;

    // add fork as a named remote (suppress logging to avoid "error: remote already exists" spam)
    try {
      $("git", ["remote", "add", remoteName, forkUrl], { log: false });
      log.debug(`» added remote '${remoteName}' for fork ${headRepo.full_name}`);
    } catch {
      // remote already exists, update its URL
      $("git", ["remote", "set-url", remoteName, forkUrl], { log: false });
      log.debug(`» updated remote '${remoteName}' for fork ${headRepo.full_name}`);
    }

    // set branch push config so `git push` knows where to push
    $("git", ["config", `branch.${localBranch}.pushRemote`, remoteName]);
    // set merge ref so git knows the remote branch name (may differ from local)
    $("git", ["config", `branch.${localBranch}.merge`, `refs/heads/${headBranch}`]);
    log.debug(`» configured branch '${localBranch}' to push to '${remoteName}/${headBranch}'`);

    // warn if maintainer can't modify (push will likely fail)
    if (!pr.data.maintainer_can_modify) {
      log.warning(
        `» fork PR has maintainer_can_modify=false - push operations will fail. ` +
          `ask the PR author to enable "Allow edits from maintainers" or the fork may be owned by an organization.`
      );
    }
  } else {
    // for same-repo PRs, push to origin
    $("git", ["config", `branch.${localBranch}.pushRemote`, "origin"]);
    $("git", ["config", `branch.${localBranch}.merge`, `refs/heads/${headBranch}`]);
  }

  // update toolState
  toolState.issueNumber = pullNumber;
  if (isFork) {
    toolState.pushUrl = `https://github.com/${headRepo.full_name}.git`;
  }

  // execute post-checkout lifecycle hook
  await executeLifecycleHook({
    event: "post-checkout",
    script: params.postCheckoutScript,
  });

  return {
    prNumber: pullNumber,
    isFork,
    forkUrl: isFork ? `https://github.com/${headRepo.full_name}.git` : undefined,
  };
}

export function CheckoutPrTool(ctx: ToolContext) {
  return tool({
    name: "checkout_pr",
    description:
      "Checkout a pull request branch locally. This fetches the PR branch and sets up push configuration for fork PRs. " +
      "Returns diffPath pointing to the formatted diff file.",
    parameters: CheckoutPr,
    execute: execute(async ({ pull_number }) => {
      await checkoutPrBranch(pull_number, {
        octokit: ctx.octokit,
        owner: ctx.repo.owner,
        name: ctx.repo.name,
        gitToken: ctx.gitToken,
        toolState: ctx.toolState,
        bash: ctx.payload.bash,
        postCheckoutScript: ctx.postCheckoutScript,
      });

      // fetch PR metadata to return result
      const pr = await ctx.octokit.rest.pulls.get({
        owner: ctx.repo.owner,
        repo: ctx.repo.name,
        pull_number,
      });

      const headRepo = pr.data.head.repo;
      if (!headRepo) {
        throw new Error(`PR #${pull_number} source repository was deleted`);
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
      const tempDir = process.env.PULLFROG_TEMP_DIR;
      if (!tempDir) {
        throw new Error(
          "PULLFROG_TEMP_DIR not set - checkout_pr must run in pullfrog action context"
        );
      }
      const diffPath = join(tempDir, `pr-${pull_number}.diff`);
      writeFileSync(diffPath, formatResult.content);
      log.debug(`wrote diff to ${diffPath} (${formatResult.content.length} bytes)`);

      return {
        success: true,
        number: pr.data.number,
        title: pr.data.title,
        base: pr.data.base.ref,
        localBranch: `pr-${pull_number}`,
        remoteBranch: `refs/heads/${pr.data.head.ref}`,
        isFork: headRepo.full_name !== pr.data.base.repo.full_name,
        maintainerCanModify: pr.data.maintainer_can_modify,
        url: pr.data.html_url,
        headRepo: headRepo.full_name,
        diffPath,
        toc: formatResult.toc,
        instructions:
          `the diff file at diffPath contains a table of contents (TOC) at the top listing every changed file with its line range. ` +
          `use the line ranges to read specific files from the diff instead of reading the entire file. ` +
          `for example, if the TOC says "src/foo.ts → lines 5-42", read lines 5-42 from diffPath to see that file's changes. ` +
          `review files selectively based on relevance rather than reading everything sequentially. ` +
          `the local branch is 'localBranch' (pr-{number}), not the remote branch name. ` +
          `when pushing, omit branchName to use the current branch. do not use remoteBranch as a local branch name.`,
      } satisfies CheckoutPrResult;
    }),
  });
}
