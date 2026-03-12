import { describe, expect, it } from "vitest";
import { resolveAgent } from "./agent.ts";

describe("resolveAgent", () => {
  it("returns opentoad", () => {
    const agent = resolveAgent();
    expect(agent.name).toBe("opentoad");
  });
});
