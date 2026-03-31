import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAgentApiKey } from "./apiKeys.ts";

const base = {
  agent: { name: "opentoad" },
  owner: "test-owner",
  name: "test-repo",
};

const savedEnv = { ...process.env };

beforeEach(() => {
  // strip all known provider keys so tests start clean
  for (const key of Object.keys(process.env)) {
    if (key.endsWith("_API_KEY") || key === "CLAUDE_CODE_OAUTH_TOKEN") delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("validateAgentApiKey", () => {
  describe("free model (no keys required)", () => {
    it("passes with zero env keys", () => {
      expect(() => validateAgentApiKey({ ...base, model: "opencode/big-pickle" })).not.toThrow();
    });

    it("passes for other free opencode models", () => {
      for (const slug of [
        "opencode/gpt-5-nano",
        "opencode/mimo-v2-pro-free",
        "opencode/minimax-m2.5-free",
        "opencode/nemotron-3-super-free",
      ]) {
        expect(() => validateAgentApiKey({ ...base, model: slug })).not.toThrow();
      }
    });
  });

  describe("keyed model", () => {
    it("passes when the required key is present", () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      expect(() => validateAgentApiKey({ ...base, model: "anthropic/claude-opus" })).not.toThrow();
    });

    it("throws when the required key is missing", () => {
      expect(() => validateAgentApiKey({ ...base, model: "anthropic/claude-opus" })).toThrow(
        "no API key found"
      );
    });

    it("passes for opencode keyed model with OPENCODE_API_KEY", () => {
      process.env.OPENCODE_API_KEY = "sk-test";
      expect(() => validateAgentApiKey({ ...base, model: "opencode/claude-opus" })).not.toThrow();
    });

    it("throws for opencode keyed model without OPENCODE_API_KEY", () => {
      expect(() => validateAgentApiKey({ ...base, model: "opencode/claude-opus" })).toThrow(
        "no API key found"
      );
    });
  });

  describe("no model (auto-select)", () => {
    it("passes when any known provider key is present", () => {
      process.env.OPENAI_API_KEY = "sk-test";
      expect(() => validateAgentApiKey({ ...base, model: undefined })).not.toThrow();
    });

    it("throws when no provider keys are present", () => {
      expect(() => validateAgentApiKey({ ...base, model: undefined })).toThrow("no API key found");
    });
  });
});
