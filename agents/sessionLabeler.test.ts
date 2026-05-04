import { describe, expect, test } from "vitest";
import {
  deriveLabelFromTaskInput,
  formatWithLabel,
  ORCHESTRATOR_LABEL,
  SessionLabeler,
} from "./sessionLabeler.ts";

describe("deriveLabelFromTaskInput", () => {
  test("prefers explicit lens marker in prompt over description", () => {
    expect(
      deriveLabelFromTaskInput({
        prompt: "lens: security\nReview the diff for...",
        description: "general review",
      })
    ).toBe("lens:security");
  });

  test("supports lens=<name> alternative syntax", () => {
    expect(
      deriveLabelFromTaskInput({
        prompt: "lens=user-journey\nWalk through the happy path...",
      })
    ).toBe("lens:user-journey");
  });

  test("falls back to description when no lens marker present", () => {
    expect(
      deriveLabelFromTaskInput({
        prompt: "Review this diff for any bugs",
        description: "Auth lens",
      })
    ).toBe("lens:auth-lens");
  });

  test("falls back to subagent_type when description and lens marker absent", () => {
    expect(
      deriveLabelFromTaskInput({
        prompt: "Some generic prompt",
        subagent_type: "reviewfrog",
      })
    ).toBe("reviewfrog");
  });

  test("returns generic subagent when nothing identifiable", () => {
    expect(deriveLabelFromTaskInput({})).toBe("subagent");
  });

  test("slug normalizes whitespace and special chars", () => {
    expect(
      deriveLabelFromTaskInput({
        description: "Schema migration & operational readiness!",
      })
    ).toBe("lens:schema-migration-operational-readiness");
  });

  test("slug truncates labels longer than 40 chars to keep prefix readable", () => {
    expect(
      deriveLabelFromTaskInput({
        description: "this is a very long lens description that exceeds the slug limit",
      })
    ).toBe("lens:this-is-a-very-long-lens-description-tha");
  });

  test("ignores lens marker mid-line — must be at line start", () => {
    expect(
      deriveLabelFromTaskInput({
        prompt: "Please review the lens: security claim made above",
        description: "billing",
      })
    ).toBe("lens:billing");
  });
});

describe("SessionLabeler", () => {
  test("first session seen is the orchestrator", () => {
    const labeler = new SessionLabeler();
    expect(labeler.labelFor("ses-A")).toBe(ORCHESTRATOR_LABEL);
    // bound — same session returns same label on second call
    expect(labeler.labelFor("ses-A")).toBe(ORCHESTRATOR_LABEL);
    expect(labeler.size()).toBe(1);
  });

  test("FIFO matches dispatched labels to new sessions in dispatch order", () => {
    const labeler = new SessionLabeler();
    // orchestrator session
    labeler.labelFor("parent");

    // orchestrator dispatches 3 tasks in one assistant turn
    labeler.recordTaskDispatch({ description: "security" });
    labeler.recordTaskDispatch({ description: "correctness" });
    labeler.recordTaskDispatch({ description: "user journey" });

    expect(labeler.pendingDispatchCount()).toBe(3);

    // children appear (potentially interleaved)
    expect(labeler.labelFor("child-1")).toBe("lens:security");
    expect(labeler.labelFor("child-2")).toBe("lens:correctness");
    expect(labeler.labelFor("child-3")).toBe("lens:user-journey");

    expect(labeler.pendingDispatchCount()).toBe(0);
    expect(labeler.size()).toBe(4);
  });

  test("interleaved events from parent and children resolve to stable labels", () => {
    const labeler = new SessionLabeler();
    labeler.labelFor("parent");
    labeler.recordTaskDispatch({ description: "security" });
    labeler.recordTaskDispatch({ description: "correctness" });

    // child-1 emits an event first (its label binds)
    expect(labeler.labelFor("child-1")).toBe("lens:security");
    // parent emits some events in between
    expect(labeler.labelFor("parent")).toBe(ORCHESTRATOR_LABEL);
    // child-2 finally appears
    expect(labeler.labelFor("child-2")).toBe("lens:correctness");
    // child-1 emits more events — still the same label
    expect(labeler.labelFor("child-1")).toBe("lens:security");
  });

  test("falls back to subagent#N when child appears without a queued dispatch", () => {
    const labeler = new SessionLabeler();
    labeler.labelFor("parent");
    // no recordTaskDispatch — but a child appears anyway (defensive path)
    expect(labeler.labelFor("ghost")).toBe("subagent#1");
    expect(labeler.labelFor("ghost-2")).toBe("subagent#2");
  });

  test("undefined/null/empty sessionID resolves to orchestrator label without binding", () => {
    const labeler = new SessionLabeler();
    expect(labeler.labelFor(undefined)).toBe(ORCHESTRATOR_LABEL);
    expect(labeler.labelFor(null)).toBe(ORCHESTRATOR_LABEL);
    expect(labeler.labelFor("")).toBe(ORCHESTRATOR_LABEL);
    // size stays zero — those calls didn't bind anything
    expect(labeler.size()).toBe(0);
  });

  test("entries returns insertion-ordered (sessionID, label) pairs", () => {
    const labeler = new SessionLabeler();
    labeler.labelFor("parent");
    labeler.recordTaskDispatch({ description: "security" });
    labeler.labelFor("child-1");
    expect(labeler.entries()).toEqual([
      ["parent", ORCHESTRATOR_LABEL],
      ["child-1", "lens:security"],
    ]);
  });

  test("realistic four-lens parallel fan-out — interleaved tool_use stream", () => {
    // simulates the event order we'd see when the orchestrator dispatches
    // 4 lens subagents in a single assistant turn and they all start emitting
    // tool_use events more or less concurrently.
    const labeler = new SessionLabeler();

    // 1. orchestrator's `init` event
    expect(labeler.labelFor("p")).toBe(ORCHESTRATOR_LABEL);

    // 2. orchestrator emits 4 task tool_use events back-to-back
    labeler.recordTaskDispatch({ description: "correctness & invariants" });
    labeler.recordTaskDispatch({ description: "security" });
    labeler.recordTaskDispatch({ description: "user journey" });
    labeler.recordTaskDispatch({ description: "schema migration" });

    // 3. children emit in arbitrary interleaved order
    const observed: Array<[string, string]> = [];
    for (const session of ["c1", "c2", "p", "c3", "c1", "c4", "c2", "p"]) {
      observed.push([session, labeler.labelFor(session)]);
    }

    expect(observed).toEqual([
      ["c1", "lens:correctness-invariants"],
      ["c2", "lens:security"],
      ["p", ORCHESTRATOR_LABEL],
      ["c3", "lens:user-journey"],
      ["c1", "lens:correctness-invariants"],
      ["c4", "lens:schema-migration"],
      ["c2", "lens:security"],
      ["p", ORCHESTRATOR_LABEL],
    ]);

    expect(labeler.size()).toBe(5);
    expect(labeler.pendingDispatchCount()).toBe(0);
  });
});

describe("formatWithLabel", () => {
  test("prefixes a single-line message with magenta-wrapped label", () => {
    const out = formatWithLabel("orchestrator", "hello world");
    expect(out).toContain("[orchestrator]");
    expect(out).toContain("hello world");
    // ANSI magenta + reset markers around the bracketed label (escapes
    // built via fromCharCode to satisfy biome's no-control-character-in-regex)
    const ESC = String.fromCharCode(27);
    expect(out).toMatch(new RegExp(`${ESC}\\[35m\\[orchestrator\\]${ESC}\\[0m hello world$`));
  });

  test("prefixes every line of a multi-line message", () => {
    const out = formatWithLabel("lens:security", "line one\nline two\nline three");
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toContain("[lens:security]");
    }
    expect(lines[0]).toContain("line one");
    expect(lines[1]).toContain("line two");
    expect(lines[2]).toContain("line three");
  });

  test("handles empty input without throwing", () => {
    const out = formatWithLabel("orchestrator", "");
    expect(out).toContain("[orchestrator]");
  });
});
