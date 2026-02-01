import "./arkConfig.ts";
// this must be imported first
import { FastMCP, type Tool } from "fastmcp";
import { createServer } from "node:net";
import type { Agent } from "../agents/index.ts";
import { ghPullfrogMcpName } from "../external.ts";
import type { Mode } from "../modes.ts";
import type { PrepResult } from "../prep/index.ts";
import type { OctokitWithPlugins } from "../utils/github.ts";
import type { ResolvedPayload } from "../utils/payload.ts";

export type BackgroundProcess = {
  pid: number;
  outputPath: string;
  pidPath: string;
};

export interface ToolState {
  prNumber?: number;
  issueNumber?: number;
  selectedMode?: string;
  backgroundProcesses: Map<string, BackgroundProcess>;
  review?: {
    id: number;
    nodeId: string;
  };
  dependencyInstallation?: {
    status: "not_started" | "in_progress" | "completed" | "failed";
    promise: Promise<PrepResult[]> | undefined;
    results: PrepResult[] | undefined;
  };
  progressCommentId: number | null;
  lastProgressBody?: string;
  wasUpdated?: boolean;
  output?: string;
}

import type { ResolveRunResult } from "../utils/workflow.ts";

interface InitToolStateParams {
  runInfo: ResolveRunResult;
}

export function initToolState(ctx: InitToolStateParams): ToolState {
  const progressCommentIdStr = ctx.runInfo.workflowRunInfo.progressCommentId;
  const progressCommentId = progressCommentIdStr ? parseInt(progressCommentIdStr, 10) : null;
  const resolvedId = Number.isNaN(progressCommentId) ? null : progressCommentId;

  return {
    progressCommentId: resolvedId,
    backgroundProcesses: new Map(),
  };
}

export interface ToolContext {
  repo: RunContextData["repo"];
  payload: ResolvedPayload;
  octokit: OctokitWithPlugins;
  githubInstallationToken: string;
  apiToken: string;
  agent: Agent;
  modes: Mode[];
  toolState: ToolState;
  runId: string;
  jobId: string | undefined;
}

import type { RunContextData } from "../utils/runContextData.ts";
import { BashTool, KillBackgroundTool } from "./bash.ts";
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
import { CommitFilesTool, CreateBranchTool, PushBranchTool } from "./git.ts";
import { IssueTool } from "./issue.ts";
import { GetIssueCommentsTool } from "./issueComments.ts";
import { GetIssueEventsTool } from "./issueEvents.ts";
import { IssueInfoTool } from "./issueInfo.ts";
import { AddLabelsTool } from "./labels.ts";
import { SetOutputTool } from "./output.ts";
import { CreatePullRequestTool } from "./pr.ts";
import { PullRequestInfoTool } from "./prInfo.ts";
import { CreatePullRequestReviewTool } from "./review.ts";
import { GetReviewCommentsTool, ListPullRequestReviewsTool } from "./reviewComments.ts";
import { SelectModeTool } from "./selectMode.ts";
import { addTools } from "./shared.ts";
import { UploadFileTool } from "./upload.ts";

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
function buildTools(ctx: ToolContext): Tool<any, any>[] {
  const tools: Tool<any, any>[] = [
    SelectModeTool(ctx),
    StartDependencyInstallationTool(ctx),
    AwaitDependencyInstallationTool(ctx),
    CreateCommentTool(ctx),
    EditCommentTool(ctx),
    ReplyToReviewCommentTool(ctx),
    IssueTool(ctx),
    IssueInfoTool(ctx),
    GetIssueCommentsTool(ctx),
    GetIssueEventsTool(ctx),
    CreatePullRequestTool(ctx),
    CreatePullRequestReviewTool(ctx),
    PullRequestInfoTool(ctx),
    CommitInfoTool(ctx),
    CheckoutPrTool(ctx),
    GetReviewCommentsTool(ctx),
    ListPullRequestReviewsTool(ctx),
    GetCheckSuiteLogsTool(ctx),
    AddLabelsTool(ctx),
    CreateBranchTool(ctx),
    CommitFilesTool(ctx),
    PushBranchTool(ctx),
    UploadFileTool(ctx),
    SetOutputTool(ctx),
  ];

  // only add BashTool when bash is "restricted"
  // - "enabled": native bash only (no MCP bash needed)
  // - "restricted": MCP bash only (native blocked, env filtered)
  // - "disabled": no bash at all
  if (ctx.payload.bash === "restricted") {
    tools.push(BashTool(ctx));
    tools.push(KillBackgroundTool(ctx));
  }

  tools.push(ReportProgressTool(ctx));

  return tools;
}

type McpStartResult = {
  server: FastMCP;
  url: string;
  port: number;
};

async function tryStartMcpServer(ctx: ToolContext, port: number): Promise<McpStartResult | null> {
  const server = new FastMCP({
    name: ghPullfrogMcpName,
    version: "0.0.1",
  });
  const tools = buildTools(ctx);
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

async function selectMcpPort(ctx: ToolContext): Promise<McpStartResult> {
  let lastError: unknown = null;

  const requestedPort = readEnvPort();
  if (requestedPort !== null) {
    if (await isPortAvailable(requestedPort)) {
      const requestedResult = await tryStartMcpServer(ctx, requestedPort);
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
      const result = await tryStartMcpServer(ctx, port);
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

/**
 * Start the MCP HTTP server and return the URL and close function
 */
export async function startMcpHttpServer(
  ctx: ToolContext
): Promise<{ url: string; [Symbol.asyncDispose]: () => Promise<void> }> {
  const startResult = await selectMcpPort(ctx);

  return {
    url: startResult.url,
    [Symbol.asyncDispose]: async () => {
      await killBackgroundProcesses(ctx.toolState);
      await startResult.server.stop();
    },
  };
}
