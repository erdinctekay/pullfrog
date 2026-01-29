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

function setEnvironmentVariable(name: string, value: string | undefined) {
  const hadValue = Object.hasOwn(process.env, name);
  const originalValue = process.env[name];

  if (typeof value === "string") {
    process.env[name] = value;
  } else {
    delete process.env[name];
  }

  return () => {
    if (hadValue) {
      process.env[name] = originalValue;
    } else {
      delete process.env[name];
    }
  };
}

/**
 * Setup GitHub installation token for the action
 */
export async function resolveInstallationToken() {
  assert(!githubInstallationToken, "GitHub installation token is already set.");
  const githubJobToken = core.getInput("token");
  const externalToken = process.env.GH_TOKEN;
  const token = externalToken || (await acquireNewToken());

  const revertGithubToken = setEnvironmentVariable("GITHUB_TOKEN", token);
  githubInstallationToken = token;

  if (isGitHubActions) {
    // out of caution, we don't call this here outside of the GitHub Actions environment
    // given this uses `process.stdout.write(cmd.toString() + os.EOL)` under the hood,
    core.setSecret(token);
  }

  return {
    token,
    // in GitHub Actions environment this fallback token should always come from the action's input
    // but in other environments there is no secondary token like this so we just use the installation token itself
    githubJobToken,
    async [Symbol.asyncDispose]() {
      githubInstallationToken = undefined;
      revertGithubToken();
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
