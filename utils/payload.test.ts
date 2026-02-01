import { Inputs, JsonPayload } from "./payload.ts";

describe("Inputs schema", () => {
  it("only prompt is required", () => {
    const result = Inputs.assert({ prompt: "test prompt" });
    expect(result).toEqual({ prompt: "test prompt" });
    expect(() => Inputs.assert({})).toThrow();
  });

  it.each([
    ["web", "enabled"],
    ["web", "disabled"],
    ["web", undefined],
    ["search", "enabled"],
    ["search", "disabled"],
    ["search", undefined],
    ["write", "enabled"],
    ["write", "disabled"],
    ["write", undefined],
    ["bash", "enabled"],
    ["bash", "restricted"],
    ["bash", "disabled"],
    ["bash", undefined],
    ["effort", "mini"],
    ["effort", "auto"],
    ["effort", "max"],
    ["timeout", "10m"],
    ["timeout", "1h30m"],
    ["timeout", "30s"],
    ["timeout", undefined],
    ["agent", "claude"],
    ["agent", "codex"],
    ["agent", "cursor"],
    ["agent", "gemini"],
    ["agent", "opencode"],
    // ['agent', null],
  ] as const)("should accept %s for %s", (prop, value) => {
    const input = { prompt: "test", [prop]: value };
    expect(() => Inputs.assert(input)).not.toThrow();
  });

  it.each([["web"], ["search"], ["write"], ["bash"], ["effort"], ["agent"]] as const)(
    "should reject invalid %s values",
    (prop) => {
      const input = { prompt: "test", [prop]: "invalid" as any };
      expect(() => Inputs.assert(input)).toThrow();
    }
  );
});

describe("JsonPayload schema", () => {
  it("requires ~pullfrog and version and prompt", () => {
    const result = JsonPayload.assert({
      "~pullfrog": true,
      version: "1.2.3",
      prompt: "test prompt",
    });
    expect(result).toMatchObject({ "~pullfrog": true, version: "1.2.3", prompt: "test prompt" });
    expect(() => JsonPayload.assert({})).toThrow();
    expect(() => JsonPayload.assert({ "~pullfrog": true })).toThrow();
    expect(() => JsonPayload.assert({ version: "1.2.3" })).toThrow();
  });

  it.each([
    ["agent", "claude"],
    ["agent", "codex"],
    ["agent", "cursor"],
    ["agent", "gemini"],
    ["agent", "opencode"],
    ["effort", "mini"],
    ["effort", "auto"],
    ["effort", "max"],
    ["timeout", "10m"],
    ["timeout", "1h30m"],
    ["timeout", "30s"],
    ["event", { trigger: "unknown" }],
  ] as const)("should accept optional %s with value %s", (prop, value) => {
    const input = { "~pullfrog": true, version: "1.2.3", prompt: "test prompt", [prop]: value };
    expect(() => JsonPayload.assert(input)).not.toThrow();
  });

  it.each([["agent"], ["effort"]] as const)("should reject invalid %s values", (prop) => {
    const input = {
      "~pullfrog": true,
      version: "1.2.3",
      prompt: "test prompt",
      [prop]: "invalid" as any,
    };
    expect(() => JsonPayload.assert(input)).toThrow();
  });
});
