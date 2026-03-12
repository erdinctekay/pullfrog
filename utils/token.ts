import assert from "node:assert/strict";
import * as core from "@actions/core";
import type { PushPermission } from "../external.ts";
import { log } from "./cli.ts";
import { onExitSignal } from "./exitHandler.ts";
import { acquireNewToken } from "./github.ts";
import { isGitHubActions } from "./globals.ts";

// re-export for get-installation-token action
export { acquireNewToken as acquireInstallationToken };
export { revokeGitHubInstallationToken as revokeInstallationToken };

// store MCP token in memory for getGitHubInstallationToken()
let mcpTokenValue: string | undefined;

/**
 * get the job-scoped token from action input.
 * this token has permissions defined by the workflow's permissions block.
 *
 * fallback order:
 * 1. INPUT_TOKEN (from workflow `with: token:`)
 * 2. GH_TOKEN (external token override)
 * 3. GITHUB_TOKEN (pre-acquired in tests or from GHA env)
 */
export function getJobToken(): string {
  const inputToken = core.getInput("token");
  if (inputToken) {
    return inputToken;
  }

  // fallback for test environment and local dev
  const fallbackToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fallbackToken) {
    return fallbackToken;
  }

  throw new Error("token input is required");
}

export type TokenRef = {
  gitToken: string;
  mcpToken: string;
  [Symbol.asyncDispose]: () => Promise<void>;
};

type ResolveTokensParams = {
  push: PushPermission;
};

/**
 * resolve tokens for the action run.
 *
 * creates two separate tokens:
 * - gitToken: contents permission based on `push` setting (assumed exfiltratable)
 *   - push: enabled → contents:write (can push)
 *   - push: disabled → contents:read (read-only)
 * - mcpToken: full installation token - used for GitHub API calls in MCP tools (not exfiltratable)
 *
 * security-conscious users can pass their own token via GH_TOKEN env var or inputs.token.
 */
export async function resolveTokens(params: ResolveTokensParams): Promise<TokenRef> {
  assert(!mcpTokenValue, "tokens are already resolved");

  const externalToken = process.env.GH_TOKEN;

  // external token takes precedence - use for both git and MCP
  if (externalToken) {
    mcpTokenValue = externalToken;

    if (isGitHubActions) {
      core.setSecret(externalToken);
    }

    log.info("» using external GH_TOKEN for both git and MCP");

    return {
      gitToken: externalToken,
      mcpToken: externalToken,
      async [Symbol.asyncDispose]() {
        mcpTokenValue = undefined;
        // GH_TOKEN isn't acquired here, so it's not revoked here either
      },
    };
  }

  // create git token based on push permission (assumed exfiltratable)
  // disabled = read-only, restricted/enabled = write (MCP tools enforce branch restrictions)
  // workflows permission is write-only in the API, so only requested when pushing is allowed
  const gitPermissions =
    params.push === "disabled"
      ? { contents: "read" as const }
      : { contents: "write" as const, workflows: "write" as const };
  const gitToken = await acquireNewToken({ permissions: gitPermissions });
  if (isGitHubActions) {
    core.setSecret(gitToken);
  }
  log.info(
    `» acquired git token (${Object.entries(gitPermissions)
      .map((e) => e.join(":"))
      .join(", ")})`
  );

  // MCP token scoped to only what MCP tools actually need.
  // not exfiltratable (only accessible via MCP tools), but scoped as defense-in-depth
  // so even a compromised tool context can't touch secrets, admin, etc.
  const mcpPermissions = {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    checks: "read",
    actions: "read",
  } as const;
  const mcpToken = await acquireNewToken({ permissions: mcpPermissions });
  if (isGitHubActions) {
    core.setSecret(mcpToken);
  }
  log.info(
    `» acquired scoped MCP token (${Object.entries(mcpPermissions)
      .map((e) => e.join(":"))
      .join(", ")})`
  );

  mcpTokenValue = mcpToken;

  let disposingRef: PromiseWithResolvers<void> | undefined;

  const dispose = async () => {
    if (disposingRef) {
      // this can happen if the signal arrives when disposing tokens
      // we make sure to wait for the current dispose to complete
      return disposingRef.promise;
    }
    disposingRef = Promise.withResolvers();
    try {
      mcpTokenValue = undefined;
      // revoke both tokens
      await Promise.all([
        revokeGitHubInstallationToken(gitToken),
        revokeGitHubInstallationToken(mcpToken),
      ]);
    } finally {
      removeSignalHandler();
      disposingRef.resolve();
      disposingRef = undefined;
    }
  };

  const removeSignalHandler = onExitSignal(dispose);

  return {
    gitToken,
    mcpToken,
    [Symbol.asyncDispose]: dispose,
  };
}

/**
 * get the MCP token from memory.
 * this is the token used for GitHub API calls in MCP tools.
 */
export function getGitHubInstallationToken(): string {
  assert(mcpTokenValue, "tokens not set. call resolveTokens first.");
  return mcpTokenValue;
}

export async function revokeGitHubInstallationToken(token: string): Promise<void> {
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";

  try {
    await fetch(`${apiUrl}/installation/token`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    log.debug("» installation token revoked");
  } catch (error) {
    log.info(
      `Failed to revoke installation token: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
