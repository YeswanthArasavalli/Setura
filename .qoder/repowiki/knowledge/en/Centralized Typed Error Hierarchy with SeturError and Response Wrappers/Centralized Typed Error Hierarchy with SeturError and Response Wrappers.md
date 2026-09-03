---
kind: error_handling
name: Centralized Typed Error Hierarchy with SeturError and Response Wrappers
category: error_handling
scope:
  - "**"
source_files:
  - supabase/functions/_shared/errors.ts
  - supabase/functions/_shared/response.ts
  - supabase/functions/_shared/auth.ts
  - supabase/functions/_shared/validation.ts
  - supabase/functions/_shared/idempotency.ts
  - supabase/functions/_shared/rate_limit.ts
  - supabase/functions/_shared/db.ts
  - supabase/functions/_shared/worker.ts
  - supabase/functions/create-booking/index.ts
  - tests/unit/errors.test.ts
---

## System Overview

The repository implements a centralized, typed error-handling system built
around a single base class `SeturError` in
`supabase/functions/_shared/errors.ts`. Every domain error extends this base
class and carries a machine-readable `code`, an HTTP `statusCode`, a `retryable`
flag, structured `context` metadata, and an ISO timestamp. A parallel response
layer in `response.ts` converts these errors into standardized JSON API
responses.

## Core Architecture

### Error Types (`errors.ts`)

- **Base class**: `SeturError` — all custom errors inherit from it; provides
  `toJSON()` for structured logging and exposes `code`, `statusCode`,
  `retryable`, `context`, `timestamp`.
- **Typed error codes**: A union type `ErrorCode` enumerates every allowed code
  across domains: Auth (`UNAUTHORIZED`, `FORBIDDEN`, `INVALID_JWT`,
  `SESSION_EXPIRED`, `HOSPITAL_ACCESS_DENIED`, `ROLE_INSUFFICIENT`), Validation
  (`VALIDATION_ERROR`, `INVALID_PHONE`, `INVALID_UUID`, `INVALID_DATE`,
  `MISSING_FIELD`, `BODY_TOO_LARGE`), Booking (`BOOKING_DUPLICATE`,
  `BOOKING_NOT_FOUND`, `TOKEN_EXHAUSTED`, `QUEUE_FULL`, `HOSPITAL_CLOSED`,
  `HOSPITAL_HOLIDAY`, `ADVANCE_BOOKING_EXCEEDED`, `DOCTOR_UNAVAILABLE`,
  `PATIENT_BLOCKED`), Idempotency (`IDEMPOTENCY_KEY_REQUIRED`,
  `IDEMPOTENCY_PROCESSING`, `IDEMPOTENCY_MISMATCH`), Rate Limit
  (`RATE_LIMIT_EXCEEDED`, `IP_RATE_LIMIT_EXCEEDED`), Queue/Workers
  (`JOB_CLAIM_FAILED`, `WORKER_LEASE_LOST`, `QUEUE_CONCURRENCY_ERROR`), Payment
  (`PAYMENT_FAILED`, `PAYMENT_NOT_FOUND`, `REFUND_EXCEEDS_AMOUNT`), Database
  (`DB_ERROR`, `DB_CONSTRAINT_VIOLATION`, `DB_TIMEOUT`, `DB_CONCURRENCY_ERROR`),
  External Services (`WHATSAPP_SEND_FAILED`, `WHATSAPP_RATE_LIMITED`), Server
  (`INTERNAL_ERROR`, `NOT_IMPLEMENTED`, `SERVICE_UNAVAILABLE`).
- **Domain subclasses**: One class per error (e.g. `UnauthorizedError`,
  `ValidationError`, `HospitalClosedError`, `QueueFullError`,
  `TokenExhaustedError`, `DoctorUnavailableError`, `PatientBlockedError`,
  `IdempotencyKeyRequiredError`, `IdempotencyProcessingError`, `RateLimitError`,
  `ConcurrencyError`, `DbError`, `InternalError`). Each constructor hardcodes
  the appropriate `statusCode` and `retryable` value.
- **Type guards**: `isSeturError(err)` and `isRetryable(err)` helpers for
  runtime discrimination.

### Response Layer (`response.ts`)

- Standardized success/error shapes: `ApiSuccessResponse<T>` and
  `ApiErrorResponse` both include `success`, `correlationId`, `timestamp`, plus
  `data` or `error` blocks.
- Builders: `successResponse()`, `createdResponse()`,
  `validationErrorResponse()`, `conflictResponse()`, `rateLimitResponse()`,
  `unauthorizedResponse()`, `forbiddenResponse()`, `internalErrorResponse()`.
- Conversion: `fromSeturError()` maps a `SeturError` to an `ApiErrorResponse`,
  preserving `fieldErrors` when present on the error instance.
- Catch-all: `handleErrorResponse(err, correlationId, req)` is the single entry
  point used by handlers — if the thrown value is a `SeturError` it returns the
  mapped response; otherwise it returns a generic `INTERNAL_ERROR` 500.

### Middleware Integration (`auth.ts`)

- `withAuth(handler, opts)` wraps each handler: performs CORS preflight,
  resolves auth via `resolveAuth()` (which throws `UnauthorizedError`,
  `HospitalAccessDeniedError`, `RoleInsufficientError`), enforces required roles
  via `requireRole()`, then calls the inner handler.
- All exceptions inside the wrapped handler are caught and converted via
  `handleErrorResponse()` — no handler needs its own try/catch for auth
  failures.

### Handler Pattern (example: `create-booking/index.ts`)

- Handlers import specific error classes from `_shared/errors.ts` and throw them
  at the appropriate validation/boundary points (e.g. `ValidationError` for
  missing headers, `HospitalClosedError` for closed hospitals,
  `DoctorUnavailableError` for unavailable doctors, `QueueFullError` for full
  queues, `InternalError` for unexpected DB failures).
- The outermost `try/catch` delegates to
  `handleErrorResponse(err, trace.correlationId, req)`, which centralizes
  response formatting.
- Non-fatal side effects (audit logging, WhatsApp enqueue) swallow errors so
  they never bubble up as request failures.

### Worker Job Processing (`worker.ts`)

- `processJob(job, workerId, processor, logger)` wraps job execution: on success
  calls `completeJob()`, on any exception logs via `jobLogger.error()` and calls
  `failJob()` (which handles backoff + dead-letter internally). This isolates
  background jobs from HTTP error handling.
- Heartbeat loop catches and logs crashes without crashing the process.

## Conventions Observed

1. **Throw typed errors, never raw strings** — documented in `auth.ts`: "All
   auth failures return typed errors, never throw raw strings." Business logic
   throws domain-specific `SeturError` subclasses.
2. **Status codes are baked into constructors** — e.g. `UnauthorizedError`
   always maps to 401, `ValidationError` to 422, `RateLimitError` to 429,
   `DbError`/`InternalError` to 500. Handlers do not set status codes manually.
3. **Retryability is explicit** — only transient errors set `retryable: true`
   (e.g. `IdempotencyProcessingError` → 202, `RateLimitError` → 429,
   `ConcurrencyError` → 409). Client retry logic can use `isRetryable()`.
4. **Structured context over messages** — errors carry `context` objects with
   machine-readable fields (e.g. `{ hospitalId, reason }`, `{ fieldErrors }`,
   `{ retryAfterSeconds }`) instead of embedding details in the message string.
5. **Single catch point per handler** — `handleErrorResponse` is called once at
   the top level; intermediate layers propagate errors upward rather than
   converting them locally.
6. **Non-fatal side effects swallow errors** — audit logging and notification
   enqueues use `.catch(() => {})` so they cannot fail the primary operation.
7. **Database RPC errors are wrapped** — `db.ts` wraps Supabase RPC failures
   into `DbError` with the original message preserved in context.
8. **No `throw new Error('string')` anywhere in business paths** — all
   user-facing failures go through the typed hierarchy.

## Key Files

- `supabase/functions/_shared/errors.ts` — error hierarchy, `ErrorCode` union,
  type guards
- `supabase/functions/_shared/response.ts` — response builders,
  `handleErrorResponse`, `fromSeturError`
- `supabase/functions/_shared/auth.ts` — `withAuth` middleware that centralizes
  auth error propagation
- `supabase/functions/_shared/validation.ts` — throws `ValidationError` for
  malformed input
- `supabase/functions/_shared/idempotency.ts` — throws idempotency-related
  `SeturError` subclasses
- `supabase/functions/_shared/rate_limit.ts` — throws `RateLimitError`
- `supabase/functions/_shared/db.ts` — wraps DB errors into `DbError`
- `supabase/functions/_shared/worker.ts` — background job error handling via
  `processJob`/`failJob`
- `supabase/functions/create-booking/index.ts` — representative handler
  demonstrating the throw + `handleErrorResponse` pattern
- `tests/unit/errors.test.ts` — unit tests asserting error shape, status codes,
  retryability, and type guard behavior
