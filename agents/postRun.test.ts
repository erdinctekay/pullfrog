import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPAWN_TIMEOUT_CODE, SpawnTimeoutError } from "../utils/subprocess.ts";
import type { AgentResult } from "./shared.ts";

vi.mock("./shared.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.ts")>();
  return {
    ...actual,
    getGitStatus: vi.fn(() => ""),
  };
});

vi.mock("../utils/subprocess.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/subprocess.ts")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const { runPostRunRetryLoop, executeStopHook } = await import("./postRun.ts");
const { getGitStatus } = await import("./shared.ts");
const { spawn } = await import("../utils/subprocess.ts");
const mockedGetGitStatus = vi.mocked(getGitStatus);
const mockedSpawn = vi.mocked(spawn);

const successResult = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  success: true,
  output: "ok",
  ...overrides,
});

describe("runPostRunRetryLoop — reflection turn", () => {
  beforeEach(() => {
    mockedGetGitStatus.mockReset();
    mockedGetGitStatus.mockReturnValue("");
    mockedSpawn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not flip a successful run to failed when reflection returns success:false", async () => {
    // the reflection turn is a best-effort nudge (update_learnings). if it
    // fails — e.g. the model API errors mid-turn — the underlying task has
    // already completed and been gated cleanly, so the run as a whole must
    // still be reported as successful.
    const initial = successResult({ output: "task done" });
    const resume = vi
      .fn<(ctx: { prompt: string; previousResult: AgentResult }) => Promise<AgentResult>>()
      .mockResolvedValue({ success: false, error: "model API transient failure" });

    const result = await runPostRunRetryLoop({
      initialResult: initial,
      initialUsage: undefined,
      stopScript: null,
      resume,
      reflectionPrompt: "REFLECTION: call update_learnings if anything is worth saving",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("task done");
    expect(result.error).toBeUndefined();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0]?.[0].prompt).toMatch(/REFLECTION/);
  });

  it("still aggregates usage from a failed reflection turn", async () => {
    // the reflection consumed tokens even if it didn't produce useful output;
    // the run total must reflect that so billing/reporting stays accurate.
    const initial = successResult({
      usage: { agent: "claude", inputTokens: 100, outputTokens: 50 },
    });
    const resume = vi
      .fn<(ctx: { prompt: string; previousResult: AgentResult }) => Promise<AgentResult>>()
      .mockResolvedValue({
        success: false,
        error: "model API transient failure",
        usage: { agent: "claude", inputTokens: 10, outputTokens: 5 },
      });

    const result = await runPostRunRetryLoop({
      initialResult: initial,
      initialUsage: initial.usage,
      stopScript: null,
      resume,
      reflectionPrompt: "reflect",
    });

    expect(result.success).toBe(true);
    expect(result.usage?.inputTokens).toBe(110);
    expect(result.usage?.outputTokens).toBe(55);
  });

  it("falls back to the reflection's output when the pre-reflection output is empty", async () => {
    // the preservation fix must only kick in when the task actually produced
    // meaningful output. runs that communicate exclusively through MCP tools
    // (e.g. report_progress) leave result.output = "" — using `??` here kept
    // the empty string and dropped the reflection's reply, leaving the
    // fallback `handleAgentResult` path with nothing to show. prefer the
    // reflection's output (even a trivial "done") over no output at all.
    const initial = successResult({ output: "" });
    const resume = vi
      .fn<(ctx: { prompt: string; previousResult: AgentResult }) => Promise<AgentResult>>()
      .mockResolvedValue(successResult({ output: "done" }));

    const result = await runPostRunRetryLoop({
      initialResult: initial,
      initialUsage: undefined,
      stopScript: null,
      resume,
      reflectionPrompt: "REFLECTION: consider update_learnings",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("done");
  });

  it("preserves the pre-reflection task output when a trivial reflection ('done') succeeds", async () => {
    // the reflection turn is a meta-ask — its literal reply ("done" or a
    // short "updated learnings with N bullets") is not the task summary the
    // caller wants to see. before this fix, `result = reflectionResult`
    // clobbered the task's output on the returned AgentResult, so downstream
    // consumers (handleAgentResult's fallback path when toolState is empty,
    // programmatic callers of main()) saw "done" instead of the real
    // summary. assert the task's output survives a successful reflection.
    const initial = successResult({ output: "Implemented feature X; tests pass; pushed PR #42" });
    const resume = vi
      .fn<(ctx: { prompt: string; previousResult: AgentResult }) => Promise<AgentResult>>()
      .mockResolvedValue(successResult({ output: "done" }));

    const result = await runPostRunRetryLoop({
      initialResult: initial,
      initialUsage: undefined,
      stopScript: null,
      resume,
      reflectionPrompt: "REFLECTION: consider update_learnings",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Implemented feature X; tests pass; pushed PR #42");
  });

  it("skips reflection entirely when canResume returns false", async () => {
    const initial = successResult();
    const resume = vi
      .fn<(ctx: { prompt: string; previousResult: AgentResult }) => Promise<AgentResult>>()
      .mockResolvedValue(successResult());

    const result = await runPostRunRetryLoop({
      initialResult: initial,
      initialUsage: undefined,
      stopScript: null,
      resume,
      canResume: () => false,
      reflectionPrompt: "reflect",
    });

    expect(result.success).toBe(true);
    expect(resume).not.toHaveBeenCalled();
  });

  it("catches a reflection turn that dirties the tree via the dirty-tree gate on the next iteration", async () => {
    // PR claims: "if the reflection turn dirties the tree, the loop picks
    // that up on the next iteration via the normal dirty-tree gate." lock
    // it in — without this invariant the reflection prompt could bypass the
    // commit-before-you-finish contract whenever the agent misbehaves.
    //
    // three getGitStatus calls in sequence:
    //   1. clean (triggers reflection)
    //   2. reflection left the tree dirty
    //   3. retry committed the changes — now clean, loop exits
    mockedGetGitStatus
      .mockReturnValueOnce("")
      .mockReturnValueOnce(" M scratch/notes.md")
      .mockReturnValueOnce("");

    const initial = successResult();
    const resume = vi
      .fn<(ctx: { prompt: string; previousResult: AgentResult }) => Promise<AgentResult>>()
      .mockResolvedValue(successResult({ output: "resumed" }));

    const result = await runPostRunRetryLoop({
      initialResult: initial,
      initialUsage: undefined,
      stopScript: null,
      resume,
      reflectionPrompt: "REFLECTION: consider update_learnings",
    });

    expect(result.success).toBe(true);
    // call 0: reflection; call 1: dirty-tree retry
    expect(resume).toHaveBeenCalledTimes(2);
    expect(resume.mock.calls[0]?.[0].prompt).toContain("REFLECTION");
    expect(resume.mock.calls[1]?.[0].prompt).toContain("UNCOMMITTED CHANGES");
    expect(resume.mock.calls[1]?.[0].prompt).toContain("scratch/notes.md");
  });

  it("surfaces a persistent stop hook failure as AgentResult.error after MAX_POST_RUN_RETRIES", async () => {
    // PR test plan item #1: "confirm the agent is resumed with the hook
    // output and the run fails after 3 attempts if never resolved."
    //
    // stop the hook from passing on every invocation, have `resume` always
    // return success (the agent tried but couldn't fix the issue), and
    // verify: (a) the loop exhausts all retries, (b) the final result is
    // success=false, (c) the error mentions the retry count and the hook
    // output verbatim so the GitHub comment surfaces what actually failed.
    const hookFailure = {
      stdout: "lint: 3 issues in src/foo.ts",
      stderr: "",
      exitCode: 7,
      durationMs: 5,
    };
    mockedSpawn.mockResolvedValue(hookFailure);

    const initial = successResult({ output: "agent done" });
    const resume = vi
      .fn<(ctx: { prompt: string; previousResult: AgentResult }) => Promise<AgentResult>>()
      .mockResolvedValue(successResult({ output: "retry done" }));

    const result = await runPostRunRetryLoop({
      initialResult: initial,
      initialUsage: undefined,
      stopScript: "pnpm lint",
      resume,
      reflectionPrompt: undefined,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("stop hook failed");
    expect(result.error).toContain("exit code 7");
    expect(result.error).toContain("3 retry attempts");
    expect(result.error).toContain("lint: 3 issues in src/foo.ts");
    // each retry feeds the hook output back into the agent as the resume prompt
    expect(resume).toHaveBeenCalledTimes(3);
    for (const call of resume.mock.calls) {
      expect(call[0].prompt).toContain("STOP HOOK FAILED");
      expect(call[0].prompt).toContain("lint: 3 issues in src/foo.ts");
    }
  });

  it("treats a persistently dirty tree (no stop hook failure) as a soft-fail", async () => {
    // the PR documents: "dirty-tree-only failures preserve prior behavior:
    // they're logged but don't fail the run." a regression that started
    // surfacing dirty-tree as AgentResult.error would make every run that
    // leaves untracked test fixtures around fail spuriously. guard it.
    mockedGetGitStatus.mockReturnValue(" M src/foo.ts");
    const initial = successResult();
    const resume = vi
      .fn<(ctx: { prompt: string; previousResult: AgentResult }) => Promise<AgentResult>>()
      .mockResolvedValue(successResult({ output: "tried but tree still dirty" }));

    const result = await runPostRunRetryLoop({
      initialResult: initial,
      initialUsage: undefined,
      stopScript: null,
      resume,
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    // retries were attempted (the loop fed the dirty-tree prompt back to the agent)
    expect(resume).toHaveBeenCalledTimes(3);
    for (const call of resume.mock.calls) {
      expect(call[0].prompt).toContain("UNCOMMITTED CHANGES");
    }
  });

  it("surfaces a stop hook failure even when canResume is false (no retry budget, still fails the run)", async () => {
    // the retry loop is best-effort. when canResume says no (e.g. claude
    // without a sessionId), we still need the failure gate to fire so the
    // user sees WHY the run failed instead of an opaque success. covers the
    // "checks still ran even if we can't resume" comment in postRun.ts.
    mockedSpawn.mockResolvedValue({
      stdout: "typecheck: 2 errors",
      stderr: "",
      exitCode: 1,
      durationMs: 1,
    });
    const initial = successResult();
    const resume = vi
      .fn<(ctx: { prompt: string; previousResult: AgentResult }) => Promise<AgentResult>>()
      .mockResolvedValue(successResult());

    const result = await runPostRunRetryLoop({
      initialResult: initial,
      initialUsage: undefined,
      stopScript: "pnpm typecheck",
      resume,
      canResume: () => false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("stop hook failed");
    expect(result.error).toContain("typecheck: 2 errors");
    // no retries were attempted because canResume said no — error lists no
    // retry count (that would be a lie).
    expect(result.error).not.toContain("retry attempt");
    expect(resume).not.toHaveBeenCalled();
  });

  it("short-circuits the loop when the initial result is already failed", async () => {
    // if the agent already failed (timeout, model error) there's no point
    // running gates or a reflection — the run is toast. preserve the original
    // error verbatim so triage is straightforward.
    const initial: AgentResult = {
      success: false,
      error: "agent died mid-turn",
      output: "partial",
    };
    const resume = vi
      .fn<(ctx: { prompt: string; previousResult: AgentResult }) => Promise<AgentResult>>()
      .mockResolvedValue(successResult());

    const result = await runPostRunRetryLoop({
      initialResult: initial,
      initialUsage: undefined,
      stopScript: "pnpm lint",
      resume,
      reflectionPrompt: "reflect",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("agent died mid-turn");
    expect(resume).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(mockedGetGitStatus).not.toHaveBeenCalled();
  });

  it("aggregates usage across every gate retry", async () => {
    // billing/reporting rely on the usage summary reflecting the full run,
    // not just the final retry's slice. regression gate.
    mockedSpawn.mockResolvedValue({
      stdout: "fail",
      stderr: "",
      exitCode: 1,
      durationMs: 1,
    });
    const initial = successResult({
      usage: { agent: "claude", inputTokens: 100, outputTokens: 50 },
    });
    const resume = vi
      .fn<(ctx: { prompt: string; previousResult: AgentResult }) => Promise<AgentResult>>()
      .mockResolvedValue({
        success: true,
        output: "retry",
        usage: { agent: "claude", inputTokens: 10, outputTokens: 5 },
      });

    const result = await runPostRunRetryLoop({
      initialResult: initial,
      initialUsage: initial.usage,
      stopScript: "flaky",
      resume,
    });

    // 100 initial + 10 * 3 retries = 130
    expect(result.usage?.inputTokens).toBe(130);
    expect(result.usage?.outputTokens).toBe(65);
  });
});

describe("executeStopHook — output capture", () => {
  beforeEach(() => {
    mockedSpawn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("includes both stdout and stderr in the failure output when both are populated", async () => {
    // hooks that wrap other tools commonly emit a benign warning to stderr
    // (e.g. "config file not found, using defaults") and the actionable error
    // to stdout. a `(stderr || stdout)` heuristic drops stdout entirely
    // whenever stderr is non-empty, starving the agent of the information it
    // needs to fix the issue.
    mockedSpawn.mockResolvedValue({
      stdout: "ERROR: lint check failed at path/to/file.ts:42",
      stderr: "Warning: config file not found, using defaults",
      exitCode: 1,
      durationMs: 5,
    });
    const failure = await executeStopHook("run-lint");
    expect(failure).not.toBeNull();
    expect(failure?.output).toContain("ERROR: lint check failed at path/to/file.ts:42");
    expect(failure?.output).toContain("Warning: config file not found, using defaults");
  });

  it("returns null (treated as passed) when spawn throws a timeout", async () => {
    // infra-level failures can't be fixed by the agent. surfacing them as a
    // hook failure would put the loop into a retry cycle that never
    // terminates. soft-fail and let the run succeed.
    mockedSpawn.mockRejectedValue(
      new SpawnTimeoutError("hook exceeded 10 minutes", SPAWN_TIMEOUT_CODE)
    );
    const failure = await executeStopHook("slow-hook");
    expect(failure).toBeNull();
  });

  it("returns null (treated as passed) on spawn ENOENT (command not found)", async () => {
    // if the user misconfigures the hook (wrong binary, typo), the spawn
    // itself throws. same rationale as timeouts: soft-fail, don't retry.
    mockedSpawn.mockRejectedValue(
      Object.assign(new Error("spawn nosuchbin ENOENT"), { code: "ENOENT" })
    );
    const failure = await executeStopHook("nosuchbin");
    expect(failure).toBeNull();
  });

  it("truncates oversize output, keeping the tail", async () => {
    // the error is embedded in AgentResult.error and flows into GitHub
    // comments (65535-char cap). the 4096-char truncation is our guardrail;
    // lock it in so a well-meaning refactor can't blow the comment budget.
    const longTail = "LAST_LINE_IS_ACTIONABLE";
    const longOutput = "x".repeat(10_000) + longTail;
    mockedSpawn.mockResolvedValue({
      stdout: longOutput,
      stderr: "",
      exitCode: 1,
      durationMs: 1,
    });
    const failure = await executeStopHook("noisy");
    expect(failure?.output).toContain(longTail);
    expect(failure?.output).toContain("truncated");
    expect(failure?.output.length).toBeLessThan(longOutput.length);
  });
});
