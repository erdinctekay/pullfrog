// this must be imported first
import "./arkConfig.ts";
import { createServer } from "node:net";
import { FastMCP, type Tool } from "fastmcp";
import type { Agent, AgentUsage } from "../agents/index.ts";
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

export type StoredPushDest = {
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
};

export type SubagentStatus = "running" | "completed" | "failed";

export type SubagentState = {
  id: string;
  status: SubagentStatus;
  mode: string;
  stdoutFilePath: string;
  output: string | undefined;
  usage: AgentUsage | undefined;
  startedAt: number;
  keepAliveInterval: ReturnType<typeof setInterval> | undefined;
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
  selectedMode?: string;
  // per-subagent lifecycle tracking (keyed by subagent uuid)
  subagents: Map<string, SubagentState>;
  // set while a subagent is running — routes set_output to the correct subagent and prevents nesting
  activeSubagentId: string | undefined;
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
  // undefined = no comment yet, number = active comment, null = deliberately deleted
  progressCommentId: number | null | undefined;
  lastProgressBody?: string;
  wasUpdated?: boolean;
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
    subagents: new Map(),
    activeSubagentId: undefined,
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
  agent: Agent;
  modes: Mode[];
  postCheckoutScript: string | null;
  toolState: ToolState;
  runId: string;
  jobId: string | undefined;
  // set after MCP server starts — used by delegate tool to pass URL to subagents
  mcpServerUrl: string;
  tmpdir: string;
}

/**
 * tool names that are only available to the orchestrator.
 * subagent MCP servers are started with these tools excluded.
 *
 * - delegation tools: only the orchestrator can spawn/manage subagents
 * - remote-mutating tools: subagents work locally; the orchestrator pushes and creates PRs
 */
export const ORCHESTRATOR_ONLY_TOOLS = [
  "select_mode",
  "delegate",
  "ask_question",
  "push_branch",
  "push_tags",
  "delete_branch",
  "create_pull_request",
  "update_pull_request_body",
] as const;

import { log } from "../utils/cli.ts";
import type { RunContextData } from "../utils/runContextData.ts";
import { AskQuestionTool } from "./askQuestion.ts";
import { CheckoutPrTool } from "./checkout.ts";
import { GetCheckSuiteLogsTool } from "./checkSuite.ts";
import {
  CreateCommentTool,
  EditCommentTool,
  ReplyToReviewCommentTool,
  ReportProgressTool,
} from "./comment.ts";
import { CommitInfoTool } from "./commitInfo.ts";
import { DelegateTool } from "./delegate.ts";
import {
  AwaitDependencyInstallationTool,
  StartDependencyInstallationTool,
} from "./dependencies.ts";
import {
  FileDeleteTool,
  FileEditTool,
  FileReadTool,
  FileWriteTool,
  ListDirectoryTool,
} from "./file.ts";
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

// tools shared by both orchestrator and subagent servers
function buildCommonTools(ctx: ToolContext): Tool<any, any>[] {
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
    SetOutputTool(ctx),
    FileReadTool(ctx),
    FileWriteTool(ctx),
    FileEditTool(ctx),
    FileDeleteTool(ctx),
    ListDirectoryTool(ctx),
    ReportProgressTool(ctx),
  ];

  // only add ShellTool when shell is "restricted"
  // - "enabled": native shell only (no MCP shell needed)
  // - "restricted": MCP shell only (native blocked, env filtered)
  // - "disabled": no shell at all
  if (ctx.payload.shell === "restricted") {
    tools.push(ShellTool(ctx));
    tools.push(KillBackgroundTool(ctx));
  }

  return tools;
}

// orchestrator gets common tools + delegation + remote-mutating tools
function buildOrchestratorTools(ctx: ToolContext): Tool<any, any>[] {
  return [
    ...buildCommonTools(ctx),
    SelectModeTool(ctx),
    DelegateTool(ctx),
    AskQuestionTool(ctx),
    PushBranchTool(ctx),
    PushTagsTool(ctx),
    DeleteBranchTool(ctx),
    CreatePullRequestTool(ctx),
    UpdatePullRequestBodyTool(ctx),
  ];
}

// subagent gets only common tools (no delegation, no remote mutation)
function buildSubagentTools(ctx: ToolContext): Tool<any, any>[] {
  return buildCommonTools(ctx);
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

/**
 * Start the orchestrator MCP HTTP server (has all tools including push/PR/delegation).
 */
export async function startMcpHttpServer(
  ctx: ToolContext
): Promise<{ url: string; [Symbol.asyncDispose]: () => Promise<void> }> {
  const tools = buildOrchestratorTools(ctx);
  const startResult = await selectMcpPort(ctx, tools);

  return {
    url: startResult.url,
    [Symbol.asyncDispose]: async () => {
      await killBackgroundProcesses(ctx.toolState);
      await startResult.server.stop();
    },
  };
}

export type ManagedMcpServer = {
  url: string;
  stop: () => Promise<void>;
};

/**
 * Start a per-subagent MCP server (common tools only — no push/PR/delegation).
 * Each subagent gets its own server; call stop() when the subagent completes.
 *
 * The subagent gets its own shallow copy of toolState so scalar writes
 * (pushUrl, pushDest, selectedMode, etc.) don't mutate the orchestrator's state.
 * Shared references (subagents Map, usageEntries array, dependencyInstallation)
 * are intentionally shared for coordination (set_output routing, usage tracking).
 */
export async function startSubagentMcpServer(ctx: ToolContext): Promise<ManagedMcpServer> {
  const subagentToolState: ToolState = {
    ...ctx.toolState,
    backgroundProcesses: new Map(),
  };
  const subagentCtx: ToolContext = { ...ctx, toolState: subagentToolState };
  const tools = buildSubagentTools(subagentCtx);
  const startResult = await selectMcpPort(subagentCtx, tools);
  return { url: startResult.url, stop: () => startResult.server.stop() };
}
