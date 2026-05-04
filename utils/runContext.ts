import type { PushPermission, ShellPermission } from "../external.ts";
import { apiFetch } from "./apiFetch.ts";
import type { RepoContext } from "./github.ts";

export interface Mode {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

export interface RepoSettings {
  model: string | null;
  modes: Mode[];
  setupScript: string | null;
  postCheckoutScript: string | null;
  prepushScript: string | null;
  stopScript: string | null;
  push: PushPermission;
  shell: ShellPermission;
  prApproveEnabled: boolean;
  modeInstructions: Record<string, string>;
  learnings: string | null;
  envAllowlist: string | null;
}

export interface RunContext {
  settings: RepoSettings;
  apiToken: string;
  oss: boolean;
  proxyModel?: string | undefined;
  dbSecrets?: Record<string, string> | undefined;
}

const defaultSettings: RepoSettings = {
  model: null,
  modes: [],
  setupScript: null,
  postCheckoutScript: null,
  prepushScript: null,
  stopScript: null,
  push: "restricted",
  shell: "restricted",
  prApproveEnabled: false,
  modeInstructions: {},
  learnings: null,
  envAllowlist: null,
};

const defaultRunContext: RunContext = {
  settings: defaultSettings,
  apiToken: "",
  oss: false,
};

/**
 * fetch run context from Pullfrog API
 * returns settings + API token for subsequent calls
 * returns defaults if fetch fails
 */
export async function fetchRunContext(params: {
  token: string;
  repoContext: RepoContext;
  oidcToken?: string | undefined;
}): Promise<RunContext> {
  const timeoutMs = 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
    };
    if (params.oidcToken) {
      headers["X-GitHub-OIDC-Token"] = params.oidcToken;
    }

    const response = await apiFetch({
      path: `/api/repo/${params.repoContext.owner}/${params.repoContext.name}/run-context`,
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return defaultRunContext;
    }

    const data = (await response.json()) as {
      settings: RepoSettings | null;
      apiToken: string;
      oss?: boolean;
      proxyModel?: string;
      dbSecrets?: Record<string, string>;
    } | null;

    if (data === null) {
      return defaultRunContext;
    }

    return {
      settings: {
        ...defaultSettings,
        ...data.settings,
        modes: data.settings?.modes ?? [],
        setupScript: data.settings?.setupScript ?? null,
        postCheckoutScript: data.settings?.postCheckoutScript ?? null,
        prepushScript: data.settings?.prepushScript ?? null,
        stopScript: data.settings?.stopScript ?? null,
      },
      apiToken: data.apiToken,
      oss: data.oss ?? false,
      proxyModel: data.proxyModel,
      dbSecrets: data.dbSecrets,
    };
  } catch {
    clearTimeout(timeoutId);
    return defaultRunContext;
  }
}
