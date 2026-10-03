import { callFunction } from "@/lib/api";
import type {
  CancellationPolicyReadResponseBody,
  CancellationPolicyUpdateResponseBody,
} from "@/types/api";

/**
 * Boundary over the WS-CONF-1 `cancellation-policy` Edge Function - the ONLY
 * path an authorized operator uses to read or write a hospital's cancellation /
 * refund policy from the SETURA UI.
 *
 * The browser supplies ONLY the field-level patch the backend `Schema` reads.
 * Every absent optional field is OMITTED (never coerced to "" / 0 / null) so the
 * RPC leaves the existing column untouched. The frontend owns NONE of the write
 * path: role authorization, tenant cross-check, atomicity, the optimistic
 * expected-version concurrency check, policy versioning (via the existing
 * `trg_cancel_policy_history` trigger) and audit all live behind the
 * service-role SECURITY DEFINER RPCs added by migration 72.
 *
 * This surface only CONFIGURES the operator's own refund-policy inputs. It never
 * computes a refund: the canonical `calculate_refund_amount` engine remains the
 * sole consumer of these values.
 */

/** Field-level editable subset of `cancellation_policies`. Mirrors the RPC
 *  allowlist; the RPC remains authoritative. `id`, `hospital_id`, `version`,
 *  `effective_from`, `created_at`, `updated_at` and `metadata` are
 *  system-managed and NEVER present here. */
export interface CancellationPolicyPatch {
  full_refund_within_minutes?: number;
  partial_refund_within_minutes?: number;
  partial_refund_percentage?: number;
  same_day_refund_percentage?: number;
  no_show_penalty_enabled?: boolean;
  no_show_penalty_amount_inr?: number;
  allow_manual_full_refund?: boolean;
  notes?: string;
}

/** POST /functions/v1/cancellation-policy with `mode: "read"`. No
 *  Idempotency-Key is required for a read. */
export function getCancellationPolicy(
  hospitalId: string,
): Promise<CancellationPolicyReadResponseBody> {
  return callFunction<CancellationPolicyReadResponseBody>(
    "cancellation-policy",
    { mode: "read" },
    { hospitalId },
  );
}

/** POST /functions/v1/cancellation-policy with `mode: "update"`. The
 *  `idempotencyKey` is REQUIRED (backend `extractIdempotencyKey(req, true)`); a
 *  retry of the same key replays the stored result rather than re-running the
 *  RPC. `expectedVersion` is the version the caller last read; a mismatch is a
 *  server-side 409 the UI resolves by reloading. */
export function updateCancellationPolicy(
  hospitalId: string,
  idempotencyKey: string,
  input: {
    expectedVersion: number;
    patch?: CancellationPolicyPatch;
  },
): Promise<CancellationPolicyUpdateResponseBody> {
  return callFunction<CancellationPolicyUpdateResponseBody>(
    "cancellation-policy",
    {
      mode: "update",
      expectedVersion: input.expectedVersion,
      ...(input.patch ? { patch: input.patch } : {}),
    },
    { hospitalId, idempotencyKey },
  );
}
