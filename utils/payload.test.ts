import { Inputs, JsonPayload } from "./payload.ts";

describe("Inputs schema", () => {
  it("only prompt is required", () => {
    const result = Inputs.assert({ prompt: "test prompt" });
    expect(result).toEqual({ prompt: "test prompt" });
    expect(() => Inputs.assert({})).toThrow();
  });

  it.each([
    ["push", "enabled"],
    ["push", "disabled"],
    ["push", undefined],
    ["shell", "enabled"],
    ["shell", "restricted"],
    ["shell", "disabled"],
    ["shell", undefined],
    ["timeout", "10m"],
    ["timeout", "1h30m"],
    ["timeout", "30s"],
    ["timeout", undefined],
  ] as const)("should accept %s for %s", (prop, value) => {
    const input = { prompt: "test", [prop]: value };
    expect(() => Inputs.assert(input)).not.toThrow();
  });

  it.each([["push"], ["shell"]] as const)("should reject invalid %s values", (prop) => {
    const input = { prompt: "test", [prop]: "invalid" as any };
    expect(() => Inputs.assert(input)).toThrow();
  });
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
    ["timeout", "10m"],
    ["timeout", "1h30m"],
    ["timeout", "30s"],
    ["model", "anthropic/claude-opus"],
    ["event", { trigger: "unknown" }],
  ] as const)("should accept optional %s with value %s", (prop, value) => {
    const input = { "~pullfrog": true, version: "1.2.3", prompt: "test prompt", [prop]: value };
    expect(() => JsonPayload.assert(input)).not.toThrow();
  });
});
