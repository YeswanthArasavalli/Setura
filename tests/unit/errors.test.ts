/**
 * tests/unit/errors.test.ts — Smoke tests for the typed error hierarchy.
 * Pure module: no env bootstrap needed (errors.ts reads no env vars).
 */

import {
  assertEquals,
  assertInstanceOf,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  ConcurrencyError,
  DbError,
  HospitalClosedError,
  IdempotencyKeyRequiredError,
  IdempotencyProcessingError,
  InternalError,
  isRetryable,
  isSeturError,
  QueueFullError,
  RateLimitError,
  RoleInsufficientError,
  SeturError,
  UnauthorizedError,
  ValidationError,
} from "../../supabase/functions/_shared/errors.ts";

Deno.test("SeturError carries code, status, retryable, context, timestamp", () => {
  const err = new SeturError("boom", "INTERNAL_ERROR", 500, true, {
    requestId: "r-1",
  });
  assertEquals(err.code, "INTERNAL_ERROR");
  assertEquals(err.statusCode, 500);
  assertEquals(err.retryable, true);
  assertEquals(err.context.requestId, "r-1");
  assertMatch(err.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assertEquals(err.name, "SeturError");
});

Deno.test("SeturError.toJSON serializes all fields", () => {
  const err = new UnauthorizedError();
  const json = err.toJSON();
  assertEquals(json.code, "UNAUTHORIZED");
  assertEquals(json.statusCode, 401);
  assertEquals(json.retryable, false);
  assertEquals(json.name, "UnauthorizedError");
  assertEquals(typeof json.timestamp, "string");
});

Deno.test("UnauthorizedError defaults: 401, non-retryable", () => {
  const err = new UnauthorizedError();
  assertEquals(err.statusCode, 401);
  assertEquals(err.retryable, false);
  assertEquals(err.message, "Authentication required");
});

Deno.test("RoleInsufficientError formats required vs actual", () => {
  const err = new RoleInsufficientError(["doctor", "hospital_admin"], null);
  assertEquals(err.statusCode, 403);
  assertEquals(err.code, "ROLE_INSUFFICIENT");
  assertEquals(
    err.message,
    "Role insufficient. Required: doctor or hospital_admin, actual: none",
  );
  assertEquals(err.context.required, ["doctor", "hospital_admin"]);
});

Deno.test("ValidationError is 422 and carries field errors", () => {
  const err = new ValidationError("Validation failed", {
    patientPhone: ["Must be a valid 10-digit Indian mobile number"],
  });
  assertEquals(err.statusCode, 422);
  assertEquals(err.code, "VALIDATION_ERROR");
  assertEquals(
    err.fieldErrors.patientPhone,
    ["Must be a valid 10-digit Indian mobile number"],
  );
});

Deno.test("Idempotency errors: 400 required, 202 processing (retryable)", () => {
  const required = new IdempotencyKeyRequiredError();
  assertEquals(required.statusCode, 400);
  assertEquals(required.retryable, false);

  const processing = new IdempotencyProcessingError("key-1");
  assertEquals(processing.statusCode, 202);
  assertEquals(processing.retryable, true);
  assertEquals(processing.context.key, "key-1");
});

Deno.test("RateLimitError is 429, retryable, carries retry-after", () => {
  const err = new RateLimitError(30, { ip: "1.2.3.4" });
  assertEquals(err.statusCode, 429);
  assertEquals(err.retryable, true);
  assertEquals(err.context.retryAfterSeconds, 30);
  assertEquals(err.context.ip, "1.2.3.4");
});

Deno.test("ConcurrencyError is 409 and retryable", () => {
  const err = new ConcurrencyError("row was updated concurrently");
  assertEquals(err.statusCode, 409);
  assertEquals(err.retryable, true);
  assertEquals(err.code, "DB_CONCURRENCY_ERROR");
});

Deno.test("Booking-domain errors carry structured context", () => {
  const closed = new HospitalClosedError("h-1", "Sunday closed");
  assertEquals(closed.statusCode, 422);
  assertEquals(closed.context, { hospitalId: "h-1", reason: "Sunday closed" });

  const full = new QueueFullError("h-1", "s-1", 100);
  assertEquals(full.code, "QUEUE_FULL");
  assertEquals(full.context.maxTokens, 100);
});

Deno.test("DbError and InternalError are 500, non-retryable", () => {
  assertEquals(new DbError("x").statusCode, 500);
  assertEquals(new DbError("x").retryable, false);
  assertEquals(new InternalError().statusCode, 500);
  assertEquals(new InternalError().code, "INTERNAL_ERROR");
});

Deno.test("isSeturError / isRetryable type guards", () => {
  const retryable = new RateLimitError(10);
  const fatal = new ValidationError("bad");
  const plain = new Error("plain");

  assertEquals(isSeturError(retryable), true);
  assertEquals(isSeturError(plain), false);
  assertEquals(isSeturError(null), false);

  assertEquals(isRetryable(retryable), true);
  assertEquals(isRetryable(fatal), false);
  assertEquals(isRetryable(plain), false);
});

Deno.test("all errors inherit from SeturError and Error", () => {
  const samples = [
    new UnauthorizedError(),
    new ValidationError("x"),
    new RateLimitError(1),
    new DbError("x"),
    new InternalError(),
  ];
  for (const err of samples) {
    assertInstanceOf(err, SeturError);
    assertInstanceOf(err, Error);
  }
});
