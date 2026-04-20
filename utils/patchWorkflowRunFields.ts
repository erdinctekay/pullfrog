import type { AgentUsage } from "../agents/shared.ts";
import type { ToolContext } from "../mcp/server.ts";
import { apiFetch } from "./apiFetch.ts";
import { log } from "./cli.ts";
import { retry } from "./retry.ts";

/**
 * Artifact tracking fields — one-off PATCHes from MCP tools as GitHub entities
 * are created during the run. Strings only (GraphQL node IDs).
 * Keep in sync with `STRING_FIELDS` in `app/api/workflow-run/[runId]/route.ts`.
 */
export type WorkflowRunArtifactPatchKey =
  | "prNodeId"
  | "issueNodeId"
  | "reviewNodeId"
  | "planCommentNodeId"
  | "summaryCommentNodeId";

/**
 * Usage fields — aggregated across all agent calls and PATCHed once at
 * end-of-run. Token counts are Int4 on the DB side (ample for any realistic
 * run); `costUsd` is a Decimal populated by provider-reported dollar amounts.
 * Keep in sync with `INT_FIELDS` + `DECIMAL_FIELDS` in the server route.
 */
export type WorkflowRunUsagePatchKey =
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "costUsd";

export type WorkflowRunPatch = Partial<Record<WorkflowRunArtifactPatchKey, string>> &
  Partial<Record<WorkflowRunUsagePatchKey, number>>;

const STRING_KEYS: WorkflowRunArtifactPatchKey[] = [
  "prNodeId",
  "issueNodeId",
  "reviewNodeId",
  "planCommentNodeId",
  "summaryCommentNodeId",
];

const NUMBER_KEYS: WorkflowRunUsagePatchKey[] = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
];

/** PATCH workflow-run fields (Pullfrog JWT, not GitHub). */
export async function patchWorkflowRunFields(
  ctx: ToolContext,
  fields: WorkflowRunPatch
): Promise<void> {
  if (ctx.runId === undefined || !ctx.apiToken) return;
  const body: Record<string, string | number> = {};
  for (const key of STRING_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.length > 0) {
      body[key] = value;
    }
  }
  for (const key of NUMBER_KEYS) {
    const value = fields[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      body[key] = value;
    }
  }
  if (Object.keys(body).length === 0) return;
  try {
    await retry(
      async () => {
        const response = await apiFetch({
          path: `/api/workflow-run/${ctx.runId}`,
          method: "PATCH",
          headers: {
            authorization: `Bearer ${ctx.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`PATCH workflow-run: ${response.status}`);
      },
      {
        maxAttempts: 3,
        delayMs: 2000,
        label: "patchWorkflowRunFields",
      }
    );
  } catch (error) {
    log.warning(`patchWorkflowRunFields exhausted retries: ${error}`);
  }
}

/**
 * Postgres INTEGER / Prisma Int4 is signed 32-bit. Aggregated usage won't
 * realistically hit this in a single run (2.1B tokens ≈ $6000+ of input on
 * Claude Opus), but clamping here keeps the wire payload self-consistent:
 * the server rejects out-of-range INT fields individually, so without a
 * client-side clamp a single overflow would write a partial row where
 * some columns land and others silently don't.
 */
const INT4_MAX = 2_147_483_647;

function clampInt(value: number, field: WorkflowRunUsagePatchKey): number {
  if (value > INT4_MAX) {
    log.warning(
      `aggregateUsage: ${field}=${value} exceeds INT4_MAX (${INT4_MAX}) — clamping so the rest of the usage row still persists.`
    );
    return INT4_MAX;
  }
  return value;
}

/**
 * Sum per-agent usage entries into a single WorkflowRunPatch payload.
 * Returns an empty object when there's nothing to report, which causes
 * `patchWorkflowRunFields` to no-op — safe to call unconditionally from
 * end-of-run paths. Zero-valued fields are dropped so the DB only stores
 * positive sums (and NULL means "not reported").
 *
 * Token sums are clamped to INT4_MAX to guarantee the payload the server
 * sees is always self-consistent across all numeric columns.
 */
export function aggregateUsage(entries: AgentUsage[]): WorkflowRunPatch {
  if (entries.length === 0) return {};

  const sum = entries.reduce(
    (acc, e) => ({
      inputTokens: acc.inputTokens + e.inputTokens,
      outputTokens: acc.outputTokens + e.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + (e.cacheReadTokens ?? 0),
      cacheWriteTokens: acc.cacheWriteTokens + (e.cacheWriteTokens ?? 0),
      costUsd: acc.costUsd + (e.costUsd ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }
  );

  const out: WorkflowRunPatch = {};
  if (sum.inputTokens > 0) out.inputTokens = clampInt(sum.inputTokens, "inputTokens");
  if (sum.outputTokens > 0) out.outputTokens = clampInt(sum.outputTokens, "outputTokens");
  if (sum.cacheReadTokens > 0)
    out.cacheReadTokens = clampInt(sum.cacheReadTokens, "cacheReadTokens");
  if (sum.cacheWriteTokens > 0)
    out.cacheWriteTokens = clampInt(sum.cacheWriteTokens, "cacheWriteTokens");
  if (sum.costUsd > 0) out.costUsd = sum.costUsd;
  return out;
}
