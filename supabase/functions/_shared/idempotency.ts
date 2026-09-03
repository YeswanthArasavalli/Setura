/**
 * idempotency.ts — API idempotency key management
 *
 * Integrates with Script 25 (api_idempotency_keys table).
 *
 * Flow:
 *   1. Extract Idempotency-Key header (UUID v4 from client)
 *   2. call claim() — atomically registers the key or returns existing state
 *   3. If is_new=false and status=completed → return cached response
 *   4. If is_new=false and status=processing → return 202
 *   5. If is_new=true → run handler → call complete() or fail()
 *
 * Security:
 *   - Keys are scoped to (endpoint, user_id) — different users cannot
 *     share idempotency keys
 *   - Body hash detects same-key-different-payload misuse
 *   - Keys expire after 24 hours
 */

import { getServiceClient } from "./db.ts";
import {
  IdempotencyKeyRequiredError,
  IdempotencyProcessingError,
} from "./errors.ts";
import type { Logger } from "./logger.ts";
import type { Json } from "./types.ts";

export interface IdempotencyState {
  isNew: boolean;
  keyId?: string;
  status: "processing" | "completed" | "failed" | "expired";
  responseStatusCode?: number;
  responseBody?: unknown;
  mismatchDetected?: boolean;
}

// ─── Extract and validate Idempotency-Key header ──────────────────────────────

export function extractIdempotencyKey(
  req: Request,
  required = true,
): string | null {
  const key = req.headers.get("Idempotency-Key");

  if (!key && required) {
    throw new IdempotencyKeyRequiredError();
  }

  if (key) {
    // Must be UUID v4
    const uuidV4Pattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidV4Pattern.test(key)) {
      throw new IdempotencyKeyRequiredError();
    }
  }

  return key;
}

// ─── Compute request hash (for mismatch detection) ────────────────────────────

export async function computeRequestHash(body: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── Claim idempotency key ────────────────────────────────────────────────────

/**
 * Atomically claims an idempotency key.
 * If the key already exists:
 *   - status=completed → caller should return cached response
 *   - status=processing → caller should return 202
 *   - status=failed → caller may retry with a new key or re-run
 */
export async function claimIdempotencyKey(
  key: string,
  endpoint: string,
  userId: string,
  hospitalId: string | null,
  requestHash: string,
  requestSummary: Record<string, unknown>,
  instanceId: string,
  logger: Logger,
): Promise<IdempotencyState> {
  const db = getServiceClient();

  const { data, error } = await db.rpc("claim_idempotency_key", {
    p_key: key,
    p_endpoint: endpoint,
    p_user_id: userId,
    p_hospital_id: hospitalId ?? undefined,
    p_request_hash: requestHash,
    p_request_summary: requestSummary as unknown as Json,
    p_instance_id: instanceId,
  });

  if (error) {
    logger.error("Failed to claim idempotency key", error, { key, endpoint });
    // Fail open: allow the request to proceed rather than blocking on infra error
    return { isNew: true, status: "processing" };
  }

  // The RPC returns snake_case rows; map to the camelCase DTO.
  const r = (data ?? [])[0];
  if (!r) {
    return { isNew: true, status: "processing" };
  }

  const row: IdempotencyState = {
    isNew: r.is_new,
    status: r.status,
    responseStatusCode: r.response_status_code ?? undefined,
    responseBody: r.response_body ?? undefined,
    mismatchDetected: r.mismatch_detected,
  };

  logger.debug("Idempotency key claimed", {
    key,
    isNew: row.isNew,
    status: row.status,
    mismatch: row.mismatchDetected,
  });

  return row;
}

// ─── Complete idempotency key ─────────────────────────────────────────────────

export async function completeIdempotencyKey(
  key: string,
  endpoint: string,
  responseStatusCode: number,
  responseBody: unknown,
  logger: Logger,
): Promise<void> {
  const db = getServiceClient();

  const { error } = await db.rpc("complete_idempotency_key", {
    p_key: key,
    p_endpoint: endpoint,
    p_response_code: responseStatusCode,
    p_response_body: responseBody as unknown as Json,
  });

  if (error) {
    // Non-fatal: log and continue — the request already succeeded
    logger.warn("Failed to complete idempotency key", {
      key,
      error: error.message,
    });
  }
}

// ─── Fail idempotency key ─────────────────────────────────────────────────────

export async function failIdempotencyKey(
  key: string,
  endpoint: string,
  errorCode: string,
  errorMessage: string,
  logger: Logger,
): Promise<void> {
  const db = getServiceClient();

  const { error } = await db.rpc("fail_idempotency_key", {
    p_key: key,
    p_endpoint: endpoint,
    p_error_code: errorCode,
    p_error_message: errorMessage,
  });

  if (error) {
    logger.warn("Failed to mark idempotency key as failed", {
      key,
      error: error.message,
    });
  }
}

// ─── Handler wrapper ──────────────────────────────────────────────────────────

/**
 * Wraps an async handler with idempotency enforcement.
 *
 * If the request was already processed:
 *   - Returns the cached response (status + body) immediately
 * If another instance is processing:
 *   - Returns 202 with Retry-After header
 * Otherwise:
 *   - Runs the handler, stores the result
 */
export async function withIdempotency<T>(
  key: string,
  endpoint: string,
  userId: string,
  hospitalId: string | null,
  requestBody: unknown,
  instanceId: string,
  logger: Logger,
  handler: () => Promise<{ statusCode: number; body: T }>,
): Promise<{ statusCode: number; body: T; wasDuplicate: boolean }> {
  const requestHash = await computeRequestHash(requestBody);

  const state = await claimIdempotencyKey(
    key,
    endpoint,
    userId,
    hospitalId,
    requestHash,
    typeof requestBody === "object" && requestBody !== null
      ? (requestBody as Record<string, unknown>)
      : {},
    instanceId,
    logger,
  );

  // Return cached response if already completed
  if (
    !state.isNew && state.status === "completed" &&
    state.responseBody !== undefined
  ) {
    logger.info("Idempotent replay", { key, endpoint });
    return {
      statusCode: state.responseStatusCode ?? 200,
      body: state.responseBody as T,
      wasDuplicate: true,
    };
  }

  // Another instance is processing — tell client to retry
  if (!state.isNew && state.status === "processing") {
    throw new IdempotencyProcessingError(key);
  }

  // Run the handler
  try {
    const result = await handler();
    await completeIdempotencyKey(
      key,
      endpoint,
      result.statusCode,
      result.body,
      logger,
    );
    return { ...result, wasDuplicate: false };
  } catch (err) {
    const errorCode = err instanceof Error && "code" in err
      ? String((err as { code: unknown }).code)
      : "HANDLER_ERROR";
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    await failIdempotencyKey(key, endpoint, errorCode, errorMessage, logger);
    throw err;
  }
}
