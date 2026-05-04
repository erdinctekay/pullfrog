/**
 * OpenCode agent — secure harness around OpenCode CLI.
 *
 * transparently wraps OpenCode with a security layer:
 * - bash: "deny" via OPENCODE_CONFIG_CONTENT (agent cannot shell out)
 * - OPENCODE_PERMISSION: filesystem sandbox — deny all external paths except /tmp
 * - MCP ShellTool provides restricted shell (filtered env, no secrets)
 * - MCP server injected alongside project config (not replacing)
 * - ASKPASS handles git auth separately (token never in subprocess env)
 *
 * the agent process itself gets full env (needs LLM API keys, PATH, etc.).
 * security is enforced at the tool layer, not the process layer.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pullfrogMcpName } from "../external.ts";
import { modelAliases } from "../models.ts";
import { getIdleMs, markActivity } from "../utils/activity.ts";
import { formatJsonValue, log } from "../utils/cli.ts";
import { installFromNpmTarball } from "../utils/install.ts";
import { detectProviderError } from "../utils/providerErrors.ts";
import { addSkill, installBundledSkills } from "../utils/skills.ts";
import { SPAWN_ACTIVITY_TIMEOUT_CODE, SpawnTimeoutError, spawn } from "../utils/subprocess.ts";
import { ThinkingTimer } from "../utils/timer.ts";
import type { TodoTracker } from "../utils/todoTracking.ts";
import { getDevDependencyVersion } from "../utils/version.ts";
import { buildLearningsReflectionPrompt, runPostRunRetryLoop } from "./postRun.ts";
import { REVIEWER_AGENT_NAME, REVIEWER_SYSTEM_PROMPT } from "./reviewer.ts";
import { formatWithLabel, ORCHESTRATOR_LABEL, SessionLabeler } from "./sessionLabeler.ts";
import {
  type AgentResult,
  type AgentRunContext,
  type AgentUsage,
  agent,
  logTokenTable,
  MAX_STDERR_LINES,
} from "./shared.ts";

async function installOpencodeCli(): Promise<string> {
  return await installFromNpmTarball({
    packageName: "opencode-ai",
    version: getDevDependencyVersion("opencode-ai"),
    executablePath: "bin/opencode",
    installDependencies: true,
  });
}

// ── config ─────────────────────────────────────────────────────────────────────

type OpenCodeConfig = {
  mcp?: Record<string, unknown>;
  permission?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  model?: string;
  enabled_providers?: string[];
  [key: string]: unknown;
};

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
    agent: buildReviewerAgentConfig(),
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

/**
 * Read-only subagent for self-review and /anneal lens dispatch. The
 * non-mutative + non-recursive contract is enforced by the prose system
 * prompt — see action/agents/reviewer.ts for why we no longer wire per-agent
 * tool/permission denies here.
 */
function buildReviewerAgentConfig(): Record<string, unknown> {
  return {
    [REVIEWER_AGENT_NAME]: {
      description:
        "Read-only review subagent for self-review and lens-based code review. " +
        "Reads only — no writes, no state-changing shell or MCP calls, no nested subagent dispatch.",
      mode: "subagent",
      prompt: REVIEWER_SYSTEM_PROMPT,
    },
  };
}

// ── model auto-select fallback ──────────────────────────────────────────────────
//
// steps 1–2 of model resolution (PULLFROG_MODEL env, slug resolution) are handled
// by resolveModel() in utils/agent.ts before the agent runs. this fallback only
// handles step 3: auto-select via `opencode models`.

function getOpenCodeModels(cliPath: string): string[] {
  try {
    const output = execFileSync(cliPath, ["models"], {
      encoding: "utf-8",
      timeout: 30_000,
      env: process.env,
    });
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    log.debug(
      `» failed to run \`opencode models\`: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

const AUTO_SELECT_WARNING =
  "select a model explicitly in the Pullfrog console (https://pullfrog.com/console) to avoid this.";

function autoSelectModel(cliPath: string): string | undefined {
  const availableModels = getOpenCodeModels(cliPath);
  const availableSet = new Set(availableModels);
  if (availableSet.size > 0) {
    log.debug(`» opencode models (${availableSet.size}): ${availableModels.join(", ")}`);
    const match =
      modelAliases.find((a) => a.preferred && availableSet.has(a.resolve)) ??
      modelAliases.find((a) => availableSet.has(a.resolve));
    if (match) {
      log.info(
        `» model: ${match.resolve} (auto-selected${match.preferred ? " — preferred" : ""} curated match)`
      );
      log.warning(`» model auto-selected. ${AUTO_SELECT_WARNING}`);
      return match.resolve;
    }
    log.info(
      `» opencode has ${availableSet.size} models but none match curated aliases — letting OpenCode auto-select`
    );
  }

  log.warning(`» no model resolved. letting OpenCode auto-select. ${AUTO_SELECT_WARNING}`);
  return undefined;
}

// ── NDJSON event types ─────────────────────────────────────────────────────────

interface OpenCodeInitEvent {
  type: "init";
  timestamp?: string;
  session_id?: string;
  model?: string;
  [key: string]: unknown;
}

interface OpenCodeMessageEvent {
  type: "message";
  timestamp?: string;
  role?: "user" | "assistant";
  content?: string;
  delta?: boolean;
  [key: string]: unknown;
}

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

interface OpenCodeToolUseEvent {
  type: "tool_use";
  timestamp?: number;
  sessionID?: string;
  part?: {
    id?: string;
    callID?: string;
    tool?: string;
    state?: { status?: string; input?: unknown; output?: string };
  };
  [key: string]: unknown;
}

interface OpenCodeToolResultEvent {
  type: "tool_result";
  timestamp?: number;
  sessionID?: string;
  part?: { callID?: string; state?: { status?: string; output?: string } };
  tool_id?: string;
  status?: "success" | "error";
  output?: string;
  [key: string]: unknown;
}

interface OpenCodeResultEvent {
  type: "result";
  timestamp?: string;
  status?: "success" | "error";
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    duration_ms?: number;
    tool_calls?: number;
  };
  [key: string]: unknown;
}

interface OpenCodeErrorEvent {
  type: "error";
  timestamp?: string;
  sessionID?: string;
  error?: { name?: string; message?: string; data?: unknown; [key: string]: unknown };
  [key: string]: unknown;
}

type OpenCodeEvent =
  | OpenCodeInitEvent
  | OpenCodeMessageEvent
  | OpenCodeTextEvent
  | OpenCodeStepStartEvent
  | OpenCodeStepFinishEvent
  | OpenCodeToolUseEvent
  | OpenCodeToolResultEvent
  | OpenCodeResultEvent
  | OpenCodeErrorEvent;

// ── runner ──────────────────────────────────────────────────────────────────────

type RunParams = {
  label: string;
  cliPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  todoTracker?: TodoTracker | undefined;
  onActivityTimeout?: (() => void) | undefined;
  onToolUse?: ((event: { toolName: string; input: unknown }) => void) | undefined;
};

async function runOpenCode(params: RunParams): Promise<AgentResult> {
  const startTime = performance.now();
  let eventCount = 0;
  const thinkingTimer = new ThinkingTimer();

  let finalOutput = "";
  let accumulatedTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // per-step `part.cost` sums across the whole session. sourced from models.dev
  // inside opencode — present for every supported provider (Anthropic, OpenAI,
  // Google, xAI, DeepSeek, Moonshot, OpenRouter sub-providers, etc.).
  let accumulatedCostUsd = 0;
  let tokensLogged = false;
  const toolCallTimings = new Map<string, number>();
  let currentStepId: string | null = null;
  let currentStepType: string | null = null;
  let stepHistory: Array<{ stepId: string; stepType: string; toolCalls: string[] }> = [];

  // per-session labeler so parallel subagent log lines can be differentiated.
  // the orchestrator's task tool_use events seed the labeler; the next
  // previously-unseen sessionID consumes the head of the pending-label queue.
  // NB: opencode's runtime currently encapsulates subagent execution inside
  // the `task` tool — subagent-internal tool_use/tool_result events do not
  // surface on the parent's NDJSON stream. The labeler is therefore mostly
  // dormant in practice for opencode (no per-event session differentiation
  // is needed because there are no per-subagent events). The orchestrator's
  // `task` dispatch log (with `description: <lens>`) and the per-task
  // duration log below are the actual attribution surface available today.
  // The labeler is kept in place defensively so that if/when opencode begins
  // streaming subagent sessions, attribution flips on with no further work.
  const labeler = new SessionLabeler();
  function eventLabel(event: Record<string, unknown>): string {
    const sid = event.sessionID ?? event.session_id;
    return labeler.labelFor(typeof sid === "string" ? sid : null);
  }
  function withLabel(label: string, message: string): string {
    return label === ORCHESTRATOR_LABEL ? message : formatWithLabel(label, message);
  }

  // tracks per-task dispatch metadata so the matching tool_result can log a
  // labeled "» subagent finished: lens=X duration=Ys" line. this is the most
  // useful per-lens observability available given that subagent-internal
  // events aren't streamed.
  //
  // matching strategy is hybrid because opencode does NOT reliably emit a
  // tool_result with a callID equal to the originating tool_use.callID for
  // the `task` tool (verified empirically in T3 — 5 task dispatches recorded
  // here, 0 finish lines fired, yet aggregation succeeded so results did
  // arrive on the stream). we keep an exact-match Map for the fast path, and
  // also a FIFO queue for the fallback path where the callID mismatches.
  // the queue + map share entries by reference so popping one removes both.
  interface TaskDispatch {
    label: string;
    startedAt: number;
    toolUseCallID: string;
  }
  const taskDispatchByCallID = new Map<string, TaskDispatch>();
  const pendingTaskDispatches: TaskDispatch[] = [];
  // every non-task tool_use callID we've observed. lets us tell, on a
  // tool_result, whether its callID belongs to a known non-task tool (in
  // which case we never fall back to FIFO) or is unrecognised (in which case
  // a long-output result is a strong "this is probably a task result with a
  // mismatched callID" signal).
  const knownNonTaskCallIDs = new Set<string>();

  function emitSubagentFinished(
    dispatch: TaskDispatch,
    status: string,
    output: unknown,
    matchKind: "exact" | "fifo"
  ) {
    const subagentDuration = performance.now() - dispatch.startedAt;
    const outputStr = typeof output === "string" ? output : "";
    const outputPreview = outputStr.length > 120 ? `${outputStr.slice(0, 120)}…` : outputStr;
    const matchSuffix = matchKind === "fifo" ? " [fifo-matched]" : "";
    log.info(
      `» subagent finished: ${dispatch.label} (${(subagentDuration / 1000).toFixed(1)}s, status=${status})${matchSuffix}` +
        (outputPreview ? ` — ${outputPreview.replace(/\n/g, " ")}` : "")
    );
    taskDispatchByCallID.delete(dispatch.toolUseCallID);
    const idx = pendingTaskDispatches.indexOf(dispatch);
    if (idx >= 0) pendingTaskDispatches.splice(idx, 1);
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
    init: (event: OpenCodeInitEvent) => {
      // bind this sessionID to a label so subsequent events (tool_use,
      // tool_result, text, message) route to the right prefix. for the
      // first session this is "orchestrator"; for subagents it pops from
      // the pending-dispatch queue.
      const label = labeler.labelFor(event.session_id ?? null);
      log.debug(
        withLabel(
          label,
          `» ${params.label} init: session_id=${event.session_id || "unknown"}, model=${event.model || "unknown"}`
        )
      );
      log.debug(withLabel(label, `» ${params.label} init event (full): ${JSON.stringify(event)}`));
      // only reset run-wide state on the orchestrator's init — child sessions
      // emit their own init events and we don't want them to clobber the
      // parent's accumulated counters.
      if (label === ORCHESTRATOR_LABEL) {
        finalOutput = "";
        accumulatedTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        accumulatedCostUsd = 0;
        tokensLogged = false;
      } else {
        log.info(`» ${params.label} subagent init: ${label} (session ${event.session_id || "?"})`);
      }
    },
    message: (event: OpenCodeMessageEvent) => {
      const label = eventLabel(event);
      if (event.role === "assistant" && event.content?.trim()) {
        const message = event.content.trim();
        if (event.delta) {
          log.debug(
            withLabel(
              label,
              `» ${params.label} thinking: ${message.substring(0, 300)}${message.length > 300 ? "..." : ""}`
            )
          );
        } else {
          log.debug(
            withLabel(
              label,
              `» ${params.label} message (${event.role}): ${message.substring(0, 100)}${message.length > 100 ? "..." : ""}`
            )
          );
          // same reasoning as `text` handler — only orchestrator's non-delta
          // assistant message is the run output; subagent reports stay scoped
          // to the box / debug log.
          if (label === ORCHESTRATOR_LABEL) {
            finalOutput = message;
          }
        }
      } else if (event.role === "user") {
        log.debug(
          withLabel(
            label,
            `» ${params.label} message (${event.role}): ${event.content?.substring(0, 100) || ""}${event.content && event.content.length > 100 ? "..." : ""}`
          )
        );
      }
    },
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
    step_start: (event: OpenCodeStepStartEvent) => {
      const stepType = event.part?.type || "unknown";
      const stepId = event.part?.id || "unknown";
      currentStepId = stepId;
      currentStepType = stepType;
      stepHistory.push({ stepId, stepType, toolCalls: [] });
    },
    step_finish: async (event: OpenCodeStepFinishEvent) => {
      const stepId = event.part?.id || "unknown";
      const eventTokens = event.part?.tokens;
      if (eventTokens) {
        accumulatedTokens.input += eventTokens.input || 0;
        accumulatedTokens.output += eventTokens.output || 0;
        accumulatedTokens.cacheRead += eventTokens.cache?.read || 0;
        accumulatedTokens.cacheWrite += eventTokens.cache?.write || 0;
      }
      // step_finish.part.cost is a per-step delta (not a running total) —
      // OpenCode emits varying per-event values that sum to the session cost.
      // verified empirically across Anthropic, OpenAI, Gemini, xAI, DeepSeek,
      // Moonshot, and OpenRouter (see pullfrog-baseline/opencode-*.log).
      // guard against NaN/Infinity — a single poison value would make the
      // running total un-recoverable for the rest of the session.
      if (typeof event.part?.cost === "number" && Number.isFinite(event.part.cost)) {
        accumulatedCostUsd += event.part.cost;
      }
      if (currentStepId === stepId) {
        currentStepId = null;
        currentStepType = null;
      }
    },
    tool_use: (event: OpenCodeToolUseEvent) => {
      const toolName = event.part?.tool;
      const toolId = event.part?.callID;
      if (!toolName || !toolId) {
        log.info(
          `» tool_use event missing toolName or toolId: ${JSON.stringify(event).substring(0, 500)}`
        );
        return;
      }

      // when the orchestrator dispatches a subagent via the `task` tool, push
      // a label for the upcoming child session so its events are attributable.
      // record BEFORE label lookup: this event's session is the parent (whose
      // label is already bound); the dispatch label is for the next new
      // sessionID that appears.
      if (toolName === "task") {
        const taskInput = (event.part?.state?.input ?? {}) as {
          description?: string;
          subagent_type?: string;
          prompt?: string;
        };
        const dispatchedLabel = labeler.recordTaskDispatch(taskInput);
        // dual-index by callID (fast path) AND in a FIFO queue (fallback path
        // for when opencode's task tool_result carries a different callID).
        const dispatch: TaskDispatch = {
          label: dispatchedLabel,
          startedAt: performance.now(),
          toolUseCallID: toolId,
        };
        taskDispatchByCallID.set(toolId, dispatch);
        pendingTaskDispatches.push(dispatch);
        log.info(
          `» dispatching subagent: ${dispatchedLabel}` +
            (taskInput.subagent_type ? ` (subagent_type=${taskInput.subagent_type})` : "")
        );
      } else {
        // remember non-task callIDs so a later tool_result with that callID
        // is correctly identified as not-a-task (and we don't FIFO-pop a
        // pending task by mistake).
        knownNonTaskCallIDs.add(toolId);
      }

      const label = eventLabel(event);

      if (stepHistory.length > 0) {
        stepHistory[stepHistory.length - 1]!.toolCalls.push(toolName);
      }

      if (params.onToolUse) {
        params.onToolUse({
          toolName,
          input: event.part?.state?.input,
        });
      }

      thinkingTimer.markToolCall();
      const inputFormatted = formatJsonValue(event.part?.state?.input || {});
      const toolCallLine =
        inputFormatted !== "{}" ? `» ${toolName}(${inputFormatted})` : `» ${toolName}()`;
      log.info(withLabel(label, toolCallLine));

      if (event.part?.state?.status === "completed" && event.part.state.output) {
        log.debug(withLabel(label, `  output: ${event.part.state.output}`));
      }

      // agent's explicit MCP report_progress takes priority over todo tracking
      if (toolName.includes("report_progress") && params.todoTracker) {
        log.debug("» report_progress detected, disabling todo tracking");
        params.todoTracker.cancel();
      }

      // parse todowrite events for live progress tracking
      if (toolName === "todowrite" && params.todoTracker?.enabled) {
        params.todoTracker.update(event.part?.state?.input);
      }
    },
    tool_result: (event: OpenCodeToolResultEvent) => {
      const toolId = event.part?.callID || event.tool_id;
      const status = event.part?.state?.status || event.status || "unknown";
      const output = event.part?.state?.output || event.output;
      const label = eventLabel(event);

      thinkingTimer.markToolResult();

      // surface subagent completion at info level — opencode otherwise hides
      // per-task timing in debug-only logs, so a parallel multi-lens fan-out
      // looks like N dispatches followed by a long quiet gap then a single
      // assistant turn. with this line you can see each lens finishing.
      //
      // matching is hybrid: exact callID first; FIFO fallback when the
      // tool_result's callID is unrecognised. opencode does not consistently
      // surface matching callIDs for the `task` tool, so the FIFO path is the
      // one that fires in practice. we only fall through to FIFO when the
      // callID is brand-new (not in `knownNonTaskCallIDs`) so genuinely
      // non-task tool_results never accidentally pop a pending task.
      if (taskDispatchByCallID.size > 0 || pendingTaskDispatches.length > 0) {
        if (toolId && taskDispatchByCallID.has(toolId)) {
          const dispatch = taskDispatchByCallID.get(toolId);
          if (dispatch) emitSubagentFinished(dispatch, status, output, "exact");
        } else {
          const callIDIsKnownNonTask = toolId ? knownNonTaskCallIDs.has(toolId) : false;
          if (!callIDIsKnownNonTask && pendingTaskDispatches.length > 0) {
            const dispatch = pendingTaskDispatches[0]!;
            emitSubagentFinished(dispatch, status, output, "fifo");
          }
        }
      }

      if (toolId) {
        const toolStartTime = toolCallTimings.get(toolId);
        if (toolStartTime) {
          const toolDuration = performance.now() - toolStartTime;
          toolCallTimings.delete(toolId);
          const stepContext = currentStepId ? ` (step=${currentStepType || "unknown"})` : "";
          log.debug(
            withLabel(
              label,
              `» ${params.label} tool_result${stepContext}: id=${toolId}, status=${status}, duration=${Math.round(toolDuration)}ms`
            )
          );
          if (output) {
            log.debug(
              withLabel(
                label,
                `  output: ${typeof output === "string" ? output : JSON.stringify(output)}`
              )
            );
          }
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
      if (status === "error") {
        const errorMsg = typeof output === "string" ? output : JSON.stringify(output);
        log.info(withLabel(label, `» tool call failed: ${errorMsg}`));
      } else if (output) {
        const outputStr = typeof output === "string" ? output : JSON.stringify(output);
        log.debug(withLabel(label, `tool output: ${outputStr}`));
      }
    },
    result: async (event: OpenCodeResultEvent) => {
      const status = event.status || "unknown";
      const duration = event.stats?.duration_ms || 0;
      const toolCalls = event.stats?.tool_calls || 0;
      log.info(
        `» ${params.label} result: status=${status}, duration=${duration}ms, tool_calls=${toolCalls}`
      );

      if (event.status === "error") {
        log.info(`» ${params.label} failed: ${JSON.stringify(event)}`);
      } else {
        // the final `result` event only carries input_tokens/output_tokens and
        // no cache breakdown — accumulatedTokens (summed across step_finish
        // events) is strictly more accurate, so we prefer it unconditionally.
        log.info(`» run complete: tool_calls=${toolCalls}, duration=${duration}ms`);

        if (
          (accumulatedTokens.input > 0 ||
            accumulatedTokens.output > 0 ||
            accumulatedTokens.cacheRead > 0 ||
            accumulatedTokens.cacheWrite > 0) &&
          !tokensLogged
        ) {
          logTokenTable({ ...accumulatedTokens, costUsd: accumulatedCostUsd });
          tokensLogged = true;
        }
      }
    },
  };

  const recentStderr: string[] = [];

  let lastProviderError: string | null = null;

  let output = "";
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
      onStdout: async (chunk) => {
        const text = chunk.toString();
        output += text;
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
          log.debug(JSON.stringify(event, null, 2));

          const timeSinceLastActivity = getIdleMs();
          if (timeSinceLastActivity > 10000) {
            const activeToolCalls = toolCallTimings.size;
            const toolCallInfo =
              activeToolCalls > 0
                ? ` (waiting for ${activeToolCalls} tool call${activeToolCalls > 1 ? "s" : ""})`
                : ` (${params.label} may be processing internally - LLM calls, planning, etc.)`;
            log.info(
              `» no activity for ${(timeSinceLastActivity / 1000).toFixed(1)}s${toolCallInfo} (${eventCount} events processed so far)`
            );
          }
          markActivity();

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

        const providerError = detectProviderError(trimmed);
        if (providerError) {
          lastProviderError = providerError;
          log.info(`» provider error detected (${providerError}): ${trimmed.substring(0, 500)}`);
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

    // any pending task dispatches that never got a matching tool_result are
    // surfaced here so the gap is visible rather than silently swallowed.
    // this happens when opencode delivers the subagent's reply through a
    // path other than tool_result (e.g. inlined into the next assistant
    // message). flushing here is best-effort attribution — the durations
    // reported are upper bounds (the subagent could have finished any time
    // between dispatch and run-end), but the labels and ordering are exact.
    //
    // NB: the `result` event handler is dead in opencode (opencode never
    // emits a `result`-typed event), which is why this flush lives here in
    // the post-subprocess block instead.
    if (pendingTaskDispatches.length > 0) {
      for (const dispatch of [...pendingTaskDispatches]) {
        const elapsed = performance.now() - dispatch.startedAt;
        log.info(
          `» subagent finished (inferred at run-end): ${dispatch.label} (≤${(elapsed / 1000).toFixed(1)}s) — no matching tool_result observed; subagent reply likely arrived via assistant message`
        );
      }
      pendingTaskDispatches.length = 0;
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
      const errorMessage =
        result.stderr ||
        result.stdout ||
        `unknown error - no output from OpenCode CLI${errorContext}`;
      log.error(
        `${params.label} exited with code ${result.exitCode}${errorContext}: ${errorMessage}`
      );
      log.debug(`stdout: ${result.stdout?.substring(0, 500)}`);
      log.debug(`stderr: ${result.stderr?.substring(0, 500)}`);
      return { success: false, output: finalOutput || output, error: errorMessage, usage };
    }

    if (eventCount === 0 && lastProviderError) {
      return {
        success: false,
        output: finalOutput || output,
        error: `provider error: ${lastProviderError}`,
        usage,
      };
    }

    return { success: true, output: finalOutput || output, usage };
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

    return {
      success: false,
      output: finalOutput || output,
      error: `${errorMessage} [${diagnosis}]`,
      usage: buildUsage(),
    };
  }
}

// ── agent ───────────────────────────────────────────────────────────────────────

export const opencode = agent({
  name: "opencode",
  install: installOpencodeCli,
  run: async (ctx) => {
    const cliPath = await installOpencodeCli();

    const model = ctx.payload.proxyModel ?? ctx.resolvedModel ?? autoSelectModel(cliPath);

    const homeEnv = {
      HOME: ctx.tmpdir,
      XDG_CONFIG_HOME: join(ctx.tmpdir, ".config"),
    };

    mkdirSync(join(homeEnv.XDG_CONFIG_HOME, "opencode"), { recursive: true });

    const agentBrowserVersion = getDevDependencyVersion("agent-browser");
    addSkill({
      ref: `vercel-labs/agent-browser@v${agentBrowserVersion}`,
      skill: "agent-browser",
      env: homeEnv,
      agent: "opencode",
    });

    installBundledSkills({ home: homeEnv.HOME });

    // base args shared between initial run and continue runs
    const baseArgs = ["run", "--format", "json", "--print-logs"];

    // OPENCODE_PERMISSION has absolute highest precedence (merged after managed/MDM configs).
    // external_directory gates ALL native filesystem tools (Read, Write, Edit, Glob, Grep, etc.)
    // for paths outside the project root. last-match-wins: deny everything, then allow /tmp.
    const permissionOverride = JSON.stringify({
      external_directory: { "*": "deny", "/tmp/*": "allow" },
    });

    const env: Record<string, string | undefined> = {
      ...process.env,
      ...homeEnv,
      OPENCODE_CONFIG_CONTENT: buildSecurityConfig(ctx, model),
      OPENCODE_PERMISSION: permissionOverride,
      GOOGLE_GENERATIVE_AI_API_KEY:
        process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY,
    };

    const repoDir = process.cwd();

    log.debug(`» starting Pullfrog (OpenCode): ${cliPath} ${baseArgs.join(" ")}`);
    log.debug(`» working directory: ${repoDir}`);

    const runParams = {
      label: "Pullfrog",
      cliPath,
      cwd: repoDir,
      env,
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
      initialResult: result,
      initialUsage: result.usage,
      stopScript: ctx.stopScript,
      reflectionPrompt: buildLearningsReflectionPrompt("opencode"),
      resume: async (c) =>
        runOpenCode({
          ...runParams,
          args: [...baseArgs, "--continue", c.prompt],
        }),
    });
  },
});
