/**
 * Track per-session labels so log lines from parallel subagents can be
 * differentiated. The orchestrator dispatches lens subagents (e.g. reviewfrog)
 * via the Task tool; each subagent runs in its own opencode/claude Session
 * with its own `sessionID` (or `session_id`) tag on the NDJSON event stream.
 *
 * Without per-session prefixing, parallel subagent tool_use / tool_result /
 * text events appear as a single interleaved stream tagged with `[Pullfrog]`,
 * making it impossible for a human reading the logs to attribute work to a
 * specific lens.
 *
 * The labeler is deliberately runtime-agnostic — both opencode.ts and
 * claude.ts feed it the same shape. The contract is FIFO: when the orchestrator
 * dispatches N task tool_use blocks in a single assistant turn (the parallel
 * fan-out the multi-lens prompt requires), the i-th new sessionID is assumed
 * to belong to the i-th task dispatch. This is correct as long as parallel
 * dispatches are emitted in source-order and the runtimes respect that order
 * when assigning child sessions; we do not depend on it for correctness of
 * the read-only contract — only for log readability.
 */

export interface TaskDispatchInput {
  description?: string | undefined;
  subagent_type?: string | undefined;
  prompt?: string | undefined;
}

export const ORCHESTRATOR_LABEL = "orchestrator";

const LENS_PROMPT_PATTERN = /^\s*(?:lens|Lens|LENS)\s*[:=]\s*([A-Za-z][\w &/.-]{0,60})/m;

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Extract a human-readable label from a Task tool's input. Tries (in order):
 *   1. explicit `lens: <name>` marker on a line in the prompt — preferred,
 *      lets the orchestrator name the lens deterministically
 *   2. the Task tool's `description` field — short, written by orchestrator
 *      per call, usually enough
 *   3. the `subagent_type` (e.g. `reviewfrog`) — falls back to the named
 *      subagent identity when description is missing
 *   4. generic "subagent" — last resort
 */
export function deriveLabelFromTaskInput(input: TaskDispatchInput): string {
  if (typeof input.prompt === "string") {
    const match = input.prompt.match(LENS_PROMPT_PATTERN);
    if (match?.[1]) {
      const slugged = slug(match[1]);
      if (slugged) return `lens:${slugged}`;
    }
  }
  if (input.description) {
    const slugged = slug(input.description);
    if (slugged) return `lens:${slugged}`;
  }
  if (input.subagent_type) {
    return input.subagent_type;
  }
  return "subagent";
}

/**
 * Stateful tracker mapping sessionIDs to human labels.
 *
 * Lifecycle:
 *   - First call to `labelFor()` returns ORCHESTRATOR_LABEL and binds that
 *     sessionID to it. Every subsequent event from that session gets the
 *     same label.
 *   - When the orchestrator emits a Task tool_use, the harness calls
 *     `recordTaskDispatch()` to push the dispatch's derived label onto a
 *     pending FIFO queue.
 *   - The next previously-unseen sessionID consumes the head of the queue.
 *   - If `labelFor()` is called for a new session with an empty queue
 *     (e.g. a subagent emitted events before the parent's tool_use was
 *     parsed, or the runtime spawned a session we didn't expect), the
 *     labeler falls back to `subagent#N` so log lines remain attributable.
 */
export class SessionLabeler {
  private readonly labels = new Map<string, string>();
  private readonly pendingLabels: string[] = [];
  private fallbackCounter = 0;

  recordTaskDispatch(input: TaskDispatchInput): string {
    const label = deriveLabelFromTaskInput(input);
    this.pendingLabels.push(label);
    return label;
  }

  /**
   * Return a label for the given sessionID. Binds on first call.
   * Pass undefined/empty for events that lack a session id — the caller
   * gets ORCHESTRATOR_LABEL so the line is still attributable.
   */
  labelFor(sessionID: string | undefined | null): string {
    if (!sessionID) return ORCHESTRATOR_LABEL;
    const existing = this.labels.get(sessionID);
    if (existing) return existing;

    let label: string;
    if (this.labels.size === 0) {
      label = ORCHESTRATOR_LABEL;
    } else if (this.pendingLabels.length > 0) {
      label = this.pendingLabels.shift() as string;
    } else {
      this.fallbackCounter += 1;
      label = `subagent#${this.fallbackCounter}`;
    }
    this.labels.set(sessionID, label);
    return label;
  }

  /** number of distinct sessions seen so far (for diagnostics) */
  size(): number {
    return this.labels.size;
  }

  /** all (sessionID, label) pairs, oldest first */
  entries(): Array<[string, string]> {
    return Array.from(this.labels.entries());
  }

  /** how many pending labels are queued waiting to bind to a new session */
  pendingDispatchCount(): number {
    return this.pendingLabels.length;
  }
}

/**
 * Format a log message with a session label prefix in magenta. Mirrors the
 * style of utils/log.ts:prefixLines() so per-session prefixes look the same
 * as the dormant withLogPrefix-based ones.
 */
export function formatWithLabel(label: string, message: string): string {
  const MAGENTA = "\x1b[35m";
  const RESET = "\x1b[0m";
  const colored = `${MAGENTA}[${label}]${RESET} `;
  return message
    .split("\n")
    .map((line) => `${colored}${line}`)
    .join("\n");
}
