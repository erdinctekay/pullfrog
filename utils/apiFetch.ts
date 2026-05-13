import { getApiUrl } from "./apiUrl.ts";
import { log } from "./cli.ts";

type ApiFetchOptions = {
  path: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  signal?: AbortSignal | undefined;
};

/**
 * fetch wrapper for hitting the Pullfrog API with Vercel deployment protection bypass.
 *
 * adds the bypass secret as BOTH a query parameter and a header for maximum reliability.
 * the server-side forwarding code uses query params, and the Vercel docs say both work,
 * so we do both as belt-and-suspenders.
 *
 * the query param approach is the primary bypass mechanism (matches server-side forwarding).
 * the header is added as a fallback.
 */
export async function apiFetch(options: ApiFetchOptions): Promise<Response> {
  const apiUrl = getApiUrl();
  const url = new URL(options.path, apiUrl);

  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    url.searchParams.set("x-vercel-protection-bypass", bypassSecret);
  }

  const headers: Record<string, string> = {
    ...options.headers,
  };

  // also add as header for belt-and-suspenders
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  // never send Content-Type on body-less requests. empirically, Vercel's
  // Next.js lambda adapter (Next 16.1.x) throws `SyntaxError: Unexpected
  // end of data` before delegating to the route handler — returning a 500 —
  // when Content-Type is set but no body is present. exact mechanism is
  // unverified (minified runtime frame), but Content-Type on a body-less
  // request has no defined semantics per RFC 9110 §8.3 anyway. see #692.
  if (!options.body) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "content-type") delete headers[key];
    }
  }

  log.debug(`api fetch: ${options.method ?? "GET"} ${url.pathname}`);

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };
  if (options.body) init.body = options.body;
  if (options.signal) init.signal = options.signal;

  return fetch(url.toString(), init);
}
