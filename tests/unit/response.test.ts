/**
 * tests/unit/response.test.ts — Smoke tests for API response builders.
 *
 * response.ts → cors.ts → env.ts, so the fake-env bootstrap MUST be
 * the first import (env.ts validates eagerly at module load).
 */

import "../utils/setup_env.ts";

import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  conflictResponse,
  createdResponse,
  errorResponse,
  forbiddenResponse,
  fromSeturError,
  handleErrorResponse,
  internalErrorResponse,
  rateLimitResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "../../supabase/functions/_shared/response.ts";
import {
  NotImplementedError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from "../../supabase/functions/_shared/errors.ts";

const CID = "corr-123";

async function readJson(resp: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await resp.text());
}

Deno.test("successResponse: 200 with envelope fields", async () => {
  const resp = successResponse({ token: 7 }, CID);
  assertEquals(resp.status, 200);
  assertEquals(resp.headers.get("Content-Type"), "application/json");

  const body = await readJson(resp);
  assertEquals(body.success, true);
  assertEquals((body.data as { token: number }).token, 7);
  assertEquals(body.correlationId, CID);
  assertStringIncludes(String(body.timestamp), "T");
});

Deno.test("successResponse includes meta when provided", async () => {
  const resp = successResponse({ ok: 1 }, CID, undefined, { page: 2 });
  const body = await readJson(resp);
  assertEquals((body.meta as { page: number }).page, 2);
});

Deno.test("createdResponse returns 201", async () => {
  const resp = createdResponse({ id: "b-1" }, CID);
  assertEquals(resp.status, 201);
  const body = await readJson(resp);
  assertEquals(body.success, true);
});

Deno.test("errorResponse: retryable defaults to false", async () => {
  const resp = errorResponse("NOT_FOUND", "missing", 404, CID);
  assertEquals(resp.status, 404);
  const body = await readJson(resp);
  assertEquals(body.success, false);
  const error = body.error as Record<string, unknown>;
  assertEquals(error.code, "NOT_FOUND");
  assertEquals(error.retryable, false);
});

Deno.test("fromSeturError maps code/status/retryable", async () => {
  const resp = fromSeturError(new RateLimitError(15), CID);
  assertEquals(resp.status, 429);
  const body = await readJson(resp);
  const error = body.error as Record<string, unknown>;
  assertEquals(error.code, "RATE_LIMIT_EXCEEDED");
  assertEquals(error.retryable, true);
});

Deno.test("fromSeturError surfaces fieldErrors for ValidationError", async () => {
  const err = new ValidationError("Validation failed", {
    patientPhone: ["invalid"],
  });
  const resp = fromSeturError(err, CID);
  assertEquals(resp.status, 422);
  const body = await readJson(resp);
  const error = body.error as Record<string, unknown>;
  assertEquals(
    (error.fieldErrors as Record<string, string[]>).patientPhone,
    ["invalid"],
  );
});

Deno.test("handleErrorResponse: typed error → mapped, unknown → 500", async () => {
  const mapped = handleErrorResponse(new UnauthorizedError(), CID);
  assertEquals(mapped.status, 401);
  const mappedBody = await readJson(mapped);
  assertEquals((mappedBody.error as { code: string }).code, "UNAUTHORIZED");

  const fallback = handleErrorResponse(new Error("kaboom"), CID);
  assertEquals(fallback.status, 500);
  const fallbackBody = await readJson(fallback);
  assertEquals(
    (fallbackBody.error as { code: string }).code,
    "INTERNAL_ERROR",
  );
  // internal errors must NOT leak the raw message
  assertEquals(
    (fallbackBody.error as { message: string }).message,
    "An unexpected error occurred",
  );
});

Deno.test("handleErrorResponse: NotImplementedError maps to 501, not 500", async () => {
  // P0-D: the retired settlement record_payment action must be a 501 whose
  // message reaches the client, never a generic 500 that hides intent.
  const resp = handleErrorResponse(
    new NotImplementedError("record_payment retired", { action: "x" }),
    CID,
  );
  assertEquals(resp.status, 501);
  const body = await readJson(resp);
  const error = body.error as {
    code: string;
    message: string;
    retryable: boolean;
  };
  assertEquals(error.code, "NOT_IMPLEMENTED");
  assertEquals(error.retryable, false);
  assertStringIncludes(error.message, "record_payment retired");
});

Deno.test("named error builders return their documented statuses", () => {
  assertEquals(unauthorizedResponse(CID).status, 401);
  assertEquals(forbiddenResponse(CID).status, 403);
  assertEquals(conflictResponse("BOOKING_DUPLICATE", "dup", CID).status, 409);
  assertEquals(internalErrorResponse(CID).status, 500);
  assertEquals(
    validationErrorResponse("bad", { f: ["x"] }, CID).status,
    422,
  );
});

Deno.test("rateLimitResponse sets Retry-After header", () => {
  const resp = rateLimitResponse(42, CID);
  assertEquals(resp.status, 429);
  assertEquals(resp.headers.get("Retry-After"), "42");
});

Deno.test("responses keep the shared CORS headers and fail closed on origin", () => {
  const resp = successResponse({}, CID);
  // No Origin header on the request → the response must NOT advertise an
  // allowed origin (it used to echo the first ALLOWED_ORIGINS entry).
  assertEquals(resp.headers.get("Access-Control-Allow-Origin"), null);
  assertEquals(resp.headers.get("Vary"), "Origin");
  assertStringIncludes(
    resp.headers.get("Access-Control-Allow-Headers") ?? "",
    "Idempotency-Key",
  );
});
