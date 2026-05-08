type ProviderErrorPattern = { regex: RegExp; label: string };

// status codes are only treated as provider errors when they are adjacent to
// a recognised status key. this rejects commit SHAs that happen to contain
// "429", version strings, file hashes, etc.
const statusKey = `\\b(?:status[_ ]?code|http[_ ]?status|status)["']?\\s*[:=]\\s*["']?`;

const PROVIDER_ERROR_PATTERNS: ProviderErrorPattern[] = [
  // auth patterns must come BEFORE rate-limit patterns. OpenRouter 401 error
  // payloads carry `x-ratelimit-*` response headers in the dump, and the
  // free-form rate-limit regex below would otherwise win on word-boundary
  // matches inside header names. canonical 401 messages: OpenRouter returns
  // `{"error":{"message":"User not found","code":401}}` for disabled or
  // invalid keys (https://openai.luzhipeng.com/docs/api/reference/errors-and-debugging).
  { regex: new RegExp(`${statusKey}401\\b`, "i"), label: "auth error (401)" },
  { regex: new RegExp(`${statusKey}403\\b`, "i"), label: "auth error (403)" },
  { regex: /\bUser not found\b/i, label: "auth error (invalid/disabled key)" },
  { regex: /\bInvalid authentication\b/i, label: "auth error (invalid credentials)" },
  { regex: /\bNo auth credentials found\b/i, label: "auth error (missing credentials)" },
  { regex: new RegExp(`${statusKey}429\\b`, "i"), label: "rate limited (429)" },
  { regex: new RegExp(`${statusKey}500\\b`, "i"), label: "provider 500 error" },
  { regex: new RegExp(`${statusKey}503\\b`, "i"), label: "provider unavailable (503)" },
  // matches `rate limit`, `rate limited`, `rate limits exceeded`,
  // `rate_limit_error`, `rate_limit_exceeded`. the leading `\b` + `[_ ]`
  // separator rejects `x-ratelimit-*` / `anthropic-ratelimit-*` response
  // headers (no separator between "rate" and "limit") which routinely
  // appear in dumped 401 / 4xx error JSON.
  { regex: /\brate[_ ]limit/i, label: "rate limited" },
  { regex: /\bRESOURCE_EXHAUSTED\b/, label: "quota exhausted" },
  // Google gRPC `INTERNAL` status. word-boundary anchors reject
  // `INTERNAL_SERVER_ERROR` (HTTP 500 message that may appear in unrelated
  // log lines) and identifiers like `INTERNALS`.
  { regex: /\bINTERNAL\b/, label: "provider internal error" },
  { regex: /\bUNAVAILABLE\b/, label: "provider unavailable" },
  // matches `quota`, `insufficient_quota`, `quota_exceeded`, `quotaExceeded`.
  // word-character lookarounds would reject `_quota` / `quotaX`; `quota` is
  // specific enough that a plain substring match is safe.
  { regex: /quota/i, label: "quota error" },
  // explicit zero-quota response, e.g. `{"limit": 0}`. the `\b` anchor
  // around `limit` rejects keys like `time_limit` or `field_limit`.
  { regex: /["']?\blimit\b["']?\s*:\s*0\b/, label: "zero quota" },
];

export function detectProviderError(text: string): string | null {
  for (const entry of PROVIDER_ERROR_PATTERNS) {
    if (entry.regex.test(text)) return entry.label;
  }
  return null;
}

/**
 * OpenRouter's response when the per-run key's remaining budget can't cover
 * the agent's `max_tokens` reservation. Distinct from a generic provider error
 * because it's a Pullfrog billing concern, not an upstream outage — the user's
 * Router wallet ran out (or the key budget was undersized at mint time and the
 * agent ran out of headroom partway through).
 *
 * Match must be specific to this exact OpenRouter error class. Generic "credits"
 * or "limit" text shows up in unrelated errors and would mis-classify them.
 *
 * Sample:
 *   `APIError: This request requires more credits, or fewer max_tokens.
 *    You requested up to 32000 tokens, but can only afford 22800.`
 */
// `/s` (dotAll) lets `.*?` cross newlines so we still detect the error if any
// upstream layer reformats the message onto multiple lines. Without it, a
// single inserted `\n` would silently bypass the BillingError reclassification
// and the user would see the generic `❌ Pullfrog failed` dump instead of the
// actionable top-up CTA.
const ROUTER_KEYLIMIT_EXHAUSTED_PATTERN =
  /requires more credits.*?fewer max_tokens|requested up to \d+ tokens.*?can only afford/is;

export function isRouterKeylimitExhaustedError(text: string): boolean {
  return ROUTER_KEYLIMIT_EXHAUSTED_PATTERN.test(text);
}
