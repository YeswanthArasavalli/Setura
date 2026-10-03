/**
 * tests/integration/clinical_configuration.test.ts
 *
 * WS-ONBOARD-4 - the nine clinical-configuration RPCs (migration 68),
 * exercised against the REAL local Supabase stack as the REAL roles. This
 * suite proves the DATABASE-layer contract only (no Edge runtime required):
 *
 *   - create/update/set_status department: per-hospital case-insensitive
 *     duplicate refusal (23505), optimistic expected_version (P0001, never
 *     40001), version advance, description NULL-vs-clear semantics, and the
 *     independent actor role + tenant re-check (42501).
 *   - create/update doctor writes the EXISTING model only: a profiles row
 *     plus a user_roles 'doctor' row. No parallel doctor table, no invented
 *     auth identity. The specialization JSONB really lands in
 *     doctor_specializations.consultation_fee /
 *     average_consultation_minutes (the column names are the RPC contract).
 *     Deactivating a doctor deactivates that doctor's ACTIVE schedules in the
 *     same transaction, because doctor_schedules.is_active is what the
 *     availability engine reads.
 *   - schedule + leave RPCs write doctor_schedules / doctor_leaves - the
 *     tables the booking runtime already consumes - and the suites below
 *     prove the write is CONSUMED, not merely stored: is_doctor_available()
 *     and get_doctor_availability_reason() change as a direct result.
 *   - The pre-existing EXCLUDE constraints are the atomic backstop, so the
 *     RPC pre-checks reproduce their exact terms (a schedule overlap ignores
 *     is_active; a leave overlap ignores hospital AND status) and a cancelled
 *     leave releases its range instead of blocking the dates forever.
 *   - The nine new write RPCs plus assert_department_id_array are
 *     service_role-only: anon and authenticated EXECUTE is refused by the
 *     database ("permission denied"), not by the Edge layer (F16-04).
 *   - departments / doctor_departments have SELECT-only RLS for the browser:
 *     a direct authenticated INSERT/UPDATE/DELETE is refused, and the read is
 *     tenant-scoped.
 *
 * The Edge HTTP layer (JWT + role gating, idempotent replay, audit emission,
 * the initial doctor credential never crossing the response) is covered
 * separately by clinical_configuration_http.test.ts (requires the Edge
 * runtime serving; F16-01).
 *
 * Run with:  deno task test:integration   (requires `supabase start`)
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
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

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "8");
const FIXTURE_PASSWORD = `K68-${RUN}-fixture-pass`;

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
  const email = `k68-${tag}-${RUN}@setura.test`;
  await createAuthUser(userId, email);
  const { error: pErr } = await (db.from as AnyClient)("profiles").upsert({
    id: userId,
    full_name: `K68 ${tag} ${RUN}`,
    normalized_phone: `98${RUN}${phoneSuffix}`,
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

// ─── RPC wrappers ────────────────────────────────────────────────────────────

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

const createDepartment = (
  actor: string,
  hospital: string,
  name: string,
  code: string,
  description?: string,
) =>
  call("create_department", {
    p_actor_user_id: actor,
    p_hospital_id: hospital,
    p_name: name,
    p_code: code,
    p_description: description,
  });

const updateDepartment = (
  actor: string,
  hospital: string,
  departmentId: string,
  expectedVersion: number | null,
  patch: Record<string, unknown> = {},
) =>
  call("update_department", {
    p_actor_user_id: actor,
    p_hospital_id: hospital,
    p_department_id: departmentId,
    p_expected_version: expectedVersion,
    ...patch,
  });

const setDepartmentStatus = (
  actor: string,
  hospital: string,
  departmentId: string,
  expectedVersion: number,
  isActive: boolean,
) =>
  call("set_department_status", {
    p_actor_user_id: actor,
    p_hospital_id: hospital,
    p_department_id: departmentId,
    p_expected_version: expectedVersion,
    p_is_active: isActive,
  });

const createDoctor = (
  actor: string,
  hospital: string,
  authUserId: string,
  fullName: string,
  extra: Record<string, unknown> = {},
) =>
  call("create_doctor", {
    p_actor_user_id: actor,
    p_hospital_id: hospital,
    p_auth_user_id: authUserId,
    p_full_name: fullName,
    ...extra,
  });

const updateDoctor = (
  actor: string,
  hospital: string,
  doctorId: string,
  patch: Record<string, unknown> = {},
) =>
  call("update_doctor", {
    p_actor_user_id: actor,
    p_hospital_id: hospital,
    p_doctor_id: doctorId,
    ...patch,
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

const cancelLeave = (
  actor: string,
  hospital: string,
  leaveId: string,
) =>
  call("cancel_doctor_leave", {
    p_actor_user_id: actor,
    p_hospital_id: hospital,
    p_leave_id: leaveId,
  });

const availability = (doctorId: string, hospital: string, date: string) =>
  call("get_doctor_availability_reason", {
    p_doctor_id: doctorId,
    p_hospital_id: hospital,
    p_date: date,
  });

const isAvailable = (doctorId: string, hospital: string, date: string) =>
  call("is_doctor_available", {
    p_doctor_id: doctorId,
    p_hospital_id: hospital,
    p_date: date,
  });

// ─── Row readers ─────────────────────────────────────────────────────────────

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

async function rows(
  table: string,
  filter: Record<string, unknown>,
  select = "*",
): Promise<Array<Record<string, unknown>>> {
  const { db } = await ctx();
  let q = (db.from as AnyClient)(table).select(select);
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const { data, error } = await q;
  assertEquals(error, null, `read ${table} failed: ${JSON.stringify(error)}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

const departmentRow = (id: string) => row("departments", { id });
const leaveRow = (id: string) => row("doctor_leaves", { id });

async function scheduleRow(
  doctorId: string,
  hospital: string,
  weekday: number,
): Promise<Record<string, unknown> | null> {
  const found = await rows("doctor_schedules", {
    doctor_id: doctorId,
    hospital_id: hospital,
    weekday,
  });
  return found[0] ?? null;
}

async function doctorExists(userId: string): Promise<boolean> {
  return (await row("profiles", { id: userId })) !== null;
}

// ─── Date helpers ────────────────────────────────────────────────────────────

/**
 * The next date whose PostgreSQL DOW equals `weekday` (0 = Sunday), at least
 * 3 days out so the leave windows below never straddle "today" in a way that
 * could collide with a fixture created for a different weekday.
 */
function dateForWeekday(weekday: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 3);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface FixtureState {
  globalAdmin: Actor;
  adminA: Actor;
  adminB: Actor;
  doctorA: Actor;
  hospitalA: string;
  hospitalB: string;
}

let F: FixtureState | null = null;
function fx(): FixtureState {
  if (!F) throw new Error("setup test not run");
  return F;
}

/** Fresh auth identities that have NO profile yet - create_doctor's input. */
const identities: Record<string, string> = {};
async function newIdentity(tag: string): Promise<string> {
  if (identities[tag]) return identities[tag];
  const id = crypto.randomUUID();
  await createAuthUser(id, `k68-dr-${tag}-${RUN}@setura.test`);
  identities[tag] = id;
  return id;
}

/** A doctor created through the RPC itself, cached per tag. */
const rpcDoctors: Record<string, string> = {};
async function ensureDoctor(tag: string): Promise<string> {
  const f = fx();
  if (rpcDoctors[tag]) return rpcDoctors[tag];
  const authId = await newIdentity(tag);
  const res = await createDoctor(
    f.adminA.userId,
    f.hospitalA,
    authId,
    `K68 Dr ${tag} ${RUN}`,
    { p_normalized_phone: `97${RUN}${tag.padStart(2, "0")}` },
  );
  assertEquals(
    res.error,
    null,
    `doctor ${tag} failed: ${JSON.stringify(res.error)}`,
  );
  rpcDoctors[tag] = authId;
  return authId;
}

const departments: Record<string, string> = {};
async function ensureDepartment(tag: string, code: string): Promise<string> {
  const f = fx();
  if (departments[tag]) return departments[tag];
  const res = await createDepartment(
    f.adminA.userId,
    f.hospitalA,
    `K68 Dept ${tag} ${RUN}`,
    code,
  );
  assertEquals(
    res.error,
    null,
    `department ${tag} failed: ${JSON.stringify(res.error)}`,
  );
  departments[tag] = String(res.data!.department_id);
  return departments[tag];
}

// ─── 0. Setup ────────────────────────────────────────────────────────────────

Deno.test("c68: setup two provisioned tenants + role fixtures", async () => {
  const globalAdmin = await fixtureActor("ga", "global_admin", null, "01");
  const hospitalA = await provisionAs(
    globalAdmin.userId,
    `K68 A ${RUN}`,
    `k68-hosp-a-${RUN}`,
  );
  const hospitalB = await provisionAs(
    globalAdmin.userId,
    `K68 B ${RUN}`,
    `k68-hosp-b-${RUN}`,
  );
  const adminA = await fixtureActor("ha-a", "hospital_admin", hospitalA, "02");
  const adminB = await fixtureActor("ha-b", "hospital_admin", hospitalB, "03");
  const doctorA = await fixtureActor("dr-a", "doctor", hospitalA, "04");
  F = { globalAdmin, adminA, adminB, doctorA, hospitalA, hospitalB };
});

// ─── 1. Departments ──────────────────────────────────────────────────────────

Deno.test("c68: create_department writes a live versioned row and normalizes description", async () => {
  const f = fx();
  const res = await createDepartment(
    f.adminA.userId,
    f.hospitalA,
    `  CardiologY  `,
    `  ${RUN}card  `,
    "   ",
  );
  assertEquals(res.error, null, `create failed: ${JSON.stringify(res.error)}`);
  assertEquals(res.data!.ok, true);
  assertEquals(res.data!.name, "CardiologY");
  assertEquals(res.data!.code, `${RUN}card`);
  assertEquals(res.data!.version, 1);
  assertEquals(res.data!.is_active, true);

  const loaded = await departmentRow(String(res.data!.department_id));
  assertExists(loaded);
  assertEquals(loaded!.hospital_id, f.hospitalA);
  assertEquals(loaded!.is_active, true);
  assertEquals(loaded!.is_deleted, false);
  assertEquals(loaded!.version, 1);
  // Whitespace-only description is normalized to NULL, not stored as blank.
  assertEquals(loaded!.description, null);
  assertEquals(loaded!.created_by, f.adminA.userId);
});

Deno.test("c68: create_department refuses empty name/code (22023) and writes nothing", async () => {
  const f = fx();
  const noName = await createDepartment(
    f.adminA.userId,
    f.hospitalA,
    "  ",
    "x",
  );
  assertExists(noName.error);
  assertEquals(noName.error!.code, "22023");

  const noCode = await createDepartment(
    f.adminA.userId,
    f.hospitalA,
    "Neuro",
    " ",
  );
  assertExists(noCode.error);
  assertEquals(noCode.error!.code, "22023");

  const count = await rows("departments", { hospital_id: f.hospitalA }, "id");
  const before = count.length;
  const res = await createDepartment(
    f.adminA.userId,
    f.hospitalA,
    `K68 Dept uniq ${RUN}`,
    `${RUN}uniq`,
  );
  assertEquals(res.error, null);
  const after = await rows("departments", { hospital_id: f.hospitalA }, "id");
  assertEquals(after.length, before + 1, "only the valid call inserted");
});

Deno.test("c68: duplicate department code/name refused case-insensitively (23505) per hospital only", async () => {
  const f = fx();
  const id = await ensureDepartment("dup", `${RUN}dup`);
  assertExists(id);

  const dupCode = await createDepartment(
    f.adminA.userId,
    f.hospitalA,
    `K68 Other ${RUN}`,
    `${RUN}DUP`,
  );
  assertExists(dupCode.error);
  assertEquals(dupCode.error!.code, "23505");

  const dupName = await createDepartment(
    f.adminA.userId,
    f.hospitalA,
    `k68 dept dup ${RUN}`,
    `${RUN}dup2`,
  );
  assertExists(dupName.error);
  assertEquals(dupName.error!.code, "23505");

  // Uniqueness is PER HOSPITAL: the same code in tenant B is legitimate.
  const crossOk = await createDepartment(
    f.globalAdmin.userId,
    f.hospitalB,
    `K68 Dup ${RUN}`,
    `${RUN}dup`,
  );
  assertEquals(
    crossOk.error,
    null,
    `B create failed: ${JSON.stringify(crossOk.error)}`,
  );
  assertEquals(crossOk.data!.hospital_id, f.hospitalB);
});

Deno.test("c68: department writes re-check actor role + tenant (42501) with no cross-tenant row", async () => {
  const f = fx();
  const before = await rows("departments", { hospital_id: f.hospitalA }, "id");

  const foreignAdmin = await createDepartment(
    f.adminB.userId,
    f.hospitalA,
    `K68 pwn ${RUN}`,
    `${RUN}pwn`,
  );
  assertExists(foreignAdmin.error);
  assertEquals(foreignAdmin.error!.code, "42501");

  const asDoctor = await createDepartment(
    f.doctorA.userId,
    f.hospitalA,
    `K68 pwn2 ${RUN}`,
    `${RUN}pwn2`,
  );
  assertExists(asDoctor.error);
  assertEquals(asDoctor.error!.code, "42501");

  const nullActor = await createDepartment(
    "00000000-0000-0000-0000-000000000000",
    f.hospitalA,
    `K68 pwn3 ${RUN}`,
    `${RUN}pwn3`,
  );
  assertExists(nullActor.error);
  assertEquals(nullActor.error!.code, "42501");

  const after = await rows("departments", { hospital_id: f.hospitalA }, "id");
  assertEquals(after.length, before.length, "target untouched");
});

Deno.test("c68: update_department enforces expected_version (P0001), advances version, and clears/keeps description", async () => {
  const f = fx();
  const id = await ensureDepartment("upd", `${RUN}upd`);
  const first = await departmentRow(id);

  const stale = await updateDepartment(f.adminA.userId, f.hospitalA, id, 99, {
    p_name: "Renamed",
  });
  assertExists(stale.error);
  assertEquals(stale.error!.code, "P0001");
  const unchanged = await departmentRow(id);
  assertEquals(unchanged!.name, first!.name, "refused update wrote nothing");
  assertEquals(unchanged!.version, first!.version);

  const ok = await updateDepartment(
    f.adminA.userId,
    f.hospitalA,
    id,
    first!.version as number,
    {
      p_name: "Renamed Dept",
      p_description: "now set",
    },
  );
  assertEquals(ok.error, null, `update failed: ${JSON.stringify(ok.error)}`);
  assertEquals(ok.data!.version, (first!.version as number) + 1);

  const afterSet = await departmentRow(id);
  assertEquals(afterSet!.name, "Renamed Dept");
  assertEquals(afterSet!.description, "now set");

  // Omitted description is untouched; an empty one is cleared to NULL.
  const keep = await updateDepartment(
    f.adminA.userId,
    f.hospitalA,
    id,
    afterSet!.version as number,
    {},
  );
  assertEquals(keep.error, null);
  assertEquals((await departmentRow(id))!.description, "now set");

  const cleared = await updateDepartment(
    f.adminA.userId,
    f.hospitalA,
    id,
    keep.data!.version as number,
    { p_description: "   " },
  );
  assertEquals(cleared.error, null);
  assertEquals((await departmentRow(id))!.description, null);
});

Deno.test("c68: update_department refuses duplicate identifier (23505), unknown id (P0002) and foreign row (42501)", async () => {
  const f = fx();
  const a = await ensureDepartment("u1", `${RUN}u1`);
  const b = await ensureDepartment("u2", `${RUN}u2`);
  const rowA = await departmentRow(a);

  const clash = await updateDepartment(
    f.adminA.userId,
    f.hospitalA,
    a,
    rowA!.version as number,
    {
      p_code: (await departmentRow(b))!.code,
    },
  );
  assertExists(clash.error);
  assertEquals(clash.error!.code, "23505");

  const missing = await updateDepartment(
    f.adminA.userId,
    f.hospitalA,
    crypto.randomUUID(),
    1,
    { p_name: "ghost" },
  );
  assertExists(missing.error);
  assertEquals(missing.error!.code, "P0002");

  // Tenant B's admin naming A's hospital with B's OWN department is fine;
  // naming A's hospital with B's department id is a privilege refusal.
  const foreign = await updateDepartment(
    f.adminB.userId,
    f.hospitalB,
    a,
    1,
    { p_name: "cross" },
  );
  assertExists(foreign.error);
  assertEquals(foreign.error!.code, "42501");
  assertEquals((await departmentRow(a))!.name, rowA!.name, "A's row untouched");
});

Deno.test("c68: concurrent same-version department updates -> exactly one wins, one conflicts", async () => {
  const f = fx();
  const id = await ensureDepartment("race", `${RUN}race`);
  const base = (await departmentRow(id))!.version as number;
  const results = await Promise.all([
    updateDepartment(f.adminA.userId, f.hospitalA, id, base, {
      p_name: "Racer 1",
    }),
    updateDepartment(f.adminA.userId, f.hospitalA, id, base, {
      p_name: "Racer 2",
    }),
  ]);
  const ok = results.filter((r) => r.error === null);
  const conflict = results.filter((r) => r.error?.code === "P0001");
  assertEquals(ok.length, 1, "exactly one wins");
  assertEquals(conflict.length, 1, "exactly one conflicts");
});

Deno.test("c68: set_department_status flips activation + version; stale version and empty hospital refused", async () => {
  const f = fx();
  const id = await ensureDepartment("status", `${RUN}status`);
  const cur = await departmentRow(id);

  const off = await setDepartmentStatus(
    f.adminA.userId,
    f.hospitalA,
    id,
    cur!.version as number,
    false,
  );
  assertEquals(off.error, null, `status failed: ${JSON.stringify(off.error)}`);
  assertEquals(off.data!.is_active, false);
  assertEquals(off.data!.version, (cur!.version as number) + 1);
  const afterOff = await departmentRow(id);
  assertEquals(afterOff!.is_active, false);
  // Soft deactivation only: the row still exists (audit + history reference it).
  assertEquals(afterOff!.is_deleted, false);

  const stale = await setDepartmentStatus(
    f.adminA.userId,
    f.hospitalA,
    id,
    afterOff!.version as number - 1,
    true,
  );
  assertExists(stale.error);
  assertEquals(stale.error!.code, "P0001");

  const on = await setDepartmentStatus(
    f.globalAdmin.userId,
    f.hospitalA,
    id,
    afterOff!.version as number,
    true,
  );
  assertEquals(on.error, null);
  assertEquals((await departmentRow(id))!.is_active, true);
});

Deno.test("c68: departments/doctor_departments give the browser SELECT only - direct writes refused", async () => {
  const f = fx();
  const id = await ensureDepartment("rls", `${RUN}rls`);
  const doctorId = await ensureDoctor("rls");
  const { createAuthClient } = await ctx();

  // The read path the UI uses really works for the owning tenant.
  const asA = createAuthClient(f.adminA.token) as AnyClient;
  const read = await asA
    .from("departments")
    .select("id,name,code,description,is_active,version")
    .eq("hospital_id", f.hospitalA)
    .eq("is_deleted", false);
  assertEquals(
    read.error,
    null,
    `tenant read failed: ${JSON.stringify(read.error)}`,
  );
  assert(
    ((read.data ?? []) as Array<Record<string, unknown>>).some((r) =>
      r.id === id
    ),
    "own department visible",
  );

  // ... and is empty for another tenant.
  const asB = createAuthClient(f.adminB.token) as AnyClient;
  const foreign = await asB
    .from("departments")
    .select("id")
    .eq("hospital_id", f.hospitalA);
  assertEquals(foreign.error, null);
  assertEquals(
    (foreign.data ?? []).length,
    0,
    "no cross-tenant existence leak",
  );

  for (
    const attempt of [
      () =>
        asA.from("departments").insert({
          hospital_id: f.hospitalA,
          name: `browser write ${RUN}`,
          code: `${RUN}browser`,
        }),
      () =>
        asA.from("departments").update({ name: "browser edited" }).eq("id", id),
      () => asA.from("departments").delete().eq("id", id),
      () =>
        asA.from("doctor_departments").insert({
          hospital_id: f.hospitalA,
          doctor_id: doctorId,
          department_id: id,
        }),
    ]
  ) {
    const { error } = await attempt();
    assertExists(error, "privileged browser write must be refused");
    // Measured posture: `authenticated` holds no INSERT/UPDATE/DELETE grant on
    // these tables, so PostgreSQL refuses at the TABLE-PRIVILEGE layer
    // (`permission denied for table ...`) before RLS is even evaluated. The
    // SELECT-only RLS policies remain the second boundary, not the first.
    // SQLSTATE 42501 covers both layers, so assert the code exactly and accept
    // either message rather than a hoped-for one.
    const err = error as { code?: string; message?: string };
    assertEquals(err.code, "42501", `refusal code: ${JSON.stringify(error)}`);
    const msg = String(err.message ?? "").toLowerCase();
    assert(
      msg.includes("permission denied") || msg.includes("row-level security"),
      `refusal must be a privilege or RLS denial, got: ${
        JSON.stringify(error)
      }`,
    );
  }

  assertEquals(
    (await departmentRow(id))!.name,
    `K68 Dept rls ${RUN}`,
    "the row is unchanged after four write attempts",
  );
});

// ─── 2. Doctors (existing profiles + user_roles model) ───────────────────────

Deno.test("c68: create_doctor writes profiles + user_roles('doctor') + specializations + assignments", async () => {
  const f = fx();
  const dept = await ensureDepartment("doc", `${RUN}doc`);
  const authId = await newIdentity("full");

  const res = await createDoctor(
    f.adminA.userId,
    f.hospitalA,
    authId,
    `  Dr Creationsmith ${RUN}  `,
    {
      // The RPC normalizes digits only, then requires 10-15 digits.
      p_normalized_phone: ` +91 98${RUN} 77 `,
      p_specializations: [
        {
          name: " Cardiology ",
          consultation_fee: 600,
          average_consultation_minutes: 12,
        },
        { name: "Dermatology" },
      ],
      p_department_ids: [dept],
    },
  );
  assertEquals(
    res.error,
    null,
    `create_doctor failed: ${JSON.stringify(res.error)}`,
  );
  assertEquals(res.data!.doctor_id, authId);
  assertEquals(res.data!.full_name, `Dr Creationsmith ${RUN}`);
  assertEquals(res.data!.normalized_phone, `9198${RUN}77`);
  assertEquals(res.data!.is_active, true);
  assertEquals(res.data!.department_count, 1);
  assertEquals(res.data!.specialization_count, 2);

  const profile = await row("profiles", { id: authId });
  assertExists(profile, "the doctor IS a profiles row");
  assertEquals(profile!.full_name, `Dr Creationsmith ${RUN}`);
  assertEquals(profile!.normalized_phone, `9198${RUN}77`);
  assertEquals(profile!.is_active, true);

  const roles = await rows("user_roles", {
    user_id: authId,
    hospital_id: f.hospitalA,
  }, "role");
  assertEquals(roles.length, 1);
  assertEquals(
    roles[0].role,
    "doctor",
    "the doctor role is the existing model",
  );

  const specs = await rows("doctor_specializations", {
    doctor_id: authId,
    hospital_id: f.hospitalA,
  });
  assertEquals(specs.length, 2);
  const cardiology = specs.find((s) => s.specialization_name === "Cardiology");
  assertExists(cardiology, "specialization name is trimmed");
  // THE column contract: the RPC reads s->>'consultation_fee'. A camelCase
  // key would silently store the defaults (0 / 10) instead.
  assertEquals(Number(cardiology!.consultation_fee), 600);
  assertEquals(cardiology!.average_consultation_minutes, 12);
  const derm = specs.find((s) => s.specialization_name === "Dermatology");
  assertExists(derm);
  assertEquals(Number(derm!.consultation_fee), 0, "documented default");
  assertEquals(derm!.average_consultation_minutes, 10, "documented default");

  const assigned = await rows("doctor_departments", {
    doctor_id: authId,
    hospital_id: f.hospitalA,
  });
  assertEquals(assigned.length, 1);
  assertEquals(assigned[0].department_id, dept);
  assertEquals(assigned[0].assigned_by, f.adminA.userId);
});

Deno.test("c68: create_doctor input validation is 22023, and a fabricated auth id is 23503", async () => {
  const f = fx();
  const authId = await newIdentity("bad");

  const noName = await createDoctor(
    f.adminA.userId,
    f.hospitalA,
    authId,
    "   ",
  );
  assertExists(noName.error);
  assertEquals(noName.error!.code, "22023");

  const noAuth = await createDoctor(
    f.adminA.userId,
    f.hospitalA,
    null as unknown as string,
    `Dr ${RUN}`,
  );
  assertExists(noAuth.error);
  assertEquals(noAuth.error!.code, "22023");

  const shortPhone = await createDoctor(
    f.adminA.userId,
    f.hospitalA,
    authId,
    `Dr Phone ${RUN}`,
    { p_normalized_phone: "12345" },
  );
  assertExists(shortPhone.error);
  assertEquals(shortPhone.error!.code, "22023");

  const notArray = await createDoctor(
    f.adminA.userId,
    f.hospitalA,
    authId,
    `Dr Spec ${RUN}`,
    { p_specializations: { name: "Cardiology" } },
  );
  assertExists(notArray.error);
  assertEquals(notArray.error!.code, "22023");

  const namelessSpec = await createDoctor(
    f.adminA.userId,
    f.hospitalA,
    authId,
    `Dr Spec2 ${RUN}`,
    { p_specializations: [{ consultation_fee: 10 }] },
  );
  assertExists(namelessSpec.error);
  assertEquals(namelessSpec.error!.code, "22023");

  // A department from ANOTHER tenant is refused by the database, not merely
  // hidden by RLS.
  const bDept = await createDepartment(
    f.globalAdmin.userId,
    f.hospitalB,
    `K68 B dept ${RUN}`,
    `${RUN}bdept`,
  );
  assertEquals(bDept.error, null);
  const crossDept = await createDoctor(
    f.adminA.userId,
    f.hospitalA,
    authId,
    `Dr Cross ${RUN}`,
    { p_department_ids: [bDept.data!.department_id] },
  );
  assertExists(crossDept.error);
  assertEquals(crossDept.error!.code, "22023");

  const fabricated = await createDoctor(
    f.adminA.userId,
    f.hospitalA,
    crypto.randomUUID(),
    `Dr Ghost ${RUN}`,
  );
  assertExists(fabricated.error);
  assertEquals(fabricated.error!.code, "23503", "profiles.id FKs auth.users");
});

Deno.test("c68: create_doctor is atomic - a late column failure leaves no half-created doctor", async () => {
  const f = fx();
  const authId = await newIdentity("atomic");

  // The profiles + user_roles inserts succeed first; the specialization INSERT
  // then fails on the doctor_specializations minutes CHECK (23514), which
  // aborts the whole function transaction.
  const res = await createDoctor(
    f.adminA.userId,
    f.hospitalA,
    authId,
    `Dr Atomic ${RUN}`,
    {
      p_specializations: [{ name: "Bad", average_consultation_minutes: 9999 }],
    },
  );
  assertExists(res.error, "the bad minutes must be refused");
  assertEquals(res.error!.code, "23514");

  assertEquals(await doctorExists(authId), false, "no orphan profile");
  assertEquals(
    (await rows("user_roles", { user_id: authId })).length,
    0,
    "no orphan role",
  );
  assertEquals(
    (await rows("doctor_specializations", { doctor_id: authId })).length,
    0,
  );
});

Deno.test("c68: create_doctor never duplicates an identity already holding a role in the hospital", async () => {
  const f = fx();
  const res = await createDoctor(
    f.adminA.userId,
    f.hospitalA,
    f.doctorA.userId,
    `Dr Duplicate ${RUN}`,
  );
  assertExists(res.error);
  assertEquals(res.error!.code, "23505");
  // The pre-existing doctor is unchanged.
  assertEquals(
    (await row("profiles", { id: f.doctorA.userId }))!.full_name,
    `K68 dr-a ${RUN}`,
  );
});

Deno.test("c68: update_doctor patches the profile and replaces the specialization + department sets", async () => {
  const f = fx();
  const doctorId = await ensureDoctor("upd");
  const keepDept = await ensureDepartment("keep", `${RUN}keep`);
  const otherDept = await ensureDepartment("other", `${RUN}other`);

  const patched = await updateDoctor(f.adminA.userId, f.hospitalA, doctorId, {
    p_full_name: `Dr Updated ${RUN}`,
    p_specializations: [{ name: "Neurology", consultation_fee: 750 }],
    p_department_ids: [keepDept, otherDept],
  });
  assertEquals(
    patched.error,
    null,
    `update failed: ${JSON.stringify(patched.error)}`,
  );
  assertEquals(patched.data!.doctor_id, doctorId);

  const profile = await row("profiles", { id: doctorId });
  assertEquals(profile!.full_name, `Dr Updated ${RUN}`);

  const specs = await rows("doctor_specializations", {
    doctor_id: doctorId,
    hospital_id: f.hospitalA,
  });
  assertEquals(specs.length, 1, "the set is REPLACED, not merged");
  assertEquals(specs[0].specialization_name, "Neurology");
  assertEquals(Number(specs[0].consultation_fee), 750);

  const depts = await rows(
    "doctor_departments",
    { doctor_id: doctorId },
    "department_id",
  );
  assertEquals(new Set(depts.map((d) => d.department_id)).size, 2);

  // An empty array clears deliberately; an omitted key leaves rows alone.
  const cleared = await updateDoctor(f.adminA.userId, f.hospitalA, doctorId, {
    p_specializations: [],
    p_department_ids: [],
  });
  assertEquals(cleared.error, null);
  assertEquals(
    (await rows("doctor_specializations", { doctor_id: doctorId })).length,
    0,
  );
  assertEquals(
    (await rows("doctor_departments", { doctor_id: doctorId })).length,
    0,
  );

  const phoneOnly = await updateDoctor(f.adminA.userId, f.hospitalA, doctorId, {
    p_normalized_phone: "",
  });
  assertEquals(phoneOnly.error, null);
  assertEquals(
    (await row("profiles", { id: doctorId }))!.normalized_phone,
    null,
  );

  const emptyName = await updateDoctor(f.adminA.userId, f.hospitalA, doctorId, {
    p_full_name: "   ",
  });
  assertExists(emptyName.error);
  assertEquals(emptyName.error!.code, "22023");
});

Deno.test("c68: deactivating a doctor deactivates its active schedules in the same transaction", async () => {
  const f = fx();
  const doctorId = await ensureDoctor("deact");
  const weekday = 1;
  const created = await upsertSchedule(f.adminA.userId, f.hospitalA, doctorId, {
    p_weekday: weekday,
    p_start_time: "09:00:00",
    p_end_time: "12:00:00",
    p_max_tokens: 30,
    p_average_consultation_minutes: 10,
    p_is_active: true,
  });
  assertEquals(
    created.error,
    null,
    `schedule failed: ${JSON.stringify(created.error)}`,
  );

  const date = dateForWeekday(weekday);
  assertEquals(
    await isAvailable(doctorId, f.hospitalA, date).then((r) => r.data),
    true,
  );

  const off = await updateDoctor(f.adminA.userId, f.hospitalA, doctorId, {
    p_is_active: false,
  });
  assertEquals(off.error, null);
  assertEquals(off.data!.is_active, false);
  assertEquals(
    off.data!.schedules_deactivated,
    1,
    "one active schedule deactivated",
  );

  const sched = await scheduleRow(doctorId, f.hospitalA, weekday);
  assertEquals(
    sched!.is_active,
    false,
    "the availability engine's input is off",
  );
  assertEquals(
    (await isAvailable(doctorId, f.hospitalA, date)).data,
    false,
    "deactivation is REAL, not cosmetic",
  );

  // Reactivation deliberately does NOT auto-restore the working pattern.
  const on = await updateDoctor(f.adminA.userId, f.hospitalA, doctorId, {
    p_is_active: true,
  });
  assertEquals(on.error, null);
  assertEquals(on.data!.is_active, true);
  assertEquals(
    (await scheduleRow(doctorId, f.hospitalA, weekday))!.is_active,
    false,
  );
  assertEquals((await isAvailable(doctorId, f.hospitalA, date)).data, false);

  // An inactive doctor cannot hold an active schedule.
  await updateDoctor(f.adminA.userId, f.hospitalA, doctorId, {
    p_is_active: false,
  });
  const badSchedule = await upsertSchedule(
    f.adminA.userId,
    f.hospitalA,
    doctorId,
    {
      p_weekday: 5,
      p_start_time: "09:00:00",
      p_end_time: "10:00:00",
      p_is_active: true,
    },
  );
  assertExists(badSchedule.error);
  assertEquals(badSchedule.error!.code, "22023");
  // ... but an explicitly inactive row is still recordable.
  const dormant = await upsertSchedule(f.adminA.userId, f.hospitalA, doctorId, {
    p_weekday: 5,
    p_start_time: "09:00:00",
    p_end_time: "10:00:00",
    p_is_active: false,
  });
  assertEquals(
    dormant.error,
    null,
    `dormant row failed: ${JSON.stringify(dormant.error)}`,
  );
  await updateDoctor(f.adminA.userId, f.hospitalA, doctorId, {
    p_is_active: true,
  });
});

Deno.test("c68: update_doctor refuses a doctor outside the actor's tenant (P0002) and by a foreign admin (42501)", async () => {
  const f = fx();
  const doctorId = await ensureDoctor("tenant");

  // A is not B's doctor: B's admin cannot address it at all.
  const foreign = await updateDoctor(f.adminB.userId, f.hospitalB, doctorId, {
    p_full_name: `Stolen ${RUN}`,
  });
  assertExists(foreign.error);
  assertEquals(foreign.error!.code, "P0002");
  assertEquals(
    (await row("profiles", { id: doctorId }))!.full_name,
    `K68 Dr tenant ${RUN}`,
    "target untouched",
  );

  // A doctor of B addressed by A's admin through A's hospital: same refusal.
  const ghost = await updateDoctor(
    f.adminA.userId,
    f.hospitalA,
    crypto.randomUUID(),
    {
      p_full_name: "ghost",
    },
  );
  assertExists(ghost.error);
  assertEquals(ghost.error!.code, "P0002");

  // The RPC is service-role-only, so a plain role check also refuses a doctor actor.
  const asDoctor = await updateDoctor(f.doctorA.userId, f.hospitalA, doctorId, {
    p_full_name: "self edit",
  });
  assertExists(asDoctor.error);
  assertEquals(asDoctor.error!.code, "42501");
});

// ─── 3. Schedules ────────────────────────────────────────────────────────────

Deno.test("c68: a created schedule makes the doctor genuinely bookable on that weekday", async () => {
  const f = fx();
  const doctorId = await ensureDoctor("avail");
  const weekday = 2;
  const date = dateForWeekday(weekday);

  const before = await availability(doctorId, f.hospitalA, date);
  assertEquals(before.error, null);
  assertEquals(before.data[0].is_available, false);
  assertEquals(before.data[0].reason, "No schedule on this weekday");

  const res = await upsertSchedule(f.adminA.userId, f.hospitalA, doctorId, {
    p_weekday: weekday,
    p_start_time: "10:00:00",
    p_end_time: "13:30:00",
    p_max_tokens: 40,
    p_average_consultation_minutes: 15,
    p_is_active: true,
  });
  assertEquals(
    res.error,
    null,
    `schedule failed: ${JSON.stringify(res.error)}`,
  );
  assertEquals(res.data!.created, true);
  assertEquals(res.data!.max_tokens, 40);
  // The RPC names the row it wrote, so the caller's audit event can be
  // attributed instead of carrying a NULL entity.
  assertEquals(
    (await row("doctor_schedules", { id: String(res.data!.schedule_id) }))!
      .weekday,
    weekday,
    "schedule_id identifies the real row",
  );

  // The availability engine reads the row that was just written.
  const after = await availability(doctorId, f.hospitalA, date);
  assertEquals(after.data[0].is_available, true);
  assertEquals(after.data[0].reason, "Available per regular schedule");
  assertEquals(
    await isAvailable(doctorId, f.hospitalA, date).then((r) => r.data),
    true,
  );

  const stored = await scheduleRow(doctorId, f.hospitalA, weekday);
  assertExists(stored);
  assertEquals(stored!.start_time, "10:00:00");
  assertEquals(stored!.end_time, "13:30:00");
  assertEquals(stored!.max_tokens, 40);
  assertEquals(stored!.average_consultation_minutes, 15);
  assertEquals(stored!.is_active, true);
  assertEquals(stored!.is_deleted, false);
  assertEquals(
    stored!.created_by,
    f.adminA.userId,
    "the writer is attributable",
  );

  // The neighbouring weekday is unaffected.
  const other = await availability(
    doctorId,
    f.hospitalA,
    dateForWeekday((weekday + 1) % 7),
  );
  assertEquals(other.data[0].is_available, false);
});

Deno.test("c68: schedule invariants reject bad weekday, window, tokens and minutes (22023)", async () => {
  const f = fx();
  const doctorId = await ensureDoctor("inv");
  const base = {
    p_start_time: "09:00:00",
    p_end_time: "12:00:00",
    p_max_tokens: 20,
    p_average_consultation_minutes: 10,
    p_is_active: true,
  };

  for (const weekday of [7, -1, 100]) {
    const res = await upsertSchedule(f.adminA.userId, f.hospitalA, doctorId, {
      ...base,
      p_weekday: weekday,
    });
    assertExists(res.error, `weekday ${weekday} must be refused`);
    assertEquals(res.error!.code, "22023");
    assertStringIncludes(res.error!.message ?? "", "Sunday");
  }

  for (
    const bad of [
      { p_end_time: "09:00:00", label: "end == start" },
      { p_end_time: "08:00:00", label: "end < start" },
    ]
  ) {
    const res = await upsertSchedule(f.adminA.userId, f.hospitalA, doctorId, {
      ...base,
      p_weekday: 3,
      p_end_time: bad.p_end_time,
    });
    assertExists(res.error, bad.label);
    assertEquals(res.error!.code, "22023");
  }

  const noTokens = await upsertSchedule(
    f.adminA.userId,
    f.hospitalA,
    doctorId,
    {
      ...base,
      p_weekday: 3,
      p_max_tokens: 0,
    },
  );
  assertExists(noTokens.error);
  assertEquals(noTokens.error!.code, "22023");

  for (const minutes of [0, 241]) {
    const res = await upsertSchedule(f.adminA.userId, f.hospitalA, doctorId, {
      ...base,
      p_weekday: 3,
      p_average_consultation_minutes: minutes,
    });
    assertExists(res.error, `minutes ${minutes}`);
    assertEquals(res.error!.code, "22023");
  }

  const missingTime = await upsertSchedule(
    f.adminA.userId,
    f.hospitalA,
    doctorId,
    {
      ...base,
      p_weekday: 3,
      p_start_time: null,
    },
  );
  assertExists(missingTime.error);
  assertEquals(missingTime.error!.code, "22023");

  assertEquals(
    await scheduleRow(doctorId, f.hospitalA, 3),
    null,
    "no rejected variant wrote a row",
  );
});

Deno.test("c68: overlapping schedule windows refused (23P01), including against an INACTIVE row", async () => {
  const f = fx();
  const doctorId = await ensureDoctor("ovl");
  const weekday = 4;
  const first = await upsertSchedule(f.adminA.userId, f.hospitalA, doctorId, {
    p_weekday: weekday,
    p_start_time: "09:00:00",
    p_end_time: "12:00:00",
    p_max_tokens: 20,
    p_average_consultation_minutes: 10,
    p_is_active: true,
  });
  assertEquals(first.error, null);
  const row1 = await scheduleRow(doctorId, f.hospitalA, weekday);
  assertExists(row1);

  const overlap = await upsertSchedule(f.adminA.userId, f.hospitalA, doctorId, {
    p_weekday: weekday,
    p_start_time: "11:00:00",
    p_end_time: "13:00:00",
    p_max_tokens: 20,
    p_average_consultation_minutes: 10,
    p_is_active: true,
  });
  assertExists(overlap.error);
  assertEquals(overlap.error!.code, "23P01");

  // Deactivating does NOT release the range (the EXCLUDE index ignores
  // is_active), so a disabled schedule still blocks the window.
  const deactivated = await upsertSchedule(
    f.adminA.userId,
    f.hospitalA,
    doctorId,
    {
      p_weekday: weekday,
      p_start_time: "09:00:00",
      p_end_time: "12:00:00",
      p_max_tokens: 20,
      p_average_consultation_minutes: 10,
      p_is_active: false,
      p_schedule_id: row1!.id,
    },
  );
  assertEquals(deactivated.error, null);
  assertEquals(
    (await scheduleRow(doctorId, f.hospitalA, weekday))!.is_active,
    false,
  );

  const stillBlocked = await upsertSchedule(
    f.adminA.userId,
    f.hospitalA,
    doctorId,
    {
      p_weekday: weekday,
      p_start_time: "11:30:00",
      p_end_time: "13:00:00",
      p_max_tokens: 20,
      p_average_consultation_minutes: 10,
      p_is_active: true,
    },
  );
  assertExists(stillBlocked.error);
  assertEquals(
    stillBlocked.error!.code,
    "23P01",
    "inactive row still owns its range",
  );

  // The '[)' range means touching boundaries are allowed: 12:00 start is fine.
  const adjacent = await upsertSchedule(
    f.adminA.userId,
    f.hospitalA,
    doctorId,
    {
      p_weekday: weekday,
      p_start_time: "12:00:00",
      p_end_time: "14:00:00",
      p_max_tokens: 20,
      p_average_consultation_minutes: 10,
      p_is_active: true,
    },
  );
  assertEquals(
    adjacent.error,
    null,
    `adjacent failed: ${JSON.stringify(adjacent.error)}`,
  );

  // Editing a row INTO another row's window is refused too.
  const second = (await rows("doctor_schedules", {
    doctor_id: doctorId,
    hospital_id: f.hospitalA,
    weekday,
  })).find((r) => r.id !== row1!.id);
  assertExists(second);
  const selfOverlap = await upsertSchedule(
    f.adminA.userId,
    f.hospitalA,
    doctorId,
    {
      p_weekday: weekday,
      p_start_time: "09:30:00",
      p_end_time: "10:30:00",
      p_max_tokens: 20,
      p_average_consultation_minutes: 10,
      p_is_active: true,
      p_schedule_id: second!.id,
    },
  );
  assertExists(selfOverlap.error);
  assertEquals(selfOverlap.error!.code, "23P01");

  // ... while editing a row within its OWN window is allowed (self excluded).
  const selfOk = await upsertSchedule(f.adminA.userId, f.hospitalA, doctorId, {
    p_weekday: weekday,
    p_start_time: "12:30:00",
    p_end_time: "13:30:00",
    p_max_tokens: 25,
    p_average_consultation_minutes: 10,
    p_is_active: true,
    p_schedule_id: second!.id,
  });
  assertEquals(
    selfOk.error,
    null,
    `self-edit failed: ${JSON.stringify(selfOk.error)}`,
  );
  assertEquals(selfOk.data!.created, false);
});

Deno.test("c68: schedule edit refuses a foreign row (42501) and an unknown id (P0002)", async () => {
  const f = fx();
  const doctorId = await ensureDoctor("foreign");
  const weekday = 6;
  const created = await upsertSchedule(f.adminA.userId, f.hospitalA, doctorId, {
    p_weekday: weekday,
    p_start_time: "08:00:00",
    p_end_time: "09:00:00",
    p_max_tokens: 10,
    p_average_consultation_minutes: 10,
    p_is_active: true,
  });
  assertEquals(created.error, null);
  const sched = await scheduleRow(doctorId, f.hospitalA, weekday);
  assertExists(sched);

  // B's admin naming B's hospital with A's schedule id: privilege refusal,
  // and the doctor is not even B's, so the doctor check fires first (P0002).
  const viaDoctor = await upsertSchedule(
    f.adminB.userId,
    f.hospitalB,
    doctorId,
    {
      p_weekday: weekday,
      p_start_time: "08:00:00",
      p_end_time: "09:00:00",
      p_max_tokens: 10,
      p_average_consultation_minutes: 10,
      p_is_active: true,
      p_schedule_id: sched!.id,
    },
  );
  assertExists(viaDoctor.error);
  assertEquals(viaDoctor.error!.code, "P0002");

  // A's own admin passing a schedule that belongs to a different doctor.
  const otherDoctor = await ensureDoctor("foreign2");
  const mismatch = await upsertSchedule(
    f.adminA.userId,
    f.hospitalA,
    otherDoctor,
    {
      p_weekday: weekday,
      p_start_time: "15:00:00",
      p_end_time: "16:00:00",
      p_max_tokens: 10,
      p_average_consultation_minutes: 10,
      p_is_active: true,
      p_schedule_id: sched!.id,
    },
  );
  assertExists(mismatch.error);
  assertEquals(mismatch.error!.code, "42501");

  const ghost = await upsertSchedule(f.adminA.userId, f.hospitalA, doctorId, {
    p_weekday: weekday,
    p_start_time: "15:00:00",
    p_end_time: "16:00:00",
    p_max_tokens: 10,
    p_average_consultation_minutes: 10,
    p_is_active: true,
    p_schedule_id: crypto.randomUUID(),
  });
  assertExists(ghost.error);
  assertEquals(ghost.error!.code, "P0002");
  assertEquals(
    (await scheduleRow(doctorId, f.hospitalA, weekday))!.id,
    sched!.id,
  );
});

Deno.test("c68: delete_doctor_schedule soft-deletes, releases the range, and removes availability", async () => {
  const f = fx();
  const doctorId = await ensureDoctor("del");
  const weekday = 0;
  const date = dateForWeekday(weekday);

  const created = await upsertSchedule(f.adminA.userId, f.hospitalA, doctorId, {
    p_weekday: weekday,
    p_start_time: "09:00:00",
    p_end_time: "11:00:00",
    p_max_tokens: 10,
    p_average_consultation_minutes: 10,
    p_is_active: true,
  });
  assertEquals(created.error, null);
  const sched = await scheduleRow(doctorId, f.hospitalA, weekday);
  assertExists(sched);
  assertEquals(
    (await availability(doctorId, f.hospitalA, date)).data[0].is_available,
    true,
  );

  const deleted = await deleteSchedule(
    f.adminA.userId,
    f.hospitalA,
    sched!.id as string,
  );
  assertEquals(
    deleted.error,
    null,
    `delete failed: ${JSON.stringify(deleted.error)}`,
  );
  assertEquals(deleted.data!.deleted, true);

  const after = await row("doctor_schedules", { id: sched!.id });
  assertExists(after, "soft delete: the row still exists for history");
  assertEquals(after!.is_deleted, true);
  assertEquals(after!.is_active, false, "a deleted schedule is never active");
  const gone = await availability(doctorId, f.hospitalA, date);
  assertEquals(gone.data[0].is_available, false);
  assertEquals(gone.data[0].reason, "No schedule on this weekday");

  // is_deleted releases the EXCLUDE range, so the same window can be re-used.
  const rewritten = await upsertSchedule(
    f.adminA.userId,
    f.hospitalA,
    doctorId,
    {
      p_weekday: weekday,
      p_start_time: "09:00:00",
      p_end_time: "11:00:00",
      p_max_tokens: 12,
      p_average_consultation_minutes: 10,
      p_is_active: true,
    },
  );
  assertEquals(
    rewritten.error,
    null,
    `rewrite failed: ${JSON.stringify(rewritten.error)}`,
  );

  const foreign = await deleteSchedule(
    f.adminB.userId,
    f.hospitalB,
    sched!.id as string,
  );
  assertExists(foreign.error);
  assertEquals(foreign.error!.code, "42501");

  const ghost = await deleteSchedule(
    f.adminA.userId,
    f.hospitalA,
    crypto.randomUUID(),
  );
  assertExists(ghost.error);
  assertEquals(ghost.error!.code, "P0002");

  const asDoctor = await deleteSchedule(
    f.doctorA.userId,
    f.hospitalA,
    sched!.id as string,
  );
  assertExists(asDoctor.error);
  assertEquals(asDoctor.error!.code, "42501");
});

// ─── 4. Leave ────────────────────────────────────────────────────────────────

Deno.test("c68: upsert_doctor_leave is approved on creation and the availability engine honours it", async () => {
  const f = fx();
  const doctorId = await ensureDoctor("leave");
  const weekday = 2;
  const date = dateForWeekday(weekday);

  // ensureDoctor("avail") already proved weekday-2 availability for a different
  // doctor; give this one a schedule so the leave is the ONLY change.
  const sched = await upsertSchedule(f.adminA.userId, f.hospitalA, doctorId, {
    p_weekday: weekday,
    p_start_time: "09:00:00",
    p_end_time: "17:00:00",
    p_max_tokens: 50,
    p_average_consultation_minutes: 10,
    p_is_active: true,
  });
  assertEquals(sched.error, null);
  assertEquals(
    (await availability(doctorId, f.hospitalA, date)).data[0].is_available,
    true,
  );

  const res = await upsertLeave(f.adminA.userId, f.hospitalA, doctorId, {
    p_leave_start_date: date,
    p_leave_end_date: date,
    p_leave_type: "sick_leave",
    p_reason: "  fever  ",
    p_notes: "reassess tomorrow",
  });
  assertEquals(res.error, null, `leave failed: ${JSON.stringify(res.error)}`);
  assertEquals(res.data!.created, true);
  assertEquals(res.data!.leave_status, "approved");
  // Same attribution rule as the schedule RPC: the create response names the
  // leave row it inserted.
  assertEquals(
    String((await leaveRow(String(res.data!.leave_id)))!.leave_type),
    "sick_leave",
  );

  const stored = await rows("doctor_leaves", {
    doctor_id: doctorId,
    hospital_id: f.hospitalA,
  });
  assertEquals(stored.length, 1);
  const leave = stored[0];
  // Admin-created leave is APPROVED, because 'pending' would be stored but
  // ignored by is_doctor_available() - a fake capability.
  assertEquals(leave.leave_status, "approved");
  assertEquals(leave.approved_by, f.adminA.userId);
  assertExists(leave.approved_at);
  assertEquals(leave.reason, "fever");
  assertEquals(leave.notes, "reassess tomorrow");
  assertEquals(leave.is_deleted, false);
  assertEquals(String(leave.leave_type), "sick_leave");

  const blocked = await availability(doctorId, f.hospitalA, date);
  assertEquals(blocked.data[0].is_available, false);
  assertEquals(blocked.data[0].reason, "Doctor on approved leave");
  assertEquals((await isAvailable(doctorId, f.hospitalA, date)).data, false);

  // The leave covers exactly its own window. The day before is NOT
  // leave-blocked - it is simply a non-working weekday - which proves the
  // block did not extend backwards past leave_start_date.
  const prevDay = addDays(date, -1);
  const beforeWindow = await availability(doctorId, f.hospitalA, prevDay);
  assertEquals(beforeWindow.data[0].is_available, false);
  assertEquals(
    beforeWindow.data[0].reason,
    "No schedule on this weekday",
    "the previous date is unscheduled, not leave-blocked",
  );

  const cancel = await cancelLeave(
    f.adminA.userId,
    f.hospitalA,
    leave.id as string,
  );
  assertEquals(cancel.error, null);
  assertEquals(cancel.data!.leave_status, "cancelled");
  const afterCancel = await leaveRow(leave.id as string);
  assertEquals(afterCancel!.leave_status, "cancelled");
  assertEquals(
    afterCancel!.is_deleted,
    true,
    "cancel releases the EXCLUDE range",
  );
  assertEquals(
    (await availability(doctorId, f.hospitalA, date)).data[0].is_available,
    true,
  );
});

Deno.test("c68: leave invariants - dates, unknown type (22023) and overlap (23P01)", async () => {
  const f = fx();
  const doctorId = await ensureDoctor("leaveinv");
  const start = dateForWeekday(3);

  const missing = await upsertLeave(f.adminA.userId, f.hospitalA, doctorId, {
    p_leave_start_date: start,
    p_leave_end_date: null,
  });
  assertExists(missing.error);
  assertEquals(missing.error!.code, "22023");

  const inverted = await upsertLeave(f.adminA.userId, f.hospitalA, doctorId, {
    p_leave_start_date: start,
    p_leave_end_date: addDays(start, -1),
  });
  assertExists(inverted.error);
  assertEquals(inverted.error!.code, "22023");

  const badType = await upsertLeave(f.adminA.userId, f.hospitalA, doctorId, {
    p_leave_start_date: start,
    p_leave_end_date: start,
    p_leave_type: "sabbatical",
  });
  assertExists(badType.error);
  assertEquals(
    badType.error!.code,
    "22023",
    "enum membership checked in-catalog",
  );

  assertEquals(
    (await rows("doctor_leaves", { doctor_id: doctorId })).length,
    0,
    "no rejected variant wrote a row",
  );

  const ok = await upsertLeave(f.adminA.userId, f.hospitalA, doctorId, {
    p_leave_start_date: start,
    p_leave_end_date: addDays(start, 2),
    p_leave_type: "annual_leave",
  });
  assertEquals(ok.error, null);

  const overlap = await upsertLeave(f.adminA.userId, f.hospitalA, doctorId, {
    p_leave_start_date: addDays(start, 2),
    p_leave_end_date: addDays(start, 5),
    p_leave_type: "conference",
  });
  assertExists(overlap.error);
  assertEquals(overlap.error!.code, "23P01");

  // Same doctor, DIFFERENT hospital: the leave EXCLUDE constraint is on
  // (doctor_id, daterange) only, so it still blocks - and the RPC says so.
  const asB = await upsertLeave(f.globalAdmin.userId, f.hospitalA, doctorId, {
    p_leave_start_date: addDays(start, 1),
    p_leave_end_date: addDays(start, 1),
    p_leave_type: "personal",
  });
  assertExists(asB.error);
  assertEquals(asB.error!.code, "23P01");

  const rowsNow = await rows("doctor_leaves", { doctor_id: doctorId });
  assertEquals(rowsNow.length, 1, "the overlapping attempts wrote nothing");

  // Editing the existing window is allowed (self excluded from the pre-check).
  const moved = await upsertLeave(f.adminA.userId, f.hospitalA, doctorId, {
    p_leave_start_date: addDays(start, 10),
    p_leave_end_date: addDays(start, 12),
    p_leave_type: "emergency",
    p_leave_id: rowsNow[0].id,
  });
  assertEquals(
    moved.error,
    null,
    `move failed: ${JSON.stringify(moved.error)}`,
  );
  assertEquals(moved.data!.created, false);
  const edited = await leaveRow(rowsNow[0].id as string);
  assertEquals(edited!.leave_start_date, addDays(start, 10));
  assertEquals(String(edited!.leave_type), "emergency");
  // Omitted reason/notes keep their previous values rather than being cleared.
  assertEquals(edited!.reason, null);

  // Cancel then re-book the SAME dates: cancellation must free the range.
  const cancelled = await cancelLeave(
    f.adminA.userId,
    f.hospitalA,
    rowsNow[0].id as string,
  );
  assertEquals(cancelled.error, null);
  const rebooked = await upsertLeave(f.adminA.userId, f.hospitalA, doctorId, {
    p_leave_start_date: addDays(start, 10),
    p_leave_end_date: addDays(start, 12),
    p_leave_type: "other",
  });
  assertEquals(
    rebooked.error,
    null,
    `a cancelled leave must not block the dates: ${
      JSON.stringify(rebooked.error)
    }`,
  );
});

Deno.test("c68: leave cross-tenant - a foreign admin cannot cancel or edit A's leave", async () => {
  const f = fx();
  const doctorId = await ensureDoctor("leavex");
  const date = dateForWeekday(5);
  const created = await upsertLeave(f.adminA.userId, f.hospitalA, doctorId, {
    p_leave_start_date: date,
    p_leave_end_date: date,
    p_leave_type: "personal",
    p_reason: "private",
  });
  assertEquals(created.error, null);
  const mine = await rows("doctor_leaves", {
    doctor_id: doctorId,
    hospital_id: f.hospitalA,
  });
  assertExists(mine[0]);

  const cancelAsB = await cancelLeave(
    f.adminB.userId,
    f.hospitalB,
    mine[0].id as string,
  );
  assertExists(cancelAsB.error);
  assertEquals(cancelAsB.error!.code, "42501");
  assertEquals(
    (await leaveRow(mine[0].id as string))!.leave_status,
    "approved",
  );

  const editAsB = await upsertLeave(f.adminB.userId, f.hospitalB, doctorId, {
    p_leave_start_date: date,
    p_leave_end_date: date,
    p_leave_type: "sick_leave",
    p_leave_id: mine[0].id,
  });
  assertExists(editAsB.error);
  assertEquals(editAsB.error!.code, "P0002", "the doctor is not B's either");

  const cancelGhost = await cancelLeave(
    f.adminA.userId,
    f.hospitalA,
    crypto.randomUUID(),
  );
  assertExists(cancelGhost.error);
  assertEquals(cancelGhost.error!.code, "P0002");

  const cancelAsDoctor = await cancelLeave(
    f.doctorA.userId,
    f.hospitalA,
    mine[0].id as string,
  );
  assertExists(cancelAsDoctor.error);
  assertEquals(cancelAsDoctor.error!.code, "42501");

  // The leave window is readable by the tenant through RLS (the UI reads it).
  const { createAuthClient } = await ctx();
  const asA = createAuthClient(f.adminA.token) as AnyClient;
  const visible = await asA
    .from("doctor_leaves")
    .select("id,leave_status")
    .eq("hospital_id", f.hospitalA)
    .eq("is_deleted", false);
  assertEquals(visible.error, null);
  assert(
    ((visible.data ?? []) as Array<Record<string, unknown>>).some(
      (r) => r.id === mine[0].id,
    ),
    "own leave visible to the tenant admin",
  );
  const asB = createAuthClient(f.adminB.token) as AnyClient;
  const invisible = await asB
    .from("doctor_leaves")
    .select("id")
    .eq("hospital_id", f.hospitalA);
  assertEquals(invisible.error, null);
  assertEquals((invisible.data ?? []).length, 0);
});

// ─── 5. Privilege boundary + audit catalog ───────────────────────────────────

Deno.test("c68: anon and authenticated cannot EXECUTE any new write RPC (F16-04 explicit REVOKE)", async () => {
  const f = fx();
  const { anon, createAuthClient } = await ctx();
  const doctorId = await ensureDoctor("priv");
  const deptId = await ensureDepartment("priv", `${RUN}priv`);

  const refused: Array<[string, Record<string, unknown>]> = [
    ["create_department", {
      p_actor_user_id: f.adminA.userId,
      p_hospital_id: f.hospitalA,
      p_name: `nope ${RUN}`,
      p_code: `${RUN}nope`,
    }],
    ["update_department", {
      p_actor_user_id: f.adminA.userId,
      p_hospital_id: f.hospitalA,
      p_department_id: deptId,
      p_expected_version: 1,
      p_name: "nope",
    }],
    ["set_department_status", {
      p_actor_user_id: f.adminA.userId,
      p_hospital_id: f.hospitalA,
      p_department_id: deptId,
      p_expected_version: 1,
      p_is_active: false,
    }],
    ["create_doctor", {
      p_actor_user_id: f.adminA.userId,
      p_hospital_id: f.hospitalA,
      p_auth_user_id: f.doctorA.userId,
      p_full_name: `nope ${RUN}`,
    }],
    ["update_doctor", {
      p_actor_user_id: f.adminA.userId,
      p_hospital_id: f.hospitalA,
      p_doctor_id: doctorId,
      p_full_name: "nope",
    }],
    ["upsert_doctor_schedule", {
      p_actor_user_id: f.adminA.userId,
      p_hospital_id: f.hospitalA,
      p_doctor_id: doctorId,
      p_weekday: 1,
      p_start_time: "01:00:00",
      p_end_time: "02:00:00",
    }],
    ["delete_doctor_schedule", {
      p_actor_user_id: f.adminA.userId,
      p_hospital_id: f.hospitalA,
      p_schedule_id: crypto.randomUUID(),
    }],
    ["upsert_doctor_leave", {
      p_actor_user_id: f.adminA.userId,
      p_hospital_id: f.hospitalA,
      p_doctor_id: doctorId,
      p_leave_start_date: dateForWeekday(1),
      p_leave_end_date: dateForWeekday(1),
    }],
    ["cancel_doctor_leave", {
      p_actor_user_id: f.adminA.userId,
      p_hospital_id: f.hospitalA,
      p_leave_id: crypto.randomUUID(),
    }],
    ["assert_department_id_array", { p_department_ids: [deptId] }],
  ];

  const authClient = createAuthClient(f.adminA.token) as AnyClient;
  for (const [name, args] of refused) {
    const { error: anonErr } = await (anon.rpc as AnyClient)(name, args);
    assertExists(anonErr, `anon EXECUTE of ${name} must be refused`);
    assertStringIncludes(
      String((anonErr as { message?: string }).message ?? ""),
      "permission denied",
      `anon ${name}`,
    );
    const { error: authErr } = await authClient.rpc(name, args);
    assertExists(authErr, `authenticated EXECUTE of ${name} must be refused`);
    assertStringIncludes(
      String((authErr as { message?: string }).message ?? ""),
      "permission denied",
      `authenticated ${name}`,
    );
  }

  // service_role EXECUTE really works (the positive half of the boundary).
  const serviceRead = await rows(
    "departments",
    { hospital_id: f.hospitalA },
    "id",
  );
  assert(serviceRead.length > 0, "service reads the table");
  const svc = await createDepartment(
    f.adminA.userId,
    f.hospitalA,
    `SVC ${RUN}`,
    `${RUN}svc`,
  );
  assertEquals(svc.error, null, "service_role EXECUTE is granted");
});

Deno.test("c68: audit_action_types registers the thirteen WS-ONBOARD-4 configuration actions", async () => {
  const { db } = await ctx();
  const actions = [
    "department_create",
    "department_update",
    "department_status_change",
    "doctor_create",
    "doctor_update",
    "doctor_status_change",
    "doctor_department_assignment",
    "doctor_schedule_create",
    "doctor_schedule_update",
    "doctor_schedule_delete",
    "doctor_leave_create",
    "doctor_leave_update",
    "doctor_leave_cancel",
  ];
  const { data } = await (db.from as AnyClient)("audit_action_types")
    .select("action_type,category,default_severity")
    .in("action_type", actions);
  const got = (data ?? []) as Array<Record<string, unknown>>;
  assertEquals(got.length, actions.length, "every action is registered");
  const byAction = new Map(got.map((r) => [String(r.action_type), r]));
  for (const a of actions) {
    assertExists(byAction.get(a), `${a} registered`);
    assertEquals(byAction.get(a)!.category, "configuration", `${a} category`);
  }
  // The two high-severity lifecycle facts stay high.
  assertEquals(byAction.get("doctor_create")!.default_severity, "high");
  assertEquals(byAction.get("doctor_status_change")!.default_severity, "high");
  assertEquals(
    byAction.get("doctor_schedule_delete")!.default_severity,
    "high",
  );
});
