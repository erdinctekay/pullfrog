import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgent, resolveModel } from "./agent.ts";

const savedEnv = { ...process.env };

const STRIPPED = [
  /_API_KEY$/,
  /^CLAUDE_CODE_OAUTH_TOKEN$/,
  /^AWS_BEARER_TOKEN_BEDROCK$/,
  /^AWS_ACCESS_KEY_ID$/,
  /^AWS_SECRET_ACCESS_KEY$/,
  /^AWS_SESSION_TOKEN$/,
  /^AWS_REGION$/,
  /^BEDROCK_MODEL_ID$/,
  /^PULLFROG_MODEL$/,
  /^PULLFROG_AGENT$/,
];

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (STRIPPED.some((re) => re.test(key))) delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("resolveAgent", () => {
  it("returns opencode by default", () => {
    expect(resolveAgent({}).name).toBe("opencode");
  });

  it("routes anthropic/* to claude when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(resolveAgent({ model: "anthropic/claude-opus-4-7" }).name).toBe("claude");
  });

  it("falls back to opencode for anthropic/* without claude-code creds", () => {
    expect(resolveAgent({ model: "anthropic/claude-opus-4-7" }).name).toBe("opencode");
  });

  describe("bedrock routing", () => {
    it("routes Anthropic Bedrock IDs to claude", () => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
      expect(resolveAgent({ model: "us.anthropic.claude-opus-4-7" }).name).toBe("claude");
    });

    it("routes Anthropic Bedrock IDs (no region prefix) to claude", () => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.BEDROCK_MODEL_ID = "anthropic.claude-haiku-4-5-20251001-v1:0";
      expect(resolveAgent({ model: "anthropic.claude-haiku-4-5-20251001-v1:0" }).name).toBe(
        "claude"
      );
    });

    it("routes non-Anthropic Bedrock IDs to opencode", () => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.BEDROCK_MODEL_ID = "amazon.nova-pro-v1:0";
      expect(resolveAgent({ model: "amazon.nova-pro-v1:0" }).name).toBe("opencode");
    });

    it("routes Llama IDs to opencode", () => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.BEDROCK_MODEL_ID = "us.meta.llama4-scout-17b-instruct-v1:0";
      expect(resolveAgent({ model: "us.meta.llama4-scout-17b-instruct-v1:0" }).name).toBe(
        "opencode"
      );
    });

    it("accepts AWS access keys as auth", () => {
      process.env.AWS_ACCESS_KEY_ID = "AKIA-test";
      process.env.AWS_SECRET_ACCESS_KEY = "secret-test";
      process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
      expect(resolveAgent({ model: "us.anthropic.claude-opus-4-7" }).name).toBe("claude");
    });

    it("PULLFROG_AGENT override wins over Anthropic auto-routing", () => {
      process.env.PULLFROG_AGENT = "opencode";
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
      expect(resolveAgent({ model: "us.anthropic.claude-opus-4-7" }).name).toBe("opencode");
    });
  });
});

describe("resolveModel", () => {
  it("PULLFROG_MODEL override wins", () => {
    process.env.PULLFROG_MODEL = "anthropic/claude-opus";
    expect(resolveModel({ slug: "openai/gpt" })).toBe("anthropic/claude-opus-4-7");
  });

  it("PULLFROG_MODEL bypasses bedrock routing entirely", () => {
    process.env.PULLFROG_MODEL = "openai/gpt";
    process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
    expect(resolveModel({ slug: "bedrock/byok" })).toBe("openai/gpt-5.5");
  });

  it("resolves bedrock/byok to BEDROCK_MODEL_ID", () => {
    process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
    expect(resolveModel({ slug: "bedrock/byok" })).toBe("us.anthropic.claude-opus-4-7");
  });

  it("throws when bedrock/byok is selected without BEDROCK_MODEL_ID", () => {
    expect(() => resolveModel({ slug: "bedrock/byok" })).toThrow("BEDROCK_MODEL_ID");
  });

  it("returns the alias resolve for normal slugs", () => {
    expect(resolveModel({ slug: "openai/gpt" })).toBe("openai/gpt-5.5");
  });

  it("returns undefined for no slug + no PULLFROG_MODEL", () => {
    expect(resolveModel({})).toBeUndefined();
  });

  // regression: PR #720 review caught that `resolveCliModel("bedrock/byok")`
  // returns the literal sentinel `"bedrock"` from the alias's `resolve`
  // field. Without routing-aware handling, PULLFROG_MODEL=bedrock/byok would
  // leak that sentinel downstream and break agent dispatch.
  it("PULLFROG_MODEL=bedrock/byok defers to BEDROCK_MODEL_ID, not the sentinel", () => {
    process.env.PULLFROG_MODEL = "bedrock/byok";
    process.env.BEDROCK_MODEL_ID = "us.anthropic.claude-opus-4-7";
    expect(resolveModel({ slug: "openai/gpt" })).toBe("us.anthropic.claude-opus-4-7");
  });

  it("PULLFROG_MODEL=bedrock/byok throws if BEDROCK_MODEL_ID is missing", () => {
    process.env.PULLFROG_MODEL = "bedrock/byok";
    expect(() => resolveModel({ slug: "openai/gpt" })).toThrow("BEDROCK_MODEL_ID");
  });
});
