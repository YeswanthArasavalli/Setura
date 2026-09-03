/**
 * errors.ts — Centralized typed error hierarchy
 *
 * All domain errors extend SeturError, which carries:
 *   - code: machine-readable error identifier
 *   - statusCode: HTTP status to respond with
 *   - retryable: whether the caller should retry
 *   - context: arbitrary metadata for logging
 *
 * Errors are serializable to JSON for structured logging.
 */

export type ErrorCode =
  // Auth
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INVALID_JWT"
  | "SESSION_EXPIRED"
  | "HOSPITAL_ACCESS_DENIED"
  | "ROLE_INSUFFICIENT"
  // Validation
  | "VALIDATION_ERROR"
  | "INVALID_PHONE"
  | "INVALID_UUID"
  | "INVALID_DATE"
  | "MISSING_FIELD"
  | "BODY_TOO_LARGE"
  // Booking
  | "BOOKING_DUPLICATE"
  | "BOOKING_NOT_FOUND"
  | "TOKEN_EXHAUSTED"
  | "QUEUE_FULL"
  | "HOSPITAL_CLOSED"
  | "HOSPITAL_HOLIDAY"
  | "ADVANCE_BOOKING_EXCEEDED"
  | "DOCTOR_UNAVAILABLE"
  | "PATIENT_BLOCKED"
  // Idempotency
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_PROCESSING"
  | "IDEMPOTENCY_MISMATCH"
  // Rate limit
  | "RATE_LIMIT_EXCEEDED"
  | "IP_RATE_LIMIT_EXCEEDED"
  // Queue / workers
  | "JOB_CLAIM_FAILED"
  | "WORKER_LEASE_LOST"
  | "QUEUE_CONCURRENCY_ERROR"
  // Payment
  | "PAYMENT_FAILED"
  | "PAYMENT_NOT_FOUND"
  | "REFUND_EXCEEDS_AMOUNT"
  // Database
  | "DB_ERROR"
  | "DB_CONSTRAINT_VIOLATION"
  | "DB_TIMEOUT"
  | "DB_CONCURRENCY_ERROR"
  // External services
  | "WHATSAPP_SEND_FAILED"
  | "WHATSAPP_RATE_LIMITED"
  // Server
  | "INTERNAL_ERROR"
  | "NOT_IMPLEMENTED"
  | "SERVICE_UNAVAILABLE";

export interface ErrorContext {
  [key: string]: unknown;
}

export class SeturError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly context: ErrorContext;
  public readonly timestamp: string;

  constructor(
    message: string,
    code: ErrorCode,
    statusCode: number,
    retryable = false,
    context: ErrorContext = {},
  ) {
    super(message);
    this.name = "SeturError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.context = context;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      retryable: this.retryable,
      context: this.context,
      timestamp: this.timestamp,
    };
  }
}

// ─── Auth errors ─────────────────────────────────────────────────────────────

export class UnauthorizedError extends SeturError {
  constructor(message = "Authentication required", context: ErrorContext = {}) {
    super(message, "UNAUTHORIZED", 401, false, context);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends SeturError {
  constructor(message = "Access forbidden", context: ErrorContext = {}) {
    super(message, "FORBIDDEN", 403, false, context);
    this.name = "ForbiddenError";
  }
}

export class HospitalAccessDeniedError extends SeturError {
  constructor(hospitalId: string) {
    super(
      `Access denied to hospital ${hospitalId}`,
      "HOSPITAL_ACCESS_DENIED",
      403,
      false,
      {
        hospitalId,
      },
    );
    this.name = "HospitalAccessDeniedError";
  }
}

export class RoleInsufficientError extends SeturError {
  constructor(required: string[], actual: string | null) {
    super(
      `Role insufficient. Required: ${required.join(" or ")}, actual: ${
        actual ?? "none"
      }`,
      "ROLE_INSUFFICIENT",
      403,
      false,
      { required, actual },
    );
    this.name = "RoleInsufficientError";
  }
}

// ─── Validation errors ───────────────────────────────────────────────────────

export class ValidationError extends SeturError {
  public readonly fieldErrors: Record<string, string[]>;

  constructor(message: string, fieldErrors: Record<string, string[]> = {}) {
    super(message, "VALIDATION_ERROR", 422, false, { fieldErrors });
    this.name = "ValidationError";
    this.fieldErrors = fieldErrors;
  }
}

// ─── Booking errors ──────────────────────────────────────────────────────────

export class BookingDuplicateError extends SeturError {
  constructor(idempotencyKey: string, existingBookingId: string) {
    super(
      "Booking already exists for this request",
      "BOOKING_DUPLICATE",
      409,
      false,
      {
        idempotencyKey,
        existingBookingId,
      },
    );
    this.name = "BookingDuplicateError";
  }
}

export class HospitalClosedError extends SeturError {
  constructor(hospitalId: string, reason: string) {
    super(`Hospital is closed: ${reason}`, "HOSPITAL_CLOSED", 422, false, {
      hospitalId,
      reason,
    });
    this.name = "HospitalClosedError";
  }
}

export class QueueFullError extends SeturError {
  constructor(hospitalId: string, sessionId: string, maxTokens: number) {
    super(`Queue is full (max ${maxTokens} tokens)`, "QUEUE_FULL", 422, false, {
      hospitalId,
      sessionId,
      maxTokens,
    });
    this.name = "QueueFullError";
  }
}

export class TokenExhaustedError extends SeturError {
  constructor(hospitalId: string, date: string) {
    super(
      "No more tokens available for this date",
      "TOKEN_EXHAUSTED",
      422,
      false,
      {
        hospitalId,
        date,
      },
    );
    this.name = "TokenExhaustedError";
  }
}

export class DoctorUnavailableError extends SeturError {
  constructor(doctorId: string, date: string, reason: string) {
    super(`Doctor unavailable: ${reason}`, "DOCTOR_UNAVAILABLE", 422, false, {
      doctorId,
      date,
      reason,
    });
    this.name = "DoctorUnavailableError";
  }
}

export class PatientBlockedError extends SeturError {
  constructor(phone: string) {
    super(
      "This phone number has been temporarily restricted",
      "PATIENT_BLOCKED",
      422,
      false,
      {
        phone,
      },
    );
    this.name = "PatientBlockedError";
  }
}

// ─── Idempotency errors ──────────────────────────────────────────────────────

export class IdempotencyKeyRequiredError extends SeturError {
  constructor() {
    super(
      "Idempotency-Key header is required for this endpoint",
      "IDEMPOTENCY_KEY_REQUIRED",
      400,
      false,
    );
    this.name = "IdempotencyKeyRequiredError";
  }
}

export class IdempotencyProcessingError extends SeturError {
  constructor(key: string) {
    super(
      "A request with this idempotency key is already being processed",
      "IDEMPOTENCY_PROCESSING",
      202,
      true,
      { key },
    );
    this.name = "IdempotencyProcessingError";
  }
}

// ─── Rate limit errors ───────────────────────────────────────────────────────

export class RateLimitError extends SeturError {
  constructor(retryAfterSeconds: number, context: ErrorContext = {}) {
    super("Rate limit exceeded", "RATE_LIMIT_EXCEEDED", 429, true, {
      retryAfterSeconds,
      ...context,
    });
    this.name = "RateLimitError";
  }
}

// ─── Concurrency errors ──────────────────────────────────────────────────────

export class ConcurrencyError extends SeturError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, "DB_CONCURRENCY_ERROR", 409, true, context);
    this.name = "ConcurrencyError";
  }
}

// ─── Database errors ─────────────────────────────────────────────────────────

export class DbError extends SeturError {
  constructor(message: string, context: ErrorContext = {}) {
    super(message, "DB_ERROR", 500, false, context);
    this.name = "DbError";
  }
}

// ─── Internal ────────────────────────────────────────────────────────────────

export class InternalError extends SeturError {
  constructor(
    message = "An unexpected error occurred",
    context: ErrorContext = {},
  ) {
    super(message, "INTERNAL_ERROR", 500, false, context);
    this.name = "InternalError";
  }
}

// ─── Type guard ──────────────────────────────────────────────────────────────

export function isSeturError(err: unknown): err is SeturError {
  return err instanceof SeturError;
}

export function isRetryable(err: unknown): boolean {
  return isSeturError(err) && err.retryable;
}
