/**
 * response.ts — Standardized API response builders
 *
 * Every response includes:
 *   - success: boolean
 *   - correlationId: for log tracing
 *   - timestamp: ISO 8601
 *   - data | error block depending on outcome
 */

import { buildCorsHeaders } from "./cors.ts";
import { isSeturError, type SeturError } from "./errors.ts";

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  correlationId: string;
  timestamp: string;
  meta?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    fieldErrors?: Record<string, string[]>;
    retryable: boolean;
  };
  correlationId: string;
  timestamp: string;
}

function json<T>(body: T, status: number, req?: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...buildCorsHeaders(req?.headers.get("Origin") ?? null),
    },
  });
}

export function successResponse<T>(
  data: T,
  correlationId: string,
  req?: Request,
  meta?: Record<string, unknown>,
  status = 200,
): Response {
  const body: ApiSuccessResponse<T> = {
    success: true,
    data,
    correlationId,
    timestamp: new Date().toISOString(),
    ...(meta ? { meta } : {}),
  };
  return json(body, status, req);
}

export function createdResponse<T>(
  data: T,
  correlationId: string,
  req?: Request,
): Response {
  return successResponse(data, correlationId, req, undefined, 201);
}

export function errorResponse(
  code: string,
  message: string,
  statusCode: number,
  correlationId: string,
  req?: Request,
  extra?: {
    fieldErrors?: Record<string, string[]>;
    retryable?: boolean;
  },
): Response {
  const body: ApiErrorResponse = {
    success: false,
    error: {
      code,
      message,
      retryable: extra?.retryable ?? false,
      ...(extra?.fieldErrors ? { fieldErrors: extra.fieldErrors } : {}),
    },
    correlationId,
    timestamp: new Date().toISOString(),
  };
  return json(body, statusCode, req);
}

export function fromSeturError(
  err: SeturError,
  correlationId: string,
  req?: Request,
): Response {
  return errorResponse(
    err.code,
    err.message,
    err.statusCode,
    correlationId,
    req,
    {
      retryable: err.retryable,
      fieldErrors: "fieldErrors" in err
        ? (err as { fieldErrors: Record<string, string[]> }).fieldErrors
        : undefined,
    },
  );
}

export function unauthorizedResponse(
  correlationId: string,
  req?: Request,
): Response {
  return errorResponse(
    "UNAUTHORIZED",
    "Authentication required",
    401,
    correlationId,
    req,
  );
}

export function forbiddenResponse(
  correlationId: string,
  req?: Request,
): Response {
  return errorResponse("FORBIDDEN", "Access denied", 403, correlationId, req);
}

export function validationErrorResponse(
  message: string,
  fieldErrors: Record<string, string[]>,
  correlationId: string,
  req?: Request,
): Response {
  return errorResponse("VALIDATION_ERROR", message, 422, correlationId, req, {
    fieldErrors,
  });
}

export function conflictResponse(
  code: string,
  message: string,
  correlationId: string,
  req?: Request,
): Response {
  return errorResponse(code, message, 409, correlationId, req);
}

export function rateLimitResponse(
  retryAfterSeconds: number,
  correlationId: string,
  req?: Request,
): Response {
  const body: ApiErrorResponse = {
    success: false,
    error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests",
      retryable: true,
    },
    correlationId,
    timestamp: new Date().toISOString(),
  };
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfterSeconds),
      ...buildCorsHeaders(req?.headers.get("Origin") ?? null),
    },
  });
}

export function internalErrorResponse(
  correlationId: string,
  req?: Request,
): Response {
  return errorResponse(
    "INTERNAL_ERROR",
    "An unexpected error occurred",
    500,
    correlationId,
    req,
  );
}

/**
 * Converts any thrown error into a Response.
 * Use in the outermost catch block of every handler.
 */
export function handleErrorResponse(
  err: unknown,
  correlationId: string,
  req?: Request,
): Response {
  if (isSeturError(err)) {
    return fromSeturError(err, correlationId, req);
  }
  return internalErrorResponse(correlationId, req);
}
