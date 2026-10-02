/**
 * provision-hospital/index.ts
 *
 * WS-ONBOARD-1 - Hospital Tenant Provisioning.
 *
 * Lets a global_admin create a new working hospital tenant from the SETURA
 * UI, with no SQL, seed editing or environment changes. This is a genuine
 * tenant-free GLOBAL action: the target hospital does not exist yet, so,
 * unlike hospital-scoped Edge Functions, this endpoint does NOT read or
 * trust an X-Hospital-ID header.
 *
 * Flow (the canonical SETURA shape, per AGENTS.md sec 6):
 *   HTTP -> resolveAuth (JWT-authoritative actor) -> requireRole(global_admin)
 *     -> validate body -> existing api_idempotency_keys registry
 *     -> SECURITY DEFINER provision_hospital RPC (owns the atomic tenant
 *        creation; the existing auto_create_hospital_settings trigger creates
 *        the hospital_settings defaults in the same transaction)
 *     -> audit event -> server-authoritative identity in the response.
 *
 * Authorization is enforced at BOTH boundaries: the Edge layer gates on the
 * resolved JWT role, and the RPC independently re-checks that the passed
 * actor id really holds global_admin (defense-in-depth; auth.uid() is NULL
 * under the service_role JWT, so identity is passed explicitly and re-
 * verified against user_roles).
 *
 * Scope (WS-ONBOARD-1 ONLY): creates the tenant row + default settings. It
 * deliberately does NOT create doctors/staff/patients/auth users (WS-ONBOARD-1
 * forbids seeding fake identities; "add doctors and staff" is a later UI step),
 * does NOT edit hospital_settings (WS-ONBOARD-2) and does NOT configure
 * Razorpay / Meta credentials (WS-ONBOARD-3).
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
  SeturError,
  ValidationError,
} from "../_shared/errors.ts";
import {
  extractIdempotencyKey,
  withIdempotency,
} from "../_shared/idempotency.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { parseBody } from "../_shared/validation.ts";

const ENDPOINT = "provision-hospital";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const Schema = z.object({
  name: z.string().trim().min(2).max(200),
  slug: z.string().trim().min(2).max(96).regex(
    SLUG_RE,
    "Slug must be lowercase letters, numbers and hyphens",
  ),
  phone: z.string().trim().max(20).optional(),
  email: z.string().trim().email().max(254).optional(),
  country: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  district: z.string().trim().max(120).optional(),
  town: z.string().trim().max(120).optional(),
  address: z.string().trim().max(500).optional(),
  timezone: z.string().trim().max(64).optional(),
});

interface ProvisionResult {
  ok?: boolean;
  reason?: string;
  hospital_id?: string;
  name?: string;
  slug?: string;
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

    const idempotencyKey = extractIdempotencyKey(req, true)!;

    const body = await parseBody(req, Schema);

    const db = getServiceClient();

    const result = await withIdempotency<{
      hospitalId: string;
      name: string;
      slug: string;
      created: boolean;
    }>(
      idempotencyKey,
      ENDPOINT,
      auth.userId,
      null,
      body,
      crypto.randomUUID(),
      logger,
      async () => {
        const { data, error } = await db.rpc("provision_hospital", {
          p_actor_user_id: auth.userId,
          p_name: body.name,
          p_slug: body.slug,
          ...(body.phone ? { p_phone: body.phone } : {}),
          ...(body.email ? { p_email: body.email } : {}),
          ...(body.country ? { p_country: body.country } : {}),
          ...(body.state ? { p_state: body.state } : {}),
          ...(body.district ? { p_district: body.district } : {}),
          ...(body.town ? { p_town: body.town } : {}),
          ...(body.address ? { p_address: body.address } : {}),
          ...(body.timezone ? { p_timezone: body.timezone } : {}),
        });

        if (error) {
          // Fail closed and map SQLSTATE to the correct HTTP class. Never
          // leak the driver message/SQL to the client.
          if (error.code === "42501") {
            throw new ForbiddenError(
              "Not authorized to provision a hospital tenant",
            );
          }
          if (error.code === "23505") {
            throw new SeturError(
              "A hospital with this slug already exists",
              "DB_CONSTRAINT_VIOLATION",
              409,
              false,
            );
          }
          if (error.code === "22023") {
            throw new ValidationError("Hospital provisioning rejected", {
              slug: [String(error.message ?? "invalid")],
            });
          }
          throw new InternalError("Hospital provisioning failed", {
            error: error.message,
          });
        }

        const outcome = (data ?? {}) as ProvisionResult;

        if (outcome.ok !== true || !outcome.hospital_id) {
          throw new InternalError("Hospital provisioning returned no tenant", {
            reason: outcome.reason ?? "unknown",
          });
        }

        const hospitalId = outcome.hospital_id;
        const name = outcome.name ?? body.name;
        const slug = outcome.slug ?? body.slug;

        // Best-effort audit of the tenant creation. Inside the idempotency
        // handler so a replayed key never double-records the event.
        await logAuditEvent(
          {
            hospitalId,
            actorUserId: auth.userId,
            entityType: "hospital",
            entityId: hospitalId,
            actionType: "hospital_provision",
            severity: "high",
            oldData: null,
            newData: { name, slug },
          },
          logger,
          metrics,
        );

        return {
          statusCode: 201,
          body: { hospitalId, name, slug, created: true },
        };
      },
    );

    metrics.timing("request.total", elapsedMs(trace));
    metrics.increment(
      result.wasDuplicate
        ? "provision_hospital.replay"
        : "provision_hospital.created",
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
    metrics.increment("provision_hospital.error");
    logger.error("provision-hospital failed", err, {
      durationMs: elapsedMs(trace),
    });
    return handleErrorResponse(err, trace.correlationId, req);
  }
});
