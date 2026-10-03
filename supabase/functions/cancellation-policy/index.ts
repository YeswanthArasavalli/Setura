/**
 * cancellation-policy/index.ts
 *
 * WS-CONF-1 - Hospital Cancellation Policy Configuration.
 *
 * The single canonical HTTP surface an authorized operator uses to read and
 * write a hospital's cancellation / refund policy from the SETURA UI, so
 * configuring an existing tenant requires no SQL, no source edit and no
 * environment change. The endpoint is TENANT-SCOPED: the X-Hospital-ID header
 * is resolved by `resolveAuth` exactly like every other hospital-scoped Edge
 * Function; a global_admin supplies the target tenant via that header, and a
 * hospital_admin's own tenant is the only value the backend will accept.
 *
 * Flow (the canonical SETURA shape, per AGENTS.md sec 6):
 *   HTTP -> resolveAuth(req, hospitalId) -> requireRole(['global_admin',
 *   'hospital_admin']) -> validate body ->
 *   (mode==='read'   -> get_cancellation_policy RPC,
 *    mode==='update' -> Idempotency-Key gate -> withIdempotency ->
 *                       update_cancellation_policy RPC) ->
 *   best-effort audit -> server-authoritative response.
 *
 * Authorization is enforced at BOTH boundaries: the Edge layer gates on the
 * resolved JWT role + tenant, and the RPC independently re-checks that the
 * passed actor id genuinely holds global_admin, or holds hospital_admin scoped
 * to the target hospital. A hospital_admin spoofing another tenant's
 * hospital_id is 403 at the RPC (SQLSTATE 42501), never a cross-tenant write.
 *
 * This workstream configures the operator's ALREADY-DEFINED refund-policy
 * inputs; it never computes a refund and never invents business policy (the
 * refund engine `calculate_refund_amount` remains the sole consumer).
 *
 * Concurrency: the RPC uses row-level FOR UPDATE plus an optimistic
 * expected_version check against cancellation_policies.version. A stale client
 * sends the wrong expected_version and the RPC raises SQLSTATE P0001; this Edge
 * layer maps that to HTTP 409 CONFLICT so the UI re-fetches rather than
 * silently losing an update.
 *
 * Idempotency: mutation (mode === 'update') requires an Idempotency-Key header;
 * the existing api_idempotency_keys registry (migration 25) returns the stored
 * result on a replay so the RPC runs at most once and audit fires at most once
 * per key.
 *
 * Audit: one best-effort event through the existing logAuditEvent ->
 * write_audit_log path (no parallel audit primitive). Registered action type:
 * cancellation_policy_update (high). Read mode never audits.
 */

import { handleCors } from "../_shared/cors.ts";
import { requireRole, resolveAuth } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { logAuditEvent } from "../_shared/audit.ts";
import { handleErrorResponse, successResponse } from "../_shared/response.ts";
import {
  ConcurrencyError,
  ForbiddenError,
  InternalError,
  ValidationError,
} from "../_shared/errors.ts";
import {
  extractIdempotencyKey,
  withIdempotency,
} from "../_shared/idempotency.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { parseBody } from "../_shared/validation.ts";

const ENDPOINT = "cancellation-policy";

/** The exact editable field set (mirrors the RPC's allowlist; the RPC remains
 *  authoritative). `id`, `hospital_id`, `version`, `effective_from`,
 *  `created_at`, `updated_at` and `metadata` are system-managed and never
 *  present here. Numeric fields are transmitted as strings over JSON, so the
 *  RPC casts them; the Edge layer only checks shape and range here so a bad
 *  value is 422, not 500. */
const PolicyPatchSchema = z.object({
  full_refund_within_minutes: z.coerce.number().int().min(0).max(10080)
    .optional(),
  partial_refund_within_minutes: z.coerce.number().int().min(0).max(10080)
    .optional(),
  partial_refund_percentage: z.coerce.number().min(0).max(100).optional(),
  same_day_refund_percentage: z.coerce.number().min(0).max(100).optional(),
  no_show_penalty_enabled: z.boolean().optional(),
  no_show_penalty_amount_inr: z.coerce.number().min(0).max(1_000_000)
    .optional(),
  allow_manual_full_refund: z.boolean().optional(),
  notes: z.string().trim().max(2000).optional(),
}).strict();

/** Read body: no idempotency key needed; a read is not a mutation. */
const ReadSchema = z.object({
  mode: z.literal("read"),
}).strict();

/** Update body: the caller MUST supply an expected_version (>= 1: an
 *  auto-created tenant policy row starts at version 1) and a patch. An empty
 *  patch is a valid no-op the RPC handles honestly. */
const UpdateSchema = z.object({
  mode: z.literal("update"),
  expectedVersion: z.number().int().min(1),
  patch: PolicyPatchSchema.optional(),
}).strict();

const BodySchema = z.discriminatedUnion("mode", [ReadSchema, UpdateSchema]);
type Body = z.infer<typeof BodySchema>;

interface PolicyHistoryEntry {
  version: number;
  changed_by: string | null;
  created_at: string;
  snapshot: Record<string, unknown>;
}

interface RpcReadOutcome {
  ok?: boolean;
  hospital_id?: string;
  version?: number;
  policy?: Record<string, unknown>;
  history?: PolicyHistoryEntry[];
}

interface RpcWriteOutcome {
  ok?: boolean;
  reason?: string;
  hospital_id?: string;
  version?: number;
}

interface UpdateResultBody {
  hospitalId: string;
  version: number;
  updated: boolean;
}

/** Map RPC SQLSTATE codes onto the SETURA HTTP error contract. Never leak the
 *  PostgreSQL driver message or SQL to the client. */
function mapRpcError(err: { code?: string; message?: string }): never {
  const code = err.code ?? "";
  if (code === "42501" || code === "P0002") {
    // P0002 means the (authorized-actor-checked) policy row vanished; do not
    // disclose which, treat as forbidden.
    throw new ForbiddenError("Not authorized for this cancellation policy");
  }
  if (code === "P0001") {
    // Optimistic expected-version conflict. The RPC uses SQLSTATE P0001
    // (raise_exception) deliberately rather than 40001 (serialization_failure),
    // because PostgREST treats class-40 codes as retryable and re-issues the
    // transaction. See migration 72 header for the rationale.
    throw new ConcurrencyError(
      "Policy was changed by someone else. Reload and try again.",
      { expectedVersion: true },
    );
  }
  if (code === "22023" || code === "23514" || code === "22P02") {
    throw new ValidationError("Policy rejected", {
      value: [String(err.message ?? "invalid")],
    });
  }
  throw new InternalError("Cancellation policy operation failed", { code });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const trace = createTraceContext(req);
  const logger = createRequestLogger(req, ENDPOINT).child({
    correlationId: trace.correlationId,
  });
  const metrics = createMetrics(ENDPOINT, trace.correlationId);

  try {
    // Tenant-scoped Edge Function: read X-Hospital-ID exactly like every
    // existing hospital-scoped endpoint; resolveAuth verifies the actor is
    // genuinely a member of that tenant (or a global_admin) for the selected
    // roles.
    const headerHospitalId = req.headers.get("X-Hospital-ID");
    if (!headerHospitalId) {
      throw new ValidationError("Missing X-Hospital-ID header", {
        header: ["Required"],
      });
    }

    const auth = await resolveAuth(req, headerHospitalId, logger);

    requireRole(auth, ["global_admin", "hospital_admin"]);

    const body = await parseBody<Body>(req, BodySchema);
    const db = getServiceClient();
    const hospitalId = auth.hospitalId ?? headerHospitalId;
    if (!hospitalId) {
      throw new ForbiddenError("No hospital context resolved");
    }

    if (body.mode === "read") {
      const { data, error } = await db.rpc("get_cancellation_policy", {
        p_actor_user_id: auth.userId,
        p_hospital_id: hospitalId,
      });
      if (error) mapRpcError(error as { code?: string; message?: string });
      const outcome = (data ?? {}) as RpcReadOutcome;
      if (outcome.ok !== true) {
        throw new InternalError("Cancellation policy read returned no data");
      }
      metrics.increment("cancellation_policy.read");
      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);
      return successResponse(
        {
          hospitalId,
          version: outcome.version ?? 0,
          policy: outcome.policy ?? {},
          history: outcome.history ?? [],
        },
        trace.correlationId,
        req,
      );
    }

    // Mutation: Idempotency-Key is mandatory (existing registry).
    const idempotencyKey = extractIdempotencyKey(req, true)!;

    const result = await withIdempotency<UpdateResultBody>(
      idempotencyKey,
      ENDPOINT,
      auth.userId,
      hospitalId,
      body,
      crypto.randomUUID(),
      logger,
      async () => {
        const { data, error } = await db.rpc(
          "update_cancellation_policy",
          {
            p_actor_user_id: auth.userId,
            p_hospital_id: hospitalId,
            p_expected_version: body.expectedVersion,
            p_patch: body.patch ?? {},
          },
        );
        if (error) mapRpcError(error as { code?: string; message?: string });
        const outcome = (data ?? {}) as RpcWriteOutcome;
        if (outcome.ok !== true) {
          throw new InternalError(
            "Cancellation policy update returned no result",
            { reason: outcome.reason ?? "unknown" },
          );
        }

        const updated = outcome.reason === "updated";

        // Best-effort audit inside the idempotency handler so a replay never
        // double-records the event.
        await logAuditEvent(
          {
            hospitalId,
            actorUserId: auth.userId,
            entityType: "cancellation_policy",
            entityId: hospitalId,
            actionType: "cancellation_policy_update",
            severity: "high",
            oldData: { expectedVersion: body.expectedVersion },
            newData: {
              patch: body.patch ?? {},
              version: outcome.version ?? null,
            },
          },
          logger,
          metrics,
        );

        return {
          statusCode: 200,
          body: {
            hospitalId,
            version: outcome.version ?? body.expectedVersion,
            updated,
          },
        };
      },
    );

    metrics.timing("request.total", elapsedMs(trace));
    metrics.increment(
      result.wasDuplicate
        ? "cancellation_policy.replay"
        : "cancellation_policy.update",
    );
    metrics.flush(logger);

    return successResponse(
      result.body,
      trace.correlationId,
      req,
      undefined,
      result.statusCode,
    );
  } catch (err) {
    metrics.increment("cancellation_policy.error");
    logger.error("cancellation-policy failed", err, {
      durationMs: elapsedMs(trace),
    });
    return handleErrorResponse(err, trace.correlationId, req);
  }
});
