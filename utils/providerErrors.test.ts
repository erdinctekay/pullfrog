import { detectProviderError, isRouterKeylimitExhaustedError } from "./providerErrors.ts";

describe("detectProviderError", () => {
  describe("false positives previously seen in production", () => {
    it("returns null for commit SHAs containing 429", () => {
      expect(detectProviderError("hash=7a46d89f505b36df49b4f54429daffa1a9459b11")).toBeNull();
      expect(detectProviderError("commit f609cc89e84596ab125d60dac568bfb2ef398396 429")).toBeNull();
    });

    it("classifies 401 + x-ratelimit-* headers as auth, not rate-limited", () => {
      // OpenRouter 401 responses bundle `x-ratelimit-*` rate-limit headers
      // alongside the auth error. the auth patterns must win — pre-fix this
      // got tagged as `rate limited` because of the loose `\brate[_ ]limit`
      // match against header names like `ratelimit-limit-requests`. note: in
      // OpenRouter's actual format the header name is `ratelimit` (one word),
      // but the dumped JSON sometimes contains `rate-limit` separators too.
      const stderr = JSON.stringify({
        error: { name: "APIError", statusCode: 401, message: "Invalid authentication credentials" },
        headers: {
          "x-ratelimit-limit-requests": 50,
          "x-ratelimit-remaining-requests": 49,
          "x-ratelimit-reset-tokens": "2025-01-01T00:00:00Z",
        },
      });
      expect(detectProviderError(stderr)).toBe("auth error (401)");
    });

    it("returns null for INTERNAL_SERVER_ERROR substring", () => {
      expect(detectProviderError("HTTP/1.1 500 INTERNAL_SERVER_ERROR")).toBeNull();
      expect(detectProviderError("expected: not INTERNAL_SERVER_ERROR")).toBeNull();
    });

    it("returns null for INTERNALS substring", () => {
      expect(detectProviderError("debugging INTERNALS of the parser")).toBeNull();
    });
  });

  describe("auth errors", () => {
    it("detects 401 / 403 status codes as auth errors", () => {
      expect(detectProviderError('{"statusCode": 401}')).toBe("auth error (401)");
      expect(detectProviderError('{"statusCode": 403}')).toBe("auth error (403)");
      expect(detectProviderError("status_code: 401")).toBe("auth error (401)");
    });

    it("detects OpenRouter 'User not found' (disabled/invalid key)", () => {
      // bare `"code":401` lacks a status-key prefix so the 401 status pattern
      // intentionally doesn't fire; the User-not-found pattern catches it.
      expect(detectProviderError('{"error":{"message":"User not found","code":401}}')).toBe(
        "auth error (invalid/disabled key)"
      );
      expect(detectProviderError("APIError: User not found.")).toBe(
        "auth error (invalid/disabled key)"
      );
    });

    it("detects 'Invalid authentication' phrasing", () => {
      expect(detectProviderError("Invalid authentication credentials")).toBe(
        "auth error (invalid credentials)"
      );
    });

    it("detects 'No auth credentials found' phrasing", () => {
      expect(detectProviderError("AI_APICallError: No auth credentials found")).toBe(
        "auth error (missing credentials)"
      );
    });
  });

  describe("real provider errors", () => {
    it("detects 429 only when adjacent to a status key", () => {
      expect(detectProviderError('{"statusCode": 429}')).toBe("rate limited (429)");
      expect(detectProviderError('{"status_code": 429, "message": "..."}')).toBe(
        "rate limited (429)"
      );
      expect(detectProviderError("http_status: 429")).toBe("rate limited (429)");
      expect(detectProviderError("status=429")).toBe("rate limited (429)");
    });

    it("detects rate_limit_error and rate_limit_exceeded", () => {
      expect(detectProviderError('{"type":"rate_limit_error"}')).toBe("rate limited");
      expect(detectProviderError("rate_limit_exceeded")).toBe("rate limited");
      expect(detectProviderError("plain rate limit reached")).toBe("rate limited");
    });

    it("detects rate-limit phrasing with trailing inflection", () => {
      expect(detectProviderError("Error: rate limited by provider")).toBe("rate limited");
      expect(detectProviderError("rate limits exceeded for this key")).toBe("rate limited");
    });

    it("detects RESOURCE_EXHAUSTED", () => {
      expect(detectProviderError('"status": "RESOURCE_EXHAUSTED"')).toBe("quota exhausted");
    });

    it("detects gRPC INTERNAL status as a whole word", () => {
      expect(detectProviderError('"status": "INTERNAL"')).toBe("provider internal error");
    });

    it("detects UNAVAILABLE as a whole word", () => {
      expect(detectProviderError('"status": "UNAVAILABLE"')).toBe("provider unavailable");
    });

    it("detects 500 / 503 only when adjacent to a status key", () => {
      expect(detectProviderError('"statusCode": 500')).toBe("provider 500 error");
      expect(detectProviderError('"statusCode": 503')).toBe("provider unavailable (503)");
      expect(detectProviderError("v1.503.0 release notes")).toBeNull();
    });

    it("detects quota and zero-quota responses", () => {
      expect(detectProviderError('"message": "quota exceeded"')).toBe("quota error");
      expect(detectProviderError('{"code":"insufficient_quota"}')).toBe("quota error");
      expect(detectProviderError('"error":"quota_exceeded"')).toBe("quota error");
      expect(detectProviderError('{"reason":"quotaExceeded"}')).toBe("quota error");
      expect(detectProviderError('{"limit": 0, "remaining": 0}')).toBe("zero quota");
      expect(detectProviderError('"time_limit": 0')).toBeNull();
    });
  });
});

describe("isRouterKeylimitExhaustedError", () => {
  it("matches the canonical OpenRouter mid-run error", () => {
    expect(
      isRouterKeylimitExhaustedError(
        "APIError: This request requires more credits, or fewer max_tokens. " +
          "You requested up to 32000 tokens, but can only afford 22800. " +
          "To increase, visit https://openrouter.ai/settings/keys and create a key with a higher total limit"
      )
    ).toBe(true);
  });

  it("matches the 'requires more credits' phrasing on its own", () => {
    expect(
      isRouterKeylimitExhaustedError("This request requires more credits, or fewer max_tokens.")
    ).toBe(true);
  });

  it("matches the 'requested up to ... can only afford' phrasing on its own", () => {
    expect(
      isRouterKeylimitExhaustedError("You requested up to 8000 tokens but can only afford 1234")
    ).toBe(true);
  });

  it("does not match generic out-of-credit text", () => {
    expect(isRouterKeylimitExhaustedError("Your account has insufficient credits")).toBe(false);
    expect(isRouterKeylimitExhaustedError("rate_limit_exceeded")).toBe(false);
    expect(isRouterKeylimitExhaustedError('{"limit": 0}')).toBe(false);
  });

  it("does not match unrelated mentions of max_tokens", () => {
    expect(isRouterKeylimitExhaustedError("max_tokens parameter must be a positive integer")).toBe(
      false
    );
  });

  it("matches across newlines (defends against upstream wrapping/reformatting)", () => {
    expect(
      isRouterKeylimitExhaustedError(
        "APIError: This request requires more credits, or\nfewer max_tokens. You requested up to 32000 tokens"
      )
    ).toBe(true);
    expect(
      isRouterKeylimitExhaustedError("You requested up to 32000 tokens,\nbut can only afford 22800")
    ).toBe(true);
  });
});
