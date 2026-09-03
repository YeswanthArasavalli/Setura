/**
 * cors.ts — CORS handling for Edge Functions
 */
import { Env } from "./env.ts";

export function buildCorsHeaders(requestOrigin: string | null): HeadersInit {
  const origin = requestOrigin ?? "";
  const allowed = Env.ALLOWED_ORIGINS.some((o) => o === origin || o === "*");
  return {
    "Access-Control-Allow-Origin": allowed ? origin : Env.ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": [
      "Authorization",
      "Content-Type",
      "Idempotency-Key",
      "X-Correlation-ID",
      "X-Request-ID",
      "X-Hospital-ID",
    ].join(", "),
    "Access-Control-Max-Age": "86400",
    "Access-Control-Allow-Credentials": "true",
  };
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
