// changes to tool permissions should be reflected in wiki/granular-tools.md

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as core from "@actions/core";
import { deleteProgressComment, reportProgress } from "./mcp/comment.ts";
import { startInstallation } from "./mcp/dependencies.ts";
import {
  initToolState,
  startMcpHttpServer,
  type ToolContext,
  type ToolState,
} from "./mcp/server.ts";
import { computeModes } from "./modes.ts";
import {
  type ActivityTimeout,
  createProcessOutputActivityTimeout,
  DEFAULT_ACTIVITY_CHECK_INTERVAL_MS,
  DEFAULT_ACTIVITY_TIMEOUT_MS,
} from "./utils/activity.ts";
import { resolveAgent, resolveModel } from "./utils/agent.ts";
import { apiFetch } from "./utils/apiFetch.ts";
import { validateAgentApiKey } from "./utils/apiKeys.ts";
import { isLocalApiUrl } from "./utils/apiUrl.ts";
import { resolveBody } from "./utils/body.ts";
import { formatUsageSummary, log, writeSummary } from "./utils/cli.ts";
import { recordDiffReadFromToolUse } from "./utils/diffCoverage.ts";
import { reportErrorToComment } from "./utils/errorReport.ts";
import { onExitSignal } from "./utils/exitHandler.ts";
import { resolveGit, setGitAuthServer } from "./utils/gitAuth.ts";
import { startGitAuthServer } from "./utils/gitAuthServer.ts";
import { createOctokit, writeGitHubUsageSummaryToFile } from "./utils/github.ts";
import { resolveInstructions } from "./utils/instructions.ts";
import { readLearningsFile, seedLearningsFile } from "./utils/learnings.ts";
import { executeLifecycleHook } from "./utils/lifecycle.ts";
import { normalizeEnv } from "./utils/normalizeEnv.ts";
import { aggregateUsage, patchWorkflowRunFields } from "./utils/patchWorkflowRunFields.ts";
import { resolvePayload, resolvePromptInput } from "./utils/payload.ts";
import { isRouterKeylimitExhaustedError } from "./utils/providerErrors.ts";
import { readSummaryFile, seedSummaryFile } from "./utils/prSummary.ts";
import { postReviewCleanup } from "./utils/reviewCleanup.ts";
import { handleAgentResult } from "./utils/run.ts";
import { type AccountPlan, isInfraCovered } from "./utils/runContext.ts";
import { resolveRunContextData } from "./utils/runContextData.ts";
import { setEnvAllowlist } from "./utils/secrets.ts";
import { createTempDirectory, setupGit } from "./utils/setup.ts";
import { killTrackedChildren } from "./utils/subprocess.ts";
import { resolveTimeoutMs, TIMEOUT_DISABLED } from "./utils/time.ts";
import { Timer } from "./utils/timer.ts";
import { createTodoTracker } from "./utils/todoTracking.ts";
import { getJobToken, resolveTokens } from "./utils/token.ts";
import { resolveRun } from "./utils/workflow.ts";

export { Inputs } from "./utils/payload.ts";

export interface MainResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  result?: string | undefined;
}

function resolveOutputSchema(): Record<string, unknown> | undefined {
  const raw = core.getInput("output_schema");
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`invalid output_schema: not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid output_schema: must be a JSON object`);
  }
  log.info("» structured output schema provided — output will be required");
  return parsed as Record<string, unknown>;
}

function resolveTimeoutForLog(timeout: string | undefined): string {
  if (!timeout) return "1h (default)";
  if (timeout === TIMEOUT_DISABLED) return "none (disabled)";
  return timeout;
}

function resolveModelForLog(ctx: {
  payload: ResolvedPayload;
  resolvedModel: string | undefined;
}): string {
  const envModel = process.env.PULLFROG_MODEL?.trim();
  if (envModel) return `${envModel} (override via PULLFROG_MODEL)`;
  if (ctx.payload.proxyModel) return `${ctx.payload.proxyModel} (proxy)`;
  if (ctx.resolvedModel && ctx.payload.model && ctx.payload.model !== ctx.resolvedModel) {
    return `${ctx.resolvedModel} (resolved from ${ctx.payload.model})`;
  }
  if (ctx.resolvedModel) return ctx.resolvedModel;
  if (ctx.payload.model) return `${ctx.payload.model} (unresolved)`;
  return "auto";
}

function resolveAgentForLog(ctx: { agentName: string; resolvedModel: string | undefined }): string {
  const envAgent = process.env.PULLFROG_AGENT?.trim();
  if (envAgent && envAgent === ctx.agentName) {
    return `${ctx.agentName} (override via PULLFROG_AGENT)`;
  }
  if (ctx.agentName === "claude" && ctx.resolvedModel) {
    return `${ctx.agentName} (auto-selected for ${ctx.resolvedModel})`;
  }
  return ctx.agentName;
}

import type { ResolvedPayload } from "./utils/payload.ts";

interface OidcCredentials {
  requestUrl: string;
  requestToken: string;
}

/**
 * Billing-layer error surfaced from `/api/proxy-token` as a 402. User-actionable
 * — distinct from TransientError (503 / transient sync issue) so the job
 * summary + PR comment can use affirmative "you need to do X" copy rather than
 * the ambiguous "billing error" label that makes transient outages look like
 * the user's fault.
 *
 * `code` is a server-side discriminator: `router_requires_card` (no card + no
 * wallet balance on Router), or null for unclassified. `declineCode` is
 * Stripe's more specific sub-reason on `card_declined` (e.g.
 * `insufficient_funds`, `lost_card`). `needsReauthentication` is the 3DS case
 * broken out for convenience.
 */
class BillingError extends Error {
  code: string | null;
  declineCode: string | null;
  needsReauthentication: boolean;

  constructor(
    message: string,
    opts: {
      code?: string | null;
      declineCode?: string | null;
      needsReauthentication?: boolean;
    } = {}
  ) {
    super(message);
    this.name = "BillingError";
    this.code = opts.code ?? null;
    this.declineCode = opts.declineCode ?? null;
    this.needsReauthentication = opts.needsReauthentication ?? false;
  }
}

/**
 * Transient service failures from `/api/proxy-token` (503: partial OpenRouter
 * usage sync, DB flake, in-flight payment intent). Not the user's fault — the
 * summary uses "temporarily unavailable" framing, and the non-zero exit lets
 * GH Actions apply whatever retry policy the workflow has configured.
 */
class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

/**
 * Deep link into the right console section for the failing account. Anchors
 * are defined in `app/console/[owner]/page.tsx` (`#billing`, `#model-access`).
 * `owner` is the GitHub login of the repo's account — i.e. the org or user
 * that pays for this repo's runs, which is the right scope for billing.
 */
function billingConsoleUrl(owner: string, anchor: "billing" | "model-access"): string {
  return `https://pullfrog.com/console/${encodeURIComponent(owner)}#${anchor}`;
}

/**
 * Render a BillingError as user-facing markdown (shared between GH job summary
 * and the PR progress comment). Goals:
 *
 *   - quiet, not alarmist — bold first line instead of an `### ❌` H3, since
 *     the comment already has Pullfrog branding in the footer
 *   - actionable — every branch ends in a single CTA deep-linked to the
 *     correct section of the owner's console
 *   - honest — say what actually went wrong (card declined vs. balance
 *     empty vs. 3DS required), don't lump them under "billing error"
 *
 * Branches:
 *   - `router_requires_card`: user is on Router mode with no card AND no
 *     wallet balance. Lead with the carrot ($20 free credit), link to
 *     `#model-access` where the Add Card flow lives.
 *   - `router_balance_exhausted`: user has a card on file but auto-reload is
 *     disabled and they've spent past their $5 overdraft buffer. Frame as
 *     "balance ran out" and surface both remediation paths (top up, or flip
 *     on auto-reload).
 *   - `router_keylimit_exhausted`: OpenRouter rejected mid-run because the
 *     per-run key budget was exhausted while the agent was working. The
 *     wallet is now negative; same remediation as `router_balance_exhausted`
 *     but framed for the after-the-fact case ("this run was cut short").
 *   - `needsReauthentication`: issuer requires 3DS on every off-session
 *     charge. Re-adding the card won't help — the only escape is a manual
 *     top-up where 3DS runs interactively in Stripe Checkout.
 *   - `declineCode` set: Stripe declined a real charge. Show the sub-code
 *     so support can act on it; tell the user we'll retry on next dispatch.
 *   - default: balance hit zero with no in-flight charge (auto-reload off
 *     or amount below threshold). Direct them to top up or enable auto-reload.
 */
function formatBillingErrorSummary(error: BillingError, owner: string): string {
  if (error.code === "router_requires_card") {
    return [
      "**Add a card to start using Pullfrog Router.**",
      "",
      "Router proxies OpenRouter at raw cost — no platform markup, and your first $20 of usage is on us.",
      "",
      `[Add a card →](${billingConsoleUrl(owner, "model-access")})`,
    ].join("\n");
  }

  if (error.code === "router_balance_exhausted") {
    return [
      "**Your Pullfrog Router balance is exhausted.**",
      "",
      "You have a card on file but auto-reload is disabled, so runs paused once your balance went past the overdraft buffer.",
      "",
      `[Top up balance →](${billingConsoleUrl(owner, "billing")}) · [Enable auto-reload →](${billingConsoleUrl(owner, "model-access")})`,
    ].join("\n");
  }

  if (error.code === "router_keylimit_exhausted") {
    return [
      "**This run was cut short — your Pullfrog Router balance ran out mid-run.**",
      "",
      "OpenRouter stopped the agent because the per-run budget was exhausted. Your wallet is now negative; top up or enable auto-reload to keep runs flowing.",
      "",
      `[Top up balance →](${billingConsoleUrl(owner, "billing")}) · [Enable auto-reload →](${billingConsoleUrl(owner, "model-access")})`,
    ].join("\n");
  }

  if (error.needsReauthentication) {
    const code = error.declineCode ?? "authentication_required";
    return [
      `**Your card issuer requires 3D Secure on every charge** (\`${code}\`).`,
      "",
      "Pullfrog can't complete a 3DS challenge from inside a workflow. Top up your Router balance once in Stripe Checkout — subsequent runs draw from the prepaid balance without re-triggering 3DS.",
      "",
      `[Top up balance →](${billingConsoleUrl(owner, "billing")})`,
    ].join("\n");
  }

  if (error.declineCode) {
    return [
      `**Your card was declined** (\`${error.declineCode}\`).`,
      "",
      "Update your payment method and Pullfrog will retry on the next run.",
      "",
      `[Update payment method →](${billingConsoleUrl(owner, "billing")})`,
    ].join("\n");
  }

  return [
    "**Your Pullfrog balance is empty.**",
    "",
    "Top up your balance or enable auto-reload to keep runs flowing.",
    "",
    `[Manage billing →](${billingConsoleUrl(owner, "billing")})`,
  ].join("\n");
}

/**
 * Render a TransientError as user-facing markdown. Distinct framing from
 * BillingError so the user doesn't read an alarm and assume their card
 * failed — this branch is "our fault, retry shortly", not theirs.
 */
function formatTransientErrorSummary(error: TransientError, owner: string): string {
  return [
    "**Pullfrog billing is temporarily unavailable.**",
    "",
    error.message,
    "",
    `Usually transient — the next dispatch should succeed. If it persists, check [status.pullfrog.com](https://status.pullfrog.com) or [your console](${billingConsoleUrl(owner, "billing")}).`,
  ].join("\n");
}

async function mintProxyKey(ctx: {
  oidcCredentials: OidcCredentials | null;
  repo: { owner: string; name: string };
}): Promise<string | null> {
  try {
    const headers = await buildProxyTokenHeaders(ctx);
    if (!headers) return null;

    const response = await apiFetch({
      path: "/api/proxy-token",
      method: "POST",
      headers,
    });

    if (response.status === 402) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        code?: string;
        declineCode?: string;
        needsReauthentication?: boolean;
      } | null;
      throw new BillingError(body?.error ?? "insufficient balance", {
        code: body?.code ?? null,
        declineCode: body?.declineCode ?? null,
        needsReauthentication: body?.needsReauthentication ?? false,
      });
    }

    // 503 = transient sync issue (partial OpenRouter failure, DB flake,
    // in-flight top-up). Not the user's fault — TransientError renders a
    // "temporarily unavailable" summary instead of the "billing error"
    // label that BillingError uses.
    if (response.status === 503) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new TransientError(
        body?.error ?? "billing service temporarily unavailable — retry shortly"
      );
    }

    if (!response.ok) {
      log.warning(`proxy key mint failed (${response.status})`);
      return null;
    }

    const data = (await response.json()) as { key: string };
    return data.key;
  } catch (error) {
    if (error instanceof BillingError) throw error;
    if (error instanceof TransientError) throw error;
    log.warning(`proxy key mint error: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  }
}

/**
 * choose how to authenticate the `/api/proxy-token` request:
 *
 * - production: mint a fresh OIDC token via `core.getIDToken` and send as
 *   `Authorization: Bearer …` (the server verifies it cryptographically).
 * - local dev (no OIDC + `API_URL` is localhost): send `x-dev-repo:
 *   owner/repo` instead. the server-side route only honors this header
 *   when `NODE_ENV === "development"`, so prod is never reachable through
 *   this branch even if the action is misconfigured.
 *
 * returns null when neither path is available — caller treats as soft skip.
 */
async function buildProxyTokenHeaders(ctx: {
  oidcCredentials: OidcCredentials | null;
  repo: { owner: string; name: string };
}): Promise<Record<string, string> | null> {
  if (ctx.oidcCredentials) {
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = ctx.oidcCredentials.requestUrl;
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = ctx.oidcCredentials.requestToken;
    const oidcToken = await core.getIDToken("pullfrog-api");
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    return { Authorization: `Bearer ${oidcToken}` };
  }
  if (isLocalApiUrl()) {
    log.info(`» proxy: dev bypass (x-dev-repo) for ${ctx.repo.owner}/${ctx.repo.name}`);
    return { "x-dev-repo": `${ctx.repo.owner}/${ctx.repo.name}` };
  }
  return null;
}

async function resolveProxyModel(ctx: {
  payload: ResolvedPayload;
  oss: boolean;
  plan: AccountPlan;
  proxyModel?: string | undefined;
  oidcCredentials: OidcCredentials | null;
  repo: { owner: string; name: string };
}): Promise<void> {
  // env override = BYOK escape hatch, don't proxy
  if (process.env.PULLFROG_MODEL?.trim()) return;

  const needsProxy = isInfraCovered({ isOss: ctx.oss, plan: ctx.plan }) && ctx.proxyModel;
  if (!needsProxy) return;

  // dev affordance: when talking to a localhost API, the server-side
  // x-dev-repo bypass replaces OIDC verification, so a play run can
  // exercise the proxy/router/oss path without GitHub Actions OIDC.
  if (!ctx.oidcCredentials && !isLocalApiUrl()) {
    log.warning("» proxy requested but no OIDC credentials available — skipping");
    return;
  }

  const key = await mintProxyKey({ oidcCredentials: ctx.oidcCredentials, repo: ctx.repo });
  if (!key) return;

  process.env.OPENROUTER_API_KEY = key;
  core.setSecret(key);
  ctx.payload.proxyModel = ctx.proxyModel;
  const label = ctx.oss ? "oss" : "router";
  log.info(`» proxy: ${label} → ${ctx.proxyModel}`);
}

/**
 * Fetch the most recent persisted PR summary snapshot for this PR.
 * Returns null on first-time PRs, when summary is disabled, or on any error.
 * Best-effort: a transient API failure should not block the run.
 */
async function fetchPreviousSnapshot(ctx: ToolContext, prNumber: number): Promise<string | null> {
  if (!ctx.githubInstallationToken) return null;
  try {
    const response = await apiFetch({
      path: `/api/repo/${ctx.repo.owner}/${ctx.repo.name}/pr/${prNumber}/summary-comment`,
      method: "GET",
      headers: { authorization: `Bearer ${ctx.githubInstallationToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { snapshot?: string | null };
    return typeof data.snapshot === "string" && data.snapshot.length > 0 ? data.snapshot : null;
  } catch {
    return null;
  }
}

/**
 * Read the agent-edited PR summary tmpfile and persist to `WorkflowRun.summarySnapshot`.
 *
 * Best-effort: any failure is logged and does not affect the run's success
 * status. Skips the PATCH when the file is byte-identical to its seed —
 * persisting the seed verbatim would either re-write what the DB already has
 * (on incremental runs) or serialize the placeholder scaffold (on first
 * runs), neither of which is useful.
 */
/**
 * Read the agent-edited repo-level learnings tmpfile and PATCH it to
 * `Repo.learnings`.
 *
 * Best-effort: any failure is logged and does not affect the run's success
 * status. Skips the PATCH when the file is byte-trim-identical to its seed —
 * the agent didn't touch it, so writing the same content back would just
 * burn a `LearningsRevision` row and an API round-trip.
 *
 * `model` is forwarded so `LearningsRevision.model` keeps populating; it
 * powers the per-revision attribution badge in the UI history view.
 */
async function persistLearnings(ctx: ToolContext): Promise<void> {
  const filePath = ctx.toolState.learningsFilePath;
  if (!filePath) return;
  if (ctx.toolState.learningsPersistAttempted) return;
  ctx.toolState.learningsPersistAttempted = true;
  const current = await readLearningsFile(filePath);
  if (current === null) {
    log.debug(`learnings tmpfile missing or unreadable at ${filePath} — skipping persist`);
    return;
  }
  const seed = ctx.toolState.learningsSeed?.trim() ?? "";
  if (current === seed) {
    log.debug("learnings tmpfile unchanged from seed — skipping persist");
    return;
  }
  try {
    const response = await apiFetch({
      path: `/api/repo/${ctx.repo.owner}/${ctx.repo.name}/learnings`,
      method: "PATCH",
      headers: {
        authorization: `Bearer ${ctx.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        learnings: current,
        model: ctx.toolState.model,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = await response.text().catch(() => "(no body)");
      log.debug(`learnings persist failed (${response.status}): ${error}`);
      return;
    }
    log.info("» learnings updated");
  } catch (err) {
    log.debug(`learnings persist failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function persistSummary(ctx: ToolContext): Promise<void> {
  const filePath = ctx.toolState.summaryFilePath;
  if (!filePath) return;
  // already-completed guard: the error-path call (success path persisted,
  // then a late step threw) and the SIGINT/SIGTERM handler all funnel
  // through here; the first one to arrive wins.
  if (ctx.toolState.summaryPersistAttempted) return;
  ctx.toolState.summaryPersistAttempted = true;
  const snapshot = await readSummaryFile(filePath);
  if (!snapshot) {
    log.debug(`pr summary tmpfile missing or invalid at ${filePath} — skipping persist`);
    return;
  }
  // soft gate: agent never touched the seeded file. saving the seed back
  // is a no-op at best (incremental run — DB already has it) and a bug at
  // worst (first run — serializes the placeholder italics). log a warning
  // so the failure mode is visible in CI without flipping the run to
  // failed.
  const seed = ctx.toolState.summarySeed?.trim();
  if (seed !== undefined && snapshot === seed) {
    log.warning(
      "» pr summary tmpfile unchanged from seed — skipping persist (agent did not edit it)"
    );
    return;
  }
  await patchWorkflowRunFields(ctx, { summarySnapshot: snapshot }).catch((err) => {
    log.debug(`pr summary persist failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

// fall back to the agent's final assistant message when the agent never
// called report_progress (e.g. schedule/workflow_dispatch runs that have no
// PR/issue context to comment on). lastProgressBody wins when present so we
// don't double up the progress comment body in the job summary.
async function writeJobSummary(toolState: ToolState, finalOutput?: string): Promise<void> {
  const usageSummary = formatUsageSummary(toolState.usageEntries);
  const body = toolState.lastProgressBody || finalOutput;
  const summaryParts = [body, usageSummary].filter(Boolean);
  if (summaryParts.length > 0) {
    await writeSummary(summaryParts.join("\n\n"));
  }
}

export async function main(): Promise<MainResult> {
  // normalize env var names to uppercase (handles case-insensitive workflow files)
  normalizeEnv();

  // write usage summary on SIGINT/SIGTERM so the worker can read it after sandbox.exec
  const usageSummaryPath = process.env.PULLFROG_USAGE_SUMMARY_PATH;
  if (usageSummaryPath) {
    onExitSignal(() => writeGitHubUsageSummaryToFile(usageSummaryPath));
  }

  const timer = new Timer();
  let activityTimeout: ActivityTimeout | null = null;
  let safetyNetTimer: NodeJS.Timeout | undefined;

  // parse prompt early to extract progressComment for toolState
  const resolvedPromptInput = resolvePromptInput();

  const toolState = initToolState({
    progressComment:
      typeof resolvedPromptInput !== "string" ? resolvedPromptInput.progressComment : undefined,
  });

  // resolve and fingerprint git binary before any agent code runs
  resolveGit();

  // get job token for initial API calls
  const jobToken = getJobToken();
  const initialOctokit = createOctokit(jobToken);
  const runContext = await resolveRunContextData({ octokit: initialOctokit, token: jobToken });
  timer.checkpoint("runContextData");

  // inject account-level secrets into process.env (YAML secrets take precedence)
  if (runContext.dbSecrets) {
    for (const [key, value] of Object.entries(runContext.dbSecrets)) {
      if (!process.env[key]) {
        process.env[key] = value;
        core.setSecret(value);
      }
    }
    const count = Object.keys(runContext.dbSecrets).length;
    if (count > 0) log.info(`» ${count} db secret(s) loaded`);
  }

  // configure env allowlist for subprocess filtering
  if (runContext.repoSettings.envAllowlist) {
    setEnvAllowlist(runContext.repoSettings.envAllowlist);
  }

  // resolve payload to determine shell permission
  const payload = resolvePayload(resolvedPromptInput, runContext.repoSettings);
  toolState.model = payload.model;
  if (payload.event.trigger === "pull_request_synchronize") {
    toolState.beforeSha = payload.event.before_sha;
  }

  // resolve tokens first — acquireNewToken needs OIDC env vars for token exchange
  await using tokenRef = await resolveTokens({ push: payload.push });

  // stash OIDC credentials in memory before wiping from process.env
  // the agent's shell commands can't access JS variables, so this is safe
  const oidcCredentials: OidcCredentials | null =
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
      ? {
          requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
          requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
        }
      : null;

  // clear OIDC env vars in restricted mode to prevent agent from minting tokens
  if (payload.shell !== "enabled") {
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  }

  // Proxy decision: mint an OpenRouter key for OSS repos or managed billing
  // accounts. BillingError (402) and TransientError (503) both surface here.
  // Handle explicitly so the user sees an actionable message (job summary +
  // PR progress comment when one exists) — otherwise the error unwinds past
  // the main try/catch (which needs toolState) and lands in runMain with only
  // a generic core.setFailed.
  try {
    await resolveProxyModel({
      payload,
      oss: runContext.oss,
      plan: runContext.plan,
      proxyModel: runContext.proxyModel,
      oidcCredentials,
      repo: runContext.repo,
    });
  } catch (error) {
    if (error instanceof BillingError) {
      const summary = formatBillingErrorSummary(error, runContext.repo.owner);
      await writeSummary(summary).catch(() => {});
      // Mirror to the PR progress comment if the trigger created one
      // (mention / PR event). Without this, auto-reload declines are only
      // visible in the job summary — users rarely open that, so the agent
      // just appears to silently stop mid-run.
      await reportErrorToComment({ toolState, error: summary }).catch(() => {});
      throw error;
    }
    if (error instanceof TransientError) {
      const summary = formatTransientErrorSummary(error, runContext.repo.owner);
      await writeSummary(summary).catch(() => {});
      await reportErrorToComment({ toolState, error: summary }).catch(() => {});
      throw error;
    }
    throw error;
  }

  // create octokit with MCP token for GitHub API calls
  const octokit = createOctokit(tokenRef.mcpToken);

  const runInfo = await resolveRun({ octokit });
  let toolContext: ToolContext | undefined;
  let progressCallbackDisabled = false;
  let todoTracker: ReturnType<typeof createTodoTracker> | undefined;

  try {
    if (payload.cwd && process.cwd() !== payload.cwd) {
      process.chdir(payload.cwd);
    }

    // resolve body - fetches body_html and converts to markdown if images present
    // this ensures agents receive markdown with working signed image URLs
    const originalBody = payload.event.body;
    const resolvedBody = await resolveBody({
      event: payload.event,
      octokit,
      repo: runContext.repo,
    });
    if (resolvedBody !== originalBody) {
      payload.event.body = resolvedBody;
      // also update prompt if original body was included there
      if (originalBody && payload.prompt.includes(originalBody)) {
        payload.prompt = payload.prompt.replace(originalBody, resolvedBody ?? "");
      }
    }

    const tmpdir = createTempDirectory();

    await using gitAuthServer = await startGitAuthServer(tmpdir);
    setGitAuthServer(gitAuthServer);

    const resolvedModel = payload.proxyModel ? undefined : resolveModel({ slug: payload.model });
    const agent = resolveAgent({ model: resolvedModel });

    // surface the effective model in comment/review footers. payload.model is
    // just the stored slug (often undefined for router/oss runs that derive
    // the target from proxyModel). matching priority with resolveModelForLog
    // so the "Using `…`" badge reflects what actually ran.
    toolState.model = payload.proxyModel ?? resolvedModel ?? payload.model;

    validateAgentApiKey({
      agent,
      model: payload.proxyModel ?? resolvedModel ?? payload.model,
      owner: runContext.repo.owner,
      name: runContext.repo.name,
    });

    await setupGit({
      gitToken: tokenRef.gitToken,
      owner: runContext.repo.owner,
      name: runContext.repo.name,
      octokit,
      toolState,
      shell: payload.shell,
      postCheckoutScript: runContext.repoSettings.postCheckoutScript,
    });
    timer.checkpoint("git");

    // execute setup lifecycle hook (runs once at initialization).
    // setup is load-bearing — if it fails the rest of the run is in an
    // undefined state, so upgrade the soft-fail warning to a hard error.
    const setupHook = await executeLifecycleHook({
      event: "setup",
      script: runContext.repoSettings.setupScript,
    });
    if (setupHook.warning) {
      throw new Error(setupHook.warning);
    }
    timer.checkpoint("lifecycleHooks::setup");

    const agentId = agent.name;
    const modes = [...computeModes(agentId), ...runContext.repoSettings.modes];

    const outputSchema = resolveOutputSchema();

    // mcpServerUrl and tmpdir are set after server starts
    toolContext = {
      agentId,
      repo: runContext.repo,
      payload,
      octokit,
      githubInstallationToken: tokenRef.mcpToken,
      gitToken: tokenRef.gitToken,
      apiToken: runContext.apiToken,
      modes,
      postCheckoutScript: runContext.repoSettings.postCheckoutScript,
      prepushScript: runContext.repoSettings.prepushScript,
      prApproveEnabled: runContext.repoSettings.prApproveEnabled,
      modeInstructions: runContext.repoSettings.modeInstructions,
      toolState,
      runId: runInfo.runId,
      jobId: runInfo.jobId,
      mcpServerUrl: "",
      tmpdir,
      oss: runContext.oss,
      plan: runContext.plan,
      resolvedModel,
    };
    await using mcpHttpServer = await startMcpHttpServer(toolContext, { outputSchema });
    toolContext.mcpServerUrl = mcpHttpServer.url;
    log.info(`» MCP server started at ${mcpHttpServer.url}`);
    timer.checkpoint("mcpServer");

    // seed the rolling repo-level learnings tmpfile for every run. the
    // agent reads the file at startup (path is surfaced in the LEARNINGS
    // section of the prompt) and may edit it during the post-run
    // reflection turn. persistLearnings reads it back at end-of-run and
    // PATCHes any changes to Repo.learnings, byte-trim equality against
    // the seed gates the API call. always-seed (vs gated): learnings are
    // universal — any run can produce them, and gating just hides the
    // affordance.
    //
    // wrapped in best-effort try/catch: this block runs unconditionally,
    // and an unwrapped filesystem failure (ENOSPC, EACCES, hostile sandbox)
    // would unwind into the outer main() catch and flip an otherwise-
    // successful run to "❌ Pullfrog failed" before the agent even starts.
    // matches `persistLearnings`'s own best-effort contract — learnings
    // are a peripheral artifact, not a load-bearing capability. on failure
    // toolState.learningsFilePath stays unset, and downstream consumers
    // (`persistLearnings`, agent harnesses, `resolveInstructions`) all
    // treat undefined as "no learnings affordance this run".
    try {
      const learningsPath = await seedLearningsFile({
        tmpdir,
        current: runContext.repoSettings.learnings,
      });
      toolState.learningsFilePath = learningsPath;
      try {
        toolState.learningsSeed = await readFile(learningsPath, "utf8");
      } catch {
        // intentionally empty — learningsSeed stays undefined, persistLearnings
        // will treat seed as "" and persist any non-empty content
      }
      log.info(
        `» learnings seeded at ${learningsPath} (existing=${runContext.repoSettings.learnings ? "yes" : "no"})`
      );
      const ctxForExit = toolContext;
      onExitSignal(() => persistLearnings(ctxForExit));
    } catch (err) {
      log.warning(
        `» learnings seed failed: ${err instanceof Error ? err.message : String(err)} — continuing without learnings file`
      );
    }

    // seed the rolling PR summary tmpfile when the dispatcher requested it.
    // gated on event being a PR — issue/workflow_dispatch runs have no
    // summarySnapshot to maintain. file path is exposed to the agent via
    // the select_mode response addendum (action/mcp/selectMode.ts).
    if (payload.generateSummary && payload.event.is_pr && payload.event.issue_number) {
      const previousSnapshot = await fetchPreviousSnapshot(toolContext, payload.event.issue_number);
      const filePath = await seedSummaryFile({ tmpdir, previousSnapshot });
      toolState.summaryFilePath = filePath;
      // capture the exact bytes the agent will see at startup. used by
      // the post-run retry loop to detect the agent forgetting to edit
      // the file (byte-identical to seed → nudge once via resume turn)
      // and by persistSummary to skip the DB write when nothing changed.
      // we just wrote the file, so the read shouldn't fail; the catch
      // leaves summarySeed unset (its default), in which case the unchanged
      // checks downstream are simply skipped.
      try {
        toolState.summarySeed = await readFile(filePath, "utf8");
      } catch {
        // intentionally empty — summarySeed stays undefined
      }
      log.info(
        `» summary snapshot seeded at ${filePath} (previous=${previousSnapshot ? "yes" : "no"})`
      );
      // on SIGINT/SIGTERM we still want to persist whatever the agent has
      // written so far. handler is best-effort: any failure inside is
      // swallowed by Promise.allSettled in exitHandler.ts, and the
      // summaryPersistAttempted guard prevents double-execution if the
      // signal arrives after the normal path already persisted. capture a
      // narrowed reference so the closure doesn't depend on the outer
      // `toolContext` variable being defined later.
      const ctxForExit = toolContext;
      onExitSignal(() => persistSummary(ctxForExit));
    }

    startInstallation(toolContext);

    const modelForLog = resolveModelForLog({ payload, resolvedModel });
    const agentForLog = resolveAgentForLog({ agentName: agent.name, resolvedModel });
    const timeoutForLog = resolveTimeoutForLog(payload.timeout);
    log.info(`» model:   ${modelForLog}`);
    log.info(`» agent:   ${agentForLog}`);
    log.info(`» push:    ${payload.push}`);
    log.info(`» shell:   ${payload.shell}`);
    log.info(`» timeout: ${timeoutForLog}`);

    const instructions = resolveInstructions({
      payload,
      repo: runContext.repo,
      modes,
      agentId,
      outputSchema,
      learningsFilePath: toolState.learningsFilePath ?? null,
    });
    const logParts = [
      instructions.eventInstructions
        ? `EVENT-LEVEL INSTRUCTIONS:\n${instructions.eventInstructions}`
        : null,
      instructions.user ? `USER REQUEST:\n${instructions.user}` : null,
      instructions.event,
    ].filter(Boolean);
    log.box(logParts.join("\n\n---\n\n"), {
      title: "Instructions",
    });
    log.group("View full prompt", () => {
      log.info(instructions.full);
    });

    // OpenCode loads .opencode/plugin/ files at startup. if the repo has any,
    // eagerly await dependency installation so plugin imports can resolve.
    if (agentId === "opencode") {
      const pluginDir = join(process.cwd(), ".opencode", "plugin");
      const hasPlugins =
        existsSync(pluginDir) && readdirSync(pluginDir).some((f) => /\.[jt]sx?$/.test(f));
      if (hasPlugins && toolState.dependencyInstallation?.promise) {
        log.info(
          "» .opencode/plugin/ detected — awaiting dependency installation before agent start"
        );
        await toolState.dependencyInstallation.promise.catch(() => {});
        timer.checkpoint("awaitDepsForPlugins");
      }
    }

    // run agent, optionally with timeout enforcement
    activityTimeout = createProcessOutputActivityTimeout({
      timeoutMs: DEFAULT_ACTIVITY_TIMEOUT_MS,
      checkIntervalMs: DEFAULT_ACTIVITY_CHECK_INTERVAL_MS,
    });
    activityTimeout.promise.catch(() => {}); // prevent unhandled rejection if agent wins race
    todoTracker = createTodoTracker(async (body) => {
      if (progressCallbackDisabled || !toolContext) return;
      try {
        await reportProgress(toolContext, { body });
      } catch (err) {
        log.debug(`progress update failed: ${err}`);
      }
    });
    toolState.todoTracker = todoTracker;

    // on cancellation, stop scheduling new tracker writes immediately. without this, a
    // debounced write queued just before SIGTERM could land at GitHub *after* the
    // workflow_run.completed webhook has already replaced the comment with the
    // "This run was cancelled" body, clobbering it back to the task list. we can't
    // await in-flight writes (the process is exiting), but cancelling the timer
    // shrinks the race window.
    onExitSignal(() => {
      todoTracker?.cancel();
    });

    // when the agent subprocess is killed for inner activity timeout, stop
    // the MCP HTTP server so mcp-proxy's SSE reconnect attempts don't keep
    // the outer activity timer alive. start a short safety-net timer — if
    // the agent promise hasn't resolved within 5min after the inner kill,
    // force-reject the outer timer so the run can exit.
    let innerTimeoutFired = false;
    const onInnerActivityTimeout = () => {
      if (innerTimeoutFired) return;
      innerTimeoutFired = true;
      log.info(
        "» inner activity timeout fired — stopping MCP server and starting 5min safety-net timer"
      );
      // fire and forget — the server's dispose is idempotent so the
      // `await using` cleanup at block exit is still safe.
      mcpHttpServer[Symbol.asyncDispose]().catch((err) => {
        log.debug(
          `mcp server stop after inner kill failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      safetyNetTimer = setTimeout(
        () => {
          activityTimeout?.forceReject(
            "agent still pending 5min after inner activity kill — forcing exit"
          );
        },
        5 * 60 * 1000
      );
      safetyNetTimer.unref?.();
    };

    const agentPromise = agent.run({
      payload,
      resolvedModel,
      mcpServerUrl: mcpHttpServer.url,
      tmpdir,
      instructions,
      todoTracker,
      stopScript: runContext.repoSettings.stopScript,
      summaryFilePath: toolState.summaryFilePath,
      summarySeed: toolState.summarySeed,
      learningsFilePath: toolState.learningsFilePath,
      // post-run gate: derive "review mode finished without producing
      // anything visible" inline from toolState. no parallel toolState flag —
      // the absence of `review` and `finalSummaryWritten` is the signal.
      // skipped when there's no progress comment to anchor the failure to
      // (e.g. silent runs / non-issue events) so the gate doesn't fire
      // on runs where there's nothing to display anyway.
      getUnsubmittedReview: () => {
        const mode = toolState.selectedMode;
        if (mode !== "Review" && mode !== "IncrementalReview") return null;
        if (toolState.review || toolState.finalSummaryWritten) return null;
        if (!toolState.hadProgressComment) return null;
        return mode;
      },
      onActivityTimeout: onInnerActivityTimeout,
      onToolUse: (event) => {
        const wasTracked = recordDiffReadFromToolUse({
          state: toolState.diffCoverage,
          toolName: event.toolName,
          input: event.input,
          cwd: process.cwd(),
        });
        if (!wasTracked) return;
        const trackedRanges = toolState.diffCoverage?.coveredRanges ?? [];
        log.debug(
          `» diff coverage tracked from tool ${event.toolName} (${trackedRanges.length} merged range${trackedRanges.length === 1 ? "" : "s"})`
        );
      },
    });
    // symmetric with the activityTimeout/timeoutPromise catches below: if a
    // timeout wins the race, agentPromise is stranded and its later rejection
    // becomes an unhandled rejection. node 15+ terminates the process on
    // unhandled rejection by default, which would kill main() mid-cleanup and
    // lose the error-reporting / usage-summary work that follows. the race
    // still sees the rejection (the original promise is shared); this catch
    // only keeps node from treating a post-race rejection as unobserved.
    agentPromise.catch(() => {});

    // timeout enforcement: default is 1 hour, but can be overridden via flags in the prompt:
    // - --timeout=2h (or any duration like "--timeout=30m", "--timeout=1h30m") to set a custom timeout
    // - --notimeout to disable timeout entirely
    let result: Awaited<typeof agentPromise>;
    if (payload.timeout === TIMEOUT_DISABLED) {
      result = await Promise.race([agentPromise, activityTimeout.promise]);
    } else {
      // resolveTimeoutMs rejects unparseable / zero / setTimeout-overflow inputs
      // so a bad string can't silently resolve to an instant timeout. fall back
      // to the 1h default with a warning — users who want runtime measured in
      // weeks should use --notimeout.
      const usable = resolveTimeoutMs(payload.timeout);
      if (payload.timeout && usable === null) {
        log.warning(`invalid timeout "${payload.timeout}" (use --notimeout to disable), using 1h`);
      }
      const timeoutMs = usable ?? 3600000;
      const actualTimeout = usable !== null ? payload.timeout : "1h";
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`agent run timed out after ${actualTimeout}`));
        }, timeoutMs);
      });
      timeoutPromise.catch(() => {}); // prevent unhandled rejection if agent wins race
      try {
        result = await Promise.race([agentPromise, timeoutPromise, activityTimeout.promise]);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // accumulate top-level agent usage
    if (result.usage) {
      toolState.usageEntries.push(result.usage);
    }

    // validate this before writing job summary to avoid masking the error
    if (outputSchema && !toolState.output) {
      throw new Error(
        "output_schema was provided but agent did not call set_output — structured output is required"
      );
    }

    // post-agent review cleanup: reportReviewNodeId → follow-up re-review dispatch.
    // runs after the agent exits so ordering is architecturally guaranteed (no LLM involvement).
    // best-effort: cleanup failures must not turn a successful agent run into a failure.
    //
    // note: progress-comment deletion on review submission is owned by
    // create_pull_request_review (action/mcp/review.ts) and runs atomically
    // with the submission, so it survives any path out of main (success,
    // timeout, crash) without relying on cleanup ordering here.
    if (toolContext) {
      await postReviewCleanup(toolContext).catch((error) => {
        log.debug(`post-review cleanup failed: ${error}`);
      });
    }

    // read the agent-edited summary tmpfile and persist to the DB. happens
    // after the agent exits so the file is in its final state.
    if (toolContext) {
      await persistSummary(toolContext);
    }

    // same for the rolling repo-level learnings tmpfile. always seeded, so
    // always read back; persistLearnings short-circuits when the file is
    // unchanged from its seed.
    if (toolContext) {
      await persistLearnings(toolContext);
    }

    // when the agent harness returns success=false (e.g. unsubmitted-review
    // gate exhausted retries, stop-hook persistently failing), surface the
    // error in the progress comment so the user sees it instead of a
    // deleted-comment void. mirrors the catch-block error reporting for
    // thrown errors. runs before the stranded-comment cleanup below so
    // the comment is still around to update; reportErrorToComment sets
    // wasUpdated=true and the !result.success guard skips deletion.
    if (!result.success && toolContext && toolState.progressComment) {
      await reportErrorToComment({
        toolState,
        error: result.error || "agent run failed",
      }).catch((error) => {
        log.debug(`failure error report failed: ${error}`);
      });
    }

    // clean up stranded progress comments. the comment is stale unless
    // report_progress wrote a final summary to it — three sub-cases all reduce
    // to !finalSummaryWritten:
    // 1. nothing wrote to the comment ("Leaping into action" orphan)
    // 2. tracker published a checklist but the agent never finalized it
    // 3. the agent produced a substantive artifact via another MCP write tool
    //    (create_issue_comment, update_pull_request_body, reply_to_review_comment)
    //    and skipped report_progress — wasUpdated is true, but the progress
    //    comment itself was never touched.
    // create_pull_request_review owns its own deletion (see action/mcp/review.ts),
    // so progressComment is already null by the time we get here for that path.
    // uses finalSummaryWritten (not todoTracker.enabled or wasUpdated) so cleanup
    // survives API failures in report_progress where cancel() ran but the write
    // didn't succeed, and isn't fooled by writes to *other* artifacts. skipped
    // entirely on result.success===false: the error message just written above
    // is the user's only signal that the run happened — deleting it would
    // restore the same empty-void UX this commit fixes.
    if (
      toolContext &&
      result.success &&
      toolState.progressComment &&
      !toolState.finalSummaryWritten
    ) {
      await deleteProgressComment(toolContext).catch((error) => {
        log.debug(`stranded progress comment cleanup failed: ${error}`);
      });
    }

    // best-effort: failures writing the actions step summary must not throw
    // past this point. on the result.success===false branch above we already
    // wrote `result.error` to the progress comment, and a throw here would
    // jump to the outer catch which calls reportErrorToComment again with
    // the (less actionable) writeJobSummary error — silently overwriting the
    // gate's failure message in the progress comment. the step-summary write
    // is informational; let it fail silently rather than corrupt user-facing
    // output.
    try {
      await writeJobSummary(toolState, result.output);
    } catch (error) {
      log.debug(`job summary write failed: ${error}`);
    }

    // emit structured output marker for test validation
    if (toolState.output) {
      log.info(`::pullfrog-output::${Buffer.from(toolState.output).toString("base64")}`);
      core.setOutput("result", toolState.output);
    }

    return await handleAgentResult({
      result,
      toolState,
      silent: payload.event.silent ?? false,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "unknown error occurred";
    progressCallbackDisabled = true;
    todoTracker?.cancel();
    killTrackedChildren();
    log.error(errorMessage);

    // Reclassify OpenRouter "key budget exhausted" mid-run errors as
    // BillingError. The agent runtime surfaces this as a generic APIError,
    // but it's a Pullfrog billing concern — the user's Router wallet ran
    // out partway through the run. Route through the same formatBillingErrorSummary
    // path as proxy-token 402s so the user gets actionable copy + a top-up
    // CTA on both the job summary and the PR progress comment, instead of
    // a generic "❌ Pullfrog failed" stack-trace dump.
    const billingError = isRouterKeylimitExhaustedError(errorMessage)
      ? new BillingError(errorMessage, { code: "router_keylimit_exhausted" })
      : null;

    // best-effort summary — write the error so it's visible in the Actions summary tab
    try {
      const errorSummary = billingError
        ? formatBillingErrorSummary(billingError, runContext.repo.owner)
        : `### ❌ Pullfrog failed\n\n\`\`\`\n${errorMessage}\n\`\`\``;
      const usageSummary = formatUsageSummary(toolState.usageEntries);
      const parts = [errorSummary, toolState.lastProgressBody, usageSummary].filter(Boolean);
      await writeSummary(parts.join("\n\n"));
    } catch {}

    try {
      const commentBody = billingError
        ? formatBillingErrorSummary(billingError, runContext.repo.owner)
        : errorMessage;
      await reportErrorToComment({ toolState, error: commentBody });
    } catch {
      // error reporting failed, but don't let it mask the original error
    }

    // best-effort review cleanup (e.g., agent timed out after submitting a review)
    if (toolContext) {
      await postReviewCleanup(toolContext).catch((error) => {
        log.debug(`post-review cleanup failed: ${error}`);
      });
    }

    // best-effort summary persist on the error path: if the agent successfully
    // edited the summary file before timing out / crashing, those edits are
    // worth keeping for the next incremental run.
    if (toolContext) {
      await persistSummary(toolContext);
    }

    // same rationale for learnings: a partial edit before a crash is still
    // worth keeping. persistLearnings is idempotent via learningsPersistAttempted.
    if (toolContext) {
      await persistLearnings(toolContext);
    }

    return {
      success: false,
      error: errorMessage,
    };
  } finally {
    activityTimeout?.stop();
    if (safetyNetTimer) clearTimeout(safetyNetTimer);
    if (usageSummaryPath) {
      // a write error here (ENOSPC, EACCES, dirname removed) must not mask
      // either the try's successful return or the catch's error return.
      // the summary is informational — log and move on.
      try {
        await writeGitHubUsageSummaryToFile(usageSummaryPath);
      } catch (err) {
        log.debug(
          `failed to write usage summary to ${usageSummaryPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // persist aggregated token + cost usage to the WorkflowRun row.
    // this is the single shared cleanup path across every agent implementation:
    // each agent harness returns a single AgentUsage from agent.run() that
    // already aggregates its internal retries via mergeAgentUsage, and the
    // success branch above pushes that entry into toolState.usageEntries.
    // aggregateUsage sums across those entries (one per agent.run()).
    //
    // caveat: if the agent promise rejected (timeout or uncaught throw) the
    // usage was never pushed, so nothing gets persisted for that run. runs
    // that returned AgentResult with success=false still report their partial
    // usage because the harness populates AgentUsage before returning.
    if (toolContext) {
      const patch = aggregateUsage(toolState.usageEntries);
      if (Object.keys(patch).length > 0) {
        await patchWorkflowRunFields(toolContext, patch);
      }
    }
  }
}
