/**
 * tests/integration/staff_doctor_directory.test.ts
 *
 * Migration 61 (`profiles_staff_read_doctors`) — the reception doctor
 * picker and queue-board labels depend on it: before it, a receptionist
 * could read `doctor_specializations` but not the embedded `profiles`
 * row, so the picker could not name the doctor it was queueing a patient
 * in front of.
 *
 * Proven here against the REAL stack, as the REAL roles:
 *   1. same-hospital staff (receptionist, fellow doctor, hospital admin) can
 *      read a doctor's directory row;
 *   2. a DIFFERENT hospital's staff cannot — the row is invisible (zero
 *      rows), not an error, so tenancy leaks nothing;
 *   3. `anon` cannot;
 *   4. the read is SELECT-only: a receptionist still cannot read another
 *      staff member's row through the self policy, nor write any profile;
 *   5. the exact embedded read the frontend performs
 *      (`doctor_specializations.select("...,profiles(full_name)")`) returns
 *      the doctor name for the seeded receptionist.
 *
 * Section 5 uses the deterministic seed and therefore only ever reads.
 *
 * Run with:  deno task test:integration
 */

import {
  assert,
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SEED } from "../utils/seed_constants.ts";

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

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "6");
const FIXTURE_PASSWORD = `D61-${RUN}-fixture-pass`;

interface Actor {
  userId: string;
  email: string;
  token: string;
}

type RoleName = "global_admin" | "hospital_admin" | "doctor" | "receptionist";

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

async function deleteAuthUser(userId: string): Promise<void> {
  if (!LOCAL_STATUS) return;
  try {
    await fetch(`${LOCAL_STATUS.API_URL}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${LOCAL_STATUS.SERVICE_ROLE_KEY}` },
    });
  } catch {
    // Best-effort: a leftover fixture user holds no role and is inert.
  }
}

// deno-lint-ignore no-explicit-any
type AnyClient = any;

/** Rows the caller's RLS actually exposes for `id`, name included. */
async function visibleProfiles(
  client: AnyClient,
  ids: string[],
): Promise<Array<{ id: string; full_name: string }>> {
  const { data, error } = await client
    .from("profiles")
    .select("id,full_name")
    .in("id", ids);
  assertEquals(error, null);
  return (data ?? []) as Array<{ id: string; full_name: string }>;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface FixtureState {
  hospitalA: string;
  hospitalB: string;
  /** Doctor at A - the row every read below is about. */
  doctorA: Actor;
  /** Doctor at B - must never be visible to A's staff. */
  doctorB: Actor;
  receptionistA: Actor;
  adminA: Actor;
  peerDoctorA: Actor;
  receptionistB: Actor;
  /** A second receptionist at A: proves the grant is not limited to one
   *  front-desk account. */
  receptionistA2: Actor;
  patient: Actor;
}

let F: FixtureState | null = null;

function fx(): FixtureState {
  if (!F) throw new Error("setup test not run");
  return F;
}

Deno.test("d61: setup - two hospitals, staff and a patient", async () => {
  const { db } = await ctx();

  const { data: hA, error: hAErr } = await db
    .from("hospitals")
    .insert({ name: `D61 Directory ${RUN} A`, slug: `d61-dir-${RUN}-a` })
    .select("id")
    .single();
  assertEquals(hAErr, null);
  const { data: hB, error: hBErr } = await db
    .from("hospitals")
    .insert({ name: `D61 Directory ${RUN} B`, slug: `d61-dir-${RUN}-b` })
    .select("id")
    .single();
  assertEquals(hBErr, null);
  assertExists(hA);
  assertExists(hB);
  const hospitalA = hA.id as string;
  const hospitalB = hB.id as string;

  async function actor(
    tag: string,
    fullName: string,
    phoneSuffix: string,
    hospitalId: string | null,
    role: RoleName | null,
  ): Promise<Actor> {
    const userId = crypto.randomUUID();
    const email = `d61-${tag}-${RUN}@setura.test`;
    await createAuthUser(userId, email);
    const { error: pErr } = await db.from("profiles").upsert({
      id: userId,
      full_name: fullName,
      normalized_phone: `96${RUN}${phoneSuffix}`,
    });
    assertEquals(pErr, null);
    if (role) {
      const { error } = await db.from("user_roles").insert({
        user_id: userId,
        hospital_id: hospitalId,
        role,
        is_primary: true,
      });
      assertEquals(error, null, `grant ${role} to ${tag}`);
    }
    return { userId, email, token: await tokenFor(email) };
  }

  const doctorA = await actor(
    "doc-a",
    `D61 Doctor A ${RUN}`,
    "11",
    hospitalA,
    "doctor",
  );
  const doctorB = await actor(
    "doc-b",
    `D61 Doctor B ${RUN}`,
    "12",
    hospitalB,
    "doctor",
  );
  const receptionistA = await actor(
    "rec-a",
    `D61 Reception A ${RUN}`,
    "13",
    hospitalA,
    "receptionist",
  );
  const adminA = await actor(
    "adm-a",
    `D61 Admin A ${RUN}`,
    "14",
    hospitalA,
    "hospital_admin",
  );
  const peerDoctorA = await actor(
    "doc-a2",
    `D61 Doctor A2 ${RUN}`,
    "15",
    hospitalA,
    "doctor",
  );
  const receptionistB = await actor(
    "rec-b",
    `D61 Reception B ${RUN}`,
    "16",
    hospitalB,
    "receptionist",
  );
  const receptionistA2 = await actor(
    "rec-a2",
    `D61 Reception A2 ${RUN}`,
    "17",
    hospitalA,
    "receptionist",
  );
  // No user_roles row: a pure patient must not gain staff-directory reads.
  const patient = await actor("pat", `D61 Patient ${RUN}`, "18", null, null);

  F = {
    hospitalA,
    hospitalB,
    doctorA,
    doctorB,
    receptionistA,
    adminA,
    peerDoctorA,
    receptionistB,
    receptionistA2,
    patient,
  };
});

// ─── 1. Same-hospital staff can read the doctor directory row ────────────────

Deno.test("d61: receptionist, fellow doctor and hospital admin all see the same-hospital doctor", async () => {
  const { createAuthClient } = await ctx();
  const f = fx();

  for (
    const staff of [f.receptionistA, f.receptionistA2, f.peerDoctorA, f.adminA]
  ) {
    const rows = await visibleProfiles(
      createAuthClient(staff.token) as AnyClient,
      [f.doctorA.userId],
    );
    assertEquals(
      rows.map((r) => r.full_name),
      [`D61 Doctor A ${RUN}`],
      `as ${staff.email}`,
    );
  }
});

// ─── 2. Tenant isolation is a zero-row result, not an error ─────────────────

Deno.test("d61: another hospital's staff sees nothing of the doctor", async () => {
  const { createAuthClient } = await ctx();
  const f = fx();

  const rows = await visibleProfiles(
    createAuthClient(f.receptionistB.token) as AnyClient,
    [f.doctorA.userId],
  );
  assertEquals(rows, []);
});

Deno.test("d61: a user with no hospital role sees nothing of the doctor", async () => {
  const { createAuthClient } = await ctx();
  const f = fx();

  const rows = await visibleProfiles(
    createAuthClient(f.patient.token) as AnyClient,
    [f.doctorA.userId],
  );
  assertEquals(rows, []);
});

Deno.test("d61: anon sees nothing of the doctor", async () => {
  const { anon } = await ctx();
  const f = fx();

  const rows = await visibleProfiles(anon as AnyClient, [f.doctorA.userId]);
  assertEquals(rows, []);
});

// ─── 3. The grant is read-only and does not widen anything else ─────────────

Deno.test("d61: staff cannot read a non-doctor colleague's profile", async () => {
  const { createAuthClient } = await ctx();
  const f = fx();

  // The receptionist may read doctors, not fellow staff: profiles_self only
  // exposes the caller's own row and profiles_admin_read only hospital_admins.
  const rows = await visibleProfiles(
    createAuthClient(f.receptionistA.token) as AnyClient,
    [f.receptionistA.userId, f.receptionistA2.userId, f.adminA.userId],
  );
  assertEquals(
    rows.map((r) => r.id).sort(),
    [f.receptionistA.userId].sort(),
    "only the caller's own row remains readable",
  );
});

Deno.test("d61: the directory read is SELECT-only for receptionist", async () => {
  const { createAuthClient } = await ctx();
  const f = fx();

  const client = createAuthClient(f.receptionistA.token) as AnyClient;
  const { data, error } = await client
    .from("profiles")
    .update({ full_name: `Hijacked ${RUN}` })
    .eq("id", f.doctorA.userId)
    .select("id");
  assert(
    error !== null || (data ?? []).length === 0,
    "receptionist must not update a doctor profile",
  );

  // Under RLS a DELETE that matches no policy is a silent zero-row no-op,
  // not an error, so "refused" means "affected nothing": the doctor row is
  // not visible for deletion to the receptionist, hence zero rows return
  // and the value is unchanged (asserted below through the admin re-read).
  const { data: delData, error: delErr } = await client
    .from("profiles")
    .delete()
    .eq("id", f.doctorA.userId)
    .select("id");
  assertEquals(delErr, null, "RLS delete is a no-op, not an error");
  assertEquals(
    (delData ?? []).map((r: { id: string }) => r.id),
    [],
    "receptionist must not delete a doctor profile",
  );

  // And the value genuinely did not change.
  const rows = await visibleProfiles(
    createAuthClient(f.adminA.token) as AnyClient,
    [f.doctorA.userId],
  );
  assertEquals(rows.map((r) => r.full_name), [`D61 Doctor A ${RUN}`]);
});

// ─── 4. The embedded frontend read is the one that works ───────────────────

Deno.test("d61: the seeded receptionist resolves the doctor name through the embed", async () => {
  const { db, createAuthClient } = await ctx();
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");

  const session = await fetch(
    `${LOCAL_STATUS.API_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        "apikey": LOCAL_STATUS.ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: SEED.RECEPTIONIST_EMAIL,
        password: "Setura@123",
      }),
    },
  ).then((r) => r.json() as Promise<{ access_token?: string }>);
  assertExists(
    session.access_token,
    "seeded receptionist must be able to log in",
  );

  // The frontend lists assignable doctors from doctor_specializations, so the
  // seeded doctor must hold a specialization row for the embed to be reached.
  // Asserted read-only through the service client: this test mutates nothing.
  const { data: seededSpec, error: specErr } = await db
    .from("doctor_specializations")
    .select("doctor_id")
    .eq("hospital_id", SEED.HOSPITAL_ID)
    .eq("doctor_id", SEED.DOCTOR_ID)
    .eq("is_deleted", false)
    .limit(1);
  assertEquals(specErr, null);
  assertExists(
    seededSpec?.[0],
    "seed must give the doctor a specialization row (SEED.EXPECTED.DOCTOR_SPECIALIZATIONS)",
  );

  const client = createAuthClient(session.access_token!) as AnyClient;
  const { data, error } = await client
    .from("doctor_specializations")
    .select(
      "doctor_id,specialization_name,consultation_fee,profiles(full_name)",
    )
    .eq("hospital_id", SEED.HOSPITAL_ID)
    .eq("is_deleted", false);
  assertEquals(error, null);

  const rows = (data ?? []) as Array<
    { doctor_id: string; profiles: { full_name: string | null } | null }
  >;
  const doctor = rows.find((r) => r.doctor_id === SEED.DOCTOR_ID);
  assertExists(doctor, "seeded doctor specialization must be listed");
  assertEquals(
    doctor!.profiles?.full_name,
    "Dr. Anitha Rao",
    "the embed must resolve the doctor name for a receptionist",
  );
});

// ─── 9. Teardown ─────────────────────────────────────────────────────────────

Deno.test("d61: teardown removes every fixture row", async () => {
  const { db } = await ctx();
  const f = fx();
  const actors = [
    f.doctorA,
    f.doctorB,
    f.receptionistA,
    f.adminA,
    f.peerDoctorA,
    f.receptionistB,
    f.receptionistA2,
    f.patient,
  ];
  for (const a of actors) {
    const { error } = await db.from("profiles").delete().eq("id", a.userId);
    assertEquals(error, null);
    await deleteAuthUser(a.userId);
  }
  for (const h of [f.hospitalA, f.hospitalB]) {
    const { error } = await db.from("hospitals").delete().eq("id", h);
    assertEquals(error, null);
  }
  F = null;
});
