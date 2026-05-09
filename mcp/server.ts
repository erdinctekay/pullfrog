// this must be imported first
import "./arkConfig.ts";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { FastMCP, type Tool } from "fastmcp";
import type { AgentUsage } from "../agents/index.ts";
import { type AgentId, pullfrogMcpName } from "../external.ts";
import type { Mode } from "../modes.ts";
import type { PrepResult } from "../prep/index.ts";
import { closeBrowserDaemon } from "../utils/browser.ts";
import { log } from "../utils/cli.ts";
import type { DiffCoverageState } from "../utils/diffCoverage.ts";
import type { OctokitWithPlugins } from "../utils/github.ts";
import type { ResolvedPayload } from "../utils/payload.ts";
import {
  type ProgressComment,
  type ProgressCommentType,
  parseProgressComment,
} from "../utils/progressComment.ts";
import type { AccountPlan } from "../utils/runContext.ts";
import type { RunContextData } from "../utils/runContextData.ts";
import type { TodoTracker } from "../utils/todoTracking.ts";
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
import type { CommentableLines } from "./review.ts";
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

export type BrowserDaemon = { binDir: string; error?: never } | { binDir?: never; error: string };

export type StoredPushDest = {
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
};

/**
 * mutable per-run record of facts that occurred during execution. shared
 * between the action process and the MCP server (one process — toolState is
 * just a JS object passed by reference into both surfaces).
 *
 * design rule: ToolState is LITERAL. each field records a thing that
 * happened — `review` is set when `create_pull_request_review` succeeded,
 * `finalSummaryWritten` flips when `report_progress` wrote a non-plan body,
 * `selectedMode` is set when `select_mode` was called. fields should never
 * encode the absence of an event ("unsubmittedReview", "missingArtifact"),
 * speculative state, or values derived from other fields.
 *
 * any predicate the rest of the code needs ("the agent picked review mode but
 * never produced a review or progress write") is computed inline at the call
 * site, not stored. derived state in this struct invariably drifts from the
 * literal fields under refactors and is the wrong layer for the check.
 *
 * write narrowly: prefer adding state inside the tool that mutates it (e.g.
 * `create_pull_request_review` populates `toolState.review`) and reading
 * narrowly elsewhere. don't introduce flags from main.ts that mirror what an
 * MCP tool already records.
 */
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
  // commentable lines per file at checkoutSha — captured during checkout_pr so
  // review-time inline-comment validation matches the diff GitHub will anchor
  // to (commit_id=checkoutSha). without this, a PR update between checkout and
  // review would make listFiles (latest HEAD) disagree with the anchor,
  // silently dropping valid comments or letting invalid ones through.
  //
  // commentableLinesPullNumber records WHICH PR this snapshot belongs to. if
  // the agent checks out PR B and then reviews PR A in the same session, the
  // cached snapshot for B would silently mis-validate A's comments — keying
  // by PR number forces a re-fetch when the target changes.
  //
  // commentableLinesCheckoutSha pins the snapshot to the SHA it was built
  // against. if a second checkout_pr for the SAME PR bumps checkoutSha but
  // fails before repopulating the cache (e.g., listFiles rate-limits), the
  // stale snapshot would silently mis-validate comments against the new SHA.
  // comparing both fields forces a re-fetch when either moves.
  commentableLinesByFile?: Map<string, CommentableLines>;
  commentableLinesPullNumber?: number;
  commentableLinesCheckoutSha?: string | undefined;
  // SHA to diff incrementally against — set from event payload on first checkout,
  // then from checkoutSha when review.ts detects new commits mid-review
  beforeSha?: string;
  selectedMode?: string;
  backgroundProcesses: Map<string, BackgroundProcess>;
  browserDaemon?: BrowserDaemon | undefined;
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
  // undefined = no comment yet, object = active comment, null = deliberately deleted
  progressComment: ProgressComment | null | undefined;
  // immutable snapshot: true if a progress comment was pre-created at init time.
  // survives deleteProgressComment so handleAgentResult can still detect "expected but never reported".
  hadProgressComment: boolean;
  lastProgressBody?: string;
  wasUpdated?: boolean;
  // set after a non-plan report_progress successfully writes the final summary.
  // decoupled from todoTracker.enabled so cleanup detection survives API failures.
  finalSummaryWritten?: boolean;
  // set by select_mode when Plan + issue_number and plan-comment API returns existing plan (for report_progress target_plan_comment)
  existingPlanCommentId?: number;
  previousPlanBody?: string;
  // absolute path to the PR summary markdown file the agent edits in place.
  // seeded by main.ts before the agent starts when payload.generateSummary is set;
  // read back at end-of-run to persist to DB.
  summaryFilePath?: string;
  // exact bytes of the seeded snapshot file at run start. compared against
  // the file content at end-of-run to detect "agent never touched it" — in
  // that case persistSummary skips the DB write (saving the seed verbatim
  // would either re-write what the DB already has, on incremental runs, or
  // serialize the placeholder scaffold, on first runs).
  summarySeed?: string;
  // set to true after persistSummary completes once. prevents the error-path
  // call (which exists so a successful agent edit before a crash still gets
  // persisted) from redundantly re-running the DB PATCH on the
  // success-then-late-throw path.
  summaryPersistAttempted?: boolean;
  // absolute path to the rolling repo-level learnings markdown file the
  // agent reads at startup and may edit at end-of-run. seeded by main.ts
  // for every run from `Repo.learnings` (empty file when no learnings
  // exist yet); read back at end-of-run to persist any edits.
  learningsFilePath?: string;
  // exact bytes of the seeded learnings file at run start. compared
  // against the file content at end-of-run to detect "agent never touched
  // it" — in that case persistLearnings skips the DB PATCH (saving the
  // identical content would be a no-op write that wastes a LearningsRevision
  // row and the API round-trip).
  learningsSeed?: string;
  // mirror of `summaryPersistAttempted` for the learnings tmpfile — guards
  // the error-path / exit-signal callers from a redundant second PATCH
  // after the success path already persisted.
  learningsPersistAttempted?: boolean;
  output?: string;
  usageEntries: AgentUsage[];
  model?: string | undefined;
  todoTracker?: TodoTracker | undefined;
  diffCoverage?: DiffCoverageState | undefined;
}

interface InitToolStateParams {
  progressComment: { id: string; type: ProgressCommentType } | undefined;
}

export function initToolState(params: InitToolStateParams): ToolState {
  const resolved = parseProgressComment(params.progressComment);

  if (resolved) {
    log.info(`» using pre-created progress comment: ${resolved.id} (${resolved.type})`);
  }

  return {
    progressComment: resolved,
    hadProgressComment: !!resolved,
    backgroundProcesses: new Map(),
    usageEntries: [],
  };
}

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
  // whether pullfrog is paying for marginal infra — see isInfraCovered in
  // utils/runContext.ts. plan gating for endpoints like the learnings PATCH
  // is enforced server-side via 402, so we pass plan along mostly for future
  // use / observability. see wiki/pricing.md.
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
