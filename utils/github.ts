import { createSign } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as core from "@actions/core";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { apiFetch } from "./apiFetch.ts";
import { retry } from "./retry.ts";

function isObject(value: unknown) {
  return typeof value === "object" && value !== null;
}

// we don't get access to the actual class from @octokit/rest
// it's reachable from @octokit/request-error but we'd have to add a dependency on it
// and it would pose a risk of accidentally pulling a different version of that class (node_modules dep graphs ❤️)
// so it's safer to ducktype this
interface OctokitResponseShim {
  headers: Record<string, string | number | undefined>;
}

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

type ReadWrite = "read" | "write";
type WriteOnly = "write";

/**
 * GitHub App installation access token permissions.
 * passed to `POST /app/installations/{id}/access_tokens` to scope the token.
 * fields and allowed values come from the `app-permissions` OpenAPI schema.
 * @see https://docs.github.com/en/rest/apps/installations#create-an-installation-access-token-for-an-app
 * @see https://github.com/github/rest-api-description — components.schemas.app-permissions
 */
type GitHubAppPermissions = {
  actions?: ReadWrite;
  artifact_metadata?: ReadWrite;
  attestations?: ReadWrite;
  checks?: ReadWrite;
  contents?: ReadWrite;
  deployments?: ReadWrite;
  discussions?: ReadWrite;
  issues?: ReadWrite;
  packages?: ReadWrite;
  pages?: ReadWrite;
  pull_requests?: ReadWrite;
  security_events?: ReadWrite;
  statuses?: ReadWrite;
  workflows?: WriteOnly;
};

type AcquireTokenOptions = {
  repos?: string[];
  permissions?: GitHubAppPermissions;
};

async function acquireTokenViaOIDC(opts?: AcquireTokenOptions): Promise<string> {
  const oidcToken = await core.getIDToken("pullfrog-api");

  const repos = [...(opts?.repos ?? [])];
  const targetRepo = process.env.GITHUB_REPOSITORY?.split("/")[1];
  if (targetRepo) {
    repos.push(targetRepo);
  }
  const reposParam = repos.length ? `?repos=${repos.join(",")}` : "";

  const timeoutMs = 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const tokenResponse = await apiFetch({
      path: `/api/github/installation-token${reposParam}`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json",
      },
      body: opts?.permissions ? JSON.stringify({ permissions: opts.permissions }) : undefined,
      signal: controller.signal,
    });

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
  permissions?: GitHubAppPermissions
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
  if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_PRIVATE_KEY) {
    throw new Error(
      "cannot acquire token via GitHub App: GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be set"
    );
  }

  const repoContext = parseRepoContext();

  const config: GitHubAppConfig = {
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n"),
    repoOwner: repoContext.owner,
    repoName: repoContext.name,
  };

  const jwt = generateJWT(config.appId, config.privateKey);
  const installationId = await findInstallationId(jwt, config.repoOwner, config.repoName);
  return await createInstallationToken(jwt, installationId, opts?.permissions);
}

/**
 * ensure a GitHub token is available in the environment.
 *
 * when OIDC is available (CI), always mints a fresh token scoped to
 * GITHUB_REPOSITORY — overriding any inherited GITHUB_TOKEN that may
 * be scoped to the wrong repo.
 *
 * otherwise falls back to GitHub App credentials for local development.
 *
 * only called from play.ts (test/dev path) — the live action calls
 * main() directly and never calls this.
 */
export async function ensureGitHubToken(): Promise<void> {
  // when OIDC is available, always mint a fresh token scoped to
  // GITHUB_REPOSITORY. the inherited GITHUB_TOKEN may be scoped to a
  // different repo (e.g., runner token for pullfrog/app when tests
  // target pullfrog/test-repo).
  if (isOIDCAvailable()) {
    const token = await acquireNewToken();
    process.env.GITHUB_TOKEN = token;
    return;
  }

  if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
    const token = await acquireNewToken();
    process.env.GITHUB_TOKEN = token;
  }
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

export interface ResourceUsage {
  requestCount: number;
  rateLimitRemaining: number | null;
  rateLimitResetMs: number | null;
}

function emptyResourceUsage(): ResourceUsage {
  return {
    requestCount: 0,
    rateLimitRemaining: null,
    rateLimitResetMs: null,
  };
}

const usageByResource: Record<string, ResourceUsage> = {
  core: emptyResourceUsage(),
  graphql: emptyResourceUsage(),
};

export interface UsageSummary {
  version: 1;
  github: {
    core: ResourceUsage;
    graphql: ResourceUsage;
  };
}

function getGitHubUsageSummary(): UsageSummary {
  return {
    version: 1,
    github: {
      core: usageByResource.core,
      graphql: usageByResource.graphql,
    },
  };
}

export async function writeGitHubUsageSummaryToFile(path: string): Promise<void> {
  const summary = getGitHubUsageSummary();
  const tmpPath = join(dirname(path), `.usage-summary-${process.pid}.tmp`);
  await writeFile(tmpPath, JSON.stringify(summary));
  await rename(tmpPath, path);
}

export function createOctokit(token: string): OctokitWithPlugins {
  // `OctokitWithPlugins` initialization based on https://github.com/actions/toolkit/blob/2506e78e82fbd2f9e94d63e75f5309118c8de1b1/packages/github/src/github.ts#L15-L22
  // we can't use it directly because it's stuck on `@octokit/core@v5` and we use the hottest `@octokit/core@v7`
  const OctokitWithPlugins = Octokit.plugin(throttling);
  const octokit = new OctokitWithPlugins({
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

  const onResponse = (response: OctokitResponseShim) => {
    const resource = response.headers["x-ratelimit-resource"];
    if (!resource) {
      return response;
    }
    usageByResource[resource] ??= emptyResourceUsage();
    const usage = usageByResource[resource];
    usage.requestCount++;
    const remaining = response.headers["x-ratelimit-remaining"];
    const reset = response.headers["x-ratelimit-reset"];
    if (remaining !== undefined) {
      usage.rateLimitRemaining = Number(remaining);
    }
    if (reset !== undefined) {
      usage.rateLimitResetMs = Number(reset) * 1000;
    }
    return response;
  };

  octokit.hook.wrap("request", async (request, options) => {
    try {
      const response = await request(options);
      onResponse(response);
      return response;
    } catch (error) {
      if (
        isObject(error) &&
        "response" in error &&
        isObject(error.response) &&
        "headers" in error.response &&
        isObject(error.response.headers)
      ) {
        onResponse(error.response as OctokitResponseShim);
      }
      throw error;
    }
  });

  return octokit;
}
