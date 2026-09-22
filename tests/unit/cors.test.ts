/**
 * tests/unit/cors.test.ts — the CORS allow-list boundary.
 *
 * cors.ts → env.ts, so the fake-env bootstrap MUST be the first import
 * (env.ts validates eagerly at module load). The fake env sets
 * ALLOWED_ORIGINS to the two localhost origins.
 */

import "../utils/setup_env.ts";

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  buildCorsHeaders,
  handleCors,
} from "../../supabase/functions/_shared/cors.ts";

const ALLOWED = "http://localhost:5173";
const FORBIDDEN = "https://evil.example";

Deno.test("allowed origin gets an exact ACAO echo and credentials", () => {
  const headers = buildCorsHeaders(ALLOWED) as Record<string, string>;
  assertEquals(headers["Access-Control-Allow-Origin"], ALLOWED);
  assertEquals(headers["Access-Control-Allow-Credentials"], "true");
});

Deno.test("disallowed origin gets NO ACAO (fail closed, no allow-list echo)", () => {
  const headers = buildCorsHeaders(FORBIDDEN) as Record<string, string>;
  assertEquals(headers["Access-Control-Allow-Origin"], undefined);
  // It must not fall back to the first configured origin: that leaked the
  // allow list and paired a real origin with credentialed access.
  assertEquals(headers["Access-Control-Allow-Credentials"], undefined);
});

Deno.test("absent origin gets no ACAO but keeps the shared headers", () => {
  const headers = buildCorsHeaders(null) as Record<string, string>;
  assertEquals(headers["Access-Control-Allow-Origin"], undefined);
  // Preflight/allow-list behaviour still has to be cache-partitioned by
  // origin, otherwise one client's grant can be served to another.
  assertEquals(headers["Vary"], "Origin");
  assertEquals(
    headers["Access-Control-Allow-Headers"].split(", ").includes("apikey"),
    true,
  );
  assertEquals(
    headers["Access-Control-Allow-Headers"].split(", ").includes(
      "X-Client-Info",
    ),
    true,
  );
  assertEquals(
    headers["Access-Control-Allow-Headers"].split(", ").includes(
      "Idempotency-Key",
    ),
    true,
  );
});

Deno.test("preflight from a disallowed origin is a headerless 204", () => {
  const resp = handleCors(
    new Request("http://127.0.0.1:54321/functions/v1/create-booking", {
      method: "OPTIONS",
      headers: { Origin: FORBIDDEN },
    }),
  );
  assertEquals(resp?.status, 204);
  assertEquals(resp?.headers.get("Access-Control-Allow-Origin"), null);
});

Deno.test("preflight from an allowed origin advertises the methods", () => {
  const resp = handleCors(
    new Request("http://127.0.0.1:54321/functions/v1/create-booking", {
      method: "OPTIONS",
      headers: { Origin: ALLOWED },
    }),
  );
  assertEquals(resp?.headers.get("Access-Control-Allow-Origin"), ALLOWED);
  assertEquals(
    resp?.headers.get("Access-Control-Allow-Methods")?.includes("POST"),
    true,
  );
});

Deno.test("non-preflight requests are passed through for the handler", () => {
  assertEquals(
    handleCors(
      new Request("http://127.0.0.1:54321/functions/v1/create-booking", {
        method: "POST",
        headers: { Origin: ALLOWED },
      }),
    ),
    null,
  );
});
