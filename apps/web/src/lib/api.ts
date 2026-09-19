import { supabase } from "./supabase";
import { ApiError } from "./errors";
import type { ApiEnvelope } from "@/types/api";

const BASE_URL = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export interface CallOptions {
  /** Required tenant context. Sent as X-Hospital-ID (backend header). */
  hospitalId: string;
  /** Optional Idempotency-Key for mutations (backend enforces the final guard). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/**
 * Invoke an existing SETURA Edge Function by name.
 *
 * This is the ONLY way the console reaches privileged backend logic
 * (Phase 6 §1/§24): the browser sends the user's JWT + apikey + the resolved
 * X-Hospital-ID, and the Edge Function re-authorizes role + tenant server
 * side before touching any RPC. The client trusts nothing it sends — the
 * backend is authoritative.
 */
export async function callFunction<T>(
  fnName: string,
  body: unknown,
  opts: CallOptions,
): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;

  if (!token) {
    throw new ApiError({
      code: "UNAUTHORIZED",
      message: "Not authenticated",
      status: 401,
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: ANON_KEY,
    Authorization: `Bearer ${token}`,
    "X-Hospital-ID": opts.hospitalId,
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/functions/v1/${fnName}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch {
    // Network/abort: status 0 => "network" kind.
    throw new ApiError({
      code: "NETWORK",
      message: "Network request failed",
      status: 0,
      retryable: true,
    });
  }

  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await res.json()) as ApiEnvelope<T>;
  } catch {
    throw new ApiError({
      code: "INVALID_RESPONSE",
      message: `Unexpected response from ${fnName}`,
      status: res.status || 500,
    });
  }

  if (envelope.success === true) {
    return envelope.data;
  }

  throw new ApiError({
    code: envelope.error.code,
    message: envelope.error.message,
    status: res.status,
    fieldErrors: envelope.error.fieldErrors,
    retryable: envelope.error.retryable,
    correlationId: envelope.correlationId,
  });
}
