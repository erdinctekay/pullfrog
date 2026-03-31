const PROVIDER_ERROR_PATTERNS = [
  { pattern: "429", label: "rate limited (429)" },
  { pattern: "RESOURCE_EXHAUSTED", label: "quota exhausted" },
  { pattern: "quota", label: "quota error" },
  { pattern: "status: 500", label: "provider 500 error" },
  { pattern: "INTERNAL", label: "provider internal error" },
  { pattern: "status: 503", label: "provider unavailable (503)" },
  { pattern: "UNAVAILABLE", label: "provider unavailable" },
  { pattern: "rate limit", label: "rate limited" },
  { pattern: "limit: 0", label: "zero quota" },
];

export function detectProviderError(text: string): string | null {
  for (const entry of PROVIDER_ERROR_PATTERNS) {
    if (text.includes(entry.pattern)) return entry.label;
  }
  return null;
}
