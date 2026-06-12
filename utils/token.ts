import assert from "node:assert/strict";
import * as core from "@actions/core";
import type { PushPermission } from "../external.ts";
import { log } from "./cli.ts";
import { onExitSignal } from "./exitHandler.ts";
import { acquireNewToken, type OidcCredentials } from "./github.ts";
import { isGitHubActions } from "./globals.ts";

// re-export for `pullfrog gha token` subcommand
export { acquireNewToken as acquireInstallationToken };
export { revokeGitHubInstallationToken as revokeInstallationToken };

// store MCP token in memory for getGitHubInstallationToken()
let mcpTokenValue: string | undefined;

// single-flight re-acquisition for mid-run 401s, set by resolveTokens on the
// minted path (external GH_TOKEN can't be re-minted, so it stays undefined)
let refreshMcpTokenFn: ((stale: string) => Promise<string>) | undefined;

/**
 * get the refresh function for the MCP token, if re-acquisition is possible.
 * pass to `createOctokit` so a mid-run 401 triggers a refresh + retry (#891).
 */
export function getMcpTokenRefresh(): ((stale: string) => Promise<string>) | undefined {
  return refreshMcpTokenFn;
}

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
  /**
   * OIDC credentials stashed by main.ts before the restricted-mode env wipe —
   * the mid-run MCP token refresh mints from this snapshot (#891). null when
   * OIDC isn't available (local dev, external token).
   */
  oidc: OidcCredentials | null;
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
  let currentMcpToken = mcpToken;

  // GitHub can invalidate an installation token before expiry (see #891).
  // single-flight: concurrent 401s share one mint, and a caller whose token
  // was already replaced by a parallel refresh gets the replacement without
  // minting again. cleared on settle so a transient refresh failure doesn't
  // poison the rest of the run (acquireNewToken retries transients itself).
  // note: gitToken deliberately has no refresh path — git auth failures are
  // stringly (no structured 401) and #891 only evidenced MCP-API 401s.
  let refreshPromise: Promise<string> | undefined;
  refreshMcpTokenFn = (stale) => {
    assert(mcpTokenValue, "tokens already disposed");
    if (stale !== currentMcpToken) {
      return Promise.resolve(currentMcpToken);
    }
    refreshPromise ??= acquireNewToken({
      permissions: mcpPermissions,
      oidc: params.oidc ?? undefined,
    })
      .then((fresh) => {
        if (isGitHubActions) {
          core.setSecret(fresh);
        }
        mcpTokenValue = fresh;
        currentMcpToken = fresh;
        log.warning("» GitHub rejected the MCP token; re-acquired a fresh scoped MCP token");
        return fresh;
      })
      .finally(() => {
        refreshPromise = undefined;
      });
    return refreshPromise;
  };

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
      refreshMcpTokenFn = undefined;
      // revoke both tokens (a refresh may have replaced the original MCP token)
      await Promise.all([
        revokeGitHubInstallationToken(gitToken),
        revokeGitHubInstallationToken(currentMcpToken),
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
