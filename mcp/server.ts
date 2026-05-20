// this must be imported first
import "./arkConfig.ts";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { FastMCP, type Tool } from "fastmcp";
import { type AgentId, pullfrogMcpName } from "../external.ts";
import type { Mode } from "../modes.ts";
import type { ToolState } from "../toolState.ts";
import { closeBrowserDaemon } from "../utils/browser.ts";
import type { OctokitWithPlugins } from "../utils/github.ts";
import type { ResolvedPayload } from "../utils/payload.ts";
import type { AccountPlan } from "../utils/runContext.ts";
import type { RunContextData } from "../utils/runContextData.ts";
import { CheckoutPrTool } from "./checkout.ts";
import { GetCheckSuiteLogsTool } from "./checkSuite.ts";
import {
  CreateCommentTool,
  EditCommentTool,
  ReplyToReviewCommentTool,
  ReportProgressTool,
} from "./comment.ts";
import { CommitInfoTool } from "./commitInfo.ts";
import {
  AwaitDependencyInstallationTool,
  StartDependencyInstallationTool,
} from "./dependencies.ts";
import { DeleteBranchTool, GitFetchTool, GitTool, PushBranchTool, PushTagsTool } from "./git.ts";
import { IssueTool } from "./issue.ts";
import { GetIssueCommentsTool } from "./issueComments.ts";
import { GetIssueEventsTool } from "./issueEvents.ts";
import { IssueInfoTool } from "./issueInfo.ts";
import { AddLabelsTool } from "./labels.ts";
import { SetOutputTool } from "./output.ts";
import { CreatePullRequestTool, UpdatePullRequestBodyTool } from "./pr.ts";
import { PullRequestInfoTool } from "./prInfo.ts";
import { CreatePullRequestReviewTool } from "./review.ts";
import {
  GetReviewCommentsTool,
  ListPullRequestReviewsTool,
  ResolveReviewThreadTool,
} from "./reviewComments.ts";
import { SelectModeTool } from "./selectMode.ts";
import { addTools } from "./shared.ts";
import { KillBackgroundTool, ShellTool } from "./shell.ts";
import { UploadFileTool } from "./upload.ts";

export interface ToolContext {
  agentId: AgentId;
  repo: RunContextData["repo"];
  payload: ResolvedPayload;
  octokit: OctokitWithPlugins;
  githubInstallationToken: string;
  gitToken: string;
  apiToken: string;
  modes: Mode[];
  postCheckoutScript: string | null;
  prepushScript: string | null;
  prApproveEnabled: boolean;
  modeInstructions: Record<string, string>;
  toolState: ToolState;
  runId: number | undefined;
  jobId: string | undefined;
  mcpServerUrl: string;
  tmpdir: string;
  // repo-level OSS flag + account-level billing plan. together they decide
  // whether pullfrog is paying for marginal infra — see `isInfraCovered` in
  // the server's `utils/billing.ts`. plan gating for endpoints like the
  // learnings PATCH is enforced server-side via 402, so we pass plan along
  // mostly for future use / observability. see wiki/pricing.md.
  oss: boolean;
  plan: AccountPlan;
  // resolved upstream model specifier (e.g. "google/gemini-3.1-pro-preview").
  // undefined when payload.proxyModel is set or when the alias is unresolvable.
  // used by the schema sanitizer to detect Gemini-routed traffic.
  resolvedModel: string | undefined;
}

const mcpPortStart = 3764;
const mcpPortAttempts = 100;
const mcpHost = "127.0.0.1";
const mcpEndpoint = "/mcp";

function readEnvPort(): number | null {
  const rawPort = process.env.PULLFROG_MCP_PORT;
  if (!rawPort) return null;
  const parsed = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`invalid PULLFROG_MCP_PORT: ${rawPort}`);
  }
  return parsed;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, mcpHost);
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAddressInUse(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("eaddrinuse") || message.includes("address already in use");
}

type JsonSchema = Record<string, unknown>;

function buildCommonTools(ctx: ToolContext, outputSchema?: JsonSchema): Tool<any, any>[] {
  const tools: Tool<any, any>[] = [
    StartDependencyInstallationTool(ctx),
    AwaitDependencyInstallationTool(ctx),
    CreateCommentTool(ctx),
    EditCommentTool(ctx),
    ReplyToReviewCommentTool(ctx),
    IssueTool(ctx),
    IssueInfoTool(ctx),
    GetIssueCommentsTool(ctx),
    GetIssueEventsTool(ctx),
    CreatePullRequestReviewTool(ctx),
    PullRequestInfoTool(ctx),
    CommitInfoTool(ctx),
    CheckoutPrTool(ctx),
    GetReviewCommentsTool(ctx),
    ListPullRequestReviewsTool(ctx),
    ResolveReviewThreadTool(ctx),
    GetCheckSuiteLogsTool(ctx),
    AddLabelsTool(ctx),
    GitTool(ctx),
    GitFetchTool(ctx),
    UploadFileTool(ctx),
  ];

  const isStandalone = ctx.payload.event.trigger === "unknown";
  if (isStandalone || outputSchema) {
    tools.push(SetOutputTool(ctx, outputSchema));
  }

  // MCP shell with filtered env (no secrets leaked to child processes)
  if (ctx.payload.shell === "restricted") {
    tools.push(ShellTool(ctx));
    tools.push(KillBackgroundTool(ctx));
  }

  return tools;
}

function buildOrchestratorTools(ctx: ToolContext, outputSchema?: JsonSchema): Tool<any, any>[] {
  return [
    ...buildCommonTools(ctx, outputSchema),
    ReportProgressTool(ctx),
    SelectModeTool(ctx),
    PushBranchTool(ctx),
    PushTagsTool(ctx),
    DeleteBranchTool(ctx),
    CreatePullRequestTool(ctx),
    UpdatePullRequestBodyTool(ctx),
  ];
}

type McpStartResult = {
  server: FastMCP;
  url: string;
  port: number;
};

async function tryStartMcpServer(
  ctx: ToolContext,
  tools: Tool<any, any>[],
  port: number
): Promise<McpStartResult | null> {
  const server = new FastMCP({ name: pullfrogMcpName, version: "0.0.1" });
  addTools(ctx, server, tools);

  try {
    await server.start({
      transportType: "httpStream",
      httpStream: {
        port,
        host: mcpHost,
        endpoint: mcpEndpoint,
      },
    });
    const url = `http://${mcpHost}:${port}${mcpEndpoint}`;
    return { server, url, port };
  } catch (error) {
    if (!isAddressInUse(error)) {
      throw error;
    }
    try {
      await server.stop();
    } catch {
      // ignore cleanup errors on failed start
    }
    return null;
  }
}

async function selectMcpPort(ctx: ToolContext, tools: Tool<any, any>[]): Promise<McpStartResult> {
  let lastError: unknown = null;

  const requestedPort = readEnvPort();
  if (requestedPort !== null) {
    if (await isPortAvailable(requestedPort)) {
      const requestedResult = await tryStartMcpServer(ctx, tools, requestedPort);
      if (requestedResult) {
        return requestedResult;
      }
    }
  }

  // randomize start offset to reduce collision chance in parallel runs
  const randomOffset = Math.floor(Math.random() * 50);

  for (let offset = 0; offset < mcpPortAttempts; offset++) {
    const port = mcpPortStart + randomOffset + offset;
    try {
      if (!(await isPortAvailable(port))) {
        continue;
      }
      const result = await tryStartMcpServer(ctx, tools, port);
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
      if (!isAddressInUse(error)) {
        throw error;
      }
    }
  }

  const message = getErrorMessage(lastError);
  throw new Error(
    `could not find available mcp port starting at ${mcpPortStart} (last error: ${message})`
  );
}

async function killBackgroundProcesses(toolState: ToolState): Promise<void> {
  const backgroundProcesses = toolState.backgroundProcesses;
  if (backgroundProcesses.size === 0) return;
  for (const proc of backgroundProcesses.values()) {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      // already dead
    }
  }
  await sleep(200);
  for (const proc of backgroundProcesses.values()) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
  backgroundProcesses.clear();
}

type McpHttpServerOptions = {
  outputSchema?: JsonSchema | undefined;
};

/**
 * Start the MCP HTTP server.
 *
 * The returned disposer is idempotent — safe to call multiple times.
 * Callers (e.g. the inner activity-timeout handler in main.ts) may need to
 * stop the server before the `await using` block exits; a subsequent
 * automatic dispose is then a no-op.
 */
export async function startMcpHttpServer(
  ctx: ToolContext,
  options?: McpHttpServerOptions
): Promise<{ url: string; [Symbol.asyncDispose]: () => Promise<void> }> {
  const tools = buildOrchestratorTools(ctx, options?.outputSchema);
  const startResult = await selectMcpPort(ctx, tools);

  let disposed = false;
  return {
    url: startResult.url,
    [Symbol.asyncDispose]: async () => {
      if (disposed) return;
      disposed = true;
      closeBrowserDaemon(ctx.toolState);
      await killBackgroundProcesses(ctx.toolState);
      await startResult.server.stop();
    },
  };
}
