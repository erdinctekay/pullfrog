import type { AgentName, PushPermission, ShellPermission, ToolPermission } from "../external.ts";
import { apiFetch } from "./apiFetch.ts";
import type { RepoContext } from "./github.ts";

export interface Mode {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

export interface RepoSettings {
  defaultAgent: AgentName | null;
  modes: Mode[];
  setupScript: string | null;
  postCheckoutScript: string | null;
  repoInstructions: string;
  web: ToolPermission;
  search: ToolPermission;
  push: PushPermission;
  shell: ShellPermission;
}

export interface RunContext {
  settings: RepoSettings;
  apiToken: string;
}

const defaultSettings: RepoSettings = {
  defaultAgent: null,
  modes: [],
  setupScript: null,
  postCheckoutScript: null,
  repoInstructions: "",
  web: "enabled",
  search: "enabled",
  push: "restricted",
  shell: "restricted",
};

const defaultRunContext: RunContext = {
  settings: defaultSettings,
  apiToken: "",
};

/**
 * fetch run context from Pullfrog API
 * returns settings + API token for subsequent calls
 * returns defaults if fetch fails
 */
export async function fetchRunContext(params: {
  token: string;
  repoContext: RepoContext;
}): Promise<RunContext> {
  const timeoutMs = 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await apiFetch({
      path: `/api/repo/${params.repoContext.owner}/${params.repoContext.name}/run-context`,
      headers: {
        Authorization: `Bearer ${params.token}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return defaultRunContext;
    }

    const data = (await response.json()) as {
      settings: RepoSettings | null;
      apiToken: string;
    } | null;

    if (data === null) {
      return defaultRunContext;
    }

    return {
      settings: {
        ...defaultSettings,
        ...data.settings,
        // ensure arrays are never undefined (API may omit new fields for existing repos)
        modes: data.settings?.modes ?? [],
        setupScript: data.settings?.setupScript ?? null,
        postCheckoutScript: data.settings?.postCheckoutScript ?? null,
      },
      apiToken: data.apiToken,
    };
  } catch {
    clearTimeout(timeoutId);
    return defaultRunContext;
  }
}
