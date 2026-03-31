import { describe, expect, it } from "vitest";
import {
  getModelEnvVars,
  getModelProvider,
  modelAliases,
  parseModel,
  providers,
  resolveCliModel,
  resolveModelSlug,
} from "./models.ts";

describe("parseModel", () => {
  it("parses provider/model format", () => {
    const result = parseModel("anthropic/claude-opus");
    expect(result).toEqual({ provider: "anthropic", model: "claude-opus" });
  });

  it("handles nested slashes (openrouter format)", () => {
    const result = parseModel("openrouter/anthropic/claude-opus-4.6");
    expect(result).toEqual({ provider: "openrouter", model: "anthropic/claude-opus-4.6" });
  });

  it("throws on invalid slug without slash", () => {
    expect(() => parseModel("invalid")).toThrow("invalid model slug");
  });
});

describe("getModelProvider", () => {
  it("extracts provider from slug", () => {
    expect(getModelProvider("anthropic/claude-opus")).toBe("anthropic");
    expect(getModelProvider("openai/gpt-codex")).toBe("openai");
    expect(getModelProvider("google/gemini-pro")).toBe("google");
  });
});

describe("getModelEnvVars", () => {
  it("returns correct env vars for anthropic", () => {
    expect(getModelEnvVars("anthropic/claude-opus")).toEqual([
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });

  it("returns correct env vars for google (multiple)", () => {
    const envVars = getModelEnvVars("google/gemini-pro");
    expect(envVars).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(envVars).toContain("GEMINI_API_KEY");
  });

  it("returns empty array for unknown provider", () => {
    expect(getModelEnvVars("unknown/model")).toEqual([]);
  });

  it("returns empty env vars for free opencode models", () => {
    expect(getModelEnvVars("opencode/big-pickle")).toEqual([]);
    expect(getModelEnvVars("opencode/gpt-5-nano")).toEqual([]);
    expect(getModelEnvVars("opencode/mimo-v2-pro-free")).toEqual([]);
    expect(getModelEnvVars("opencode/minimax-m2.5-free")).toEqual([]);
    expect(getModelEnvVars("opencode/nemotron-3-super-free")).toEqual([]);
  });

  it("still requires OPENCODE_API_KEY for non-free opencode models", () => {
    expect(getModelEnvVars("opencode/claude-opus")).toEqual(["OPENCODE_API_KEY"]);
  });
});

describe("resolveModelSlug", () => {
  it("resolves known alias to concrete specifier", () => {
    const resolved = resolveModelSlug("anthropic/claude-opus");
    expect(resolved).toBe("anthropic/claude-opus-4-6");
  });

  it("resolves openai alias", () => {
    const resolved = resolveModelSlug("openai/gpt-codex");
    expect(resolved).toBe("openai/gpt-5.3-codex");
  });

  it("returns undefined for unknown slug", () => {
    expect(resolveModelSlug("unknown/model")).toBeUndefined();
  });
});

describe("resolveCliModel", () => {
  it("returns same as resolveModelSlug (models.dev specifier)", () => {
    const slug = "anthropic/claude-opus";
    expect(resolveCliModel(slug)).toBe(resolveModelSlug(slug));
  });

  it("returns undefined for unknown slug", () => {
    expect(resolveCliModel("bogus/nope")).toBeUndefined();
  });
});

describe("modelAliases registry", () => {
  it("has at least one model per provider", () => {
    for (const providerKey of Object.keys(providers)) {
      const providerModels = modelAliases.filter((a) => a.provider === providerKey);
      expect(providerModels.length).toBeGreaterThan(0);
    }
  });

  it("has exactly one preferred model per provider", () => {
    for (const providerKey of Object.keys(providers)) {
      const preferred = modelAliases.filter((a) => a.provider === providerKey && a.preferred);
      expect(preferred.length, `${providerKey} should have exactly 1 preferred model`).toBe(1);
    }
  });

  it("all slugs follow provider/model format", () => {
    for (const alias of modelAliases) {
      expect(alias.slug).toContain("/");
      const parsed = parseModel(alias.slug);
      expect(parsed.provider).toBe(alias.provider);
    }
  });

  it("all resolve values follow provider/model format", () => {
    for (const alias of modelAliases) {
      expect(alias.resolve).toContain("/");
    }
  });

  it("slugs are unique", () => {
    const slugs = modelAliases.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe("providers registry", () => {
  it("every provider has envVars", () => {
    for (const [key, config] of Object.entries(providers)) {
      expect(config.envVars.length, `${key} should have env vars`).toBeGreaterThan(0);
    }
  });

  it("every provider has a displayName", () => {
    for (const [key, config] of Object.entries(providers)) {
      expect(config.displayName, `${key} should have a displayName`).toBeTruthy();
    }
  });
});
