export const PULLFROG_DIVIDER = "<!-- PULLFROG_DIVIDER_DO_NOT_REMOVE_PLZ -->";

const FROG_LOGO = `<a href="https://pullfrog.com"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pullfrog.com/logos/frog-white-full-18px.png"><img src="https://pullfrog.com/logos/frog-green-full-18px.png" width="9px" height="9px" style="vertical-align: middle; " alt="Pullfrog"></picture></a>`;

export interface WorkflowRunFooterInfo {
  owner: string;
  repo: string;
  runId: number;
  /** optional job ID - if provided, will append /job/{jobId} to the workflow run URL */
  jobId?: string | undefined;
}

export interface BuildPullfrogFooterParams {
  /** add "Triggered by Pullfrog" link */
  triggeredBy?: boolean;
  /** add "View workflow run" link */
  workflowRun?: WorkflowRunFooterInfo | undefined;
  /** alternative: just pass a pre-built URL directly (for shortlinks etc.) */
  workflowRunUrl?: string | undefined;
  /** arbitrary custom parts (e.g., action links) */
  customParts?: string[];
}

/**
 * build a pullfrog footer with configurable parts
 * always includes: frog logo at start, pullfrog.com link and X link at end
 * order: action links (customParts) > workflow run > attribution > reference links
 */
export function buildPullfrogFooter(params: BuildPullfrogFooterParams): string {
  const parts: string[] = [];

  if (params.customParts) {
    parts.push(...params.customParts);
  }

  if (params.workflowRunUrl) {
    parts.push(`[View workflow run](${params.workflowRunUrl})`);
  } else if (params.workflowRun) {
    const baseUrl = `https://github.com/${params.workflowRun.owner}/${params.workflowRun.repo}/actions/runs/${params.workflowRun.runId}`;
    const url = params.workflowRun.jobId ? `${baseUrl}/job/${params.workflowRun.jobId}` : baseUrl;
    parts.push(`[View workflow run](${url})`);
  }

  if (params.triggeredBy) {
    parts.push("Triggered by [Pullfrog](https://pullfrog.com)");
  }

  const allParts = [
    ...parts,
    "[pullfrog.com](https://pullfrog.com)",
    "[𝕏](https://x.com/pullfrogai)",
  ];

  return `
${PULLFROG_DIVIDER}
<sup>${FROG_LOGO}&nbsp;&nbsp;｜ ${allParts.join(" ｜ ")}</sup>`;
}

/**
 * strip any existing pullfrog footer from a comment body
 */
export function stripExistingFooter(body: string): string {
  const dividerIndex = body.indexOf(PULLFROG_DIVIDER);
  if (dividerIndex === -1) {
    return body;
  }
  return body.substring(0, dividerIndex).trimEnd();
}
