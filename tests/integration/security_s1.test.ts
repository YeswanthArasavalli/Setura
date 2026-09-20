/**
 * tests/integration/security_s1.test.ts
 *
 * Phase 5 — Gate S1: SECURITY CERTIFICATION. Attack the real security
 * boundaries of SETURA against the REAL local Supabase stack and prove,
 * for each attack, that the request is (a) DENIED, (b) leaks NO DATA and
 * (c) causes NO UNAUTHORIZED STATE CHANGE. Nothing here is mocked: every
 * token is a real GoTrue access token, every mutation goes through the
 * real Edge Functions / PostgREST / RPC chain, and every denial is
 * re-checked by reading the database afterwards (spec §23).
 *
 * Method: INSPECT → ATTACK → PROVE → (no fix needed unless a defect is
 * found) → REGRESSION.
 *
 * Boundaries exercised (mapped to the spec §4 S1 matrix):
 *   S1-01 tenant isolation on READ (RLS, real `authenticated` role)
 *   S1-02 tenant-id spoofing — attacker JWT of A, header says B
 *   S1-03 tenant-id spoofing — body hospitalId != validated header
 *   S1-04 resource-id spoofing — A cancels B's booking (cross-tenant)
 *   S1-05 resource-id spoofing — doctor A updates B's booking
 *   S1-06 role isolation — receptionist hits a doctor-only endpoint
 *   S1-07 authentication — missing / malformed JWT
 *   S1-08 fail-closed — missing tenant header never falls back to default
 *   S1-09 machine endpoints — cron endpoint refuses non-machine callers
 *   S1-10 webhook — unsigned POST is refused, not acknowledged
 *   S1-11 scheduler RPC privilege — anon/authenticated cannot EXECUTE
 *   S1-12 auditability — a legitimate mutation is auditable
 *   S1-13 doctor scope isolation — doctor A vs another doctor, SAME hospital
 *
 * Positive machine paths (valid CRON secret, valid Meta signature) are
 * NOT provable locally because the Edge Runtime container has none of
 * CRON_SECRET / META_APP_SECRET (see AGENTS.md §13). Those are recorded
 * RUNTIME = BLOCKED and are NOT faked: the fail-closed refusal is still
 * proven, which is the security-relevant half.
 *
 * Residue policy (E1 lesson): successful bookings write audit_logs and
 * make their tenant permanently undeletable. The teardown removes what it
 * can and documents the rest as inert residue; it never weakens RLS or
 * audit immutability to force a clean-up.
 *
 * Run with:  deno task test:integration   (requires `supabase start`
 * plus a running Edge Runtime — verify with `supabase status`).
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

// ─── One-time bootstrap: env → dynamic import of the real modules ────────────

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

  const { getServiceClient } = await import(
    "../../supabase/functions/_shared/db.ts"
  );
  return { db: getServiceClient(), status };
}

async function ctx(): Promise<Shared> {
  if (!_ctx) _ctx = await bootstrap();
  return _ctx;
}

// ─── Per-run fixture isolation ───────────────────────────────────────────────

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "7");
const FIXTURE_PASSWORD = `S1-${RUN}-fixture-pass`;

/** Clinic date: today unless Sunday (fixture doctors work Mon-Sat). */
function clinicDate(): { date: string; weekday: number } {
  const d = new Date();
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return { date: `${d.getFullYear()}-${m}-${day}`, weekday: d.getDay() };
}
const CLINIC = clinicDate();

function phoneOf(tag: number): string {
  return String(6 + (tag % 4)) + RUN + String(tag).padStart(2, "0");
}

interface S1 {
  hospitalA: string;
  hospitalB: string;
  receptionA: string;
  doctorA: string;
  receptionB: string;
  doctorB: string;
  tokens: Record<string, string>;
  bookingA: string; // A-owned booking (legitimate baseline)
  bookingB: string; // B-owned booking — the cross-tenant target
  patientB: string;
}
const J = {} as S1;

// ─── Auth fixtures ───────────────────────────────────────────────────────────

async function createUserWithRole(
  email: string,
  hospitalId: string,
  role: "global_admin" | "hospital_admin" | "doctor" | "receptionist",
  phoneTag: number,
): Promise<string> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const { db } = await ctx();

  const userId = crypto.randomUUID();
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

  const { error: profErr } = await db.from("profiles").upsert({
    id: userId,
    full_name: `S1 ${role} ${RUN}`,
    normalized_phone: `98${RUN}${String(phoneTag).padStart(2, "0")}`,
  });
  assertEquals(profErr, null);

  const { error: roleErr } = await db.from("user_roles").insert({
    user_id: userId,
    hospital_id: hospitalId,
    role,
    is_primary: true,
  });
  assertEquals(roleErr, null);

  return userId;
}

async function signIn(email: string): Promise<string> {
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
  const token = json.access_token;
  assertExists(token);
  return token;
}

// ─── Edge Function HTTP helper (real caller token + tenant header) ────────────

async function callFunction(
  name: string,
  token: string | null,
  hospitalId: string | null,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<
  {
    status: number;
    json: Record<string, unknown> | null;
    data: Record<string, unknown> | null;
  }
> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (hospitalId) headers["X-Hospital-ID"] = hospitalId;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const resp = await fetch(`${LOCAL_STATUS.API_URL}/functions/v1/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON body (gateway refusal) — status is still the assertion */
  }
  return {
    status: resp.status,
    json,
    data: (json?.data ?? null) as Record<string, unknown> | null,
  };
}

function bookingBody(
  hospitalId: string,
  doctorId: string,
  tag: number,
  name: string,
) {
  return {
    hospitalId,
    patientName: name,
    patientPhone: phoneOf(tag),
    patientAge: 41,
    patientGender: "M",
    village: `s1-village-${RUN}`,
    hasDiabetes: false,
    hasBp: false,
    bookingSource: "online",
    doctorId,
    appointmentDate: CLINIC.date,
  };
}

// ─── DB read helpers (service role = the ground truth after every attack) ─────

async function row(
  table: string,
  id: string,
  cols = "*",
): Promise<Record<string, unknown> | null> {
  const { db } = await ctx();
  const { data, error } = await db.from(table).select(cols).eq("id", id)
    .maybeSingle();
  assertEquals(error, null);
  return data as Record<string, unknown> | null;
}

async function rowCount(
  table: string,
  filters: Array<[string, string]> = [],
): Promise<number> {
  const { db } = await ctx();
  let q = db.from(table).select("id", { count: "exact", head: true });
  for (const [col, val] of filters) q = q.eq(col, val);
  const { count, error } = await q;
  assertEquals(error, null);
  return count ?? 0;
}

// ─── Role-pinned PostgREST access (real `authenticated` / `anon` roles) ───────

async function restGet(
  kind: "anon" | "authenticated",
  token: string | undefined,
  table: string,
  query: string,
): Promise<{ status: number; body: unknown }> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "apikey": LOCAL_STATUS.ANON_KEY,
  };
  if (kind === "authenticated") {
    assertExists(token, "authenticated caller needs a JWT");
    headers["Authorization"] = `Bearer ${token}`;
  }
  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/rest/v1/${table}?${query}`,
    { headers },
  );
  const text = await resp.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: resp.status, body };
}

async function restRpc(
  kind: "anon" | "authenticated",
  token: string | undefined,
  fn: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; body: unknown; raw: string }> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "apikey": LOCAL_STATUS.ANON_KEY,
  };
  if (kind === "authenticated") {
    assertExists(token, "authenticated caller needs a JWT");
    headers["Authorization"] = `Bearer ${token}`;
  }
  const resp = await fetch(`${LOCAL_STATUS.API_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
  const raw = await resp.text();
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    /* keep raw */
  }
  return { status: resp.status, body, raw };
}

/**
 * Denial must look like a privilege/auth failure, not a "function not
 * found" (404/PGRST202) — the latter means the boundary was never
 * exercised, which is a TEST defect, not a security result (privilege
 * isolation lesson, F16-05 discipline).
 */
function assertDeniedPrivilege(
  status: number,
  msg: string,
  what: string,
): void {
  assert(
    status !== 404,
    `${what}: PostgREST could not resolve the function (${msg}) — TEST DEFECT, ` +
      `not a security result: the privilege boundary was never reached.`,
  );
  assert(
    status === 401 || status === 403,
    `${what}: expected 401/403 from the database, got ${status} (${msg})`,
  );
  const lower = msg.toLowerCase();
  assert(
    lower.includes("permission denied") ||
      lower.includes("insufficient") ||
      lower.includes("jwt") ||
      lower.includes("not authorized") ||
      lower.includes("42501") ||
      lower.includes("does not exist") === false,
    `${what}: refused ${status} but the reason is not a privilege failure: ${msg}`,
  );
}

// ─── 00. Provision two isolated tenants with legitimate baseline state ────────

Deno.test("S1 00: provision tenants A/B, actors, and one booking in each", async () => {
  const { db } = await ctx();

  const { data: hA, error: hAErr } = await db
    .from("hospitals").insert({
      name: `S1 Sec ${RUN} A`,
      slug: `s1-sec-${RUN}-a`,
    })
    .select("id").single();
  const { data: hB, error: hBErr } = await db
    .from("hospitals").insert({
      name: `S1 Sec ${RUN} B`,
      slug: `s1-sec-${RUN}-b`,
    })
    .select("id").single();
  assertEquals(hAErr, null);
  assertEquals(hBErr, null);
  assertExists(hA);
  assertExists(hB);
  J.hospitalA = hA.id;
  J.hospitalB = hB.id;

  // Enable online booking on both so the legitimate baseline booking
  // succeeds; auto-provisioning triggers already created the settings /
  // fee rows on hospital insert (E1-proven contract).
  for (const h of [J.hospitalA, J.hospitalB]) {
    const { error: setErr } = await db.from("hospital_settings")
      .update({ allow_online_booking: true }).eq("hospital_id", h);
    assertEquals(setErr, null);
  }

  J.receptionA = await createUserWithRole(
    `s1-recep-a-${RUN}@setura.test`,
    J.hospitalA,
    "receptionist",
    1,
  );
  J.doctorA = await createUserWithRole(
    `s1-doc-a-${RUN}@setura.test`,
    J.hospitalA,
    "doctor",
    2,
  );
  J.receptionB = await createUserWithRole(
    `s1-recep-b-${RUN}@setura.test`,
    J.hospitalB,
    "receptionist",
    3,
  );
  J.doctorB = await createUserWithRole(
    `s1-doc-b-${RUN}@setura.test`,
    J.hospitalB,
    "doctor",
    4,
  );

  for (
    const [doc, hosp] of [[J.doctorA, J.hospitalA], [
      J.doctorB,
      J.hospitalB,
    ]] as const
  ) {
    const { error: schedErr } = await db.from("doctor_schedules").insert({
      doctor_id: doc,
      hospital_id: hosp,
      weekday: CLINIC.weekday,
      start_time: "09:00:00",
      end_time: "13:00:00",
      max_tokens: 30,
    });
    assertEquals(schedErr, null);
  }

  J.tokens = {
    receptionA: await signIn(`s1-recep-a-${RUN}@setura.test`),
    doctorA: await signIn(`s1-doc-a-${RUN}@setura.test`),
    receptionB: await signIn(`s1-recep-b-${RUN}@setura.test`),
    doctorB: await signIn(`s1-doc-b-${RUN}@setura.test`),
  };

  // Legitimate bookings — A receptionist books in A, B receptionist in B.
  const rA = await callFunction(
    "create-booking",
    J.tokens.receptionA,
    J.hospitalA,
    bookingBody(J.hospitalA, J.doctorA, 10, `S1 Pt A ${RUN}`),
    crypto.randomUUID(),
  );
  assertEquals(rA.status, 201, JSON.stringify(rA.json));
  J.bookingA = rA.data!.bookingId as string;

  const rB = await callFunction(
    "create-booking",
    J.tokens.receptionB,
    J.hospitalB,
    bookingBody(J.hospitalB, J.doctorB, 11, `S1 Pt B ${RUN}`),
    crypto.randomUUID(),
  );
  assertEquals(rB.status, 201, JSON.stringify(rB.json));
  J.bookingB = rB.data!.bookingId as string;
  J.patientB = rB.data!.patientId as string;

  // Ground truth: the B booking exists and belongs to B.
  const bB = await row("bookings", J.bookingB, "hospital_id, status");
  assertExists(bB);
  assertEquals(bB.hospital_id, J.hospitalB);
});

// ─── 01. TENANT ISOLATION ON READ (RLS under the real authenticated role) ─────

Deno.test("S1 01: receptionist A cannot read B's booking via REST (RLS, no leak)", async () => {
  // Ground truth exists for the privileged reader.
  const control = await row("bookings", J.bookingB, "id");
  assertExists(control, "service-role read proves the B booking exists");

  // The same row must be invisible to an authenticated Hospital-A user.
  const direct = await restGet(
    "authenticated",
    J.tokens.receptionA,
    "bookings",
    `id=eq.${J.bookingB}&select=id`,
  );
  assertEquals(direct.status, 200, JSON.stringify(direct.body));
  assertEquals(
    direct.body,
    [],
    "cross-tenant SELECT must return no rows (RLS leak)",
  );

  const byTenant = await restGet(
    "authenticated",
    J.tokens.receptionA,
    "bookings",
    `hospital_id=eq.${J.hospitalB}&select=id`,
  );
  assertEquals(byTenant.status, 200, JSON.stringify(byTenant.body));
  assertEquals(byTenant.body, [], "no cross-hospital booking enumerable");

  // Positive control: A user CAN read their own hospital's booking.
  const own = await restGet(
    "authenticated",
    J.tokens.receptionA,
    "bookings",
    `id=eq.${J.bookingA}&select=id`,
  );
  assertEquals(own.status, 200, JSON.stringify(own.body));
  assert(
    Array.isArray(own.body) && own.body.length === 1,
    "own-hospital read must succeed",
  );
});

// ─── 02. TENANT-ID SPOOFING — attacker JWT of A, header claims B ─────────────

Deno.test("S1 02: A receptionist cannot act in B by spoofing X-Hospital-ID", async () => {
  const before = await rowCount("bookings", [["hospital_id", J.hospitalB]]);

  const resp = await callFunction(
    "create-booking",
    J.tokens.receptionA,
    J.hospitalB,
    bookingBody(J.hospitalB, J.doctorB, 12, `S1 spoof ${RUN}`),
    crypto.randomUUID(),
  );

  assert(
    resp.status === 401 || resp.status === 403,
    `tenant-spoof header must be denied, got ${resp.status} (${
      JSON.stringify(resp.json)
    })`,
  );

  const after = await rowCount("bookings", [["hospital_id", J.hospitalB]]);
  assertEquals(
    after,
    before,
    "denied cross-tenant create must not add a B booking",
  );
});

// ─── 03. TENANT-ID SPOOFING — body hospitalId != validated header ─────────────

Deno.test("S1 03: valid A header + body hospitalId=B is rejected with no side effect", async () => {
  const beforeA = await rowCount("bookings", [["hospital_id", J.hospitalA]]);
  const beforeB = await rowCount("bookings", [["hospital_id", J.hospitalB]]);

  const resp = await callFunction(
    "create-booking",
    J.tokens.receptionA,
    J.hospitalA,
    bookingBody(J.hospitalB, J.doctorA, 13, `S1 mismatch ${RUN}`),
    crypto.randomUUID(),
  );

  // ValidationError (body/header tenant mismatch) is 422 per the error
  // contract (errors.ts). It is a refusal, not an authorization grant.
  assertEquals(resp.status, 422, JSON.stringify(resp.json)); // header/body mismatch
  assertEquals(
    await rowCount("bookings", [["hospital_id", J.hospitalA]]),
    beforeA,
  );
  assertEquals(
    await rowCount("bookings", [["hospital_id", J.hospitalB]]),
    beforeB,
  );
});

// ─── 04. RESOURCE-ID SPOOFING — A cancels B's booking (cross-tenant write) ────

Deno.test("S1 04: A receptionist cannot cancel B's booking; state unchanged", async () => {
  const pre = await row("bookings", J.bookingB, "status, cancelled_at");
  assertExists(pre);
  assertEquals(pre!.status, "booked", "target must start non-cancelled");
  // Baseline audit rows for the victim booking: the legitimate S1-00
  // creation of bookingB already wrote one. A refused attack must add NONE.
  const auditBefore = await rowCount("audit_logs", [["entity_id", J.bookingB]]);

  const resp = await callFunction(
    "cancel-booking",
    J.tokens.receptionA,
    J.hospitalA,
    {
      bookingId: J.bookingB,
      cancellationReason: "cross-tenant attack",
      initiateRefund: false,
    },
  );

  assert(
    resp.status === 401 || resp.status === 403,
    `resource-id spoof must be denied, got ${resp.status} (${
      JSON.stringify(resp.json)
    })`,
  );

  // Spec §23: denial alone is not proof — re-read the database.
  const post = await row("bookings", J.bookingB, "status, cancelled_at");
  assertExists(post);
  assertEquals(post!.status, pre!.status, "B booking status must be unchanged");
  assertEquals(
    post!.cancelled_at,
    pre!.cancelled_at,
    "no cancellation timestamp written",
  );

  // No NEW cancellation audit event was produced for the victim tenant.
  assertEquals(
    await rowCount("audit_logs", [["entity_id", J.bookingB]]),
    auditBefore,
    "a refused attack must not append an audit row for the victim",
  );
});

// ─── 05. RESOURCE-ID SPOOFING — doctor A updates B's booking ──────────────────

Deno.test("S1 05: doctor A cannot status-update B's booking; state unchanged", async () => {
  const pre = await row("bookings", J.bookingB, "status");
  assertExists(pre);

  const resp = await callFunction(
    "update-booking-status",
    J.tokens.doctorA,
    J.hospitalA,
    { bookingId: J.bookingB, newStatus: "completed" },
  );

  assert(
    resp.status === 401 || resp.status === 403,
    `doctor cross-tenant update must be denied, got ${resp.status} (${
      JSON.stringify(resp.json)
    })`,
  );

  const post = await row("bookings", J.bookingB, "status");
  assertEquals(
    post!.status,
    pre!.status,
    "B booking status unchanged after denial",
  );
});

// ─── 13. DOCTOR SCOPE ISOLATION — intra-hospital, doctor A vs another doctor ──

Deno.test("S1 13: doctor A cannot mutate another doctor's booking in the SAME hospital", async () => {
  const { db } = await ctx();

  // A second doctor in hospital A, with a schedule, and a booking assigned
  // to them. This isolates the INTRA-hospital ownership boundary from the
  // cross-tenant one already covered by S1-05.
  const doctorA2 = await createUserWithRole(
    `s1-doc-a2-${RUN}@setura.test`,
    J.hospitalA,
    "doctor",
    20,
  );
  const { error: schedErr } = await db.from("doctor_schedules").insert({
    doctor_id: doctorA2,
    hospital_id: J.hospitalA,
    weekday: CLINIC.weekday,
    start_time: "09:00:00",
    end_time: "13:00:00",
    max_tokens: 30,
  });
  assertEquals(schedErr, null);

  const created = await callFunction(
    "create-booking",
    J.tokens.receptionA,
    J.hospitalA,
    bookingBody(J.hospitalA, doctorA2, 21, `S1 Pt other-doc ${RUN}`),
    crypto.randomUUID(),
  );
  assertEquals(created.status, 201, JSON.stringify(created.json));
  const otherBooking = created.data!.bookingId as string;

  const pre = await row("bookings", otherBooking, "status, assigned_doctor_id");
  assertExists(pre);
  assertEquals(
    pre!.assigned_doctor_id,
    doctorA2,
    "booking owned by the OTHER doctor",
  );

  // Doctor A (a legitimate A doctor) tries to complete the other doctor's
  // booking within the same tenant -> refused by the ownership check
  // (update-booking-status `Doctors can only update their own patients`).
  const attack = await callFunction(
    "update-booking-status",
    J.tokens.doctorA,
    J.hospitalA,
    { bookingId: otherBooking, newStatus: "completed" },
  );
  assertEquals(attack.status, 403, JSON.stringify(attack.json));

  // Spec §23: the denial must correspond to an unchanged row.
  const post = await row("bookings", otherBooking, "status");
  assertEquals(
    post!.status,
    pre!.status,
    "other doctor's booking status unchanged after denial",
  );
});

// ─── 06. ROLE ISOLATION — receptionist hits a doctor-only endpoint ────────────

Deno.test("S1 06: receptionist cannot invoke doctor-operations (role boundary)", async () => {
  const resp = await callFunction(
    "doctor-operations",
    J.tokens.receptionA,
    J.hospitalA,
    { action: "dashboard" },
  );
  assert(
    resp.status === 401 || resp.status === 403,
    `role isolation must deny receptionist→doctor endpoint, got ${resp.status} (${
      JSON.stringify(resp.json)
    })`,
  );

  // Positive control: the doctor CAN call the same endpoint.
  const ok = await callFunction(
    "doctor-operations",
    J.tokens.doctorA,
    J.hospitalA,
    { action: "dashboard" },
  );
  assertEquals(ok.status, 200, JSON.stringify(ok.json));
});

// ─── 07. AUTHENTICATION — missing / malformed JWT ─────────────────────────────

Deno.test("S1 07: protected endpoint refuses missing and malformed credentials", async () => {
  const noAuth = await callFunction(
    "create-booking",
    null,
    J.hospitalA,
    bookingBody(J.hospitalA, J.doctorA, 14, `S1 noauth ${RUN}`),
    crypto.randomUUID(),
  );
  assertEquals(noAuth.status, 401, JSON.stringify(noAuth.json));

  const garbage = await callFunction(
    "create-booking",
    "not-a-real-jwt",
    J.hospitalA,
    bookingBody(J.hospitalA, J.doctorA, 15, `S1 garbage ${RUN}`),
    crypto.randomUUID(),
  );
  assertEquals(garbage.status, 401, JSON.stringify(garbage.json));
});

// ─── 08. FAIL-CLOSED — a missing tenant header never selects a default ────────

Deno.test("S1 08: missing X-Hospital-ID is refused, no default-tenant fallback", async () => {
  const beforeTotal = await rowCount("bookings");
  const resp = await callFunction(
    "create-booking",
    J.tokens.receptionA,
    null,
    bookingBody(J.hospitalA, J.doctorA, 16, `S1 nodflt ${RUN}`),
    crypto.randomUUID(),
  );
  // Missing X-Hospital-ID is a ValidationError -> 422, not a silent
  // fallback to any default tenant.
  assertEquals(resp.status, 422, JSON.stringify(resp.json));
  assertEquals(
    await rowCount("bookings"),
    beforeTotal,
    "no booking created without a resolved tenant",
  );
});

// ─── 09. MACHINE ENDPOINTS — cron refuses non-machine callers (fail-closed) ───

Deno.test("S1 09: cron endpoint refuses non-machine callers (fail-closed)", async () => {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const url = `${LOCAL_STATUS.API_URL}/functions/v1/run-cron-minute`;

  // A request with no credential at all is refused at the gateway (401):
  // it never reaches the function. Still a refusal — recorded honestly.
  const noCred = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const noCredStatus = noCred.status;
  await noCred.text();
  assert(
    noCredStatus === 401 || noCredStatus === 403,
    `uncertificated cron call must be refused, got ${noCredStatus}`,
  );

  // A normal user JWT carrying NO machine secret reaches the function and
  // is refused by the endpoint's own fail-closed secret check (403).
  const asUser = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${J.tokens.receptionA}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assertEquals(
    asUser.status,
    403,
    "a user JWT without a cron secret must not trigger the cron endpoint",
  );
  await asUser.text();

  // A normal user JWT carrying a WRONG secret is likewise refused by the
  // function (403), proving the boundary is the secret, not mere JWT presence.
  const asWrong = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${J.tokens.receptionA}`,
      "X-Cron-Secret": "definitely-not-the-secret",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assertEquals(asWrong.status, 403, "a wrong machine secret must be refused");
  await asWrong.text();

  // Positive path (correct secret) is BLOCKED locally: the Edge Runtime
  // container has no CRON_SECRET, so the endpoint is fail-closed to every
  // caller and the authorized branch is never taken. Not faked.
});

// ─── 10. WEBHOOK — unsigned POST is refused, not acknowledged ─────────────────

Deno.test("S1 10: unsigned webhook POST is refused (never 2xx, fail-closed)", async () => {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const url = `${LOCAL_STATUS.API_URL}/functions/v1/process-whatsapp-webhook`;
  const payload = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [],
  });

  // No signature header at all.
  const noSig = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  const noSigStatus = noSig.status;
  await noSig.text();

  // Well-formed-shape but wrong signature.
  const badSig = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`,
    },
    body: payload,
  });
  const badSigStatus = badSig.status;
  await badSig.text();

  // Fail-closed: an unsigned / wrongly-signed request is never accepted
  // (never a 2xx acknowledgement). The refusal may come from the gateway
  // (401: no credential, request never reaches the function) or from the
  // function's signature gate (403 caller fault / 500 secret_missing).
  // All are refusals. The INTERNAL signature logic is proven separately by
  // tests/unit/webhook_signature.test.ts, and the LIVE signed webhook is
  // BLOCKED locally (no META_APP_SECRET) — neither is conflated here.
  assert(
    noSigStatus >= 400,
    `unsigned webhook must be refused, got ${noSigStatus}`,
  );
  assert(
    badSigStatus >= 400,
    `bad-signature webhook must be refused, got ${badSigStatus}`,
  );
});

// ─── 11. SCHEDULER RPC PRIVILEGE — anon/authenticated cannot EXECUTE ──────────

Deno.test("S1 11: anon & authenticated cannot execute service-only scheduler RPC", async () => {
  // run_scheduled_tasks is a no-arg service-only RPC (invoked only by the
  // cron path). A 404 here would mean the name/args are wrong = test defect.
  const anon = await restRpc("anon", undefined, "run_scheduled_tasks", {});
  assertDeniedPrivilege(
    anon.status,
    JSON.stringify(anon.body),
    "anon run_scheduled_tasks",
  );

  const authed = await restRpc(
    "authenticated",
    J.tokens.receptionA,
    "run_scheduled_tasks",
    {},
  );
  assertDeniedPrivilege(
    authed.status,
    JSON.stringify(authed.body),
    "authenticated run_scheduled_tasks",
  );

  // service_role retains EXECUTE (not 401/403): proves the revoke is
  // role-scoped, not a broken worker/scheduler path.
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const svc = await fetch(
    `${LOCAL_STATUS.API_URL}/rest/v1/rpc/run_scheduled_tasks`,
    {
      method: "POST",
      headers: {
        "apikey": LOCAL_STATUS.SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${LOCAL_STATUS.SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  const svcText = await svc.text();
  assert(
    svc.status !== 401 && svc.status !== 403,
    `service_role must retain EXECUTE, got ${svc.status} (${svcText})`,
  );
});

// ─── 12. AUDITABILITY — a legitimate mutation is recorded in the audit trail ──

Deno.test("S1 12: a legitimate booking is auditable against its tenant", async () => {
  const { db } = await ctx();
  const { data, error } = await db.from("audit_logs")
    .select("id, hospital_id, entity_id, action_type")
    .eq("entity_id", J.bookingA)
    .eq("hospital_id", J.hospitalA)
    .limit(1);
  assertEquals(error, null);
  assert(
    (data?.length ?? 0) >= 1,
    "legitimate A booking must have an audit event",
  );
});

// ─── 99. Teardown: remove what the platform contract allows, keep residue ─────

Deno.test("S1 99: teardown cleans non-audit fixtures; documents permanent residue", async () => {
  const { db } = await ctx();

  // Audit-bearing tenants are permanently undeletable (immutability
  // trigger). We attempt the delete and tolerate the contract outcome;
  // we never drop RLS / audit triggers to force a clean-up.
  for (const h of [J.hospitalA, J.hospitalB]) {
    const { error } = await db.from("hospitals").delete().eq("id", h);
    // error is expected when the tenant has append-only audit/config rows.
    if (error) {
      console.log(
        `[S1 teardown] tenant ${h} retained as documented residue: ${error.message}`,
      );
    }
  }
});
