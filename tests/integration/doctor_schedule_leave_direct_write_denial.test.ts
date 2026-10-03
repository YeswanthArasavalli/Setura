/**
 * tests/integration/doctor_schedule_leave_direct_write_denial.test.ts
 *
 * WS-SEC-1 - Legacy Doctor Schedule & Leave direct-write security hardening.
 *
 * This suite proves, against the REAL local Supabase stack, the exact
 * security invariant migration 70 is meant to hold:
 *
 *   Browser roles (anon, authenticated - including a hospital_admin / doctor
 *   JWT) MUST NOT be able to INSERT / UPDATE / DELETE doctor_schedules or
 *   doctor_leaves through PostgREST directly. The denial is proven at the
 *   DATABASE boundary (SQLSTATE 42501), independently of the Edge layer.
 *
 *   Legitimate browser READS through the retained SELECT-only RLS policies
 *   MUST keep working and stay tenant-scoped (no cross-tenant leak).
 *
 *   The privileged application path (the canonical WS-ONBOARD-4 write RPCs
 *   upsert_doctor_schedule / delete_doctor_schedule / upsert_doctor_leave /
 *   cancel_doctor_leave, which run as service_role inside SECURITY DEFINER
 *   functions) MUST still succeed after the hardening - a schedule/leave
 *   create, edit, delete and cancel are exercised end to end.
 *
 *   Cross-tenant mutation stays denied on BOTH paths: the direct PostgREST
 *   attempt (even with a known UUID) and the authorized RPC path when the
 *   actor belongs to another hospital.
 *
 * There is deliberately NO assertion here that merely inspects catalog
 * metadata - the invariant is pinned behaviorally (§11). Catalog verification
 * (pg_policies / role_table_grants / relrowsecurity) is performed separately
 * against the live DB as part of the WS-SEC-1 evidence.
 *
 * Run with:  deno task test:integration   (requires `supabase start`)
 */

import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

interface LocalStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

let LOCAL_STATUS: LocalStatus | null = null;

async function getLocalStatus(): Promise<LocalStatus | null> {
  try {
    const cmd = new Deno.Command("supabase", {
      args: ["status", "-o", "json"],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await cmd.output();
    if (code !== 0) return null;
    const text = new TextDecoder().decode(stdout);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return JSON.parse(text.slice(start, end + 1)) as LocalStatus;
  } catch {
    return null;
  }
}

type Shared = Awaited<ReturnType<typeof bootstrap>>;
let _ctx: Shared | null = null;

async function bootstrap() {
  const status = await getLocalStatus();
  if (!status) {
    throw new Error(
      "Local Supabase stack is not running. Run `supabase start` first.",
    );
  }
  LOCAL_STATUS = status;
  Deno.env.set("APP_ENV", "test");
  Deno.env.set("SUPABASE_URL", status.API_URL);
  Deno.env.set("SUPABASE_ANON_KEY", status.ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", status.SERVICE_ROLE_KEY);

  const { createAuthClient, getAnonClient, getServiceClient } = await import(
    "../../supabase/functions/_shared/db.ts"
  );
  return {
    db: getServiceClient(),
    anon: getAnonClient(),
    createAuthClient,
  };
}

async function ctx(): Promise<Shared> {
  if (!_ctx) _ctx = await bootstrap();
  return _ctx;
}

// deno-lint-ignore no-explicit-any
type AnyClient = any;

type RpcError = { code?: string; message?: string } | null;
interface RpcResult {
  data: AnyClient;
  error: RpcError;
}

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "1");
const FIXTURE_PASSWORD = `SEC1-${RUN}-fixture-pass`;

interface Actor {
  userId: string;
  email: string;
  token: string;
}

async function createAuthUser(userId: string, email: string): Promise<void> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const resp = await fetch(`${LOCAL_STATUS.API_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${LOCAL_STATUS.SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: userId,
      email,
      email_confirm: true,
      password: FIXTURE_PASSWORD,
    }),
  });
  if (resp.status >= 300) {
    throw new Error(`admin user create failed: ${resp.status}`);
  }
}

async function tokenFor(email: string): Promise<string> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        "apikey": LOCAL_STATUS.ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password: FIXTURE_PASSWORD }),
    },
  );
  if (resp.status >= 300) {
    throw new Error(`password grant failed: ${resp.status}`);
  }
  const json = await resp.json() as { access_token?: string };
  assertExists(json.access_token);
  return json.access_token!;
}

async function fixtureActor(
  tag: string,
  role: "global_admin" | "hospital_admin" | "doctor",
  hospitalId: string | null,
  phoneSuffix: string,
): Promise<Actor> {
  const { db } = await ctx();
  const userId = crypto.randomUUID();
  const email = `sec1-${tag}-${RUN}@setura.test`;
  await createAuthUser(userId, email);
  const { error: pErr } = await (db.from as AnyClient)("profiles").upsert({
    id: userId,
    full_name: `SEC1 ${tag} ${RUN}`,
    normalized_phone: `96${RUN}${phoneSuffix}`,
  });
  assertEquals(pErr, null);
  const { error: rErr } = await (db.from as AnyClient)("user_roles").insert({
    user_id: userId,
    hospital_id: hospitalId,
    role,
    is_primary: true,
  });
  assertEquals(rErr, null);
  return { userId, email, token: await tokenFor(email) };
}

async function provisionAs(
  actorId: string,
  name: string,
  slug: string,
): Promise<string> {
  const { db } = await ctx();
  const { data, error } = await (db.rpc as AnyClient)("provision_hospital", {
    p_actor_user_id: actorId,
    p_name: name,
    p_slug: slug,
  });
  assertEquals(error, null, `provision failed: ${JSON.stringify(error)}`);
  const id = (data as { hospital_id: string }).hospital_id;
  assertExists(id);
  return id;
}

// ─── Canonical RPC wrappers (the privileged application path) ────────────────

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<RpcResult> {
  const { db } = await ctx();
  const { data, error } = await (db.rpc as AnyClient)(name, args);
  return {
    data: (data ?? null) as AnyClient,
    error: (error ?? null) as RpcError,
  };
}

const createDoctor = (
  actor: string,
  hospital: string,
  authUserId: string,
  fullName: string,
  phone: string,
) =>
  call("create_doctor", {
    p_actor_user_id: actor,
    p_hospital_id: hospital,
    p_auth_user_id: authUserId,
    p_full_name: fullName,
    p_normalized_phone: phone,
  });

const upsertSchedule = (
  actor: string,
  hospital: string,
  doctorId: string,
  fields: Record<string, unknown>,
) =>
  call("upsert_doctor_schedule", {
    p_actor_user_id: actor,
    p_hospital_id: hospital,
    p_doctor_id: doctorId,
    ...fields,
  });

const deleteSchedule = (
  actor: string,
  hospital: string,
  scheduleId: string,
) =>
  call("delete_doctor_schedule", {
    p_actor_user_id: actor,
    p_hospital_id: hospital,
    p_schedule_id: scheduleId,
  });

const upsertLeave = (
  actor: string,
  hospital: string,
  doctorId: string,
  fields: Record<string, unknown>,
) =>
  call("upsert_doctor_leave", {
    p_actor_user_id: actor,
    p_hospital_id: hospital,
    p_doctor_id: doctorId,
    ...fields,
  });

const cancelLeave = (actor: string, hospital: string, leaveId: string) =>
  call("cancel_doctor_leave", {
    p_actor_user_id: actor,
    p_hospital_id: hospital,
    p_leave_id: leaveId,
  });

// ─── Service-role row readers (used to prove the row really changed) ─────────

async function row(
  table: string,
  filter: Record<string, unknown>,
  select = "*",
): Promise<Record<string, unknown> | null> {
  const { db } = await ctx();
  let q = (db.from as AnyClient)(table).select(select);
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const { data } = await q.maybeSingle();
  return (data ?? null) as Record<string, unknown> | null;
}

function dateForWeekday(weekday: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 3);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Table-appropriate write payloads. PostgREST validates columns against its
// schema cache BEFORE the request reaches PostgreSQL, so a payload naming a
// column the table does not have fails with PGRST204 and never exercises the
// privilege boundary. Every probe below therefore uses only real columns, so
// the refusal we observe is the database's 42501, not a schema-cache miss.
const WRITE_PROBE: Record<
  "doctor_schedules" | "doctor_leaves",
  {
    insert: (hospital: string, doctor: string) => Record<string, unknown>;
    update: Record<string, unknown>;
  }
> = {
  doctor_schedules: {
    insert: (hospital, doctor) => ({
      hospital_id: hospital,
      doctor_id: doctor,
      weekday: 3,
      start_time: "08:00:00",
      end_time: "10:00:00",
      max_tokens: 10,
      average_consultation_minutes: 10,
      is_active: true,
    }),
    update: { is_active: false },
  },
  doctor_leaves: {
    insert: (hospital, doctor) => ({
      hospital_id: hospital,
      doctor_id: doctor,
      leave_start_date: dateForWeekday(3),
      leave_end_date: dateForWeekday(3),
      reason: "direct browser write attempt",
      leave_type: "personal",
      leave_status: "approved",
    }),
    update: { reason: "browser edited" },
  },
};

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface FixtureState {
  globalAdmin: Actor;
  adminA: Actor;
  adminB: Actor;
  doctorA: Actor;
  hospitalA: string;
  hospitalB: string;
  doctorId: string;
  scheduleId: string;
  leaveId: string;
}

let F: FixtureState | null = null;
function fx(): FixtureState {
  if (!F) throw new Error("setup test not run");
  return F;
}

Deno.test("wssec1: setup tenants + a doctor/schedule/leave created via the RPC path", async () => {
  const globalAdmin = await fixtureActor("ga", "global_admin", null, "01");
  const hospitalA = await provisionAs(
    globalAdmin.userId,
    `SEC1 A ${RUN}`,
    `sec1-hosp-a-${RUN}`,
  );
  const hospitalB = await provisionAs(
    globalAdmin.userId,
    `SEC1 B ${RUN}`,
    `sec1-hosp-b-${RUN}`,
  );
  const adminA = await fixtureActor("ha-a", "hospital_admin", hospitalA, "02");
  const adminB = await fixtureActor("ha-b", "hospital_admin", hospitalB, "03");
  const doctorA = await fixtureActor("dr-a", "doctor", hospitalA, "04");

  // A doctor + a live schedule + a live leave, all created through the
  // canonical service_role RPC path (these must keep working post-hardening).
  const authId = crypto.randomUUID();
  await createAuthUser(authId, `sec1-doc-target-${RUN}@setura.test`);
  const dr = await createDoctor(
    adminA.userId,
    hospitalA,
    authId,
    `SEC1 Target Dr ${RUN}`,
    `95${RUN}09`,
  );
  assertEquals(dr.error, null, `create_doctor: ${JSON.stringify(dr.error)}`);
  const doctorId = String(dr.data!.doctor_id);

  const sched = await upsertSchedule(adminA.userId, hospitalA, doctorId, {
    p_weekday: 2,
    p_start_time: "09:00:00",
    p_end_time: "12:00:00",
    p_max_tokens: 20,
    p_average_consultation_minutes: 10,
    p_is_active: true,
  });
  assertEquals(
    sched.error,
    null,
    `upsert_doctor_schedule: ${JSON.stringify(sched.error)}`,
  );
  const scheduleId = String(sched.data!.schedule_id);

  const date = dateForWeekday(6);
  const leave = await upsertLeave(adminA.userId, hospitalA, doctorId, {
    p_leave_start_date: date,
    p_leave_end_date: date,
    p_leave_type: "personal",
    p_reason: "ws-sec-1 fixture leave",
  });
  assertEquals(
    leave.error,
    null,
    `upsert_doctor_leave: ${JSON.stringify(leave.error)}`,
  );
  const leaveId = String(leave.data!.leave_id);

  F = {
    globalAdmin,
    adminA,
    adminB,
    doctorA,
    hospitalA,
    hospitalB,
    doctorId,
    scheduleId,
    leaveId,
  };
});

// ─── 1. Direct browser mutation is refused at the DATABASE boundary ──────────

/**
 * A browser-role PostgREST write must fail with SQLSTATE 42501. The revoke of
 * the INSERT/UPDATE/DELETE table grant makes the privilege layer refuse first;
 * the absence of any write policy would refuse second. Both surface as 42501
 * with a "permission denied" or "row-level security" message, so the code (not
 * the message) is pinned - the message text is a PostgreSQL/PostgREST
 * implementation detail (§10).
 */
function assertDenied(
  error: RpcError | { code?: string; message?: string } | null,
  label: string,
): void {
  assertExists(error, `${label}: privileged browser write must be refused`);
  const err = error as { code?: string; message?: string };
  assertEquals(
    err.code,
    "42501",
    `${label}: refusal code ${JSON.stringify(error)}`,
  );
  const msg = String(err.message ?? "").toLowerCase();
  assert(
    msg.includes("permission denied") || msg.includes("row-level security"),
    `${label}: must be a privilege or RLS denial, got ${JSON.stringify(error)}`,
  );
}

for (const table of ["doctor_schedules", "doctor_leaves"] as const) {
  Deno.test(`wssec1: anon cannot directly INSERT/UPDATE/DELETE ${table}`, async () => {
    const f = fx();
    const { anon } = await ctx();
    const anyRow = crypto.randomUUID();

    const ins = await (anon.from as AnyClient)(table)
      .insert(WRITE_PROBE[table].insert(f.hospitalA, f.doctorId));
    assertDenied(ins.error as RpcError, `anon INSERT ${table}`);

    const upd = await (anon.from as AnyClient)(table)
      .update(WRITE_PROBE[table].update)
      .eq("id", anyRow);
    assertDenied(upd.error as RpcError, `anon UPDATE ${table}`);

    const del = await (anon.from as AnyClient)(table).delete().eq("id", anyRow);
    assertDenied(del.error as RpcError, `anon DELETE ${table}`);
  });

  Deno.test(`wssec1: authenticated hospital_admin cannot directly INSERT/UPDATE/DELETE ${table}`, async () => {
    const f = fx();
    const { createAuthClient } = await ctx();
    const asA = createAuthClient(f.adminA.token) as AnyClient;

    // Even for its OWN tenant (a legitimate business identity), the DIRECT
    // table write is refused - mutation must go through the Edge/RPC path.
    const ins = await asA.from(table)
      .insert(WRITE_PROBE[table].insert(f.hospitalA, f.doctorId));
    assertDenied(ins.error as RpcError, `hospital_admin INSERT ${table}`);

    const target = table === "doctor_schedules" ? f.scheduleId : f.leaveId;
    const upd = await asA.from(table)
      .update(WRITE_PROBE[table].update)
      .eq("id", target)
      .eq("hospital_id", f.hospitalA);
    assertDenied(upd.error as RpcError, `hospital_admin UPDATE ${table}`);

    const del = await asA.from(table).delete().eq("id", target);
    assertDenied(del.error as RpcError, `hospital_admin DELETE ${table}`);
  });
}

Deno.test("wssec1: a doctor cannot directly write its own schedule/leave row", async () => {
  const f = fx();
  const { createAuthClient } = await ctx();
  const asDoctor = createAuthClient(f.doctorA.token) as AnyClient;

  // Doctor's own schedule row: uses doctorA.userId as doctor_id, but the
  // direct write is refused regardless of the row-ownership clause the old
  // FOR ALL policy used to honour.
  const ins = await asDoctor.from("doctor_schedules").insert({
    hospital_id: f.hospitalA,
    doctor_id: f.doctorA.userId,
    weekday: 4,
    start_time: "08:00:00",
    end_time: "10:00:00",
    max_tokens: 10,
    average_consultation_minutes: 10,
  });
  assertDenied(ins.error as RpcError, "doctor INSERT doctor_schedules");

  const upd = await asDoctor.from("doctor_leaves")
    .update({ reason: "doctor edited directly" })
    .eq("id", f.leaveId);
  assertDenied(upd.error as RpcError, "doctor UPDATE doctor_leaves");

  const del = await asDoctor.from("doctor_leaves").delete().eq("id", f.leaveId);
  assertDenied(del.error as RpcError, "doctor DELETE doctor_leaves");
});

// ─── 2. The rows survived every direct-write attempt ─────────────────────────

Deno.test("wssec1: schedule/leave rows are unchanged after the denial attempts", async () => {
  const f = fx();
  const sched = await row("doctor_schedules", { id: f.scheduleId });
  assertExists(sched, "the RPC-created schedule row still exists");
  assertEquals(sched!.hospital_id, f.hospitalA);

  const leave = await row("doctor_leaves", { id: f.leaveId });
  assertExists(leave, "the RPC-created leave row still exists");
  assertEquals(leave!.hospital_id, f.hospitalA);
});

// ─── 3. Legitimate browser READS still work, tenant-scoped ───────────────────

Deno.test("wssec1: browser SELECT still works for the owning tenant and leaks nothing cross-tenant", async () => {
  const f = fx();
  const { createAuthClient } = await ctx();

  for (const table of ["doctor_schedules", "doctor_leaves"] as const) {
    const asA = createAuthClient(f.adminA.token) as AnyClient;
    const own = await asA.from(table).select("id").eq(
      "hospital_id",
      f.hospitalA,
    );
    assertEquals(
      own.error,
      null,
      `tenant ${table} read failed: ${JSON.stringify(own.error)}`,
    );
    assert(
      ((own.data ?? []) as Array<Record<string, unknown>>).length >= 1,
      `own-tenant ${table} rows are visible to the tenant admin`,
    );

    const asB = createAuthClient(f.adminB.token) as AnyClient;
    const foreign = await asB.from(table).select("id").eq(
      "hospital_id",
      f.hospitalA,
    );
    assertEquals(foreign.error, null);
    assertEquals(
      (foreign.data ?? []).length,
      0,
      `no cross-tenant ${table} existence leak`,
    );
  }
});

// ─── 4. The privileged RPC write path keeps working end to end ───────────────

Deno.test("wssec1: canonical RPC path still creates, updates, deletes schedules", async () => {
  const f = fx();

  const created = await upsertSchedule(
    f.adminA.userId,
    f.hospitalA,
    f.doctorId,
    {
      p_weekday: 1,
      p_start_time: "14:00:00",
      p_end_time: "17:00:00",
      p_max_tokens: 25,
      p_average_consultation_minutes: 12,
      p_is_active: true,
    },
  );
  assertEquals(
    created.error,
    null,
    `RPC create schedule must still succeed: ${JSON.stringify(created.error)}`,
  );
  const newId = String(created.data!.schedule_id);
  assertEquals(created.data!.weekday, 1);

  const updated = await upsertSchedule(
    f.adminA.userId,
    f.hospitalA,
    f.doctorId,
    {
      p_weekday: 1,
      p_start_time: "14:00:00",
      p_end_time: "17:00:00",
      p_max_tokens: 40,
      p_average_consultation_minutes: 12,
      p_is_active: true,
      p_schedule_id: newId,
    },
  );
  assertEquals(
    updated.error,
    null,
    `RPC update schedule must still succeed: ${JSON.stringify(updated.error)}`,
  );
  const afterEdit = await row("doctor_schedules", { id: newId });
  assertEquals(afterEdit!.max_tokens, 40, "the RPC edit really landed");

  const deleted = await deleteSchedule(f.adminA.userId, f.hospitalA, newId);
  assertEquals(
    deleted.error,
    null,
    `RPC delete schedule must still succeed: ${JSON.stringify(deleted.error)}`,
  );
  const afterDelete = await row("doctor_schedules", { id: newId });
  assertEquals(
    afterDelete!.is_deleted,
    true,
    "RPC delete soft-deletes the row for history",
  );
});

Deno.test("wssec1: canonical RPC path still creates and cancels leaves", async () => {
  const f = fx();
  const date = dateForWeekday(0);

  const created = await upsertLeave(f.adminA.userId, f.hospitalA, f.doctorId, {
    p_leave_start_date: date,
    p_leave_end_date: date,
    p_leave_type: "sick_leave",
    p_reason: "post-hardening RPC write",
  });
  assertEquals(
    created.error,
    null,
    `RPC create leave must still succeed: ${JSON.stringify(created.error)}`,
  );
  const leaveId = String(created.data!.leave_id);

  const stored = await row("doctor_leaves", { id: leaveId });
  assertExists(stored, "the RPC-created leave row is present");

  const cancelled = await cancelLeave(f.adminA.userId, f.hospitalA, leaveId);
  assertEquals(
    cancelled.error,
    null,
    `RPC cancel leave must still succeed: ${JSON.stringify(cancelled.error)}`,
  );
  const afterCancel = await row("doctor_leaves", { id: leaveId });
  assertEquals(afterCancel!.leave_status, "cancelled", "the cancel landed");
});

// ─── 5. Tenant isolation stays enforced on both paths ────────────────────────

Deno.test("wssec1: cross-tenant RPC mutation of A's schedule/leave is refused", async () => {
  const f = fx();

  const editForeignSched = await upsertSchedule(
    f.adminB.userId,
    f.hospitalB,
    f.doctorId,
    {
      p_weekday: 2,
      p_start_time: "09:00:00",
      p_end_time: "12:00:00",
      p_schedule_id: f.scheduleId,
    },
  );
  assertExists(
    editForeignSched.error,
    "B's admin cannot edit A's schedule via the RPC",
  );

  const cancelForeignLeave = await cancelLeave(
    f.adminB.userId,
    f.hospitalB,
    f.leaveId,
  );
  assertExists(
    cancelForeignLeave.error,
    "B's admin cannot cancel A's leave via the RPC",
  );
});

Deno.test("wssec1: cross-tenant DIRECT PostgREST write with a known UUID is refused", async () => {
  const f = fx();
  const { createAuthClient } = await ctx();
  const asB = createAuthClient(f.adminB.token) as AnyClient;

  // Knowing A's row UUID does not help B: the direct write is refused at the
  // privilege/RLS boundary before any tenant check matters.
  const upd = await asB
    .from("doctor_schedules")
    .update({ is_active: false })
    .eq("id", f.scheduleId);
  assertDenied(
    upd.error as RpcError,
    "cross-tenant direct UPDATE doctor_schedules",
  );

  const del = await asB.from("doctor_leaves").delete().eq("id", f.leaveId);
  assertDenied(
    del.error as RpcError,
    "cross-tenant direct DELETE doctor_leaves",
  );
});
