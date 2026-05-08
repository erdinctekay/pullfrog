import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { spawn } from "./subprocess.ts";

describe("spawn error path", () => {
  it("surfaces ENOENT-style spawn failures in stderr so callers can diagnose", async () => {
    // before this regression-test's fix, spawn resolved with exitCode=1 and
    // an empty stderr buffer when the command itself couldn't start —
    // lifecycle hook warnings then said "output: (empty)" and users had no
    // way to tell a broken script from a flaky one.
    const result = await spawn({
      cmd: "/nonexistent-command-for-spawn-test-xyz",
      args: [],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 0,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("/nonexistent-command-for-spawn-test-xyz");
    expect(result.stderr).toMatch(/ENOENT|not found/i);
  });

  it("clears the SIGKILL escalator when a timed-out child exits cleanly from SIGTERM", async () => {
    // regression: the overall-timeout path did
    //   setTimeout(() => { if (!child.killed) child.kill("SIGKILL") }, 5000)
    // without capturing the timer id. if the child responded to SIGTERM and
    // `close` fired promptly, the SIGKILL escalator stayed in the event loop
    // for up to 5 seconds — delaying any clean shutdown by that long.
    const beforeHandles = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

    // sleep does not install a TERM trap, so the default action (terminate)
    // fires immediately — `close` lands within ms of the SIGTERM, giving us
    // the orphaned-escalator window that the bug would have triggered.
    const result = await spawn({
      cmd: "sleep",
      args: ["30"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 0,
      timeout: 200,
    }).catch((err) => err);

    // timed out, so we get the SpawnTimeoutError
    expect(result).toBeInstanceOf(Error);

    // the SIGKILL escalator (and any other timer spawn() owned) must be
    // cleared by the time the promise settles — active timer count should
    // not have grown past the pre-spawn baseline.
    const afterHandles = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    expect(afterHandles).toBeLessThanOrEqual(beforeHandles);
  });

  it("killGroup: true propagates SIGKILL to grandchildren so close fires promptly", async () => {
    // regression: node_modules/opencode-ai/bin/opencode is a Node shim that
    // spawnSyncs the native binary with stdio:"inherit". without killGroup,
    // child.kill("SIGKILL") hit only the shim — the native binary was
    // reparented to PID 1, kept holding our stdout pipe via the inherited
    // fds, and `child.on("close")` never fired (because pipes stayed open).
    // a 5-min outer safety-net timer eventually rejected the agent promise,
    // but the grandchild kept running until the GitHub Actions job-level
    // timeout. this test replicates the shape with bash + a backgrounded
    // sleep grandchild: with killGroup, close fires promptly after SIGKILL;
    // without it, the parent would wait for sleep to exit (30s).
    //
    // the activity-check interval is fixed at 5s so the earliest the kill
    // can fire is ~5s after start. budget 15s end-to-end.
    const before = performance.now();
    const result = await spawn({
      cmd: "bash",
      args: ["-c", "sleep 30 & wait"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 1000,
      killGroup: true,
    }).catch((err) => err);
    const elapsed = performance.now() - before;

    expect(result).toBeInstanceOf(Error);
    // 10s ceiling: 5s activity-check tick + signal delivery. a regression
    // here (no killGroup) would hang for the full 30s sleep.
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  it("isPausedExternally suspends the activity timer while it returns true", async () => {
    // opencode's `task` tool encapsulates subagent execution in-process —
    // subagent-internal events don't reach our parent NDJSON stream. this
    // means the child's stdout falls silent for the full subagent duration
    // even when real work is happening. opencode passes a predicate keyed
    // off its in-flight task dispatch tracker; while it returns true, the
    // activity timer must skip the kill decision and reset its baseline.
    const result = await spawn({
      cmd: "bash",
      args: ["-c", "sleep 8; echo done"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 1000,
      isPausedExternally: () => true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("done");
  }, 20_000);

  it("isPausedExternally fires normally once it returns false again", async () => {
    // verifies suspend/resume rather than unconditional bypass: the predicate
    // flips to false after a few hundred ms, so the timer should resume from
    // a fresh baseline (advanced during the paused window) and fire after
    // activityTimeout idle time. critical that lastActivityTime is reset
    // while paused — otherwise the resume tick would see a stale baseline
    // and kill instantly.
    let paused = true;
    setTimeout(() => {
      paused = false;
    }, 500);

    const result = await spawn({
      cmd: "sleep",
      args: ["30"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 1000,
      isPausedExternally: () => paused,
    }).catch((err) => err);

    expect(result).toBeInstanceOf(Error);
    expect(String(result)).toMatch(/activity timeout/i);
  }, 20_000);

  it("reports signal-killed subprocesses as failures, not success", async () => {
    // regression: before the fix, `child.on("close", (exitCode) => ...)`
    // discarded the signal parameter and `exitCode || 0` coerced the
    // node-delivered null to 0. lifecycle hooks killed by OOM, segfault,
    // or external SIGTERM were silently reported as exit code 0, and
    // lifecycle.ts's `if (result.exitCode !== 0)` skipped the warning —
    // so callers proceeded as if setup/post-checkout/prepush had succeeded.
    const result = await spawn({
      cmd: "bash",
      args: ["-c", "kill -KILL $$"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      activityTimeout: 0,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/killed by signal/i);
    expect(result.stderr).toMatch(/SIGKILL/);
  });
});
