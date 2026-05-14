import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAgentApiKey } from "./apiKeys.ts";

const base = {
  agent: { name: "opencode" },
  owner: "test-owner",
  name: "test-repo",
};

const savedEnv = { ...process.env };

// keys that count as provider auth in `knownApiKeys` and would let the
// auto-select path pass without our intent. strip all of them at test setup
// so each `it` starts from a clean slate regardless of what's in the dev `.env`.
const STRIPPED_PREFIXES_OR_NAMES = [
  /_API_KEY$/,
  /^CLAUDE_CODE_OAUTH_TOKEN$/,
  /^AWS_BEARER_TOKEN_BEDROCK$/,
  /^AWS_ACCESS_KEY_ID$/,
  /^AWS_SECRET_ACCESS_KEY$/,
  /^AWS_SESSION_TOKEN$/,
  /^AWS_REGION$/,
  /^BEDROCK_MODEL_ID$/,
];

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (STRIPPED_PREFIXES_OR_NAMES.some((re) => re.test(key))) delete process.env[key];
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
      for (const slug of ["opencode/mimo-v2-pro-free", "opencode/minimax-m2.5-free"]) {
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

    it("throws for opencode/gpt-5-nano without OPENCODE_API_KEY (paid Zen alias)", () => {
      expect(() => validateAgentApiKey({ ...base, model: "opencode/gpt-5-nano" })).toThrow(
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

  describe("bedrock routing slug", () => {
    it("passes with AWS_BEARER_TOKEN_BEDROCK + AWS_REGION + BEDROCK_MODEL_ID", () => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.AWS_REGION = "us-east-1";
      process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
      expect(() => validateAgentApiKey({ ...base, model: "bedrock/byok" })).not.toThrow();
    });

    it("passes with AWS access keys + region + model id", () => {
      process.env.AWS_ACCESS_KEY_ID = "AKIA-test";
      process.env.AWS_SECRET_ACCESS_KEY = "secret-test";
      process.env.AWS_REGION = "us-east-1";
      process.env.BEDROCK_MODEL_ID = "amazon.nova-pro-v1:0";
      expect(() => validateAgentApiKey({ ...base, model: "bedrock/byok" })).not.toThrow();
    });

    it("throws when BEDROCK_MODEL_ID is missing", () => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.AWS_REGION = "us-east-1";
      expect(() => validateAgentApiKey({ ...base, model: "bedrock/byok" })).toThrow(
        "BEDROCK_MODEL_ID"
      );
    });

    it("throws when AWS_REGION is missing", () => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
      expect(() => validateAgentApiKey({ ...base, model: "bedrock/byok" })).toThrow("AWS_REGION");
    });

    it("throws when no auth is set", () => {
      process.env.AWS_REGION = "us-east-1";
      process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
      expect(() => validateAgentApiKey({ ...base, model: "bedrock/byok" })).toThrow(
        "AWS_BEARER_TOKEN_BEDROCK"
      );
    });

    it("throws when only AWS_ACCESS_KEY_ID is set (missing secret)", () => {
      process.env.AWS_ACCESS_KEY_ID = "AKIA-test";
      process.env.AWS_REGION = "us-east-1";
      process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
      expect(() => validateAgentApiKey({ ...base, model: "bedrock/byok" })).toThrow(
        "AWS_BEARER_TOKEN_BEDROCK"
      );
    });

    // regression: main.ts passes the resolved model into validateAgentApiKey
    // (`payload.proxyModel ?? resolvedModel ?? payload.model`), which for
    // bedrock is the raw AWS model ID and has no `/`. parseModel would throw.
    // see PR #720 e2e run 25821218139 for the original failure mode.
    it("accepts a raw Bedrock model ID (post-resolveModel) without throwing", () => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.AWS_REGION = "us-east-1";
      process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-6-v1";
      expect(() =>
        validateAgentApiKey({ ...base, model: "us.anthropic.claude-opus-4-6-v1" })
      ).not.toThrow();
    });

    it("throws on raw Bedrock model ID when AWS auth is missing", () => {
      process.env.AWS_REGION = "us-east-1";
      process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-6-v1";
      expect(() =>
        validateAgentApiKey({ ...base, model: "us.anthropic.claude-opus-4-6-v1" })
      ).toThrow("AWS_BEARER_TOKEN_BEDROCK");
    });
  });
});
