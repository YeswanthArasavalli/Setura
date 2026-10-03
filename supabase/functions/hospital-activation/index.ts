/**
 * hospital-activation/index.ts
 *
 * WS-ONBOARD-5 - Hospital Configuration Validation & Activation.
 *
 * The closing step of the SETURA onboarding flow: a global_admin validates a
 * tenant's configuration completeness and, only once the readiness invariant
 * passes, explicitly activates it (or suspends it). This is a genuine
 * tenant-free GLOBAL action like WS-ONBOARD-1 provisioning: the actor is the
 * cross-tenant global_admin, and the TARGET hospital is supplied in the body,
 * never trusted from a header. The RPC re-verifies the actor at the DB.
 *
 * Flow (the canonical SETURA shape, per AGENTS.md sec 6):
 *   HTTP -> resolveAuth -> requireRole(global_admin) -> validate body
 *     -> read mode  : validate_hospital_configuration RPC (read-only checklist)
 *     -> write mode : existing api_idempotency_keys registry
 *                   -> set_hospital_activation RPC (row-locked, readiness-gated)
 *                   -> audit event (mutations only; reads never audit)
 *
 * Authorization is enforced at BOTH boundaries: the Edge layer gates on the
 * resolved JWT role, and each RPC independently re-checks that the actor id
 * really holds global_admin (raises 42501). Only the pre-existing operational
 * hospitals.is_active flag is mutated; no booking/availability semantics are
 * introduced here.
 *
 * Reuses every shared primitive unchanged: getServiceClient, resolveAuth,
 * requireRole, handleCors, parseBody, extractIdempotencyKey, withIdempotency,
 * logAuditEvent, successResponse, handleErrorResponse and the SeturError
 * hierarchy. No parallel auth / idempotency / audit system is created.
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

const ENDPOINT = "hospital-activation";

const Schema = z.object({
  mode: z.enum(["validate", "activate", "deactivate"]),
  hospitalId: z.string().uuid(),
});

// deno-lint-ignore no-explicit-any
type AnyRpc = any;

interface ActivationOutcome {
  ok?: boolean;
  reason?: string;
  hospital_id?: string;
  is_active?: boolean;
  activated_at?: string | null;
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
    // Tenant-free global action: no hospital context is resolved or trusted.
    const auth = await resolveAuth(req, null, logger);
    requireRole(auth, ["global_admin"]);

    const body = await parseBody(req, Schema);
    const targetHospitalId = body.hospitalId;
    const db = getServiceClient();

    // ---- READ mode: validation checklist. No idempotency, no audit. --------
    if (body.mode === "validate") {
      const { data, error } = await (db.rpc as AnyRpc)(
        "validate_hospital_configuration",
        {
          p_actor_user_id: auth.userId,
          p_hospital_id: targetHospitalId,
        },
      );

      if (error) {
        if (error.code === "42501") {
          throw new ForbiddenError("Not authorized to validate a hospital");
        }
        if (error.code === "22023") {
          throw new ValidationError("Hospital validation rejected", {
            hospitalId: [String(error.message ?? "invalid")],
          });
        }
        throw new InternalError("Hospital validation failed", {
          error: error.message,
        });
      }

      metrics.increment("hospital_activation.validate");
      metrics.flush(logger);

      return successResponse(
        { mode: "validate", result: data },
        trace.correlationId,
        req,
        undefined,
        200,
      );
    }

    // ---- WRITE mode: activate / deactivate. Idempotency + audit required. --
    const idempotencyKey = extractIdempotencyKey(req, true)!;
    const activate = body.mode === "activate";

    const result = await withIdempotency<{
      hospitalId: string;
      isActive: boolean;
      reason: string;
      activatedAt: string | null;
    }>(
      idempotencyKey,
      ENDPOINT,
      auth.userId,
      targetHospitalId,
      body,
      crypto.randomUUID(),
      logger,
      async () => {
        const { data, error } = await (db.rpc as AnyRpc)(
          "set_hospital_activation",
          {
            p_actor_user_id: auth.userId,
            p_hospital_id: targetHospitalId,
            p_activate: activate,
          },
        );

        if (error) {
          // Fail closed; map SQLSTATE to the correct HTTP class. Never leak the
          // driver message/SQL beyond a client-safe validation detail.
          if (error.code === "42501") {
            throw new ForbiddenError("Not authorized to change activation");
          }
          if (error.code === "22023") {
            throw new ValidationError(
              activate
                ? "Hospital configuration is incomplete; activation refused"
                : "Hospital activation change rejected",
              { activation: [String(error.message ?? "invalid")] },
            );
          }
          throw new InternalError("Hospital activation failed", {
            error: error.message,
          });
        }

        const outcome = (data ?? {}) as ActivationOutcome;
        if (outcome.ok !== true || !outcome.hospital_id) {
          throw new InternalError("Hospital activation returned no result", {
            reason: outcome.reason ?? "unknown",
          });
        }

        // Best-effort audit, INSIDE the idempotency handler so a replayed key
        // never double-records the event. Records intent + resulting state, not
        // any secret. The DB row (is_active) stays the source of truth.
        await logAuditEvent(
          {
            hospitalId: outcome.hospital_id,
            actorUserId: auth.userId,
            entityType: "hospital",
            entityId: outcome.hospital_id,
            actionType: "hospital_activation",
            severity: "high",
            oldData: { mode: body.mode },
            newData: {
              isActive: outcome.is_active ?? activate,
              reason: outcome.reason ?? "unknown",
              activatedAt: outcome.activated_at ?? null,
            },
          },
          logger,
          metrics,
        );

        return {
          statusCode: 200,
          body: {
            hospitalId: outcome.hospital_id,
            isActive: outcome.is_active ?? activate,
            reason: outcome.reason ?? "unknown",
            activatedAt: outcome.activated_at ?? null,
          },
        };
      },
    );

    metrics.timing("request.total", elapsedMs(trace));
    metrics.increment(
      result.wasDuplicate
        ? "hospital_activation.replay"
        : `hospital_activation.${body.mode}`,
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
    metrics.increment("hospital_activation.error");
    logger.error("hospital-activation failed", err, {
      durationMs: elapsedMs(trace),
    });
    return handleErrorResponse(err, trace.correlationId, req);
  }
});
