/**
 * OpenCode agent — secure harness around OpenCode CLI (v2 / opencode-ai >=1.14.x).
 *
 * Adapted from `./opencode.ts` for the SDK-v2 / Effect-ts CLI rewrite that
 * landed in the `opencode-ai@1.14.x` line and is current at `1.15.x`. The
 * legacy file is kept as `./opencode.ts` for reference / quick revert; the
 * agent registry (`./index.ts`) imports this module instead.
 *
 * Differences vs the v1 harness:
 *   - NDJSON event set is now `tool_use | step_start | step_finish | text |
 *     reasoning | error`. `init`, `message`, `result`, and standalone
 *     `tool_result` are no longer emitted by `cli/cmd/run.ts emit()`. The
 *     v2 `tool_use` event covers both the completion and the error terminal
 *     states (read `part.state.status`); the per-call duration tracking that
 *     was on the v1 `tool_result` handler now lives on `tool_use`.
 *   - `reasoning` events (Gemini thinking blocks etc.) only emit when the
 *     CLI is invoked with `--thinking`. Always passed in `baseArgs`.
 *   - The `task` tool's callID is now stable across the whole `tool-input-*
 *     → tool-call → tool-result/tool-error` chain (v1 had a callID-mismatch
 *     quirk that forced a FIFO fallback on the parent). Subagent-finish
 *     attribution is exact-match-only — the FIFO scaffolding is gone.
 *   - `experimental.batch_tool` is declared-but-inert at v1.15.0 (no read
 *     site upstream). Removed from the injected config until upstream wires
 *     it back; keeping the flag would just be dead config.
 *
 * Identical to v1:
 *   - bash: "deny" via OPENCODE_CONFIG_CONTENT (agent cannot shell out)
 *   - OPENCODE_PERMISSION filesystem sandbox — deny all external paths except /tmp
 *   - MCP ShellTool provides restricted shell (filtered env, no secrets)
 *   - MCP server injected via `mcp.<name> = { type: "remote", url }`
 *   - ASKPASS handles git auth separately (token never in subprocess env)
 *   - bus-event plugin (`opencodePlugin.ts`) re-emits subagent
 *     `message.part.updated` events that the CLI's run-loop filters out by
 *     `part.sessionID !== sessionID`. Plugin discovery path
 *     (`<XDG_CONFIG_HOME>/opencode/{plugin,plugins}/*.{ts,js}`) and
 *     `bus.subscribeAll()` are unchanged at v1.15.0.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import * as core from "@actions/core";
import { pullfrogMcpName } from "../external.ts";
import { BEDROCK_MODEL_ID_ENV } from "../models.ts";
import type { ToolState } from "../toolState.ts";
import { markActivity } from "../utils/activity.ts";
import { type AgentDiagnostic, formatAgentHangBody } from "../utils/agentHangReport.ts";
import { formatJsonValue, log } from "../utils/cli.ts";
import { installCodexAuth } from "../utils/codexHome.ts";
import { findProviderErrorMatch } from "../utils/providerErrors.ts";
import { addSkill, installBundledSkills } from "../utils/skills.ts";
import {
  DEFAULT_MAX_RETAINED_BYTES,
  SPAWN_ACTIVITY_TIMEOUT_CODE,
  SpawnTimeoutError,
  spawn,
  TailBuffer,
} from "../utils/subprocess.ts";
import type { TodoTracker } from "../utils/todoTracking.ts";
import { getDevDependencyVersion } from "../utils/version.ts";
import { resolveVertexOpenCodeModel } from "../utils/vertex.ts";
import {
  PULLFROG_BUS_EVENT_TYPE,
  PULLFROG_OPENCODE_PLUGIN_FILENAME,
  PULLFROG_OPENCODE_PLUGIN_SOURCE,
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

// v1.14+ npm package: postinstall.mjs renames the platform-specific native
// binary to `bin/opencode.exe` for every OS (incl. linux/darwin).
const installCli = () => installOpencodeCli({ binPath: "bin/opencode.exe" });

// ── config ─────────────────────────────────────────────────────────────────────

// NOTE: OpenCode's per-call `max_tokens` defaults to 32_000. We previously
// overrode this via `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = 5000` in #616
// to lower OpenRouter's per-call upfront budget reservation — back when the
// `ROUTER_PER_RUN_LIMIT_USD = 25` per-run key cap meant that reservation was
// a hard gate that could lock low-balance accounts out of starting a run.
//
// That gate is gone (see `app/api/proxy-token/route.ts` ~line 422 — "Per-run
// key budget … is decoupled from wallet balance"); the router now mints
// keys with `keyLimitCents = balance + buffer` ($50 / $5 / $0). The override
// no longer materially helps, and as a hard per-call output truncation it
// actively hurt: a single `create_pull_request_review` tool_use with many
// inline comments would truncate mid-stream past 5K output tokens, the JSON
// was unparseable, and the tool never invoked. We hit this on PR #710's
// verify-downshift PR. Removed in #710 — using OpenCode's 32K default.
//
// If you need to re-cap output for some reason, set
// `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` in the action env. OpenCode's
// top-level `limit.output` config field has no read site (silently dropped
// on merge in session/llm.ts), so the env var is the only working knob.

// `geminiHighThinkingOverrides` is shared with v1 — imported above. The merge
// order in v1.15 (`base ← model.options ← agent.options ← variant`,
// `session/llm.ts:141`) means our `provider.google.models[id].options` config
// still flows through unmodified.

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
    // NB: `experimental.batch_tool: true` was opt-in at v1.4.x but is
    // declared-but-inert at v1.15.0 — the schema accepts it (`config/config.ts`)
    // and the SDK exposes the type, but no runtime call site reads it. removed
    // here to avoid carrying dead config; re-add when upstream wires the batch
    // tool back. see wiki/prompt.md and the v2 plan doc for the audit trail.
    //
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

// ── NDJSON event types ─────────────────────────────────────────────────────────
//
// Mirrors `cli/cmd/run.ts emit()` at opencode-ai v1.15.0. The CLI writes one
// envelope per call: `{ type, timestamp, sessionID, ...payload }`. Six event
// types: tool_use, step_start, step_finish, text, reasoning, error.
// `init`, `message`, `result`, and standalone `tool_result` are NOT emitted
// at v1.14+ — their handlers in v1 were dead and were dropped here.

interface OpenCodeTextEvent {
  type: "text";
  timestamp?: string;
  sessionID?: string;
  part?: { id?: string; type?: string; text?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface OpenCodeStepStartEvent {
  type: "step_start";
  timestamp?: string;
  sessionID?: string;
  part?: { id?: string; type?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface OpenCodeStepFinishEvent {
  type: "step_finish";
  timestamp?: string;
  sessionID?: string;
  part?: {
    id?: string;
    type?: string;
    reason?: string;
    cost?: number;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * tool-part state, mirroring opencode's `ToolState` (anomalyco/opencode
 * `session/message-v2.ts`). error parts carry the reason on `error`,
 * completed parts on `output` — reading the wrong field is what caused
 * the silent `(no error message)` log in #662.
 *
 * Named `ToolPartState` locally (not `ToolState`) so it doesn't shadow the
 * action-wide `ToolState` imported above.
 */
type ToolPartState =
  | { status: "pending" | "running"; input?: unknown }
  | { status: "completed"; input?: unknown; output: string }
  | { status: "error"; input?: unknown; error: string };

interface OpenCodeToolUseEvent {
  type: "tool_use";
  timestamp?: number;
  sessionID?: string;
  part?: {
    id?: string;
    callID?: string;
    tool?: string;
    state?: ToolPartState;
  };
  [key: string]: unknown;
}

/**
 * Reasoning (thinking) part — only emitted when the CLI is invoked with
 * `--thinking`. Shape mirrors `TextPart`: a finished part has
 * `time?.end !== undefined`. Gemini's `thoughtSignature` round-trip,
 * OpenAI reasoning, and Anthropic extended-thinking all flow through here.
 */
interface OpenCodeReasoningEvent {
  type: "reasoning";
  timestamp?: number;
  sessionID?: string;
  part?: {
    id?: string;
    sessionID?: string;
    messageID?: string;
    type?: string;
    text?: string;
    time?: { start?: number; end?: number };
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface OpenCodeErrorEvent {
  type: "error";
  timestamp?: string;
  sessionID?: string;
  // opencode emits the error message under `error.data.message`, not at the
  // top level. see anomalyco/opencode packages/opencode/src/cli/cmd/run.ts.
  error?: {
    name?: string;
    data?: { message?: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Envelope our injected plugin (`opencodePlugin.ts`) writes to stdout per
 * non-orchestrator `message.part.updated` bus event, so subagent activity
 * surfaces in the parent stream that the CLI run loop would otherwise
 * filter (`cli/cmd/run.ts` checks `part.sessionID === sessionID`).
 * `bus_event.properties.part` matches opencode's `Part` shape so we can
 * route through the same handlers as orchestrator events.
 */
interface OpenCodeBusEnvelopeEvent {
  type: "pullfrog_bus_event";
  bus_event?: {
    type?: string;
    properties?: {
      part?: {
        sessionID?: string;
        type?: string;
        tool?: string;
        callID?: string;
        time?: { start?: number; end?: number };
        state?: { status?: string; input?: unknown };
      };
    };
  };
}

type OpenCodeEvent =
  | OpenCodeTextEvent
  | OpenCodeReasoningEvent
  | OpenCodeStepStartEvent
  | OpenCodeStepFinishEvent
  | OpenCodeToolUseEvent
  | OpenCodeErrorEvent
  | OpenCodeBusEnvelopeEvent;

// ── helpers ─────────────────────────────────────────────────────────────────────

/** Format `part.time` as a `(X.Ys)` suffix when both endpoints are present. */
function formatPartDuration(time: { start?: number; end?: number } | undefined): string {
  if (!time || typeof time.start !== "number" || typeof time.end !== "number") return "";
  if (time.end <= time.start) return "";
  return ` (${((time.end - time.start) / 1000).toFixed(1)}s)`;
}

/** Extract the terminal-state payload (output on completed, error on error). */
function terminalPayload(state: ToolPartState | undefined): string | undefined {
  if (!state) return undefined;
  if (state.status === "completed") return state.output;
  if (state.status === "error") return state.error;
  return undefined;
}

// ── runner ──────────────────────────────────────────────────────────────────────

type RunParams = {
  label: string;
  cliPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  toolState: ToolState;
  todoTracker?: TodoTracker | undefined;
  onActivityTimeout?: (() => void) | undefined;
  onToolUse?: ((event: { toolName: string; input: unknown }) => void) | undefined;
};

async function runOpenCode(params: RunParams): Promise<AgentResult> {
  const startTime = performance.now();
  let eventCount = 0;

  let finalOutput = "";
  let accumulatedTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // per-step `part.cost` sums across the whole session. sourced from models.dev
  // inside opencode — present for every supported provider (Anthropic, OpenAI,
  // Google, xAI, DeepSeek, Moonshot, OpenRouter sub-providers, etc.).
  let accumulatedCostUsd = 0;
  let tokensLogged = false;
  const toolCallTimings = new Map<string, number>();
  // event-to-event silence detector for the "no activity for Xs" diagnostic.
  // local to this runner so chunk-level `markActivity()` (which feeds the
  // outer spawn activityTimeout) doesn't reset it on every chunk arrival.
  let lastEventAt = performance.now();
  // hoisted above `handlers` so closure capture is initialized before any
  // handler can fire — defensive against future refactors that might invoke
  // a handler synchronously during setup.
  const recentStderr: string[] = [];
  let lastProviderError: string | null = null;
  let agentErrorEvent: OpenCodeErrorEvent | null = null;

  // per-session labeler. opencode's CLI run loop filters subagent events
  // (`part.sessionID !== sessionID`); our injected plugin re-emits them as
  // `pullfrog_bus_event` envelopes so the labeler sees real subagent data.
  const labeler = new SessionLabeler();
  function eventLabel(event: Record<string, unknown>): string {
    const sid = event.sessionID ?? event.session_id;
    return labeler.labelFor(typeof sid === "string" ? sid : null);
  }
  function withLabel(label: string, message: string): string {
    return label === ORCHESTRATOR_LABEL ? message : formatWithLabel(label, message);
  }

  // tracks per-task dispatch metadata so the matching tool_use(completed)
  // can log a labeled "» subagent finished: lens=X duration=Ys" line.
  //
  // v2 simplification: at v1.15, opencode keeps a single stable callID across
  // the whole `tool-input-* → tool-call → tool-result/tool-error` chain
  // (`session/processor.ts:282-330,418,448`). The v1-era hybrid exact+FIFO
  // matcher is gone; we use exact-match only.
  interface TaskDispatch {
    label: string;
    startedAt: number;
    toolUseCallID: string;
  }
  const taskDispatchByCallID = new Map<string, TaskDispatch>();

  function emitSubagentFinished(dispatch: TaskDispatch, status: string, output: unknown) {
    const subagentDuration = performance.now() - dispatch.startedAt;
    const outputStr = typeof output === "string" ? output : "";
    const outputPreview = outputStr.length > 120 ? `${outputStr.slice(0, 120)}…` : outputStr;
    log.info(
      `» subagent finished: ${dispatch.label} (${(subagentDuration / 1000).toFixed(1)}s, status=${status})` +
        (outputPreview ? ` — ${outputPreview.replace(/\n/g, " ")}` : "")
    );
    taskDispatchByCallID.delete(dispatch.toolUseCallID);
  }

  function buildUsage(): AgentUsage | undefined {
    const totalInput =
      accumulatedTokens.input + accumulatedTokens.cacheRead + accumulatedTokens.cacheWrite;
    return totalInput > 0 || accumulatedTokens.output > 0
      ? {
          agent: "pullfrog",
          inputTokens: totalInput,
          outputTokens: accumulatedTokens.output,
          cacheReadTokens: accumulatedTokens.cacheRead || undefined,
          cacheWriteTokens: accumulatedTokens.cacheWrite || undefined,
          costUsd: accumulatedCostUsd > 0 ? accumulatedCostUsd : undefined,
        }
      : undefined;
  }

  const handlers = {
    text: (event: OpenCodeTextEvent) => {
      if (event.part?.text?.trim()) {
        const message = event.part.text.trim();
        const label = eventLabel(event);
        const boxTitle = label === ORCHESTRATOR_LABEL ? params.label : `${params.label} [${label}]`;
        log.box(message, { title: boxTitle });
        // only the orchestrator's final text is the run's "output" — children
        // emit their own text on report-back, which would clobber the parent's
        // final answer if we accepted any text into finalOutput.
        if (label === ORCHESTRATOR_LABEL) {
          finalOutput = message;
        }
      }
    },
    /**
     * Reasoning blocks (only emitted when `--thinking` is set in baseArgs).
     * `part.time.{start,end}` give us a precise duration from opencode
     * itself. Not folded into `finalOutput` — that's the final answer,
     * not inner monologue.
     */
    reasoning: (event: OpenCodeReasoningEvent) => {
      const text = event.part?.text?.trim();
      if (!text) return;
      const label = eventLabel(event);
      const durationStr = formatPartDuration(event.part?.time);
      const preview = text.length > 280 ? `${text.slice(0, 280)}…` : text;
      log.info(withLabel(label, `» thinking${durationStr}: ${preview.replace(/\n+/g, " ")}`));
      if (text.length > 280) {
        log.debug(withLabel(label, `» thinking (full): ${text}`));
      }
    },
    // step_start carries no information we surface today (token / cost are
    // reported on step_finish). explicit no-op so the dispatcher doesn't
    // log "unhandled event" for every step.
    step_start: () => {},
    step_finish: (event: OpenCodeStepFinishEvent) => {
      const t = event.part?.tokens;
      if (t) {
        accumulatedTokens.input += t.input || 0;
        accumulatedTokens.output += t.output || 0;
        accumulatedTokens.cacheRead += t.cache?.read || 0;
        accumulatedTokens.cacheWrite += t.cache?.write || 0;
        // TODO: capture `t.reasoning` once `AgentUsage` grows a
        // `reasoningTokens` field. Today these tokens are silently dropped
        // from the token table for reasoning-heavy models (Gemini-3 thinking
        // pinned high, OpenAI o-/gpt-5-codex, Anthropic extended-thinking) —
        // USD totals stay correct because `part.cost` covers them.
      }
      // `part.cost` is a per-step delta, not a running total. verified
      // across Anthropic, OpenAI, Gemini, xAI, DeepSeek, Moonshot,
      // OpenRouter sub-providers. guard NaN/Infinity so a single poison
      // value can't tank the running total for the rest of the session.
      if (typeof event.part?.cost === "number" && Number.isFinite(event.part.cost)) {
        accumulatedCostUsd += event.part.cost;
      }
    },
    /**
     * Tool lifecycle event — at v1.15 a single event covers both completed
     * and error terminal states (read `part.state.status`). Subagent tool
     * parts arrive here via the bus-envelope re-emit too.
     */
    tool_use: (event: OpenCodeToolUseEvent) => {
      const toolName = event.part?.tool;
      const toolId = event.part?.callID;
      const state = event.part?.state;
      if (!toolName || !toolId) {
        log.info(
          `» tool_use event missing toolName or toolId: ${JSON.stringify(event).substring(0, 500)}`
        );
        return;
      }
      const status = state?.status;
      const isTerminal = status === "completed" || status === "error";
      const label = eventLabel(event);

      // seed the labeler's pending-queue on the FIRST observation of a `task`
      // dispatch, before the subagent's first message.part.updated fires.
      // v1.15 keeps callID stable across the lifecycle, so dedupe is by callID.
      if (toolName === "task" && !taskDispatchByCallID.has(toolId)) {
        const taskInput = (state?.input ?? {}) as {
          description?: string;
          subagent_type?: string;
          prompt?: string;
        };
        const dispatchedLabel = labeler.recordTaskDispatch(taskInput);
        taskDispatchByCallID.set(toolId, {
          label: dispatchedLabel,
          startedAt: performance.now(),
          toolUseCallID: toolId,
        });
        log.info(
          `» dispatching subagent: ${dispatchedLabel}` +
            (taskInput.subagent_type ? ` (subagent_type=${taskInput.subagent_type})` : "")
        );
      }

      params.onToolUse?.({ toolName, input: state?.input });

      // record start time on first observation; the bus-envelope re-emit can
      // route the same callID through more than once, so guard the set.
      if (!toolCallTimings.has(toolId)) {
        toolCallTimings.set(toolId, performance.now());
      }

      const inputFormatted = formatJsonValue(state?.input || {});
      const callLine =
        inputFormatted !== "{}" ? `» ${toolName}(${inputFormatted})` : `» ${toolName}()`;
      log.info(withLabel(label, callLine));

      if (state?.status === "completed") {
        log.debug(withLabel(label, `  output: ${state.output}`));
      }
      if (state?.status === "error") {
        log.info(withLabel(label, `» tool call failed: ${state.error}`));
      }

      if (isTerminal) {
        const dispatch = toolName === "task" ? taskDispatchByCallID.get(toolId) : undefined;
        if (dispatch) emitSubagentFinished(dispatch, status, terminalPayload(state));

        const toolStartTime = toolCallTimings.get(toolId);
        if (toolStartTime !== undefined) {
          const toolDuration = performance.now() - toolStartTime;
          toolCallTimings.delete(toolId);
          if (toolDuration > 5000) {
            log.info(
              withLabel(
                label,
                `» tool call took ${(toolDuration / 1000).toFixed(1)}s - may indicate network latency`
              )
            );
          }
        }
      }

      if (toolName.includes("report_progress") && params.todoTracker) {
        log.debug("» report_progress detected, disabling todo tracking");
        params.todoTracker.cancel();
      }

      // todowrite input is identical across pending/running/completed; update
      // once on the terminal observation to avoid redundant work.
      if (toolName === "todowrite" && params.todoTracker?.enabled && isTerminal) {
        params.todoTracker.update(state?.input);
      }
    },
    error: (event: OpenCodeErrorEvent) => {
      // opencode emits a `type=error` event when a provider call fails (e.g.
      // 401 Invalid authentication credentials). the underlying CLI still
      // exits 0 because the error was returned cleanly by the LLM SDK, so
      // unless we capture this event the run is reported as success.
      agentErrorEvent = event;
      const errorName = event.error?.name || "unknown";
      const errorMessage = event.error?.data?.message || event.error?.name || JSON.stringify(event);
      log.info(`» ${params.label} error event: ${errorName}: ${errorMessage}`);
    },
    /**
     * Bus envelope (re-emitted by `opencodePlugin.ts`). Synthesizes a
     * CLI-style event for each part type and routes it through the
     * orchestrator's handlers — same labeling / attribution / logging path.
     * Mirrors the dispatch in upstream's `cli/cmd/run.ts` `loop()`.
     *
     * NOT routed: subagent `step-start` / `step-finish`. step_finish carries
     * `tokens` and `cost` that the orchestrator's handler folds into run-wide
     * accumulators — double-counting subagent tokens would inflate usage
     * telemetry. text/tool_use already gate on ORCHESTRATOR_LABEL inside their
     * handlers for the same reason.
     */
    [PULLFROG_BUS_EVENT_TYPE]: async (event: OpenCodeBusEnvelopeEvent) => {
      const busEvent = event.bus_event;
      if (!busEvent || busEvent.type !== "message.part.updated") return;
      const part = busEvent.properties?.part;
      if (!part || typeof part.sessionID !== "string") return;
      const sessionID = part.sessionID;
      const partType = part.type;

      if (partType === "tool") {
        const status = part.state?.status;
        // Early task-dispatch announce: the CLI's NDJSON `tool_use` event for
        // a `task` call only fires at status=completed (after the subagent
        // finishes), but we need to bind a label to the subagent's sessionID
        // BEFORE its first message.part.updated. only fire on status=running
        // — at "pending", state.input is still {} and the lens label can't be
        // derived. dedupe against the late tool_use handler via callID.
        if (part.tool === "task" && status === "running" && part.callID) {
          if (!taskDispatchByCallID.has(part.callID)) {
            const taskInput = (part.state?.input ?? {}) as {
              description?: string;
              subagent_type?: string;
              prompt?: string;
            };
            const dispatchedLabel = labeler.recordTaskDispatch(taskInput);
            taskDispatchByCallID.set(part.callID, {
              label: dispatchedLabel,
              startedAt: performance.now(),
              toolUseCallID: part.callID,
            });
            log.info(
              `» dispatching subagent: ${dispatchedLabel}` +
                (taskInput.subagent_type ? ` (subagent_type=${taskInput.subagent_type})` : "")
            );
          }
          return;
        }
        if (status !== "completed" && status !== "error") return;
        await handlers.tool_use({ type: "tool_use", sessionID, part } as OpenCodeToolUseEvent);
        return;
      }
      if (partType === "step-start" || partType === "step-finish") return;
      if (partType === "text" && part.time?.end !== undefined) {
        handlers.text({ type: "text", sessionID, part } as OpenCodeTextEvent);
        return;
      }
      if (partType === "reasoning" && part.time?.end !== undefined) {
        handlers.reasoning({ type: "reasoning", sessionID, part } as OpenCodeReasoningEvent);
      }
    },
  };

  // shared with main.ts via toolState. updated in place as events stream and
  // stderr accumulates so the outer activity-timeout catch sees the same
  // context the harness's own catch path uses to format `result.error`.
  // recentStderr is shared by reference; the scalar fields are mirrored on
  // each update below.
  const diagnostic: AgentDiagnostic = {
    label: params.label,
    recentStderr,
    lastProviderError: undefined,
    eventCount: 0,
  };
  params.toolState.agentDiagnostic = diagnostic;

  // capped accumulator for the agent's narration. used as a post-run fallback
  // when `finalOutput` (the orchestrator's final assistant message) is empty.
  // unbounded `output += text` previously grew to ~1 GiB on multi-lens Reviews
  // and contributed to the wrapper-level RangeError. retain:"none" on spawn
  // skips the duplicate buffer there; this TailBuffer caps the agent layer.
  const output = new TailBuffer(DEFAULT_MAX_RETAINED_BYTES);
  let stdoutBuffer = "";

  try {
    const result = await spawn({
      cmd: params.cliPath,
      args: params.args,
      cwd: params.cwd,
      env: params.env,
      activityTimeout: 300_000,
      onActivityTimeout: params.onActivityTimeout,
      stdio: ["ignore", "pipe", "pipe"],
      // node_modules/opencode-ai/bin/opencode is a Node shim that spawnSyncs
      // the native opencode-<plat>-<arch> binary with stdio:"inherit". without
      // a process-group kill, SIGKILL hits only the shim, the native binary
      // is reparented to PID 1, holds our stdout pipe open, and `child.close`
      // never fires — producing zombie runs. detached + killGroup nukes the
      // whole tree.
      killGroup: true,
      // we already drain every chunk via onStdout/onStderr (NDJSON parsing
      // + recentStderr ring buffer). retaining a second copy in the spawn
      // wrapper would grow unbounded for multi-lens Reviews and previously
      // crashed the wrapper with RangeError at ~1 GiB. see issue #680.
      retain: "none",
      // NB: we used to pass `isPausedExternally: isSubagentInFlight` to suspend
      // the activity timer during subagent dispatches. unnecessary now that
      // our injected plugin (action/agents/opencodePlugin.ts) re-emits
      // subagent `message.part.updated` events on opencode's stdout — those
      // arrive at child.stdout here, fire updateActivity(), and reset
      // lastActivityTime naturally. verified empirically in PR #634
      // (~3.3 plugin events/sec during a typical subagent run).
      onStdout: async (chunk) => {
        const text = chunk.toString();
        output.append(text);
        markActivity();

        stdoutBuffer += text;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let event: OpenCodeEvent;
          try {
            event = JSON.parse(trimmed) as OpenCodeEvent;
          } catch {
            log.debug(`» non-JSON stdout line: ${trimmed.substring(0, 200)}`);
            continue;
          }

          eventCount++;
          diagnostic.eventCount = eventCount;
          log.debug(JSON.stringify(event, null, 2));

          // sample BEFORE the per-event marker — `lastEventAt` is local to
          // this runner so it isn't reset by the chunk-level `markActivity()`
          // above (which exists to feed spawn's outer activityTimeout).
          // measures real event-to-event silence; the previous sampling
          // against the module-level idle counter was always ~0ms because
          // the chunk-level reset happened µs earlier.
          const idleMs = performance.now() - lastEventAt;
          if (idleMs > 10000) {
            const activeToolCalls = toolCallTimings.size;
            const toolCallInfo =
              activeToolCalls > 0
                ? ` (waiting for ${activeToolCalls} tool call${activeToolCalls > 1 ? "s" : ""})`
                : ` (${params.label} may be processing internally - LLM calls, planning, etc.)`;
            log.info(
              `» no activity for ${(idleMs / 1000).toFixed(1)}s${toolCallInfo} (${eventCount} events processed so far)`
            );
          }
          lastEventAt = performance.now();

          const handler = handlers[event.type as keyof typeof handlers];
          if (!handler) {
            log.info(
              `» ${params.label} event (unhandled): type=${event.type}, data=${JSON.stringify(event).substring(0, 500)}`
            );
            continue;
          }
          try {
            await handler(event as never);
          } catch (err) {
            log.info(
              `» ${params.label} handler for type=${event.type} threw: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      },
      onStderr: (chunk) => {
        const trimmed = chunk.trim();
        if (!trimmed) return;

        recentStderr.push(trimmed);
        if (recentStderr.length > MAX_STDERR_LINES) recentStderr.shift();

        const match = findProviderErrorMatch(trimmed);
        if (match) {
          lastProviderError = match.label;
          diagnostic.lastProviderError = match.label;
          log.info(`» provider error detected (${match.label}): ${match.excerpt}`);
        } else {
          log.debug(trimmed);
        }
      },
    });

    if (result.exitCode === 0) {
      await params.todoTracker?.flush();
    } else {
      params.todoTracker?.cancel();
    }

    // any task dispatches that didn't see a terminal tool_use are surfaced
    // here so the gap is visible rather than silently swallowed. v2 reaches
    // here much less often than v1 (callIDs are stable, so terminal tool_use
    // matches the dispatch exactly), but a subagent reply that arrives via
    // an assistant message rather than the task tool's terminal state can
    // still leave the dispatch open. durations reported are upper bounds.
    if (taskDispatchByCallID.size > 0) {
      for (const dispatch of taskDispatchByCallID.values()) {
        const elapsed = performance.now() - dispatch.startedAt;
        log.info(
          `» subagent finished (inferred at run-end): ${dispatch.label} (≤${(elapsed / 1000).toFixed(1)}s) — no terminal tool_use observed; reply likely arrived via assistant message`
        );
      }
      taskDispatchByCallID.clear();
    }

    const duration = performance.now() - startTime;
    log.info(
      `» ${params.label} completed in ${Math.round(duration)}ms with exit code ${result.exitCode}`
    );

    if (eventCount === 0) {
      const stderrContext = recentStderr.join("\n");
      const diagnosis = lastProviderError
        ? `provider error: ${lastProviderError}`
        : "unknown cause (no stdout events received)";
      log.info(`» ${params.label} produced 0 events (${diagnosis})`);
      if (stderrContext) log.info(`» last stderr output:\n${stderrContext}`);
    }

    if (
      !tokensLogged &&
      (accumulatedTokens.input > 0 ||
        accumulatedTokens.output > 0 ||
        accumulatedTokens.cacheRead > 0 ||
        accumulatedTokens.cacheWrite > 0)
    ) {
      logTokenTable({ ...accumulatedTokens, costUsd: accumulatedCostUsd });
      tokensLogged = true;
    }

    const usage = buildUsage();

    if (result.exitCode !== 0) {
      const errorContext = lastProviderError ? ` (${lastProviderError})` : "";
      // result.stdout / result.stderr are empty because we pass retain:"none"
      // to spawn (see issue #680); use the agent's bounded mirrors instead.
      const stdoutSnapshot = output.toString();
      const stderrSnapshot = recentStderr.join("\n");
      const errorMessage =
        stderrSnapshot ||
        stdoutSnapshot ||
        `unknown error - no output from OpenCode CLI${errorContext}`;
      log.error(
        `${params.label} exited with code ${result.exitCode}${errorContext}: ${errorMessage}`
      );
      log.debug(`stdout: ${stdoutSnapshot.substring(0, 500)}`);
      log.debug(`stderr: ${stderrSnapshot.substring(0, 500)}`);
      return {
        success: false,
        output: finalOutput || stdoutSnapshot,
        error: errorMessage,
        usage,
      };
    }

    if (eventCount === 0 && lastProviderError) {
      return {
        success: false,
        output: finalOutput || output.toString(),
        error: `provider error: ${lastProviderError}`,
        usage,
      };
    }

    if (agentErrorEvent) {
      const errorEvent: OpenCodeErrorEvent = agentErrorEvent;
      const errorName = errorEvent.error?.name || "agent error";
      const errorMessage =
        errorEvent.error?.data?.message || errorEvent.error?.name || JSON.stringify(errorEvent);
      return {
        success: false,
        output: finalOutput || output.toString(),
        error: `${errorName}: ${errorMessage}`,
        usage,
      };
    }

    return { success: true, output: finalOutput || output.toString(), usage };
  } catch (error) {
    params.todoTracker?.cancel();
    const duration = performance.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isActivityTimeout =
      error instanceof SpawnTimeoutError && error.code === SPAWN_ACTIVITY_TIMEOUT_CODE;

    const stderrContext = recentStderr.slice(-10).join("\n");
    const diagnosis = lastProviderError
      ? `likely cause: ${lastProviderError}`
      : eventCount === 0
        ? "OpenCode produced 0 stdout events - check if the model provider is reachable"
        : `${eventCount} events were processed before the hang`;

    log.info(
      `» ${params.label} ${isActivityTimeout ? "hung" : "failed"} after ${(duration / 1000).toFixed(1)}s: ${errorMessage}`
    );
    log.info(`» diagnosis: ${diagnosis}`);
    if (stderrContext)
      log.info(
        `» recent stderr (last ${Math.min(recentStderr.length, 10)} lines):\n${stderrContext}`
      );

    const body = formatAgentHangBody({ diagnostic, isHang: isActivityTimeout, errorMessage });
    return {
      success: false,
      output: finalOutput || output.toString(),
      error: body ?? `${errorMessage} [${diagnosis}]`,
      usage: buildUsage(),
    };
  }
}

// ── agent ───────────────────────────────────────────────────────────────────────

export const opencode = agent({
  name: "opencode",
  install: installCli,
  run: async (ctx) => {
    const cliPath = await installCli();

    const rawModel = ctx.payload.proxyModel ?? ctx.resolvedModel ?? autoSelectModel(cliPath);

    // bedrock route: opencode's `amazon-bedrock` provider expects the model
    // string in `amazon-bedrock/<bedrock-id>` form. the bare AWS model ID
    // (what the user puts in `BEDROCK_MODEL_ID`) needs the prefix added.
    // detect via env-var sentinel — same pattern as claude.ts.
    //
    // we deliberately do NOT gate on `!isBedrockAnthropicId(rawModel)` here:
    // Anthropic-on-Bedrock normally routes to claude-code (per `resolveAgent`),
    // but `PULLFROG_AGENT=opencode` is the documented escape hatch for forcing
    // opencode regardless. when that override fires, opencode still needs the
    // `amazon-bedrock/` prefix or the provider lookup fails with
    // "Model not found: <modelId>/.". the Anthropic-vs-other discriminant
    // only belongs in `resolveAgent`.
    const bedrockModelId = process.env[BEDROCK_MODEL_ID_ENV]?.trim();
    const isBedrockRoute =
      rawModel !== undefined && bedrockModelId !== undefined && bedrockModelId === rawModel;
    const vertexModel = resolveVertexOpenCodeModel(rawModel);
    const model = vertexModel ?? (isBedrockRoute ? `amazon-bedrock/${rawModel}` : rawModel);

    const homeEnv = {
      HOME: ctx.tmpdir,
      XDG_CONFIG_HOME: join(ctx.tmpdir, ".config"),
    };

    mkdirSync(join(homeEnv.XDG_CONFIG_HOME, "opencode"), { recursive: true });

    // drop our bus-event surfacing plugin into opencode's global config dir
    // (which we've redirected to the per-run tmpdir via XDG_CONFIG_HOME).
    // opencode auto-discovers plugins from `<Global.Path.config>/{plugin,plugins}/*.{ts,js}`
    // (see `packages/opencode/src/config/config.ts:633` calling
    // `ConfigPlugin.load(dir)`), so this lands in the loader without any
    // config wiring. critically: this MUST be inside the tmpdir, never the
    // user's repo working tree — see AGENTS.md.
    const opencodePluginDir = join(homeEnv.XDG_CONFIG_HOME, "opencode", "plugin");
    mkdirSync(opencodePluginDir, { recursive: true });
    writeFileSync(
      join(opencodePluginDir, PULLFROG_OPENCODE_PLUGIN_FILENAME),
      PULLFROG_OPENCODE_PLUGIN_SOURCE
    );

    const agentBrowserVersion = getDevDependencyVersion("agent-browser");
    addSkill({
      ref: `vercel-labs/agent-browser@v${agentBrowserVersion}`,
      skill: "agent-browser",
      env: homeEnv,
      agent: "opencode",
    });

    installBundledSkills({ home: homeEnv.HOME });

    // materialize CODEX_AUTH_JSON (Pullfrog-stored Codex subscription
    // credential) into the runner's REAL $HOME/.local/share/opencode/auth.json
    // so OpenCode's CodexAuthPlugin picks it up and routes openai requests
    // through the ChatGPT subscription instead of needing OPENAI_API_KEY.
    // see action/utils/codexHome.ts and wiki/codex-auth.md.
    const codexAuth = installCodexAuth();

    // base args shared between initial run and continue runs.
    // `--thinking` is required at v1.14+ to surface `reasoning` NDJSON events
    // — the CLI's run loop suppresses reasoning emission unless this flag is
    // set (`cli/cmd/run.ts:241,671`). Without it Gemini-3 / OpenAI-reasoning /
    // Anthropic-extended-thinking blocks would silently disappear from the
    // log even though the model produced them.
    const baseArgs = ["run", "--format", "json", "--print-logs", "--thinking"];

    // OPENCODE_PERMISSION has absolute highest precedence (merged after managed/MDM configs).
    // external_directory gates ALL native filesystem tools (Read, Write, Edit, Glob, Grep, etc.)
    // for paths outside the project root. last-match-wins: deny everything, then allow /tmp.
    // auth.json sits under real $HOME (outside /tmp/*), so deny-default protects it.
    const permissionOverride = JSON.stringify({
      external_directory: { "*": "deny", "/tmp/*": "allow" },
    });

    const repoDir = process.cwd();

    // CRITICAL: opencode-ai >=1.14 reads `process.env.PWD` first when
    // resolving the SDK client's `directory` parameter (see upstream
    // `cli/cmd/run.ts:282` — `Filesystem.resolve(process.env.PWD ?? process.cwd())`).
    // We pass `cwd: repoDir` to spawn but the child inherits the harness's
    // PWD via `...process.env`, which (when running through the test runner /
    // GHA wrapper) is a different directory. Without overriding PWD, opencode
    // creates *two* instances — one at `process.cwd()` (correct) and one at
    // `PWD` (wrong) — and the agent's session runs in the wrong-cwd one,
    // missing the project's `.opencode/skills/` and `.claude/skills/`.
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...homeEnv,
      PWD: repoDir,
      OPENCODE_CONFIG_CONTENT: buildSecurityConfig(ctx, model),
      OPENCODE_PERMISSION: permissionOverride,
      GOOGLE_GENERATIVE_AI_API_KEY:
        process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY,
    };

    if (codexAuth) {
      // point OpenCode at the real-home XDG dir so it reads auth.json from
      // where we wrote it (not the tmpdir-redirected default).
      env.XDG_DATA_HOME = codexAuth.xdgDataHome;
      // remove OPENAI_API_KEY so OpenCode's provider merge unambiguously
      // picks the OAuth path. with both set, the merge order in opencode
      // makes the effective key ambiguous.
      delete env.OPENAI_API_KEY;
      // hand the post-hook everything it needs to detect + persist refresh.
      // post-hook runs in a fresh node process, so we have to ferry apiToken
      // explicitly — env is preserved across main/post but our run-context
      // JWT is computed at runtime and not put in env. see action/entryPost.ts.
      core.saveState(
        "codex_writeback",
        JSON.stringify({
          apiToken: ctx.apiToken,
          authPath: codexAuth.authPath,
          originalRefresh: codexAuth.originalRefresh,
        })
      );
    }

    log.debug(`» starting Pullfrog (OpenCode): ${cliPath} ${baseArgs.join(" ")}`);
    log.debug(`» working directory: ${repoDir}`);

    const runParams = {
      label: "Pullfrog",
      cliPath,
      cwd: repoDir,
      env,
      toolState: ctx.toolState,
      todoTracker: ctx.todoTracker,
      onActivityTimeout: ctx.onActivityTimeout,
      onToolUse: ctx.onToolUse,
    };

    const result = await runOpenCode({
      ...runParams,
      args: [...baseArgs, ctx.instructions.full],
    });

    // post-run retry loop aggregates usage across the initial run + every
    // resume, so the caller sees the whole session — not just the final
    // slice. opencode always accepts `--continue`, so no canResume guard.
    // the reflection prompt fires once after gates go clean, as a dedicated
    // turn that nudges the agent to persist learnings.
    return runPostRunRetryLoop({
      ctx,
      initialResult: result,
      initialUsage: result.usage,
      reflectionPrompt:
        ctx.toolState.learningsFilePath && shouldRunReflection(ctx.toolState.selectedMode)
          ? buildLearningsReflectionPrompt(ctx.toolState.learningsFilePath)
          : undefined,
      resume: async (c) =>
        runOpenCode({
          ...runParams,
          args: [...baseArgs, "--continue", c.prompt],
        }),
    });
  },
});
