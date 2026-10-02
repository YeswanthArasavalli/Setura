/**
 * hospital-configuration/index.ts
 *
 * WS-ONBOARD-2 - Hospital Configuration Write Surfaces.
 *
 * The single canonical HTTP surface an authorized operator uses to read
 * and write a hospital's operational configuration from the SETURA UI,
 * so configuring an existing tenant requires no SQL, no source edit and
 * no environment change. The endpoint is TENANT-SCOPED: the
 * X-Hospital-ID header is resolved by `resolveAuth` exactly like every
 * other hospital-scoped Edge Function; a global_admin supplies the target
 * tenant via that header, and a hospital_admin's own tenant is the only
 * value the backend will accept.
 *
 * Flow (the canonical SETURA shape, per AGENTS.md sec 6):
 *   HTTP -> resolveAuth(req, hospitalId) -> requireRole(['hospital_admin',
 *   'global_admin']) -> tenant cross-check -> validate body ->
 *   (mode==='read'   -> get_hospital_configuration RPC,
 *    mode==='update' -> Idempotency-Key gate -> withIdempotency ->
 *                       update_hospital_configuration RPC) ->
 *   best-effort audit -> server-authoritative response.
 *
 * Authorization is enforced at BOTH boundaries: the Edge layer gates on
 * the resolved JWT role + tenant, and the RPC independently re-checks
 * that the passed actor id genuinely holds global_admin, or holds
 * hospital_admin scoped to the target hospital. A hospital_admin
 * spoofing another tenant's hospital_id is 403 at the RPC (SQLSTATE
 * 42501), never a cross-tenant mutation.
 *
 * Concurrency: the RPC uses row-level FOR UPDATE plus an optimistic
 * expected_version check against config_versions. A stale client sends
 * the wrong expected_version and the RPC raises SQLSTATE 40001; this
 * Edge layer maps that to HTTP 409 CONFIG_VERSION_CONFLICT so the UI
 * re-fetches rather than silently losing an update.
 *
 * Idempotency: mutation (mode === 'update') requires an Idempotency-Key
 * header; the existing api_idempotency_keys registry (migration 25)
 * returns the stored result on a replay so the RPC runs at most once
 * and audit fires at most once per key.
 *
 * Audit: one best-effort event through the existing logAuditEvent ->
 * write_audit_log path (no parallel audit primitive). Registered action
 * types: hospital_setting_update (high) and feature_flag_update
 * (medium). Read mode never audits.
 *
 * Out of scope (WS-ONBOARD-3): Razorpay key id / secret, Meta/WhatsApp
 * tokens, and every other credential field. The RPC's field allowlist
 * rejects them; this Edge layer does not accept them either.
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

const ENDPOINT = "hospital-configuration";

/** The exact hospital-scope editable field set (mirrors the RPC's
 *  allowlist; the RPC remains authoritative). */
const HospitalPatchSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  name_te: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().max(254).optional(),
  country: z.string().trim().min(1).max(120).optional(),
  state: z.string().trim().min(1).max(120).optional(),
  district: z.string().trim().max(120).optional(),
  town: z.string().trim().min(1).max(120).optional(),
  address: z.string().trim().max(500).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  online_booking_enabled: z.boolean().optional(),
  max_advance_booking_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional(),
}).strict();

/** The exact settings-scope editable field set (mirrors the RPC's
 *  allowlist). Numeric fields are transmitted as strings over JSON, so
 *  the RPC casts them; the Edge layer only checks shape and range here
 *  so a bad value is 422 not 500. */
const SettingsPatchSchema = z.object({
  display_name: z.string().trim().max(200).optional(),
  logo_url: z.string().trim().max(500).optional(),
  platform_fee_online: z.coerce.number().min(0).max(1_000_000).optional(),
  platform_fee_whatsapp: z.coerce.number().min(0).max(1_000_000).optional(),
  receptionist_fee: z.coerce.number().min(0).max(1_000_000).optional(),
  online_booking_fee_enabled: z.boolean().optional(),
  default_consultation_fee_inr: z.coerce
    .number()
    .min(0)
    .max(1_000_000)
    .nullable()
    .optional(),
  gst_enabled: z.boolean().optional(),
  gst_percentage: z.coerce.number().min(0).max(100).optional(),
  gst_registration_number: z.string().trim().max(32).optional(),
  max_tokens_per_day: z.coerce.number().int().min(1).max(5000).optional(),
  allow_walkin_tokens: z.boolean().optional(),
  allow_online_booking: z.boolean().optional(),
  allow_carry_forward: z.boolean().optional(),
  queue_display_enabled: z.boolean().optional(),
  send_whatsapp_confirmation: z.boolean().optional(),
  send_whatsapp_reminder: z.boolean().optional(),
  send_feedback_request: z.boolean().optional(),
  reminder_before_minutes: z.coerce.number().int().min(1).max(1440).optional(),
  preferred_language: z.string().trim().min(2).max(10).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  metadata: z.record(z.any()).optional(),
}).strict();

const FeatureOverrideSchema = z.array(
  z.object({
    flag_key: z.string().trim().min(1).max(128),
    is_enabled: z.boolean(),
  }).strict(),
).max(64);

/** Read body: no idempotency key needed; a read is not a mutation. */
const ReadSchema = z.object({
  mode: z.literal("read"),
}).strict();

/** Update body: the caller MUST supply an expected_version, and one (or
 *  more) of hospitalPatch / settingsPatch / featureOverrides. An empty
 *  update is a valid no-op the RPC handles honestly. */
const UpdateSchema = z.object({
  mode: z.literal("update"),
  expectedVersion: z.number().int().min(0),
  hospitalPatch: HospitalPatchSchema.optional(),
  settingsPatch: SettingsPatchSchema.optional(),
  featureOverrides: FeatureOverrideSchema.optional(),
}).strict();

const BodySchema = z.discriminatedUnion("mode", [ReadSchema, UpdateSchema]);
type Body = z.infer<typeof BodySchema>;

interface RpcReadOutcome {
  ok?: boolean;
  version?: number;
  hospital?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  feature_flags?: unknown;
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

/** Map RPC SQLSTATE codes onto the SETURA HTTP error contract. Never
 *  leak the PostgreSQL driver message or SQL to the client. */
function mapRpcError(err: { code?: string; message?: string }): never {
  const code = err.code ?? "";
  if (code === "42501" || code === "P0002") {
    // P0002 means the (authorized-actor-checked) hospital or settings
    // row vanished; do not disclose which, treat as forbidden.
    throw new ForbiddenError("Not authorized for this hospital configuration");
  }
  if (code === "P0001") {
    // Optimistic expected-version conflict. The RPC uses SQLSTATE
    // P0001 (raise_exception) deliberately rather than 40001
    // (serialization_failure), because PostgREST treats class-40 codes
    // as retryable and re-issues the transaction, converting a benign
    // expected-version conflict into a client-visible timeout. See
    // migration 66 header for the rationale.
    throw new ConcurrencyError(
      "Configuration was changed by someone else. Reload and try again.",
      { expectedVersion: true },
    );
  }
  if (code === "22023" || code === "23514" || code === "22P02") {
    throw new ValidationError("Configuration rejected", {
      value: [String(err.message ?? "invalid")],
    });
  }
  throw new InternalError("Hospital configuration failed", { code });
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
    // existing hospital-scoped endpoint; resolveAuth verifies the actor
    // is genuinely a member of that tenant (or a global_admin) for the
    // selected roles.
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
      const { data, error } = await db.rpc("get_hospital_configuration", {
        p_actor_user_id: auth.userId,
        p_hospital_id: hospitalId,
      });
      if (error) mapRpcError(error as { code?: string; message?: string });
      const outcome = (data ?? {}) as RpcReadOutcome;
      if (outcome.ok !== true) {
        throw new InternalError("Hospital configuration read returned no data");
      }
      metrics.increment("hospital_configuration.read");
      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);
      return successResponse(
        {
          hospitalId,
          version: outcome.version ?? 0,
          hospital: outcome.hospital ?? {},
          settings: outcome.settings ?? {},
          featureFlags: outcome.feature_flags ?? [],
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
          "update_hospital_configuration",
          {
            p_actor_user_id: auth.userId,
            p_hospital_id: hospitalId,
            p_expected_version: body.expectedVersion,
            p_hospital_patch: body.hospitalPatch ?? {},
            p_settings_patch: body.settingsPatch ?? {},
            p_feature_overrides: body.featureOverrides ?? [],
          },
        );
        if (error) mapRpcError(error as { code?: string; message?: string });
        const outcome = (data ?? {}) as RpcWriteOutcome;
        if (outcome.ok !== true) {
          throw new InternalError(
            "Hospital configuration update returned no result",
            { reason: outcome.reason ?? "unknown" },
          );
        }

        const updated = outcome.reason === "updated" ||
          (body.featureOverrides?.length ?? 0) > 0;

        // Best-effort audit inside the idempotency handler so a replay
        // never double-records the event.
        await logAuditEvent(
          {
            hospitalId,
            actorUserId: auth.userId,
            entityType: "hospital",
            entityId: hospitalId,
            actionType: "hospital_setting_update",
            severity: "high",
            oldData: { expectedVersion: body.expectedVersion },
            newData: {
              hospitalPatch: body.hospitalPatch ?? {},
              settingsPatch: body.settingsPatch ?? {},
              featureOverrides: body.featureOverrides ?? [],
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
        ? "hospital_configuration.replay"
        : "hospital_configuration.update",
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
    metrics.increment("hospital_configuration.error");
    logger.error("hospital-configuration failed", err, {
      durationMs: elapsedMs(trace),
    });
    return handleErrorResponse(err, trace.correlationId, req);
  }
});
