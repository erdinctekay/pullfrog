export interface WorkflowRunInfo {
  progressCommentId: string | null;
}

interface FetchWorkflowRunInfoParams {
  runId: string;
  apiToken: string;
}

/**
 * Fetch workflow run info from the Pullfrog API.
 * Returns the pre-created progress comment ID if one exists.
 */
export async function fetchWorkflowRunInfo(params: FetchWorkflowRunInfoParams): Promise<WorkflowRunInfo> {
  const apiUrl = process.env.API_URL || "https://pullfrog.com";
  const timeoutMs = 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${apiUrl}/api/workflow-run/${params.runId}`, {
      method: "GET",
      headers: {
        // apiToken not strictly required (route only exposes public IDs)
        // but claims in token enable preview API URL forwarding
        Authorization: `Bearer ${params.apiToken}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { progressCommentId: null };
    }

    const data = (await response.json()) as WorkflowRunInfo;
    return data;
  } catch {
    clearTimeout(timeoutId);
    return { progressCommentId: null };
  }
}
