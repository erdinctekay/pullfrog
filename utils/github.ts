import { createSign } from "node:crypto";
import * as core from "@actions/core";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { getApiUrl, getVercelBypassHeaders } from "./apiUrl.ts";
import { retry } from "./retry.ts";

export interface InstallationToken {
  token: string;
  expires_at: string;
  installation_id: number;
  repository: string;
  ref: string;
  runner_environment: string;
  owner?: string;
}

interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  repoOwner: string;
  repoName: string;
}

interface Installation {
  id: number;
  account: {
    login: string;
    type: string;
  };
}

interface Repository {
  owner: {
    login: string;
  };
  name: string;
}

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

interface RepositoriesResponse {
  repositories: Repository[];
}

function isOIDCAvailable(): boolean {
  // OIDC requires both env vars to be set (only in real GitHub Actions with id-token permission)
  return Boolean(
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  );
}

// github installation token permission levels
type ReadWrite = "read" | "write";
type WriteOnly = "write";
type ReadOnly = "read";

// permission names use underscores (API format)
type InstallationTokenPermissions = {
  actions?: ReadWrite;
  artifact_metadata?: ReadWrite;
  attestations?: ReadWrite;
  checks?: ReadWrite;
  contents?: ReadWrite;
  deployments?: ReadWrite;
  id_token?: WriteOnly;
  issues?: ReadWrite;
  models?: ReadOnly;
  discussions?: ReadWrite;
  packages?: ReadWrite;
  pages?: ReadWrite;
  pull_requests?: ReadWrite;
  security_events?: ReadWrite;
  statuses?: ReadWrite;
};

type AcquireTokenOptions = {
  repos?: string[];
  permissions?: InstallationTokenPermissions;
};

async function acquireTokenViaOIDC(opts?: AcquireTokenOptions): Promise<string> {
  const oidcToken = await core.getIDToken("pullfrog-api");

  const apiUrl = getApiUrl();
  const params = new URLSearchParams();

  // ensure the token covers GITHUB_REPOSITORY (may differ from OIDC claims repo)
  const repos = [...(opts?.repos ?? [])];
  const targetRepo = process.env.GITHUB_REPOSITORY?.split("/")[1];
  if (targetRepo) {
    repos.push(targetRepo);
  }
  if (repos.length) {
    params.set("repos", repos.join(","));
  }
  const queryString = params.toString() ? `?${params.toString()}` : "";

  const timeoutMs = 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const fetchOptions: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json",
        ...getVercelBypassHeaders(),
      },
      signal: controller.signal,
    };
    if (opts?.permissions) {
      fetchOptions.body = JSON.stringify({ permissions: opts.permissions });
    }
    const tokenResponse = await fetch(
      `${apiUrl}/api/github/installation-token${queryString}`,
      fetchOptions
    );

    clearTimeout(timeoutId);

    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenResponse.status} ${tokenResponse.statusText}`);
    }

    const tokenData = (await tokenResponse.json()) as InstallationToken;
    return tokenData.token;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Token exchange timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

const base64UrlEncode = (str: string): string => {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

const generateJWT = (appId: string, privateKey: string): string => {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 5 * 60,
    iss: appId,
  };

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signaturePart = `${encodedHeader}.${encodedPayload}`;

  const signature = createSign("RSA-SHA256")
    .update(signaturePart)
    .sign(privateKey, "base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return `${signaturePart}.${signature}`;
};

const githubRequest = async <T>(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<T> => {
  const { method = "GET", headers = {}, body } = options;

  const url = `https://api.github.com${path}`;
  const requestHeaders = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Pullfrog-Installation-Token-Generator/1.0",
    ...headers,
  };

  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    ...(body && { body }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `GitHub API request failed: ${response.status} ${response.statusText}\n${errorText}`
    );
  }

  return response.json() as T;
};

const checkRepositoryAccess = async (
  token: string,
  repoOwner: string,
  repoName: string
): Promise<boolean> => {
  try {
    const response = await githubRequest<RepositoriesResponse>("/installation/repositories", {
      headers: { Authorization: `token ${token}` },
    });

    return response.repositories.some(
      (repo) => repo.owner.login === repoOwner && repo.name === repoName
    );
  } catch {
    return false;
  }
};

const createInstallationToken = async (
  jwt: string,
  installationId: number,
  permissions?: InstallationTokenPermissions
): Promise<string> => {
  const requestOpts: { method: string; headers: Record<string, string>; body?: string } = {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
  };
  if (permissions) {
    requestOpts.body = JSON.stringify({ permissions });
  }
  const response = await githubRequest<InstallationTokenResponse>(
    `/app/installations/${installationId}/access_tokens`,
    requestOpts
  );

  return response.token;
};

const findInstallationId = async (
  jwt: string,
  repoOwner: string,
  repoName: string
): Promise<number> => {
  const installations = await githubRequest<Installation[]>("/app/installations", {
    headers: { Authorization: `Bearer ${jwt}` },
  });

  for (const installation of installations) {
    try {
      const tempToken = await createInstallationToken(jwt, installation.id);
      const hasAccess = await checkRepositoryAccess(tempToken, repoOwner, repoName);

      if (hasAccess) {
        return installation.id;
      }
    } catch {}
  }

  throw new Error(
    `No installation found with access to ${repoOwner}/${repoName}. ` +
      "Ensure the GitHub App is installed on the target repository."
  );
};

// for local development only
async function acquireTokenViaGitHubApp(opts?: AcquireTokenOptions): Promise<string> {
  const repoContext = parseRepoContext();

  const config: GitHubAppConfig = {
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n")!,
    repoOwner: repoContext.owner,
    repoName: repoContext.name,
  };

  const jwt = generateJWT(config.appId, config.privateKey);
  const installationId = await findInstallationId(jwt, config.repoOwner, config.repoName);
  return await createInstallationToken(jwt, installationId, opts?.permissions);
}

export async function acquireNewToken(opts?: AcquireTokenOptions): Promise<string> {
  if (isOIDCAvailable()) {
    return await retry(() => acquireTokenViaOIDC(opts), {
      label: "token exchange",
      shouldRetry: (error) =>
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message.includes("fetch failed") ||
          error.message.includes("ECONNRESET") ||
          error.message.includes("ETIMEDOUT") ||
          error.message.includes("Token exchange failed")),
    });
  } else {
    // local development via GitHub App
    return await acquireTokenViaGitHubApp(opts);
  }
}

export interface RepoContext {
  owner: string;
  name: string;
}

/**
 * Parse repository context from GITHUB_REPOSITORY environment variable.
 */
export function parseRepoContext(): RepoContext {
  const githubRepo = process.env.GITHUB_REPOSITORY;
  if (!githubRepo) {
    throw new Error("GITHUB_REPOSITORY environment variable is required");
  }

  const [owner, name] = githubRepo.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid GITHUB_REPOSITORY format: ${githubRepo}. Expected 'owner/repo'`);
  }

  return { owner, name };
}

export type OctokitWithPlugins = InstanceType<
  ReturnType<typeof Octokit.plugin<typeof Octokit, [typeof throttling]>>
>;

export function createOctokit(token: string): OctokitWithPlugins {
  // `OctokitWithPlugins` initialization based on https://github.com/actions/toolkit/blob/2506e78e82fbd2f9e94d63e75f5309118c8de1b1/packages/github/src/github.ts#L15-L22
  // we can't use it directly because it's stuck on `@octokit/core@v5` and we use the hottest `@octokit/core@v7`
  const OctokitWithPlugins = Octokit.plugin(throttling);
  return new OctokitWithPlugins({
    auth: token,
    throttle: {
      onRateLimit: (_retryAfter, _options, _octokit, retryCount) => {
        return retryCount <= 2;
      },
      onSecondaryRateLimit: (_retryAfter, _options, _octokit, retryCount) => {
        return retryCount <= 2;
      },
    },
  });
}
