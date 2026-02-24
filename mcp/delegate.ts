import { type } from "arktype";
import { Effort } from "../external.ts";
import { log } from "../utils/cli.ts";
import type { SubagentState, ToolContext } from "./server.ts";
import { execute, tool } from "./shared.ts";
import { createSubagentState, hasRunningSubagents, runSubagent } from "./subagent.ts";

const DelegateTask = type({
  label: type.string.describe(
    "short label identifying this task (e.g. 'frontend-review', 'schema-check'). returned in results for easy matching."
  ),
  instructions: type.string.describe(
    "the complete prompt for the subagent. the subagent receives ONLY this text (plus a system preamble) — include all context it needs (file paths, constraints, conventions, tool usage instructions). specify exactly what information to return. craft a focused, self-contained task description."
  ),
  "effort?": Effort.describe(
    'effort level for the subagent: "mini" (low-effort and fast, only for simple tasks), "auto" (medium-effort, good for typical tasks that don\'t require significant reasoning), or "max" (high-effort, good for PR reviews and complex coding tasks). defaults to "auto".'
  ),
});

export const DelegateParams = type({
  tasks: DelegateTask.array()
    .atLeastLength(1)
    .describe(
      "array of tasks to delegate. all tasks run as parallel subagents and results are returned together."
    ),
});

type DelegateTaskResult = {
  label: string;
  success: boolean;
  effort: string;
  summary: string;
  stdoutFile: string;
  error: string | undefined;
};

function buildTaskResult(
  label: string,
  effort: string,
  subagent: SubagentState,
  error: string | undefined
): DelegateTaskResult {
  return {
    label,
    success: subagent.status === "completed",
    effort,
    summary:
      subagent.output ??
      error ??
      "no output produced — the subagent may not have called set_output. check stdoutFile for full logs.",
    stdoutFile: subagent.stdoutFilePath,
    error,
  };
}

export function DelegateTool(ctx: ToolContext) {
  return tool({
    name: "delegate",
    description:
      "Delegate research, local coding tasks, and codebase investigations to subagents. Accepts an array of tasks that run in parallel — use this to fan out work (e.g. reviewing different areas of a PR simultaneously). Each subagent receives ONLY the instructions you provide (plus a system preamble enforcing set_output). Use select_mode first to get guidance on how to craft instructions. Subagents have file operations, shell, read-only GitHub tools (PR/issue info, review comments, check suite logs), and upload_file. They have NO git/checkout tools (would conflict between parallel subagents), NO dependency tools, and NO GitHub-write tools (commenting, reviews, labels, issues). All state-mutating and user-facing operations are your responsibility as orchestrator.",
    parameters: DelegateParams,
    execute: execute(async (params) => {
      if (ctx.toolState.selfSubagentId) {
        return {
          error:
            "delegation is not available inside a subagent. you are already running as a delegated subagent. complete the task directly using the available tools.",
        };
      }

      if (hasRunningSubagents(ctx)) {
        return { error: "delegation is already in progress" };
      }

      const mode = ctx.toolState.selectedMode ?? "unknown";
      if (!ctx.toolState.selectedMode) {
        log.info(`» warning: delegating without calling select_mode first (mode=${mode})`);
      }

      // matched by delegate test validators — update tests if changed
      const n = params.tasks.length;
      log.info(
        `» delegating ${n} task${n === 1 ? "" : "s"}${n > 1 ? " in parallel" : ""} (mode=${mode})`
      );

      const taskEntries = params.tasks.map((task) => {
        const effort = task.effort ?? "auto";
        const subagent = createSubagentState({ ctx, mode, label: task.label });
        log.info(`» task "${task.label}" (effort=${effort})`);
        return { task, effort, subagent };
      });

      const settled = await Promise.allSettled(
        taskEntries.map((entry) =>
          runSubagent({
            ctx,
            subagent: entry.subagent,
            effort: entry.effort,
            instructions: entry.task.instructions,
          })
        )
      );

      const results: DelegateTaskResult[] = taskEntries.map((entry, i) => {
        const outcome = settled[i];
        const error = outcome.status === "rejected" ? String(outcome.reason) : outcome.value.error;
        const result = buildTaskResult(entry.task.label, entry.effort, entry.subagent, error);
        log.info(
          `» task "${entry.task.label}" ${result.success ? "succeeded" : "failed"}:\n${result.summary}`
        );
        return result;
      });

      const succeeded = results.filter((r) => r.success).length;
      log.info(`» delegation completed: ${succeeded}/${results.length} succeeded (mode=${mode})`);

      return { mode, results };
    }),
  });
}
