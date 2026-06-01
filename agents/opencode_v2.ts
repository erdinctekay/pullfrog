/**
 * OpenCode agent — in-process harness (opencode-ai >=1.14.x SDK-v2 / Effect-ts
 * CLI rewrite).
 *
 * Architecture, post v2-in-process migration:
 *
 *   1. Spawn ONE `opencode serve --port <p>` subprocess per Pullfrog run via
 *      `node:child_process.spawn` directly (NOT our `spawn()` wrapper — see
 *      `bootOpencodeServer` for why: long-lived stdio streaming, manual
 *      activity gating against the SDK event loop, killGroup teardown).
 *   2. Talk to it over loopback HTTP via the typed `@opencode-ai/sdk/v2`
 *      `createOpencodeClient({ baseUrl })` — no `Server.Default()` embed,
 *      no `createOpencode()` SDK lifecycle (would re-wrap our subprocess).
 *   3. Create ONE session up front (`client.session.create`).
 *   4. Subscribe to events once (`client.event.subscribe`) and pump them
 *      through a single per-run handler set for live logging + activity
 *      tracking + subagent labeling.
 *   5. Run the initial prompt via `client.session.prompt({ sessionID, parts })`.
 *      Every post-run gate retry AND the reflection turn re-enter the same
 *      session via another `client.session.prompt()` call. Warm MCP, warm
 *      plugins, warm provider connections, same context window — no
 *      `--continue` subprocess respawn.
 *   6. Close the server in a finally.
 *
 * What that replaces (vs the pre-migration v2 harness):
 *   - The per-run `opencode run --format json --print-logs --thinking` CLI
 *     subprocess that emitted NDJSON envelopes.
 *   - The `runOpenCode(... args: [...baseArgs, "--continue", c.prompt] ...)`
 *     resume callback that booted a SECOND opencode process (fresh MCP,
 *     fresh plugins, cold cache) for each gate retry / reflection turn.
 *   - The `opencodePlugin.ts` bus-event re-emitter — we subscribe to the
 *     global event stream now, so subagent events arrive naturally without
 *     a stdout sentinel envelope.
 *
 * What stays identical:
 *   - bash: "deny" via OPENCODE_CONFIG_CONTENT
 *   - OPENCODE_PERMISSION filesystem sandbox — deny-all + allow /tmp
 *   - MCP Pullfrog server injected via `mcp.<name> = { type: "remote", url }`
 *   - ASKPASS for git auth
 *   - codex auth materialization + post-hook writeback
 *   - reviewfrog subagent config / model derivation
 *   - bedrock model prefix routing
 *   - skills install
 *   - todo tracker / onToolUse forwarding
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import * as core from "@actions/core";
import {
  type AssistantMessage,
  createOpencodeClient,
  type EventSubscribeResponse,
  type OpencodeClient,
  type Part,
  type TextPartInput,
} from "@opencode-ai/sdk/v2";
import { pullfrogMcpName } from "../external.ts";
import { BEDROCK_MODEL_ID_ENV } from "../models.ts";
import type { ToolState } from "../toolState.ts";
import { markActivity } from "../utils/activity.ts";
import { type AgentDiagnostic, formatAgentHangBody } from "../utils/agentHangReport.ts";
import { formatJsonValue, log } from "../utils/cli.ts";
import { installCodexAuth } from "../utils/codexHome.ts";
import { findProviderErrorMatch } from "../utils/providerErrors.ts";
import { addSkill, installBundledSkills } from "../utils/skills.ts";
import { trackChild, untrackChild } from "../utils/subprocess.ts";
import type { TodoTracker } from "../utils/todoTracking.ts";
import { getDevDependencyVersion } from "../utils/version.ts";
import { resolveVertexOpenCodeModel } from "../utils/vertex.ts";
import {
  PULLFROG_OPENCODE_GATE_PLUGIN_FILENAME,
  PULLFROG_OPENCODE_GATE_PLUGIN_SOURCE,
} from "./opencodePlugin.ts";
import {
  autoSelectModel,
  buildReviewerAgentConfig,
  geminiHighThinkingOverrides,
  installOpencodeCli,
  type OpenCodeConfig,
} from "./opencodeShared.ts";
import {
  buildLearningsReflectionPrompt,
  runPostRunRetryLoop,
  shouldRunReflection,
} from "./postRun.ts";
import { REVIEWER_AGENT_NAME } from "./reviewer.ts";
import { formatWithLabel, ORCHESTRATOR_LABEL, SessionLabeler } from "./sessionLabeler.ts";
import {
  type AgentResult,
  type AgentRunContext,
  type AgentUsage,
  agent,
  logTokenTable,
  MAX_STDERR_LINES,
} from "./shared.ts";

const installCli = () => installOpencodeCli({ binPath: "bin/opencode.exe" });

// ── config ─────────────────────────────────────────────────────────────────────

function buildSecurityConfig(ctx: AgentRunContext, model: string | undefined): string {
  const config: OpenCodeConfig = {
    permission: {
      bash: "deny",
      edit: "allow",
      read: "allow",
      webfetch: "allow",
      external_directory: "allow",
      skill: "allow",
    },
    mcp: {
      [pullfrogMcpName]: { type: "remote", url: ctx.mcpServerUrl },
    },
    agent: (() => {
      const cfg = buildReviewerAgentConfig(model);
      const reviewerModel = (cfg[REVIEWER_AGENT_NAME] as { model?: string })?.model ?? "(inherit)";
      log.info(`» subagent models: reviewfrog=${reviewerModel}`);
      return cfg;
    })(),
    // gemini-3 thinking pinned to high for review depth; gpt and anthropic
    // effort set elsewhere (gpt: upstream default, anthropic: --effort flag in claude.ts).
    provider: { google: { models: geminiHighThinkingOverrides() } },
  };

  if (model) {
    config.model = model;
    const slashIndex = model.indexOf("/");
    if (slashIndex > 0) {
      config.enabled_providers = [model.slice(0, slashIndex).toLowerCase()];
    }
  }

  return JSON.stringify(config);
}

/** split `<providerID>/<modelID>` into the SDK's prompt model shape. */
function parseModel(
  value: string | undefined
): { providerID: string; modelID: string } | undefined {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0) return undefined;
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}

// ── server boot ────────────────────────────────────────────────────────────────

interface ServerHandle {
  baseUrl: string;
  proc: ChildProcess;
  /** kill the server; idempotent. */
  close: () => Promise<void>;
  /** rolling tail of server stderr for diagnostics. */
  recentStderr: string[];
}

/**
 * Spawn `<cliPath> serve --port 0 --hostname 127.0.0.1` and wait for the
 * "opencode server listening on http://..." stdout line.
 *
 * Direct node:child_process.spawn instead of our `spawn()` wrapper because
 * the wrapper's contract is "Promise<SpawnResult> that resolves on exit" —
 * we need a handle that stays alive across many session.prompt() calls.
 * We still register with `trackChild()` so Ctrl-C kills the server alongside
 * everything else.
 */
function bootOpencodeServer(params: {
  cliPath: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<ServerHandle> {
  const proc = nodeSpawn(params.cliPath, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: params.cwd,
    env: params.env,
    stdio: ["ignore", "pipe", "pipe"],
    // detached + killGroup so SIGKILL nukes the whole tree: node_modules/
    // opencode-ai/bin/opencode is a Node shim that spawnSync's the native
    // binary; without process-group kill the native binary is reparented
    // to PID 1 and never dies. mirrors the same fix in runOpenCode's
    // original spawn().
    detached: true,
  });
  trackChild({ child: proc, killGroup: true });

  const recentStderr: string[] = [];
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (!text) return;
    recentStderr.push(text);
    if (recentStderr.length > MAX_STDERR_LINES) recentStderr.shift();
    log.debug(`[opencode serve] ${text}`);
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    untrackChild(proc);
    if (proc.pid && !proc.killed) {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        proc.kill("SIGTERM");
      }
      // give the server 2s to exit cleanly, then SIGKILL the group.
      await new Promise<void>((resolve) => {
        const escalator = setTimeout(() => {
          if (!proc.killed) {
            try {
              process.kill(-proc.pid!, "SIGKILL");
            } catch {
              proc.kill("SIGKILL");
            }
          }
        }, 2000);
        proc.once("close", () => {
          clearTimeout(escalator);
          resolve();
        });
      });
    }
  };

  return new Promise<ServerHandle>((resolve, reject) => {
    // serve.ts logs `opencode server listening on http://<host>:<port>` once
    // bound. parse it out, then resolve. drain remaining stdout to debug.
    let buffer = "";
    let resolved = false;
    const onStdout = (chunk: Buffer) => {
      const text = chunk.toString();
      buffer += text;
      if (!resolved) {
        const match = buffer.match(/opencode server listening on (https?:\/\/[^\s]+)/);
        if (match?.[1]) {
          resolved = true;
          log.info(`» opencode server up: ${match[1]}`);
          resolve({ baseUrl: match[1], proc, close, recentStderr });
          // keep draining for debug visibility after handover.
        }
      }
      // log any stdout line that's not the listening sentinel at debug level
      // so a noisy serve startup is visible without polluting info logs.
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.includes("opencode server listening")) {
          log.debug(`[opencode serve] ${trimmed}`);
        }
      }
    };
    proc.stdout?.on("data", onStdout);

    proc.once("error", (err) => {
      if (!resolved) {
        reject(new Error(`failed to spawn opencode serve: ${err.message}`));
      }
    });
    proc.once("close", (code, signal) => {
      if (!resolved) {
        const tail = recentStderr.slice(-5).join("\n");
        reject(
          new Error(
            `opencode serve exited before ready (code=${code} signal=${signal})${tail ? `\n${tail}` : ""}`
          )
        );
      }
    });

    // safety: if the listening line never arrives, bail after 30s.
    const bootTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        const tail = recentStderr.slice(-5).join("\n");
        void close();
        reject(
          new Error(
            `timed out after 30s waiting for opencode serve to bind${tail ? `\n${tail}` : ""}`
          )
        );
      }
    }, 30_000);
    bootTimeout.unref?.();
  });
}

// ── per-turn state ─────────────────────────────────────────────────────────────

/**
 * What we collect during a single session.prompt() turn so we can render a
 * unified AgentResult at the end. Per-turn snapshot is reset between turns
 * inside the event loop via `beginTurn()` / `endTurn()`.
 */
interface TurnAccumulator {
  finalText: string;
  /**
   * Aggregate token totals from step-finish parts across the orchestrator AND
   * any subagent sessions dispatched during the turn (e.g. reviewfrog).
   * Mirrors v1's `accumulatedTokens` semantics so production billing/audit
   * numbers stay apples-to-apples across the migration.
   */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  sessionError: string | null;
  /** populated when a tool_use part on the orchestrator session reports error. */
  lastToolError: string | null;
}

function newTurn(): TurnAccumulator {
  return {
    finalText: "",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    sessionError: null,
    lastToolError: null,
  };
}

// ── runner ─────────────────────────────────────────────────────────────────────

interface RunnerContext {
  client: OpencodeClient;
  sessionID: string;
  label: string;
  orchestratorSessionID: string;
  labeler: SessionLabeler;
  toolState: ToolState;
  todoTracker?: TodoTracker | undefined;
  onActivityTimeout?: (() => void) | undefined;
  onToolUse?: ((event: { toolName: string; input: unknown }) => void) | undefined;
  /** current per-turn aggregator; nullable between turns. */
  currentTurn: TurnAccumulator | null;
  /** monotonic event count for diagnostics. */
  eventCount: number;
  /** last activity timestamp (event-stream silence detector). */
  lastEventAt: number;
  /** active task dispatch metadata keyed by callID (for subagent timing). */
  taskDispatchByCallID: Map<string, { label: string; startedAt: number }>;
  /**
   * orchestrator tool callIDs already surfaced via `log.info(» ${tool}(...))`,
   * tracked so the end-of-turn fallback can re-emit only the calls the live
   * event stream missed. closes the SSE-connect race against the first
   * `session.prompt()` (the SDK opens the SSE lazily on first iteration; by
   * then the server may already have emitted the turn's tool part-updated
   * events). without the fallback those calls never appear in stdout, which
   * breaks every validator that greps for tool-call shape.
   */
  loggedToolCallIDs: Set<string>;
  /** rolling stderr tail from the server process (for diagnostics). */
  recentStderr: string[];
  diagnostic: AgentDiagnostic;
}

/**
 * orchestrate the event stream consumer for the entire server lifetime.
 *
 * NB: the SDK subscribe is lazy — the SSE fetch only opens on the first
 * iteration. so the first turn's tool part-updated events can race the
 * connect and be missed. live-stream logging is best-effort; see the
 * end-of-turn `logUnseenToolCalls` fallback for the guarantee.
 */
async function consumeEvents(ctx: RunnerContext, signal: AbortSignal): Promise<void> {
  const result = await ctx.client.event.subscribe();
  for await (const event of result.stream as AsyncGenerator<EventSubscribeResponse>) {
    if (signal.aborted) break;
    ctx.eventCount += 1;
    ctx.diagnostic.eventCount = ctx.eventCount;
    ctx.lastEventAt = performance.now();
    markActivity();
    try {
      await dispatchEvent(ctx, event);
    } catch (err) {
      log.debug(
        `» event dispatch threw for type=${(event as { type?: string }).type ?? "?"}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

async function dispatchEvent(ctx: RunnerContext, event: EventSubscribeResponse): Promise<void> {
  // event union covers heartbeats, session lifecycle, message lifecycle, tui,
  // mcp, etc. we only care about a small subset.
  if (event.type === "message.part.updated") {
    await onPartUpdated(ctx, event.properties.part);
    return;
  }
  if (event.type === "session.error") {
    const sessionID = event.properties.sessionID;
    if (sessionID !== ctx.orchestratorSessionID) return;
    const err = event.properties.error;
    const message = err ? extractErrorMessage(err) : "(no error payload)";
    if (ctx.currentTurn) ctx.currentTurn.sessionError = message;
    log.info(`» ${ctx.label} session error: ${message}`);
    return;
  }
  // session.idle / session.status are useful breadcrumbs but we don't drive
  // anything off them — the prompt() POST returns when the assistant message
  // is committed, which is also when the session goes idle.
}

function extractErrorMessage(err: {
  name?: string;
  data?: { message?: string; [key: string]: unknown };
}): string {
  if (err.data?.message) return err.data.message;
  if (err.name) return err.name;
  return JSON.stringify(err);
}

async function onPartUpdated(ctx: RunnerContext, part: Part): Promise<void> {
  const label = ctx.labeler.labelFor(part.sessionID);
  const isOrchestrator = part.sessionID === ctx.orchestratorSessionID;

  // text — only orchestrator's final text becomes the run's "output";
  // subagent text is logged but not folded into finalOutput.
  if (part.type === "text" && part.time?.end !== undefined) {
    const text = part.text.trim();
    if (!text) return;
    const boxTitle = label === ORCHESTRATOR_LABEL ? ctx.label : `${ctx.label} [${label}]`;
    log.box(text, { title: boxTitle });
    if (isOrchestrator && ctx.currentTurn) {
      ctx.currentTurn.finalText = text;
    }
    return;
  }

  if (part.type === "reasoning" && part.time.end !== undefined) {
    const text = part.text.trim();
    if (!text) return;
    const dur = formatPartDuration(part.time);
    const preview = text.length > 280 ? `${text.slice(0, 280)}…` : text;
    log.info(withLabel(label, `» thinking${dur}: ${preview.replace(/\n+/g, " ")}`));
    if (text.length > 280) log.debug(withLabel(label, `» thinking (full): ${text}`));
    return;
  }

  if (part.type === "step-finish") {
    // aggregate orchestrator AND subagent step-finish events into the same
    // per-turn accumulator. v1 (`opencode.ts`) summed both via opencode's
    // CLI `--print-logs` output; filtering subagents here would silently
    // undercount production cost/usage by the reviewfrog subagent's
    // contribution (often the bulk of a Review-mode turn).
    if (!ctx.currentTurn) return;
    const t = part.tokens;
    if (t) {
      ctx.currentTurn.tokens.input += t.input || 0;
      ctx.currentTurn.tokens.output += t.output || 0;
      ctx.currentTurn.tokens.cacheRead += t.cache?.read || 0;
      ctx.currentTurn.tokens.cacheWrite += t.cache?.write || 0;
    }
    if (typeof part.cost === "number" && Number.isFinite(part.cost)) {
      ctx.currentTurn.costUsd += part.cost;
    }
    return;
  }

  if (part.type === "tool") {
    await onToolPart(ctx, part, label, isOrchestrator);
    return;
  }

  // step-start / snapshot / patch / agent / retry / compaction / subtask /
  // file: nothing actionable here.
}

async function onToolPart(
  ctx: RunnerContext,
  part: Extract<Part, { type: "tool" }>,
  label: string,
  isOrchestrator: boolean
): Promise<void> {
  const status = part.state.status;
  const toolName = part.tool;
  const toolId = part.callID;

  // early task-dispatch announce: bind subagent sessionID to a label as soon
  // as the orchestrator's task tool transitions to "running" (where input is
  // populated). dedupe against later terminal observations via callID.
  if (
    toolName === "task" &&
    status === "running" &&
    isOrchestrator &&
    !ctx.taskDispatchByCallID.has(toolId)
  ) {
    const input = (part.state.input ?? {}) as {
      description?: string;
      subagent_type?: string;
      prompt?: string;
    };
    const dispatched = ctx.labeler.recordTaskDispatch(input);
    ctx.taskDispatchByCallID.set(toolId, { label: dispatched, startedAt: performance.now() });
    log.info(
      `» dispatching subagent: ${dispatched}` +
        (input.subagent_type ? ` (subagent_type=${input.subagent_type})` : "")
    );
    return;
  }

  // terminal bookkeeping (log line, side effects) runs once per callID via
  // `processTerminalToolPart` — see its docstring for the dedup contract
  // shared with the end-of-turn fallback.
  processTerminalToolPart(ctx, part, label, isOrchestrator);
}

/**
 * shared terminal bookkeeping for a tool part: log line, dedup callID, run
 * orchestrator-side hooks (`onToolUse` → diff-coverage tracker; `todowrite` /
 * `report_progress` → todo tracker; tool-error → `lastToolError`), and emit
 * subagent-finish summary on `task` returns.
 *
 * called from both the live SSE path (`onToolPart`) and the end-of-turn
 * fallback (`logUnseenToolCalls`) — `loggedToolCallIDs` is the dedup guard
 * so each call's side effects fire exactly once across both paths. critical
 * for diff-coverage: a first-turn `Read` that races SSE attach would
 * otherwise be missed by `recordDiffReadFromToolUse`, and the subsequent
 * `create_pull_request_review` pre-flight would reject the review.
 */
function processTerminalToolPart(
  ctx: RunnerContext,
  part: Extract<Part, { type: "tool" }>,
  label: string,
  isOrchestrator: boolean
): void {
  const toolName = part.tool;
  const toolId = part.callID;
  const state = part.state;
  if (state.status !== "completed" && state.status !== "error") return;
  if (isOrchestrator && ctx.loggedToolCallIDs.has(toolId)) return;

  const input = state.input ?? {};
  const inputFormatted = formatJsonValue(input);
  const callLine = inputFormatted !== "{}" ? `» ${toolName}(${inputFormatted})` : `» ${toolName}()`;
  log.info(withLabel(label, callLine));
  if (isOrchestrator) ctx.loggedToolCallIDs.add(toolId);

  if (state.status === "completed") {
    log.debug(withLabel(label, `  output: ${state.output}`));
  } else {
    log.info(withLabel(label, `» tool call failed: ${state.error}`));
    if (isOrchestrator && ctx.currentTurn) {
      ctx.currentTurn.lastToolError = state.error;
    }
  }

  // subagent finish bookkeeping — exact callID match (v1.15 keeps callID
  // stable across the whole tool-input → tool-call → terminal chain).
  if (toolName === "task") {
    const dispatch = ctx.taskDispatchByCallID.get(toolId);
    if (dispatch) {
      const dur = ((performance.now() - dispatch.startedAt) / 1000).toFixed(1);
      const outputStr = state.status === "completed" ? state.output : "";
      const preview =
        typeof outputStr === "string" && outputStr.length > 120
          ? `${outputStr.slice(0, 120)}…`
          : outputStr;
      log.info(
        `» subagent finished: ${dispatch.label} (${dur}s, status=${state.status})` +
          (preview ? ` — ${String(preview).replace(/\n/g, " ")}` : "")
      );
      ctx.taskDispatchByCallID.delete(toolId);
    }
  }

  // forward orchestrator tool usage to the harness's hooks. subagent
  // tool calls don't count toward the parent's diff-coverage tracking —
  // it's the orchestrator that submits the review.
  if (isOrchestrator) {
    ctx.onToolUse?.({ toolName, input });
  }

  if (toolName.includes("report_progress") && ctx.todoTracker) {
    log.debug("» report_progress detected, disabling todo tracking");
    ctx.todoTracker.cancel();
  }
  if (toolName === "todowrite" && ctx.todoTracker?.enabled && isOrchestrator) {
    ctx.todoTracker.update(input);
  }
}

/**
 * end-of-turn safety net for tool-call bookkeeping. queries `session.messages`
 * for the canonical orchestrator transcript and replays any tool callID the
 * live event stream hasn't already processed — closes the SSE-connect race
 * documented on `loggedToolCallIDs`. `session.prompt`'s own `data.parts` is
 * only the final assistant message's parts (mostly text/reasoning); the tool
 * calls in earlier steps of the same turn live on prior messages, so we need
 * the full session-scoped read.
 *
 * delegates to `processTerminalToolPart` so the same side effects fire as
 * on the live SSE path: log line, `onToolUse` (diff-coverage feed),
 * `todoTracker` updates, `lastToolError`. completed/errored parts only;
 * pending states are inflight and not yet meaningful.
 */
async function logUnseenToolCalls(ctx: RunnerContext): Promise<void> {
  try {
    const resp = await ctx.client.session.messages({ sessionID: ctx.orchestratorSessionID });
    if (resp.error || !resp.data) return;
    for (const message of resp.data) {
      for (const part of message.parts) {
        if (part.type !== "tool") continue;
        processTerminalToolPart(ctx, part, ORCHESTRATOR_LABEL, true);
      }
    }
  } catch (err) {
    log.debug(`» logUnseenToolCalls failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function formatPartDuration(time: { start?: number; end?: number } | undefined): string {
  if (!time || typeof time.start !== "number" || typeof time.end !== "number") return "";
  if (time.end <= time.start) return "";
  return ` (${((time.end - time.start) / 1000).toFixed(1)}s)`;
}

function withLabel(label: string, message: string): string {
  return label === ORCHESTRATOR_LABEL ? message : formatWithLabel(label, message);
}

// ── per-turn execution ─────────────────────────────────────────────────────────

/**
 * Run a single prompt turn against the persistent server. Resets the per-turn
 * accumulator, calls `client.session.prompt()`, then assembles an AgentResult
 * from the returned AssistantMessage + accumulated event state.
 *
 * Token / cost: `AssistantMessage.tokens` and `.cost` are authoritative for
 * the turn. The event-stream accumulator is a fallback / sanity-check path
 * used when the response is missing (e.g. abort, transport error) — and as
 * the only source of per-step subagent attribution if we ever surface it.
 */
async function runPromptTurn(
  ctx: RunnerContext,
  params: {
    text: string;
    model: { providerID: string; modelID: string } | undefined;
    signal: AbortSignal;
  }
): Promise<AgentResult> {
  const start = performance.now();
  // record the turn boundary in milliseconds (matches AssistantMessage.time.created)
  // so the post-turn aggregator can isolate this turn's messages from the prior
  // turns' messages on the same persistent orchestrator session.
  const turnStartMs = Date.now();
  ctx.currentTurn = newTurn();
  const turn = ctx.currentTurn;

  const part: TextPartInput = { type: "text", text: params.text };

  let assistant: AssistantMessage | undefined;
  let returnedParts: Part[] | undefined;
  let networkError: string | null = null;
  try {
    const response = await ctx.client.session.prompt(
      {
        sessionID: ctx.sessionID,
        parts: [part],
        ...(params.model ? { model: params.model } : {}),
      },
      // wire the inner activity watchdog's abort signal into the SDK request
      // — without this a hung HTTP keeps the run stuck even after the
      // watchdog fires.
      { signal: params.signal }
    );
    if (response.error) {
      networkError = formatPromptError(response.error);
    } else if (response.data) {
      assistant = response.data.info;
      returnedParts = response.data.parts;
    } else {
      // neither error nor data — malformed/partial SDK response. don't silently
      // succeed with an empty AgentResult; treat as a failure so the gate loop
      // surfaces it instead of looping on a "successful" no-op.
      networkError = "opencode prompt returned neither data nor error";
    }
  } catch (err) {
    networkError = err instanceof Error ? err.message : String(err);
  }
  const durationMs = performance.now() - start;

  // authoritative cost/usage: walk every assistant message that landed during
  // this turn (orchestrator session + any subagent sessions dispatched while
  // it ran) and sum tokens + cost. The step-finish accumulator and the live
  // AssistantMessage from session.prompt are both non-authoritative for a
  // multi-step turn — step-finish events arrive on the SSE stream after
  // session.prompt has already resolved (at least for the final message),
  // and AssistantMessage carries only the final message's usage. Mirrors v1's
  // accumulator-after-the-fact model but driven by the canonical message
  // store instead of best-effort SSE sniffing.
  const aggregatedUsage = await aggregateTurnUsage(ctx, turnStartMs);
  const usage = aggregatedUsage ?? buildUsage(turn, assistant);

  // surface the rendered final text. preference order:
  //   1. orchestrator text part with time.end set (captured by event loop)
  //   2. text part on the returned response (when present)
  //   3. assistant message id as a last-resort placeholder
  const finalText = turn.finalText || extractTextFromParts(returnedParts) || "";

  await logUnseenToolCalls(ctx);

  log.info(`» ${ctx.label} turn completed in ${Math.round(durationMs)}ms`);
  if (usage) {
    logTokenTable({
      input: usage.inputTokens - (usage.cacheReadTokens ?? 0) - (usage.cacheWriteTokens ?? 0),
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
      output: usage.outputTokens,
      costUsd: usage.costUsd,
    });
  }

  // failure modes, in order of authority:
  //   1. transport / SDK-side error (response.error or thrown)
  //   2. AssistantMessage.error set by the provider (auth, context overflow, etc.)
  //   3. session.error event observed during the turn
  if (networkError) {
    return {
      success: false,
      output: finalText,
      error: `opencode prompt failed: ${networkError}`,
      usage,
    };
  }
  if (assistant?.error) {
    return {
      success: false,
      output: finalText,
      error: `provider error: ${extractErrorMessage(assistant.error)}`,
      usage,
    };
  }
  if (turn.sessionError) {
    return {
      success: false,
      output: finalText,
      error: `session error: ${turn.sessionError}`,
      usage,
    };
  }

  return { success: true, output: finalText, usage };
}

/**
 * Sum the cost + tokens of every assistant message created during this turn,
 * across the orchestrator session AND any subagent sessions dispatched while
 * it ran. Authoritative: the SDK's own cost/tokens fields per message are the
 * source of truth, identical to what `opencode --print-logs` aggregated in v1.
 */
async function aggregateTurnUsage(
  ctx: RunnerContext,
  turnStartMs: number
): Promise<AgentUsage | undefined> {
  // labeler tracks every sessionID we've observed events from on the
  // global SSE stream, including any subagent (task tool) child sessions.
  const sessionIDs = new Set<string>([ctx.orchestratorSessionID]);
  for (const [sessionID] of ctx.labeler.entries()) {
    sessionIDs.add(sessionID);
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let counted = 0;

  for (const sessionID of sessionIDs) {
    try {
      const resp = await ctx.client.session.messages({ sessionID });
      if (resp.error || !resp.data) continue;
      for (const msg of resp.data) {
        if (msg.info.role !== "assistant") continue;
        if (msg.info.time.created < turnStartMs) continue;
        const t = msg.info.tokens;
        inputTokens += t.input || 0;
        outputTokens += t.output || 0;
        cacheReadTokens += t.cache?.read || 0;
        cacheWriteTokens += t.cache?.write || 0;
        costUsd += msg.info.cost || 0;
        counted++;
      }
    } catch (err) {
      log.debug(
        `» aggregateTurnUsage failed for session ${sessionID}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (counted === 0) return undefined;

  const total = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (total === 0 && outputTokens === 0 && costUsd === 0) return undefined;

  return {
    agent: "pullfrog",
    inputTokens: total,
    outputTokens,
    cacheReadTokens: cacheReadTokens || undefined,
    cacheWriteTokens: cacheWriteTokens || undefined,
    costUsd: costUsd > 0 ? costUsd : undefined,
  };
}

function buildUsage(
  turn: TurnAccumulator,
  assistant: AssistantMessage | undefined
): AgentUsage | undefined {
  // Prefer the step-finish accumulator: it sums every LLM call across the
  // whole turn (orchestrator iterations + any subagent dispatches). The
  // AssistantMessage at the SDK boundary only carries the *final* assistant
  // message's tokens/cost — for a multi-step Review-mode turn that's just
  // the closing acknowledgment, missing the bulk of the work. Fall back to
  // assistant.tokens only if the accumulator is empty (e.g., the turn
  // errored before any step-finish events landed).
  const t = turn.tokens;
  const accumulatorTotal = t.input + t.cacheRead + t.cacheWrite;
  if (accumulatorTotal > 0 || t.output > 0 || turn.costUsd > 0) {
    return {
      agent: "pullfrog",
      inputTokens: accumulatorTotal,
      outputTokens: t.output,
      cacheReadTokens: t.cacheRead || undefined,
      cacheWriteTokens: t.cacheWrite || undefined,
      costUsd: turn.costUsd > 0 ? turn.costUsd : undefined,
    };
  }
  if (assistant) {
    const at = assistant.tokens;
    const total = (at.input || 0) + (at.cache?.read || 0) + (at.cache?.write || 0);
    if (total === 0 && (at.output || 0) === 0 && (assistant.cost || 0) === 0) return undefined;
    return {
      agent: "pullfrog",
      inputTokens: total,
      outputTokens: at.output || 0,
      cacheReadTokens: at.cache?.read || undefined,
      cacheWriteTokens: at.cache?.write || undefined,
      costUsd: assistant.cost > 0 ? assistant.cost : undefined,
    };
  }
  return undefined;
}

function extractTextFromParts(parts: Part[] | undefined): string | undefined {
  if (!parts) return undefined;
  const texts: string[] = [];
  for (const p of parts) {
    if (p.type === "text" && p.text) texts.push(p.text);
  }
  const joined = texts.join("\n").trim();
  return joined || undefined;
}

function formatPromptError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const obj = error as { message?: string; error?: { message?: string }; data?: unknown };
    if (obj.message) return obj.message;
    if (obj.error?.message) return obj.error.message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

// ── inner activity timer ───────────────────────────────────────────────────────

/**
 * Start an event-silence watchdog. The outer process-level activity timer
 * (main.ts `createProcessOutputActivityTimeout`) watches `process.stdout.write`
 * which our harness log lines drive — but it doesn't see SSE event silence
 * when the harness is itself quiet. This inner timer specifically watches
 * `ctx.lastEventAt` and fires `onActivityTimeout` so main.ts can tear down
 * the MCP server early, mirroring the per-spawn watchdog in `subprocess.ts`.
 */
function startInnerActivityWatchdog(params: {
  ctx: RunnerContext;
  timeoutMs: number;
  abortController: AbortController;
}): { stop: () => void } {
  let fired = false;
  const id = setInterval(() => {
    if (fired) return;
    const idleMs = performance.now() - params.ctx.lastEventAt;
    if (idleMs <= params.timeoutMs) return;
    fired = true;
    const idleSec = Math.round(idleMs / 1000);
    log.info(
      `» no opencode events for ${idleSec}s — aborting in-flight prompt and notifying harness`
    );
    params.abortController.abort();
    try {
      params.ctx.onActivityTimeout?.();
    } catch (err) {
      log.debug(
        `inner activity callback threw: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, 5_000);
  id.unref?.();
  return { stop: () => clearInterval(id) };
}

// ── agent entrypoint ───────────────────────────────────────────────────────────

export const opencode = agent({
  name: "opencode",
  install: installCli,
  run: async (ctx) => {
    const cliPath = await installCli();

    const rawModel = ctx.payload.proxyModel ?? ctx.resolvedModel ?? autoSelectModel();

    // bedrock route: opencode's `amazon-bedrock` provider expects the model
    // in `amazon-bedrock/<bedrock-id>` form. detect via env-var sentinel
    // (same pattern as claude.ts). do not gate on Anthropic-vs-other — that
    // discriminant lives in resolveAgent.
    const bedrockModelId = process.env[BEDROCK_MODEL_ID_ENV]?.trim();
    const isBedrockRoute =
      rawModel !== undefined && bedrockModelId !== undefined && bedrockModelId === rawModel;
    const vertexModel = resolveVertexOpenCodeModel(rawModel);
    const model = vertexModel ?? (isBedrockRoute ? `amazon-bedrock/${rawModel}` : rawModel);

    const homeEnv = {
      HOME: ctx.tmpdir,
      XDG_CONFIG_HOME: join(ctx.tmpdir, ".config"),
    };
    // install the subagent gate into opencode's auto-discovered plugin dir
    // (under the tmpdir-redirected XDG_CONFIG_HOME). v2 installs ONLY the gate,
    // not the events re-emitter — it reads subagent events off the SDK stream,
    // so the re-emitter would be dead weight. see action/agents/opencodePlugin.ts.
    const opencodePluginDir = join(homeEnv.XDG_CONFIG_HOME, "opencode", "plugin");
    mkdirSync(opencodePluginDir, { recursive: true });
    writeFileSync(
      join(opencodePluginDir, PULLFROG_OPENCODE_GATE_PLUGIN_FILENAME),
      PULLFROG_OPENCODE_GATE_PLUGIN_SOURCE
    );

    const agentBrowserVersion = getDevDependencyVersion("agent-browser");
    addSkill({
      ref: `vercel-labs/agent-browser@v${agentBrowserVersion}`,
      skill: "agent-browser",
      env: homeEnv,
      agent: "opencode",
    });
    installBundledSkills({ home: homeEnv.HOME });

    // materialize CODEX_AUTH_JSON into the runner's real $HOME/.local/share/
    // opencode/auth.json so OpenCode's CodexAuthPlugin picks it up. see
    // action/utils/codexHome.ts and wiki/codex-auth.md.
    const codexAuth = installCodexAuth();

    // OPENCODE_PERMISSION has absolute highest precedence (merged after managed/MDM configs).
    // external_directory gates ALL native filesystem tools (Read, Write, Edit, Glob, Grep, etc.)
    // for paths outside the project root. last-match-wins: deny everything, then allow /tmp.
    // codex auth lives at /var/lib/pullfrog/opencode/auth.json in CI (see codexHome.ts),
    // which is outside /tmp/* — deny-default protects it from native FS tools.
    //
    // edit rule denies git config / hooks / attributes inside the project
    // root (see opencode.ts for the same shape and rationale).
    const permissionOverride = JSON.stringify({
      external_directory: { "*": "deny", "/tmp/*": "allow" },
      edit: {
        "*": "allow",
        ".git/config": "deny",
        ".git/hooks/*": "deny",
        ".git/info/attributes": "deny",
      },
    });

    const repoDir = process.cwd();

    // opencode-ai >=1.14 resolves the session's `directory` from process.env.PWD
    // first (cli/cmd/run.ts:282 → Filesystem.resolve(PWD ?? cwd)). The server
    // does the same per-request via the x-opencode-directory header, but we
    // also pass PWD on the spawn env so any in-server tool that re-resolves
    // cwd locally lands in repoDir.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...homeEnv,
      PWD: repoDir,
      OPENCODE_CONFIG_CONTENT: buildSecurityConfig(ctx, model),
      OPENCODE_PERMISSION: permissionOverride,
      GOOGLE_GENERATIVE_AI_API_KEY:
        process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY,
    };
    if (codexAuth) {
      env.XDG_DATA_HOME = codexAuth.xdgDataHome;
      delete env.OPENAI_API_KEY;
      core.saveState(
        "codex_writeback",
        JSON.stringify({
          apiToken: ctx.apiToken,
          authPath: codexAuth.authPath,
          originalRefresh: codexAuth.originalRefresh,
        })
      );
    }

    log.debug(`» starting Pullfrog (OpenCode, in-process SDK): ${cliPath}`);
    log.debug(`» working directory: ${repoDir}`);

    // ── boot server + create session ─────────────────────────────────────────
    const server = await bootOpencodeServer({ cliPath, env, cwd: repoDir });
    try {
      const client = createOpencodeClient({ baseUrl: server.baseUrl, directory: repoDir });

      const sessionResp = await client.session.create({ title: "Pullfrog" });
      if (sessionResp.error || !sessionResp.data) {
        const msg = sessionResp.error
          ? formatPromptError(sessionResp.error)
          : "session.create returned no data";
        return {
          success: false,
          output: "",
          error: `opencode session.create failed: ${msg}`,
        };
      }
      const sessionID = sessionResp.data.id;
      log.info(`» opencode session: ${sessionID}`);

      // bind the orchestrator label up front. without this, the first
      // foreign sessionID we see (a subagent) would consume the ORCHESTRATOR
      // slot in the labeler's FIFO and every label downstream would shift.
      const labeler = new SessionLabeler();
      labeler.labelFor(sessionID);

      const runnerCtx: RunnerContext = {
        client,
        sessionID,
        label: "Pullfrog",
        orchestratorSessionID: sessionID,
        labeler,
        toolState: ctx.toolState,
        todoTracker: ctx.todoTracker,
        onActivityTimeout: ctx.onActivityTimeout,
        onToolUse: ctx.onToolUse,
        currentTurn: null,
        eventCount: 0,
        lastEventAt: performance.now(),
        taskDispatchByCallID: new Map(),
        loggedToolCallIDs: new Set(),
        recentStderr: server.recentStderr,
        diagnostic: {
          label: "Pullfrog",
          recentStderr: server.recentStderr,
          lastProviderError: undefined,
          eventCount: 0,
        },
      };
      ctx.toolState.agentDiagnostic = runnerCtx.diagnostic;

      // server stderr → provider-error attribution (same pattern as the
      // old CLI subprocess harness's onStderr handler).
      server.proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const match = findProviderErrorMatch(trimmed);
          if (match) {
            runnerCtx.diagnostic.lastProviderError = match.label;
            log.info(`» provider error detected (${match.label}): ${match.excerpt}`);
          }
        }
      });

      const abortController = new AbortController();
      const eventLoopPromise = consumeEvents(runnerCtx, abortController.signal).catch((err) => {
        // SSE stream breakage during cleanup is expected; only surface during
        // active operation.
        if (!abortController.signal.aborted) {
          log.warning(
            `» opencode event subscription ended: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      });

      const watchdog = startInnerActivityWatchdog({
        ctx: runnerCtx,
        timeoutMs: 300_000,
        abortController,
      });

      const sdkModel = parseModel(model);

      try {
        // initial run
        const initial = await runWithHangReport(runnerCtx, () =>
          runPromptTurn(runnerCtx, {
            text: ctx.instructions.full,
            model: sdkModel,
            signal: abortController.signal,
          })
        );

        // post-run gate retry loop — every resume is another session.prompt()
        // against the same sessionID, so MCP, plugins, provider sockets stay
        // warm and the session's prompt cache survives.
        const result = await runPostRunRetryLoop({
          ctx,
          initialResult: initial,
          initialUsage: initial.usage,
          reflectionPrompt:
            ctx.toolState.learningsFilePath && shouldRunReflection(ctx.toolState.selectedMode)
              ? buildLearningsReflectionPrompt(ctx.toolState.learningsFilePath)
              : undefined,
          resume: async (c) =>
            runWithHangReport(runnerCtx, () =>
              runPromptTurn(runnerCtx, {
                text: c.prompt,
                model: sdkModel,
                signal: abortController.signal,
              })
            ),
        });

        // gate the todo-tracker flush on the post-run loop's final verdict
        // (`result.success`), not the initial turn — otherwise a Review that
        // exhausts the `unsubmittedReview` retry budget flips success to
        // false but the tracker still flushes "completed" tasks to GitHub.
        // mirrors the old `if (result.exitCode === 0)` discriminant.
        if (result.success) {
          await ctx.todoTracker?.flush();
        } else {
          ctx.todoTracker?.cancel();
        }

        return result;
      } finally {
        watchdog.stop();
        abortController.abort();
        await eventLoopPromise.catch(() => {});
      }
    } finally {
      await server.close().catch((err) => {
        log.debug(
          `opencode server close failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  },
});

/**
 * Wrap a single turn so an exception (typically the inner watchdog aborting
 * the AbortController) renders the same diagnostic body the old CLI harness
 * surfaced on activity timeout / spawn error.
 */
async function runWithHangReport(
  ctx: RunnerContext,
  fn: () => Promise<AgentResult>
): Promise<AgentResult> {
  try {
    return await fn();
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isHang = errorMessage.toLowerCase().includes("abort");
    const body = formatAgentHangBody({
      diagnostic: ctx.diagnostic,
      isHang,
      errorMessage,
    });
    log.info(`» ${ctx.label} turn failed: ${errorMessage}`);
    return {
      success: false,
      output: ctx.currentTurn?.finalText ?? "",
      error: body ?? errorMessage,
    };
  }
}
