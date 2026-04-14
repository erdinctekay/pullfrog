import type { ToolContext } from "../mcp/server.ts";
import { apiFetch } from "./apiFetch.ts";
import { log } from "./cli.ts";
import { retry } from "./retry.ts";

/** Keys accepted by PATCH /api/workflow-run/[runId] — keep in sync with `ALLOWED_FIELDS` in `app/api/workflow-run/[runId]/route.ts`. */
export type WorkflowRunArtifactPatchKey =
  | "prNodeId"
  | "issueNodeId"
  | "reviewNodeId"
  | "planCommentNodeId"
  | "summaryCommentNodeId";

export type WorkflowRunArtifactPatch = Partial<Record<WorkflowRunArtifactPatchKey, string>>;

const ARTIFACT_PATCH_KEYS: WorkflowRunArtifactPatchKey[] = [
  "prNodeId",
  "issueNodeId",
  "reviewNodeId",
  "planCommentNodeId",
  "summaryCommentNodeId",
];

/** PATCH workflow-run artifact fields (Pullfrog JWT, not GitHub). */
export async function patchWorkflowRunFields(
  ctx: ToolContext,
  fields: WorkflowRunArtifactPatch
): Promise<void> {
  if (ctx.runId === undefined || !ctx.apiToken) return;
  const body: Record<string, string> = {};
  for (const key of ARTIFACT_PATCH_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.length > 0) {
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
