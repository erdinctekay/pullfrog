import { describe, expect, it } from "vitest";
import { resolveCliModel } from "../models.ts";
import { FREE_FALLBACK_SLUG, selectFallbackModelIfNeeded } from "./byokFallback.ts";

describe("FREE_FALLBACK_SLUG", () => {
  it("resolves in the curated catalog", () => {
    expect(resolveCliModel(FREE_FALLBACK_SLUG)).toBe("opencode/big-pickle");
  });

  it("is opencode/big-pickle", () => {
    expect(FREE_FALLBACK_SLUG).toBe("opencode/big-pickle");
  });
});

describe("selectFallbackModelIfNeeded", () => {
  const empty = new Set<string>();

  it("falls back when the resolved model is not in OpenCode's authorized set", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: "anthropic/claude-opus-4-7",
      proxyModel: undefined,
      authorized: empty,
      agentName: "opencode",
    });
    expect(result).toEqual({
      fallback: true,
      from: "anthropic/claude-opus-4-7",
      to: FREE_FALLBACK_SLUG,
    });
  });

  it("does not fall back when the resolved model IS authorized", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: "anthropic/claude-opus-4-7",
      proxyModel: undefined,
      authorized: new Set(["anthropic/claude-opus-4-7"]),
      agentName: "opencode",
    });
    expect(result.fallback).toBe(false);
  });

  it("does not fall back when the claude harness serves the model", () => {
    // opencode models can't see CLAUDE_CODE_OAUTH_TOKEN, so `authorized` is
    // empty for anthropic/* — but resolveAgent picks the claude agent, which
    // brings its own auth. the gate must not downgrade to big-pickle.
    const result = selectFallbackModelIfNeeded({
      resolvedModel: "anthropic/claude-opus-4-7",
      proxyModel: undefined,
      authorized: empty,
      agentName: "claude",
    });
    expect(result.fallback).toBe(false);
  });

  it("does not fall back on Router runs (proxyModel set)", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: undefined,
      proxyModel: "openrouter/anthropic/claude-opus-4.7",
      authorized: empty,
      agentName: "opencode",
    });
    expect(result.fallback).toBe(false);
  });

  it("does not fall back when no model is resolved (auto-select path)", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: undefined,
      proxyModel: undefined,
      authorized: empty,
      agentName: "opencode",
    });
    expect(result.fallback).toBe(false);
  });

  it("does not fall back when the resolved model is itself the free fallback", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: FREE_FALLBACK_SLUG,
      proxyModel: undefined,
      authorized: empty,
      agentName: "opencode",
    });
    expect(result.fallback).toBe(false);
  });

  it("does not fall back for Bedrock routing (raw model ID has no slash)", () => {
    // resolveModel({slug:"bedrock/byok"}) returns the raw BEDROCK_MODEL_ID
    // value (e.g. "us.anthropic.claude-opus-4-7"), which has no `/`. the
    // routing validator (validateBedrockSetup) owns auth + region + model-id
    // checking for this path, not the BYOK fallback gate.
    const result = selectFallbackModelIfNeeded({
      resolvedModel: "us.anthropic.claude-opus-4-7",
      proxyModel: undefined,
      authorized: empty,
      agentName: "claude",
    });
    expect(result.fallback).toBe(false);
  });

  it("does not fall back when stored minimax-m2.5-free resolves to big-pickle", () => {
    const result = selectFallbackModelIfNeeded({
      resolvedModel: resolveCliModel("opencode/minimax-m2.5-free"),
      proxyModel: undefined,
      authorized: empty,
      agentName: "opencode",
    });
    expect(result.fallback).toBe(false);
  });
});
