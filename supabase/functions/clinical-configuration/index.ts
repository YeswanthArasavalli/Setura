/**
 * clinical-configuration/index.ts
 *
 * WS-ONBOARD-4 - Doctor, Department, Schedule & Leave Configuration.
 *
 * The single canonical HTTP surface through which an authorized hospital
 * operator configures the operational people-and-time data of a tenant:
 * departments, doctors, doctor<->department assignment, recurring weekly
 * schedules, and doctor leave. A newly provisioned hospital becomes operable
 * from the SETURA UI with no SQL, no dashboard edit, no source change and no
 * developer intervention.
 *
 * TENANT-SCOPED like every other hospital Edge Function: X-Hospital-ID is
 * resolved by `resolveAuth`, so a global_admin names the target tenant and a
 * hospital_admin can only ever address its own.
 *
 * Flow (the canonical SETURA shape, per AGENTS.md sec 6):
 *   HTTP -> resolveAuth -> requireRole(['global_admin','hospital_admin'])
 *   -> X-Hospital-ID / tenant validation -> Zod validation
 *   -> Idempotency-Key gate -> withIdempotency -> SECURITY DEFINER RPC
 *   -> database invariant -> audit -> server-authoritative response.
 *
 * Reads are NOT served here. The browser already reads RLS-scoped tables
 * directly (apps/web/src/api/reads.ts); departments and
 * doctor_departments were given tenant-scoped SELECT policies plus an
 * explicit GRANT SELECT to authenticated in migration 68 precisely so that
 * path works. Inventing a second read RPC would duplicate an existing
 * primitive.
 *
 * Authorization is enforced at BOTH boundaries. The Edge layer gates on the
 * JWT-resolved role and tenant; every RPC independently re-checks that the
 * actor id really holds global_admin, or hospital_admin scoped to the target
 * hospital, and re-asserts that the addressed entity belongs to that hospital,
 * raising SQLSTATE 42501. A hospital_admin spoofing another tenant's id is a
 * 403, never a cross-tenant mutation and never an existence leak.
 *
 * Doctor identity provisioning (documented design decision):
 *   The repository has no existing user-invitation workflow - `auth.admin`
 *   and `createUser` have zero matches across all Edge Functions and there is
 *   no `handle_new_user` profile trigger in any migration. So the operator
 *   supplies an initial password and the Edge layer creates the auth user via
 *   the Supabase Auth admin API using the service-role client that
 *   `_shared/db.ts` already owns, then calls `create_doctor`. The password is
 *   NEVER logged, NEVER audited and NEVER returned. If the RPC fails, a
 *   compensating `deleteUser` runs so a half-provisioned identity cannot
 *   linger; the database transaction already rolls back its own writes.
 *   A self-service invitation/reset flow is a genuine follow-up product
 *   decision, not something this workstream claims to have built.
 *
 * No fake capability (task sec 20):
 *   Everything written here is read by the live availability engine.
 *   `is_doctor_available()` reads doctor_schedules.is_active/weekday and
 *   doctor_leaves rows whose leave_status = 'approved';
 *   `get_remaining_token_capacity` (migration 55) sums max_tokens;
 *   `estimate_wait_minutes` reads average_consultation_minutes. Admin-created
 *   leave is therefore created APPROVED - a 'pending' row would be stored but
 *   ignored by the engine, which is exactly the fake screen this rule forbids.
 *   Fields with no runtime consumer at all (doctor_schedule_blocks,
 *   is_walkin_allowed, buffer_minutes, auto_cancel_bookings) are deliberately
 *   NOT accepted by this API, so the UI cannot promise behavior that does not
 *   exist.
 *
 * Idempotency: every mutation requires an Idempotency-Key header and runs
 * inside the existing api_idempotency_keys registry (migration 25), so a
 * replay re-runs neither the RPC nor its audit event. Auth-user creation also
 * lives inside the handler, so a replay cannot mint a second identity.
 *
 * Concurrency: departments carry an optimistic expected_version (SQLSTATE
 * P0001 -> HTTP 409), reusing the migration 66 contract rather than a new
 * one. The pre-existing tables are protected by FOR UPDATE, their EXCLUDE
 * constraints and idempotency instead of a version column added to a closed
 * engine's schema.
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
  SeturError,
  ValidationError,
} from "../_shared/errors.ts";
import {
  extractIdempotencyKey,
  withIdempotency,
} from "../_shared/idempotency.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { DateSchema, parseBody } from "../_shared/validation.ts";
import type { Database } from "../_shared/types.ts";

const ENDPOINT = "clinical-configuration";

/** The exact doctor_leave_type enum labels from migration 31. Kept here so a
 *  bad value is a 422 at the boundary; the RPC re-checks against pg_enum, so
 *  this list is a convenience, never the authority. */
const LEAVE_TYPES = [
  "annual_leave",
  "sick_leave",
  "conference",
  "emergency",
  "personal",
  "other",
] as const;

const Uuid = z.string().uuid();
const Specializations = z.array(
  z.object({
    name: z.string().trim().min(1).max(120),
    // Informational only: migrations 28/35 state the collected fee comes from
    // booking_fee_policies / hospital_settings, never from this column.
    consultationFee: z.coerce.number().min(0).max(1_000_000).optional(),
    averageConsultationMinutes: z.coerce.number().int().min(1).max(240)
      .optional(),
  }).strict(),
).max(32);
const DepartmentIds = z.array(Uuid).max(32);

interface SpecializationInput {
  name: string;
  consultationFee?: number;
  averageConsultationMinutes?: number;
}

type RpcSpecialization = {
  name: string;
  consultation_fee: number;
  average_consultation_minutes: number;
};

/**
 * Maps the HTTP specialization shape onto the RPC JSONB contract.
 *
 * The two RPCs read `s->>'consultation_fee'` and
 * `s->>'average_consultation_minutes'` because that JSONB is a direct mirror
 * of the `doctor_specializations` columns it writes. The HTTP body keeps
 * camelCase like every other field in this function, so the rename belongs at
 * THIS boundary. Passing camelCase through would not error — the `->>` lookups
 * would simply miss and `coalesce` would silently store the column defaults
 * (fee 0, 10 minutes), which is exactly the fake-write UX this gate forbids.
 *
 * Declared as a type alias, not an interface, so the generated `Json` union
 * accepts it (structural index signature).
 */
function specializationPayload(
  items: readonly SpecializationInput[],
): RpcSpecialization[] {
  return items.map((s) => ({
    name: s.name,
    consultation_fee: s.consultationFee ?? 0,
    average_consultation_minutes: s.averageConsultationMinutes ?? 10,
  }));
}

const DepartmentCreateSchema = z.object({
  action: z.literal("department_create"),
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().min(1).max(32),
  description: z.string().trim().max(500).nullish(),
}).strict();

const DepartmentUpdateSchema = z.object({
  action: z.literal("department_update"),
  departmentId: Uuid,
  expectedVersion: z.number().int().min(1),
  name: z.string().trim().min(2).max(120).optional(),
  code: z.string().trim().min(1).max(32).optional(),
  description: z.string().trim().max(500).nullish(),
}).strict();

const DepartmentStatusSchema = z.object({
  action: z.literal("department_status_change"),
  departmentId: Uuid,
  expectedVersion: z.number().int().min(1),
  isActive: z.boolean(),
}).strict();

const DoctorCreateSchema = z.object({
  action: z.literal("doctor_create"),
  fullName: z.string().trim().min(2).max(200),
  email: z.string().trim().email().max(254),
  // Admin-supplied initial credential. Never logged, never audited, never
  // returned. See the header note on why this shape was chosen.
  password: z.string().min(8).max(256),
  phone: z.string().trim().max(20).nullish(),
  specializations: Specializations.optional(),
  departmentIds: DepartmentIds.optional(),
}).strict();

const DoctorUpdateSchema = z.object({
  action: z.literal("doctor_update"),
  doctorId: Uuid,
  fullName: z.string().trim().min(2).max(200).optional(),
  phone: z.string().trim().max(20).nullish(),
  /** Supplied only when the operator is deliberately changing activation. */
  isActive: z.boolean().optional(),
  specializations: Specializations.optional(),
  departmentIds: DepartmentIds.optional(),
}).strict();

const ScheduleUpsertSchema = z.object({
  action: z.literal("schedule_upsert"),
  doctorId: Uuid,
  scheduleId: Uuid.nullish(),
  weekday: z.number().int().min(0).max(6),
  /** PostgreSQL TIME over JSON: HH:MM or HH:MM:SS. */
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  maxTokens: z.number().int().min(1).max(5000),
  averageConsultationMinutes: z.number().int().min(1).max(240),
  isActive: z.boolean(),
}).strict();

const ScheduleDeleteSchema = z.object({
  action: z.literal("schedule_delete"),
  doctorId: Uuid,
  scheduleId: Uuid,
}).strict();

/**
 * `DateSchema` proves the SHAPE, not the calendar. Measured on this runtime:
 * Deno's best-fit parser accepts `2026-02-30` (it overflows to `2026-03-02`),
 * so the shared `!isNaN(Date.parse(...))` refine passes it and PostgreSQL would
 * answer SQLSTATE 22007 - not one of the mapped input states - which the
 * boundary would report as a 500 for a client typing error. The round-trip
 * through the already-proved-numeric timestamp rejects exactly the dates that
 * do not exist, without a throw path for NaN input.
 */
const CalendarDateSchema = DateSchema.refine((value: string) => {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return true; // DateSchema's own refine reports this.
  return new Date(ts).toISOString().slice(0, 10) === value;
}, { message: "Must be a real calendar date (YYYY-MM-DD)" });

const LeaveUpsertSchema = z.object({
  action: z.literal("leave_upsert"),
  doctorId: Uuid,
  leaveId: Uuid.nullish(),
  /**
   * `CalendarDateSchema` extends the shared `DateSchema` primitive with the
   * calendar validity it does not check; a format regex alone would let a
   * non-existent date reach the database and surface as a 500.
   */
  startDate: CalendarDateSchema,
  endDate: CalendarDateSchema,
  leaveType: z.enum(LEAVE_TYPES),
  reason: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(2000).nullish(),
}).strict();

const LeaveCancelSchema = z.object({
  action: z.literal("leave_cancel"),
  leaveId: Uuid,
}).strict();

const BodySchema = z.discriminatedUnion("action", [
  DepartmentCreateSchema,
  DepartmentUpdateSchema,
  DepartmentStatusSchema,
  DoctorCreateSchema,
  DoctorUpdateSchema,
  ScheduleUpsertSchema,
  ScheduleDeleteSchema,
  LeaveUpsertSchema,
  LeaveCancelSchema,
]);
type Body = z.infer<typeof BodySchema>;

/** Every RPC returns JSONB built by `jsonb_build_object`. */
interface RpcOutcome {
  ok?: boolean;
  created?: boolean;
  department_id?: string;
  doctor_id?: string;
  schedule_id?: string;
  leave_id?: string;
  version?: number;
  is_active?: boolean;
  leave_status?: string;
  schedules_deactivated?: number;
  [key: string]: unknown;
}

/**
 * Maps RPC SQLSTATE onto the established SETURA HTTP error contract. Never
 * leaks the PostgreSQL driver message or SQL to the client.
 *
 *   42501 / P0002 -> 403  (also used for a vanished id, so a cross-tenant
 *                          probe cannot distinguish "absent" from "not yours")
 *   P0001         -> 409  (expected-version conflict; migration 66 rationale)
 *   23505         -> 409  (duplicate identifier; provision-hospital precedent)
 *   23P01         -> 409  (EXCLUDE overlap - the schedule/leave invariant)
 *   22023/23514/22P02/23503 -> 422
 *   anything else -> 500
 */
function mapRpcError(err: { code?: string; message?: string }): never {
  const code = err.code ?? "";

  if (code === "42501" || code === "P0002") {
    throw new ForbiddenError("Not authorized for this clinical configuration");
  }
  if (code === "P0001") {
    throw new ConcurrencyError(
      "This record changed while you were editing. Reload and try again.",
      { expectedVersion: true },
    );
  }
  if (code === "23505") {
    throw new SeturError(
      "Another record already uses this identifier",
      "DB_CONSTRAINT_VIOLATION",
      409,
      false,
    );
  }
  if (code === "23P01") {
    // exclusion_violation: a schedule or leave overlaps an existing one.
    throw new SeturError(
      "This time window overlaps an existing record",
      "DB_CONSTRAINT_VIOLATION",
      409,
      false,
    );
  }
  if (
    code === "22023" || code === "23514" || code === "22P02" ||
    code === "23503"
  ) {
    throw new ValidationError("Clinical configuration rejected", {
      value: [String(err.message ?? "invalid")],
    });
  }
  throw new InternalError("Clinical configuration failed", { code });
}

/** Runs one service_role RPC and maps its failure. The RPC names are literal
 *  at every call site, so the generated Database types still govern the
 *  argument shape; only the JSONB result is narrowed here. */
async function rpc<
  F extends string & keyof Database["public"]["Functions"],
>(
  name: F,
  params: Database["public"]["Functions"][F]["Args"],
): Promise<RpcOutcome> {
  const db = getServiceClient();
  const { data, error } = await db.rpc(name, params);
  if (error) {
    mapRpcError(error as { code?: string; message?: string });
  }
  const outcome = (data ?? {}) as RpcOutcome;
  if (outcome.ok !== true) {
    throw new InternalError("Clinical configuration RPC returned no result", {
      fn: name,
    });
  }
  return outcome;
}

interface ResultBody {
  action: string;
  hospitalId: string;
  entity: Record<string, unknown>;
}

async function dispatch(
  body: Body,
  actorUserId: string,
  hospitalId: string,
): Promise<ResultBody> {
  switch (body.action) {
    case "department_create": {
      const o = await rpc("create_department", {
        p_actor_user_id: actorUserId,
        p_hospital_id: hospitalId,
        p_name: body.name,
        p_code: body.code,
        p_description: body.description ?? undefined,
      });
      return {
        action: body.action,
        hospitalId,
        entity: {
          departmentId: o.department_id,
          name: o.name,
          code: o.code,
          isActive: o.is_active,
          version: o.version,
        },
      };
    }

    case "department_update":
    case "department_status_change": {
      const o = body.action === "department_update"
        ? await rpc("update_department", {
          p_actor_user_id: actorUserId,
          p_hospital_id: hospitalId,
          p_department_id: body.departmentId,
          p_expected_version: body.expectedVersion,
          p_name: body.name ?? undefined,
          p_code: body.code ?? undefined,
          p_description: body.description ?? undefined,
        })
        : await rpc("set_department_status", {
          p_actor_user_id: actorUserId,
          p_hospital_id: hospitalId,
          p_department_id: body.departmentId,
          p_expected_version: body.expectedVersion,
          p_is_active: body.isActive,
        });
      return {
        action: body.action,
        hospitalId,
        entity: {
          departmentId: body.departmentId,
          name: o.name ?? undefined,
          code: o.code ?? undefined,
          isActive: o.is_active ?? undefined,
          version: o.version,
        },
      };
    }

    case "doctor_create": {
      // Identity first, then the domain rows. The auth user id is the only
      // credential-shaped thing that ever leaves this function scope, and it
      // is a foreign key, not a secret.
      const db = getServiceClient();
      const { data: created, error: authErr } = await db.auth.admin.createUser({
        email: body.email.toLowerCase(),
        password: body.password,
        email_confirm: true,
        user_metadata: { full_name: body.fullName },
      });
      if (authErr || !created?.user) {
        throw new ValidationError("Could not create the doctor sign-in", {
          email: [
            String(authErr?.message ?? "auth admin rejected the request"),
          ],
        });
      }

      const newUserId = created.user.id;
      try {
        const o = await rpc("create_doctor", {
          p_actor_user_id: actorUserId,
          p_hospital_id: hospitalId,
          p_auth_user_id: newUserId,
          p_full_name: body.fullName,
          p_normalized_phone: body.phone ?? undefined,
          p_specializations: specializationPayload(
            body.specializations ?? [],
          ),
          p_department_ids: body.departmentIds ?? [],
        });
        return {
          action: body.action,
          hospitalId,
          entity: {
            doctorId: o.doctor_id,
            fullName: o.full_name,
            isActive: o.is_active,
            departmentCount: o.department_count,
            specializationCount: o.specialization_count,
          },
        };
      } catch (err) {
        // Compensate: the database transaction already rolled back, but the
        // auth row lives outside it. Without this a failed provision would
        // leave an orphan login with no profile and no role.
        await db.auth.admin.deleteUser(newUserId);
        throw err;
      }
    }

    case "doctor_update": {
      const o = await rpc("update_doctor", {
        p_actor_user_id: actorUserId,
        p_hospital_id: hospitalId,
        p_doctor_id: body.doctorId,
        p_full_name: body.fullName ?? undefined,
        p_normalized_phone: body.phone ?? undefined,
        p_is_active: body.isActive ?? undefined,
        p_specializations: body.specializations
          ? specializationPayload(body.specializations)
          : undefined,
        p_department_ids: body.departmentIds ?? undefined,
      });
      return {
        action: body.action,
        hospitalId,
        entity: {
          doctorId: body.doctorId,
          isActive: o.is_active,
          schedulesDeactivated: o.schedules_deactivated,
        },
      };
    }

    case "schedule_upsert": {
      const o = await rpc("upsert_doctor_schedule", {
        p_actor_user_id: actorUserId,
        p_hospital_id: hospitalId,
        p_doctor_id: body.doctorId,
        p_schedule_id: body.scheduleId ?? undefined,
        p_weekday: body.weekday,
        p_start_time: body.startTime,
        p_end_time: body.endTime,
        p_max_tokens: body.maxTokens,
        p_average_consultation_minutes: body.averageConsultationMinutes,
        p_is_active: body.isActive,
      });
      return {
        action: body.action,
        hospitalId,
        entity: {
          doctorId: body.doctorId,
          scheduleId: o.schedule_id ?? body.scheduleId ?? null,
          created: o.created,
          weekday: o.weekday,
          startTime: o.start_time,
          endTime: o.end_time,
          maxTokens: o.max_tokens,
          isActive: o.is_active,
        },
      };
    }

    case "schedule_delete": {
      const o = await rpc("delete_doctor_schedule", {
        p_actor_user_id: actorUserId,
        p_hospital_id: hospitalId,
        p_schedule_id: body.scheduleId,
      });
      return {
        action: body.action,
        hospitalId,
        entity: {
          doctorId: body.doctorId,
          scheduleId: body.scheduleId,
          deleted: o.deleted,
        },
      };
    }

    case "leave_upsert": {
      const o = await rpc("upsert_doctor_leave", {
        p_actor_user_id: actorUserId,
        p_hospital_id: hospitalId,
        p_doctor_id: body.doctorId,
        p_leave_id: body.leaveId ?? undefined,
        p_leave_start_date: body.startDate,
        p_leave_end_date: body.endDate,
        p_leave_type: body.leaveType,
        p_reason: body.reason ?? undefined,
        p_notes: body.notes ?? undefined,
      });
      return {
        action: body.action,
        hospitalId,
        entity: {
          doctorId: body.doctorId,
          leaveId: o.leave_id ?? body.leaveId ?? null,
          created: o.created,
          startDate: o.start_date,
          endDate: o.end_date,
          leaveType: o.leave_type,
          leaveStatus: o.leave_status,
        },
      };
    }

    case "leave_cancel": {
      const o = await rpc("cancel_doctor_leave", {
        p_actor_user_id: actorUserId,
        p_hospital_id: hospitalId,
        p_leave_id: body.leaveId,
      });
      return {
        action: body.action,
        hospitalId,
        entity: {
          leaveId: body.leaveId,
          leaveStatus: o.leave_status,
        },
      };
    }
  }

  // Exhaustiveness guard. Every member of the discriminated union returns
  // above, so this is unreachable; it exists so the compiler and a future
  // added action both fail loudly rather than silently returning undefined.
  throw new ValidationError("Unsupported action");
}

/** Audit actions for a completed mutation. `doctor_update` can legitimately
 *  produce two or three events, because changing activation and changing the
 *  department set are different operational facts. */
function auditPlan(
  body: Body,
  result: ResultBody,
): Array<{
  actionType: Parameters<typeof logAuditEvent>[0]["actionType"];
  entityType: string;
  entityId: string | null;
  severity: "low" | "medium" | "high" | "critical";
  notes: string;
}> {
  const e = result.entity;

  switch (body.action) {
    case "department_create":
      return [{
        actionType: "department_create",
        entityType: "department",
        entityId: String(e.departmentId ?? ""),
        severity: "medium",
        notes: "Department created (WS-ONBOARD-4)",
      }];

    case "department_update":
    case "department_status_change":
      return [{
        actionType: body.action,
        entityType: "department",
        entityId: body.departmentId,
        severity: "medium",
        notes: `Department ${body.action} (WS-ONBOARD-4)`,
      }];

    case "doctor_create":
      return [{
        actionType: "doctor_create",
        entityType: "profile",
        entityId: String(e.doctorId ?? ""),
        severity: "high",
        notes: "Doctor provisioned into a hospital (WS-ONBOARD-4)",
      }];

    case "doctor_update": {
      const plan: ReturnType<typeof auditPlan> = [{
        actionType: "doctor_update",
        entityType: "profile",
        entityId: body.doctorId,
        severity: "medium",
        notes: "Doctor profile or specialization set edited (WS-ONBOARD-4)",
      }];
      if (body.isActive !== undefined) {
        plan.push({
          actionType: "doctor_status_change",
          entityType: "profile",
          entityId: body.doctorId,
          severity: "high",
          notes: body.isActive
            ? "Doctor reactivated; schedules are NOT auto-restored " +
              "(WS-ONBOARD-4)"
            : `Doctor deactivated; ${e.schedulesDeactivated ?? 0} active ` +
              "schedule(s) deactivated in the same transaction (WS-ONBOARD-4)",
        });
      }
      if (body.departmentIds !== undefined) {
        plan.push({
          actionType: "doctor_department_assignment",
          entityType: "profile",
          entityId: body.doctorId,
          severity: "medium",
          notes: "Doctor department set replaced (WS-ONBOARD-4)",
        });
      }
      return plan;
    }

    case "schedule_upsert":
      return [{
        actionType: body.scheduleId
          ? "doctor_schedule_update"
          : "doctor_schedule_create",
        entityType: "doctor_schedule",
        // The upsert RPC returns the row id, so the create event names the
        // schedule it created instead of carrying a NULL entity.
        entityId: String(e.scheduleId ?? body.scheduleId ?? ""),
        severity: "medium",
        notes: "Weekly schedule written to the table the availability engine " +
          "reads (WS-ONBOARD-4)",
      }];

    case "schedule_delete":
      return [{
        actionType: "doctor_schedule_delete",
        entityType: "doctor_schedule",
        entityId: body.scheduleId,
        severity: "high",
        notes: "Weekly schedule soft-deleted (WS-ONBOARD-4)",
      }];

    case "leave_upsert":
      return [{
        actionType: body.leaveId
          ? "doctor_leave_update"
          : "doctor_leave_create",
        entityType: "doctor_leave",
        entityId: String(e.leaveId ?? body.leaveId ?? ""),
        severity: "medium",
        notes: "Approved leave window written; the availability engine " +
          "honours it from creation (WS-ONBOARD-4)",
      }];

    case "leave_cancel":
      return [{
        actionType: "doctor_leave_cancel",
        entityType: "doctor_leave",
        entityId: body.leaveId,
        severity: "medium",
        notes: "Leave cancelled and its date range released (WS-ONBOARD-4)",
      }];
  }

  // Exhaustiveness guard, mirroring dispatch(): unreachable, but a newly
  // added action without an audit plan is a governance bug, not a default.
  throw new InternalError("No audit plan for action");
}

/**
 * The audit payload must never carry the admin-supplied initial credential.
 * Only doctor_create has a `password`, so a shallow copy plus an explicit
 * delete is the whole redaction - not a key set to undefined and hoped away.
 */
function redact(body: Body): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...body };
  delete copy.password;
  return copy;
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
    const headerHospitalId = req.headers.get("X-Hospital-ID");
    if (!headerHospitalId) {
      throw new ValidationError("Missing X-Hospital-ID header", {
        header: ["Required"],
      });
    }

    const auth = await resolveAuth(req, headerHospitalId, logger);
    requireRole(auth, ["global_admin", "hospital_admin"]);

    const hospitalId = auth.hospitalId ?? headerHospitalId;
    if (!hospitalId) {
      throw new ForbiddenError("No hospital context resolved");
    }

    const body = await parseBody<Body>(req, BodySchema);
    const idempotencyKey = extractIdempotencyKey(req, true)!;

    const result = await withIdempotency<ResultBody>(
      idempotencyKey,
      ENDPOINT,
      auth.userId,
      hospitalId,
      body,
      crypto.randomUUID(),
      logger,
      async () => {
        const outcome = await dispatch(body, auth.userId, hospitalId);

        // Best-effort audit INSIDE the handler, so a replay never
        // double-records. The password is structurally absent from both
        // oldData and newData.
        for (const plan of auditPlan(body, outcome)) {
          await logAuditEvent(
            {
              hospitalId,
              actorUserId: auth.userId,
              entityType: plan.entityType,
              entityId: plan.entityId,
              actionType: plan.actionType,
              severity: plan.severity,
              oldData: body.action === "department_update" ||
                  body.action === "department_status_change"
                ? { expectedVersion: body.expectedVersion }
                : null,
              newData: {
                request: redact(body),
                result: outcome.entity,
              },
              notes: plan.notes,
            },
            logger,
            metrics,
          );
        }

        metrics.increment(`clinical_configuration.${body.action}`);
        return { statusCode: 200, body: outcome };
      },
    );

    metrics.increment(
      result.wasDuplicate
        ? "clinical_configuration.replay"
        : "clinical_configuration.mutation",
    );
    metrics.timing("request.total", elapsedMs(trace));
    metrics.flush(logger);

    return successResponse(
      result.body,
      trace.correlationId,
      req,
      undefined,
      result.statusCode,
    );
  } catch (err) {
    metrics.increment("clinical_configuration.error");
    logger.error("clinical-configuration failed", err, {
      durationMs: elapsedMs(trace),
    });
    return handleErrorResponse(err, trace.correlationId, req);
  }
});
