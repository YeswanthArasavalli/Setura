/**
 * tests/integration/hospital_activation.test.ts
 *
 * WS-ONBOARD-5 — the `validate_hospital_configuration` and
 * `set_hospital_activation` RPCs (migration 71), exercised against the REAL
 * local Supabase stack as the REAL roles.
 *
 * Proves the DATABASE-layer contract only (no Edge runtime): the privilege
 * boundary is fail-closed (F16-04 explicit REVOKE — anon / authenticated cannot
 * EXECUTE), each RPC independently refuses a non-global_admin / NULL actor
 * (42501), a missing tenant is refused (22023), the validation checklist
 * reflects the real department / doctor / schedule counts, activation REFUSES
 * an incomplete tenant WITHOUT flipping is_active, activation of a ready tenant
 * sets is_active + activated_at, re-activation is a no-op, and de-activation
 * clears is_active.
 *
 * The Edge layer (HTTP authz, idempotent replay, audit) is covered by
 * hospital_activation_http.test.ts.
 *
 * Run with:  deno task test:integration   (requires `supabase start`)
 */

import {
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

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "5");
const FIXTURE_PASSWORD = `P71-${RUN}-fixture-pass`;

// deno-lint-ignore no-explicit-any
type AnyClient = any;

interface Check {
  key: string;
  passed: boolean;
  blocking: boolean;
}
interface ValidationOutcome {
  ok?: boolean;
  hospital_id?: string;
  ready?: boolean;
  checks?: Check[];
}
interface ActivationOutcome {
  ok?: boolean;
  reason?: string;
  hospital_id?: string;
  is_active?: boolean;
  activated_at?: string | null;
}
type RpcError = { code?: string; message?: string } | null;

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

/** Create a real auth user + profile + role and return the actor id + token. */
async function fixtureActor(
  tag: string,
  role: "global_admin" | "hospital_admin" | "doctor",
  hospitalId: string | null,
  phoneSuffix: string,
): Promise<{ userId: string; email: string; token: string }> {
  const { db } = await ctx();
  const userId = crypto.randomUUID();
  const email = `p71-${tag}-${RUN}@setura.test`;
  await createAuthUser(userId, email);
  const { error: pErr } = await db.from("profiles").upsert({
    id: userId,
    full_name: `P71 ${tag} ${RUN}`,
    normalized_phone: `98${RUN}${phoneSuffix}`,
    is_active: true,
  });
  assertEquals(pErr, null, `profile upsert failed: ${JSON.stringify(pErr)}`);
  const { error: rErr } = await db.from("user_roles").insert({
    user_id: userId,
    hospital_id: hospitalId,
    role,
    is_primary: true,
  });
  assertEquals(rErr, null, `role insert failed: ${JSON.stringify(rErr)}`);
  return { userId, email, token: await tokenFor(email) };
}

async function newHospital(label: string): Promise<string> {
  const { db } = await ctx();
  const slug = `p71-${label}-${RUN}`.toLowerCase();
  const { data, error } = await db.from("hospitals")
    .insert({ name: `P71 ${label} ${RUN}`, slug })
    .select("id")
    .single();
  assertEquals(error, null, `hospital insert failed: ${JSON.stringify(error)}`);
  assertExists(data);
  return data.id as string;
}

async function hospitalState(
  id: string,
): Promise<{ is_active: boolean; activated_at: string | null }> {
  const { db } = await ctx();
  const { data } = await (db.from as AnyClient)("hospitals")
    .select("is_active,activated_at")
    .eq("id", id)
    .maybeSingle();
  return {
    is_active: (data?.is_active ?? null) as boolean,
    activated_at: (data?.activated_at ?? null) as string | null,
  };
}

async function validateAs(
  actorId: string,
  hospitalId: string,
  client?: AnyClient,
): Promise<{ data: ValidationOutcome | null; error: RpcError }> {
  const db = client ?? (await ctx()).db;
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (db.rpc as any)(
    "validate_hospital_configuration",
    { p_actor_user_id: actorId, p_hospital_id: hospitalId },
  );
  return {
    data: (data ?? null) as ValidationOutcome | null,
    // deno-lint-ignore no-explicit-any
    error: (error ?? null) as any,
  };
}

async function activateAs(
  actorId: string,
  hospitalId: string,
  activate: boolean,
  client?: AnyClient,
): Promise<{ data: ActivationOutcome | null; error: RpcError }> {
  const db = client ?? (await ctx()).db;
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (db.rpc as any)("set_hospital_activation", {
    p_actor_user_id: actorId,
    p_hospital_id: hospitalId,
    p_activate: activate,
  });
  return {
    data: (data ?? null) as ActivationOutcome | null,
    // deno-lint-ignore no-explicit-any
    error: (error ?? null) as any,
  };
}

async function addDepartment(hospitalId: string): Promise<void> {
  const { db } = await ctx();
  const { error } = await db.from("departments").insert({
    hospital_id: hospitalId,
    name: `Cardiology ${RUN}`,
    code: `CARD-${RUN}`,
  });
  assertEquals(
    error,
    null,
    `department insert failed: ${JSON.stringify(error)}`,
  );
}

async function addDoctorAndSchedule(
  hospitalId: string,
  suffix: string,
): Promise<void> {
  const { db } = await ctx();
  const doctor = await fixtureActor(
    `doc-${suffix}`,
    "doctor",
    hospitalId,
    suffix,
  );
  const sRes = await db.from("doctor_schedules").insert({
    doctor_id: doctor.userId,
    hospital_id: hospitalId,
    weekday: 1,
    start_time: "09:00:00",
    end_time: "13:00:00",
  });
  assertEquals(
    sRes.error ?? null,
    null,
    `schedule insert failed: ${JSON.stringify(sRes.error)}`,
  );
}

interface FixtureState {
  globalAdmin: { userId: string };
  hospitalAdmin: { userId: string; token: string };
  empty: string; // no departments/doctors/schedules
  ready: string; // all three
}

let F: FixtureState | null = null;
function fx(): FixtureState {
  if (!F) throw new Error("setup test not run");
  return F;
}

// ─── 0. Setup ────────────────────────────────────────────────────────────────

Deno.test("p71: setup fixture actors + hospitals (empty and ready)", async () => {
  const globalAdmin = await fixtureActor("ga", "global_admin", null, "01");
  const empty = await newHospital("empty");
  const ready = await newHospital("ready");

  // Seed the READY tenant with one department, one doctor + one schedule.
  await addDepartment(ready);
  await addDoctorAndSchedule(ready, "02");

  const hospitalAdmin = await fixtureActor(
    "ha",
    "hospital_admin",
    ready,
    "03",
  );

  F = { globalAdmin, hospitalAdmin, empty, ready };
});

// ─── 1. Validation checklist reflects real counts ────────────────────────────

Deno.test("p71: validate reports not-ready for an unconfigured tenant", async () => {
  const f = fx();
  const res = await validateAs(f.globalAdmin.userId, f.empty);
  assertEquals(res.error, null, JSON.stringify(res.error));
  assertEquals(res.data?.ok, true);
  assertEquals(res.data?.ready, false);
  const blocking = (res.data?.checks ?? []).filter((c) => c.blocking);
  assertEquals(blocking.every((c) => !c.passed), true);
});

Deno.test("p71: validate reports ready for a fully configured tenant", async () => {
  const f = fx();
  const res = await validateAs(f.globalAdmin.userId, f.ready);
  assertEquals(res.error, null, JSON.stringify(res.error));
  assertEquals(res.data?.ready, true);
  const byKey = new Map((res.data?.checks ?? []).map((c) => [c.key, c]));
  assertEquals(byKey.get("has_active_department")?.passed, true);
  assertEquals(byKey.get("has_active_doctor")?.passed, true);
  assertEquals(byKey.get("has_active_schedule")?.passed, true);
});

// ─── 2. Privilege boundary (F16-04 explicit REVOKE) ──────────────────────────

Deno.test("p71: anon cannot EXECUTE validate_hospital_configuration", async () => {
  const { anon } = await ctx();
  const f = fx();
  const { error } = await (anon.rpc as AnyClient)(
    "validate_hospital_configuration",
    { p_actor_user_id: f.globalAdmin.userId, p_hospital_id: f.ready },
  );
  assertExists(error, "anon EXECUTE must be refused at the privilege layer");
  assertStringIncludes(
    (error as { message?: string }).message ?? "",
    "permission denied",
  );
});

Deno.test("p71: authenticated cannot EXECUTE set_hospital_activation", async () => {
  const { createAuthClient } = await ctx();
  const f = fx();
  const client = createAuthClient(f.hospitalAdmin.token) as AnyClient;
  const { error } = await client.rpc("set_hospital_activation", {
    p_actor_user_id: f.hospitalAdmin.userId,
    p_hospital_id: f.ready,
    p_activate: true,
  });
  assertExists(
    error,
    "authenticated EXECUTE must be refused (service_role-only)",
  );
  assertStringIncludes(
    (error as { message?: string }).message ?? "",
    "permission denied",
  );
});

// ─── 3. DB-layer authorization: non-global_admin / NULL actor refused ─────────

Deno.test("p71: validate refuses a non-global_admin actor (42501)", async () => {
  const f = fx();
  const res = await validateAs(f.hospitalAdmin.userId, f.ready);
  assertExists(res.error, "hospital_admin actor must be refused");
  assertEquals(res.error!.code, "42501");
});

Deno.test("p71: activation refuses a NULL actor (42501)", async () => {
  const f = fx();
  const res = await activateAs(null as unknown as string, f.ready, true);
  assertExists(res.error, "NULL actor must be refused");
  assertEquals(res.error!.code, "42501");
});

Deno.test("p71: validate refuses a missing tenant (22023)", async () => {
  const f = fx();
  const res = await validateAs(f.globalAdmin.userId, crypto.randomUUID());
  assertExists(res.error, "missing tenant must be refused");
  assertEquals(res.error!.code, "22023");
});

// ─── 4. Activation readiness invariant ───────────────────────────────────────

Deno.test("p71: activation of an incomplete tenant is refused (22023) and does NOT flip is_active", async () => {
  const f = fx();
  const before = await hospitalState(f.empty);
  const res = await activateAs(f.globalAdmin.userId, f.empty, true);
  assertExists(res.error, "incomplete tenant activation must be refused");
  assertEquals(res.error!.code, "22023");
  const after = await hospitalState(f.empty);
  assertEquals(
    after.is_active,
    before.is_active,
    "refusal must not change is_active",
  );
  assertEquals(after.activated_at, null, "refusal must not stamp activated_at");
});

Deno.test("p71: activation of a ready tenant sets is_active + activated_at", async () => {
  const f = fx();
  // Start from a deliberately inactive ready tenant so the flip is observable.
  const { db } = await ctx();
  await db.from("hospitals").update({ is_active: false }).eq("id", f.ready);

  const res = await activateAs(f.globalAdmin.userId, f.ready, true);
  assertEquals(res.error, null, JSON.stringify(res.error));
  assertEquals(res.data?.ok, true);
  assertEquals(res.data?.is_active, true);

  const after = await hospitalState(f.ready);
  assertEquals(after.is_active, true);
  assertExists(after.activated_at, "activation must stamp activated_at");
});

Deno.test("p71: re-activating an already-active tenant is a no-op success", async () => {
  const f = fx();
  const res = await activateAs(f.globalAdmin.userId, f.ready, true);
  assertEquals(res.error, null, JSON.stringify(res.error));
  assertEquals(res.data?.reason, "already_active");
  assertEquals(await (await hospitalState(f.ready)).is_active, true);
});

Deno.test("p71: de-activation clears is_active", async () => {
  const f = fx();
  const res = await activateAs(f.globalAdmin.userId, f.ready, false);
  assertEquals(res.error, null, JSON.stringify(res.error));
  assertEquals(res.data?.is_active, false);
  assertEquals((await hospitalState(f.ready)).is_active, false);
});
