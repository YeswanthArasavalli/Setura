/**
 * cors.ts — CORS handling for Edge Functions
 */
import { Env } from "./env.ts";

export function buildCorsHeaders(requestOrigin: string | null): HeadersInit {
  const origin = requestOrigin ?? "";
  const wildcard = Env.ALLOWED_ORIGINS.includes("*");
  const allowed = wildcard || Env.ALLOWED_ORIGINS.includes(origin);
  // Fail closed: a disallowed (or absent) origin gets NO
  // `Access-Control-Allow-Origin`, not the first allow-list entry. Echoing a
  // real origin to an unrelated requester both leaked the allow list and,
  // with `Allow-Credentials: true` below, paired a fixed origin with
  // credentialed access instead of denying the request (Part 4 §28.7).
  // `Vary: Origin` is mandatory once the response depends on the request
  // origin, or a shared cache can serve one tenant's grant to another.
  const headers: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": [
      "Authorization",
      "Content-Type",
      "Idempotency-Key",
      "X-Correlation-ID",
      "X-Request-ID",
      "X-Hospital-ID",
      // supabase-js always sends `apikey`/`x-client-info` cross-origin, so the
      // browser preflight requires them here or every function POST is blocked.
      "apikey",
      "X-Client-Info",
    ].join(", "),
    "Access-Control-Max-Age": "86400",
  };
  if (allowed) {
    headers["Access-Control-Allow-Origin"] = wildcard ? "*" : origin;
    // Credentials are only meaningful (and only spec-legal alongside a
    // concrete origin) for an origin that is actually allowed.
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: buildCorsHeaders(req.headers.get("Origin")),
    });
  }
  return null;
}
