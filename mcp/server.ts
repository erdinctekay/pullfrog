// this must be imported first
import "./arkConfig.ts";
import { createServer } from "node:net";
import { FastMCP, type Tool } from "fastmcp";
import type { AgentUsage } from "../agents/index.ts";
import { ghPullfrogMcpName } from "../external.ts";
import type { Mode } from "../modes.ts";
import type { PrepResult } from "../prep/index.ts";
import { log } from "../utils/cli.ts";
import type { OctokitWithPlugins } from "../utils/github.ts";
import type { ResolvedPayload } from "../utils/payload.ts";
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

export type BackgroundProcess = {
  pid: number;
  outputPath: string;
  pidPath: string;
};

export type StoredPushDest = {
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
};

export interface ToolState {
  // where we're allowed to push - base repo initially, fork URL for fork PRs
  // set by setupGit, updated by checkout_pr. always set before push validation.
  pushUrl?: string;
  // push destination set by checkout_pr - used as primary source in push_branch
  // because git config reads can fail in certain environments
  pushDest?: StoredPushDest;
  // issue or PR number (same number space in GitHub)
  issueNumber?: number;
  // PR HEAD sha at checkout time — used to detect new commits pushed during a review
  checkoutSha?: string;
  selectedMode?: string;
  backgroundProcesses: Map<string, BackgroundProcess>;
  review?: {
    id: number;
    nodeId: string;
    reviewedSha: string | undefined;
  };
  dependencyInstallation?: {
    status: "not_started" | "in_progress" | "completed" | "failed";
    promise: Promise<PrepResult[]> | undefined;
    results: PrepResult[] | undefined;
  };
  // undefined = no comment yet, number = active comment, null = deliberately deleted
  progressCommentId: number | null | undefined;
  lastProgressBody?: string;
  wasUpdated?: boolean;
  // set by select_mode when Plan + issue_number and plan-comment API returns existing plan (for report_progress target_plan_comment)
  existingPlanCommentId?: number;
  previousPlanBody?: string;
  output?: string;
  usageEntries: AgentUsage[];
}

interface InitToolStateParams {
  progressCommentId: string | undefined;
}

export function initToolState(params: InitToolStateParams): ToolState {
  const parsed = params.progressCommentId ? parseInt(params.progressCommentId, 10) : NaN;
  const resolvedId = Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;

  if (resolvedId) {
    log.info(`» using pre-created progress comment: ${resolvedId}`);
  }

  return {
    progressCommentId: resolvedId,
    backgroundProcesses: new Map(),
    usageEntries: [],
  };
}

export interface ToolContext {
  repo: RunContextData["repo"];
  payload: ResolvedPayload;
  octokit: OctokitWithPlugins;
  githubInstallationToken: string;
  gitToken: string;
  apiToken: string;
  modes: Mode[];
  postCheckoutScript: string | null;
  prApproveEnabled: boolean;
  modeInstructions: Record<string, string>;
  toolState: ToolState;
  runId: number | undefined;
  jobId: string | undefined;
  mcpServerUrl: string;
  tmpdir: string;
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
    SetOutputTool(ctx, outputSchema),
  ];

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
  const server = new FastMCP({ name: ghPullfrogMcpName, version: "0.0.1" });
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
  await new Promise((resolve) => setTimeout(resolve, 200));
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
 */
export async function startMcpHttpServer(
  ctx: ToolContext,
  options?: McpHttpServerOptions
): Promise<{ url: string; [Symbol.asyncDispose]: () => Promise<void> }> {
  const tools = buildOrchestratorTools(ctx, options?.outputSchema);
  const startResult = await selectMcpPort(ctx, tools);

  return {
    url: startResult.url,
    [Symbol.asyncDispose]: async () => {
      await killBackgroundProcesses(ctx.toolState);
      await startResult.server.stop();
    },
  };
}
