import assert from "node:assert/strict";
import * as core from "@actions/core";
import { log } from "./cli.ts";
import { acquireNewToken } from "./github.ts";
import { isGitHubActions } from "./globals.ts";

// re-export for get-installation-token action
export { acquireNewToken as acquireInstallationToken };
export { revokeGitHubInstallationToken as revokeInstallationToken };

// store token in memory instead of process.env
let githubInstallationToken: string | undefined;

/**
 * Setup GitHub installation token for the action
 */
export async function resolveInstallationToken() {
  assert(!githubInstallationToken, "GitHub installation token is already set.");
  const originalToken = process.env.GITHUB_TOKEN;
  if (originalToken) {
    process.env.ORIGINAL_GITHUB_TOKEN = originalToken;
  }
  const externalToken = process.env.GH_TOKEN;
  const token = externalToken || (await acquireNewToken());
  process.env.GITHUB_TOKEN = token;
  githubInstallationToken = token;

  if (isGitHubActions) {
    // out of caution, we don't call this here outside of the GitHub Actions environment
    // given this uses `process.stdout.write(cmd.toString() + os.EOL)` under the hood,
    core.setSecret(token);
  }

  return {
    token,
    originalToken,
    async [Symbol.asyncDispose]() {
      githubInstallationToken = undefined;
      if (originalToken) {
        process.env.GITHUB_TOKEN = originalToken;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
      // GH_TOKEN isn't acquired here, so it's not revoked here either
      if (externalToken) {
        return;
      }
      return revokeGitHubInstallationToken(token);
    },
  };
}

/**
 * Get the GitHub installation token from memory
 */
export function getGitHubInstallationToken(): string {
  assert(
    githubInstallationToken,
    "GitHub installation token not set. Call resolveInstallationToken first."
  );
  return githubInstallationToken;
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
    log.warning(
      `Failed to revoke installation token: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
