const MAX_STDERR_BYTES = 3000;

/**
 * mutable per-run handle the agent harness writes to as a run progresses.
 * the action's outer try/catch in `main.ts` reads this off `toolState` when
 * the activity-timeout watchdog wins the race against the harness's own
 * catch — the bare timer reject reason ("activity timeout: no output for
 * 302s") tells the user nothing actionable, but `recentStderr` +
 * `lastProviderError` together usually point straight at the upstream cause.
 *
 * `recentStderr` is shared by reference with the harness's bounded ring
 * buffer, so the diagnostic always reflects the latest captured tail.
 */
export type AgentDiagnostic = {
  /** display label for the agent, e.g. "Pullfrog". used in the headline. */
  label: string;
  /** shared reference to the harness's bounded stderr ring buffer. */
  recentStderr: string[];
  /** most-recent provider-error label from `detectProviderError`, if any. */
  lastProviderError: string | undefined;
  /** count of stdout events successfully parsed before the failure. */
  eventCount: number;
};

/**
 * Build a user-facing markdown body for an agent hang or failure.
 *
 * Rendered into both the PR progress comment and the GitHub Actions job
 * summary. Returns `null` when no diagnostic is available, which signals to
 * the caller to fall back to its bare-error rendering.
 *
 * `errorMessage` is the underlying timer / spawn reject string (e.g.
 * `activity timeout: no output for 301s`). The idle seconds are parsed out
 * of it for the hang explanation — total runtime would overstate the stall
 * for runs that streamed for a long time before going quiet.
 */
export function formatAgentHangBody(input: {
  diagnostic: AgentDiagnostic | undefined;
  isHang: boolean;
  errorMessage: string;
}): string | null {
  if (!input.diagnostic) return null;

  const verb = input.isHang ? "stalled" : "failed";
  const cause = input.diagnostic.lastProviderError
    ? ` — likely cause: \`${input.diagnostic.lastProviderError}\``
    : "";
  const headline = `**${input.diagnostic.label} ${verb}**${cause}`;

  const explanation = formatExplanation({
    isHang: input.isHang,
    errorMessage: input.errorMessage,
  });
  const parts = [headline, "", `${explanation} ${formatEventsPart(input.diagnostic)}`];

  const tail = renderStderrTail(input.diagnostic.recentStderr);
  if (tail) {
    // pick a fence longer than any backtick run in the body so a stderr line
    // containing ``` (provider error JSON occasionally embeds it) can't
    // terminate the fence early and corrupt the rest of the markdown.
    const fence = pickFence(tail);
    parts.push(
      "",
      "<details><summary>Recent agent stderr</summary>",
      "",
      fence,
      tail,
      fence,
      "",
      "</details>"
    );
  }

  return parts.join("\n");
}

function formatExplanation(input: { isHang: boolean; errorMessage: string }): string {
  if (!input.isHang) return `The agent exited unexpectedly: ${input.errorMessage}`;
  const idleSec = parseIdleSec(input.errorMessage);
  if (idleSec === undefined) {
    return "The agent stopped emitting events and was killed by the activity-timeout watchdog.";
  }
  return `The agent stopped emitting events for ${idleSec}s and was killed by the activity-timeout watchdog.`;
}

function parseIdleSec(message: string): number | undefined {
  const match = /no output for (\d+)s/.exec(message);
  return match ? Number(match[1]) : undefined;
}

function formatEventsPart(diagnostic: AgentDiagnostic): string {
  if (diagnostic.eventCount > 0) {
    return `${diagnostic.eventCount} events were processed before the failure.`;
  }
  // when the provider-error label already names the cause in the headline,
  // the reachability nudge below contradicts it (e.g. an immediate 401 also
  // produces zero events but isn't a reachability problem). suppress it.
  if (diagnostic.lastProviderError) return "No events were emitted before the failure.";
  return "No events were emitted — check whether the model provider is reachable.";
}

function renderStderrTail(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  const joined = lines.join("\n");
  if (joined.length <= MAX_STDERR_BYTES) return joined;
  return `... (older lines truncated)\n${joined.slice(-MAX_STDERR_BYTES)}`;
}

function pickFence(content: string): string {
  let max = 0;
  for (const match of content.matchAll(/`+/g)) {
    if (match[0].length > max) max = match[0].length;
  }
  return "`".repeat(Math.max(3, max + 1));
}
