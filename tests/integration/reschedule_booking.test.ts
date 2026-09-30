/**
 * tests/integration/reschedule_booking.test.ts
 *
 * G-07 — Staff Booking Reschedule, exercised over REAL HTTP against the local
 * Supabase stack (spec §12 / §16). The read-only investigation found the staff
 * `reschedule-booking` endpoint was non-functional because it wrote two columns
 * that do not exist (`rescheduled_at`, `rescheduled_by`), which the canonical
 * WhatsApp flow never touched. This suite proves the corrected endpoint behaves
 * exactly like the proven WhatsApp semantics for a staff actor:
 *
 *   staff reschedule → HTTP 200 → old booking status = rescheduled
 *   → a NEW booking exists with a fresh token → fee snapshots preserved
 *   → notification job enqueued exactly once → audit event recorded
 *
 * plus every rejection the endpoint owns: invalid state, past / same / too-far
 * date, holiday, doctor unavailable, concurrency, idempotent replay, tenant
 * isolation and role isolation.
 *
 * Nothing is mocked: tokens are real GoTrue access tokens, the request is a
 * real `fetch` to `/functions/v1/reschedule-booking`, and `resolveAuth` /
 * `requireRole` / `withIdempotency` / `create_booking` are the production
 * primitives. Razorpay and Meta are never called; the outbound notification is
 * only asserted as an ENQUEUED job (enqueueing is not delivery).
 *
 * Run with:  deno task test:integration   (requires `supabase start`).
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

type Db = Awaited<
  ReturnType<
    typeof import("../../supabase/functions/_shared/db.ts").getServiceClient
  >
>;

let _db: Db | null = null;

async function db(): Promise<Db> {
  if (_db) return _db;
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
  _db = getServiceClient();
  return _db;
}

// ─── Per-run fixture isolation ───────────────────────────────────────────────

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "7");
const FIXTURE_PASSWORD = `G07-${RUN}-fixture-pass`;

/** today + n days as YYYY-MM-DD (local). */
function isoAdd(n: number): string {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function phoneOf(tag: number): string {
  return String(6 + (tag % 4)) + RUN + String(tag).padStart(2, "0");
}

async function createUserWithRole(
  email: string,
  hospitalId: string | null,
  role: "global_admin" | "hospital_admin" | "doctor" | "receptionist",
  tag: number,
): Promise<string> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const client = await db();
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
  if (resp.status >= 300) throw new Error(`admin user create: ${resp.status}`);

  const { error: profErr } = await client.from("profiles").upsert({
    id: userId,
    full_name: `G07 ${role} ${RUN}`,
    normalized_phone: `98${RUN}${String(tag).padStart(2, "0")}`,
  });
  assertEquals(profErr, null);

  const { error: roleErr } = await client.from("user_roles").insert({
    user_id: userId,
    hospital_id: hospitalId,
    role,
    is_primary: hospitalId !== null,
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
  if (resp.status >= 300) throw new Error(`password grant: ${resp.status}`);
  const json = await resp.json() as { access_token?: string };
  assertExists(json.access_token);
  return json.access_token;
}

interface HttpResult {
  status: number;
  code: string | null;
  data: Record<string, unknown> | null;
}

async function callReschedule(
  token: string,
  hospitalId: string | null,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<HttpResult> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/functions/v1/reschedule-booking`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        ...(hospitalId ? { "X-Hospital-ID": hospitalId } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    },
  );
  const text = await resp.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* gateway refusal is non-JSON; status still asserted */
  }
  const err = json?.error as { code?: string } | undefined;
  return {
    status: resp.status,
    code: err?.code ?? null,
    data: (json?.data ?? null) as Record<string, unknown> | null,
  };
}

/** Create an eligible booking through the canonical `create_booking` RPC. */
async function newBooking(
  hospitalId: string,
  doctorId: string | null,
  date: string,
  tag: number,
): Promise<{ bookingId: string; token: number }> {
  const client = await db();
  const { data, error } = await client.rpc("create_booking", {
    p_hospital_id: hospitalId,
    p_queue_session_id: undefined,
    p_patient_id: undefined,
    p_patient_name: `G07 ${RUN} ${tag}`,
    p_patient_phone: phoneOf(tag),
    p_patient_age: 40,
    p_patient_gender: "male",
    p_village: `g07-village-${RUN}`,
    p_has_diabetes: false,
    p_has_bp: false,
    p_booking_source: "walkin",
    p_doctor_id: doctorId ?? undefined,
    p_appointment_date: date,
    p_platform_fee: 25,
    p_receptionist_fee: 10,
    p_hospital_fee: 270,
    p_idempotency_key: `g07-seed-${RUN}-${tag}`,
  });
  assertEquals(error, null, `create_booking seed ${tag}`);
  assertExists(data);
  const row = (Array.isArray(data) ? data[0] : data) as {
    booking_id: string;
    token_number: number;
  };
  return { bookingId: row.booking_id, token: row.token_number };
}

interface Fixture {
  hospitalA: string;
  hospitalB: string;
  doctorA: string;
  doctorNoSchedule: string;
  receptionist: string;
  adminA: string;
  doctorUser: string;
  tok: { reception: string; admin: string; doctor: string };
}

let F: Fixture | null = null;
function fx(): Fixture {
  if (!F) throw new Error("setup test has not run");
  return F;
}

// ─── 0. Setup ────────────────────────────────────────────────────────────────

Deno.test("g07: setup tenants, staff, doctor schedules", async () => {
  const client = await db();

  const { data: hA, error: hAErr } = await client
    .from("hospitals")
    .insert({ name: `G07 ${RUN} A`, slug: `g07-${RUN}-a` })
    .select("id")
    .single();
  assertEquals(hAErr, null);
  const { data: hB, error: hBErr } = await client
    .from("hospitals")
    .insert({ name: `G07 ${RUN} B`, slug: `g07-${RUN}-b` })
    .select("id")
    .single();
  assertEquals(hBErr, null);
  assertExists(hA);
  assertExists(hB);
  const hospitalA = hA.id as string;
  const hospitalB = hB.id as string;

  // Neutralize any closed-weekday defaults so the ONLY variable each rejection
  // test isolates is the one it names. A missing working-hours row is treated
  // as "open" by the endpoint.
  await client.from("hospital_working_hours")
    .delete()
    .eq("hospital_id", hospitalA);

  // doctorA is scheduled every weekday, so a date's day-of-week never causes an
  // incidental availability failure in the success / replay / concurrency legs.
  const doctorA = await createUserWithRole(
    `g07-doc-${RUN}@setura.test`,
    hospitalA,
    "doctor",
    1,
  );
  const { error: schedErr } = await client.from("doctor_schedules").insert(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      doctor_id: doctorA,
      hospital_id: hospitalA,
      weekday,
      start_time: "09:00:00",
      end_time: "17:00:00",
      max_tokens: 200,
    })),
  );
  assertEquals(schedErr, null);

  // A second doctor with NO schedule — the doctor-unavailable rejection target.
  const doctorNoSchedule = await createUserWithRole(
    `g07-doc-ghost-${RUN}@setura.test`,
    hospitalA,
    "doctor",
    2,
  );

  const receptionist = await createUserWithRole(
    `g07-recep-${RUN}@setura.test`,
    hospitalA,
    "receptionist",
    3,
  );
  const adminA = await createUserWithRole(
    `g07-admin-${RUN}@setura.test`,
    hospitalA,
    "hospital_admin",
    4,
  );
  const doctorUser = await createUserWithRole(
    `g07-docstaff-${RUN}@setura.test`,
    hospitalA,
    "doctor",
    5,
  );

  F = {
    hospitalA,
    hospitalB,
    doctorA,
    doctorNoSchedule,
    receptionist,
    adminA,
    doctorUser,
    tok: {
      reception: await signIn(`g07-recep-${RUN}@setura.test`),
      admin: await signIn(`g07-admin-${RUN}@setura.test`),
      doctor: await signIn(`g07-docstaff-${RUN}@setura.test`),
    },
  };
});

// ─── 1. Success + side effects ───────────────────────────────────────────────

Deno.test("g07: staff reschedule succeeds and preserves fee snapshots", async () => {
  const client = await db();
  const f = fx();
  const origDate = isoAdd(3);
  const newDate = isoAdd(5);
  const { bookingId } = await newBooking(f.hospitalA, f.doctorA, origDate, 10);

  const idem = crypto.randomUUID();
  const res = await callReschedule(
    f.tok.reception,
    f.hospitalA,
    { bookingId, newDate, reason: "Patient travelling" },
    idem,
  );
  assertEquals(res.status, 200);
  assertExists(res.data);
  const newBookingId = res.data.newBookingId as string;
  assertExists(newBookingId);
  assertEquals(res.data.originalBookingId, bookingId);
  assertEquals(res.data.newDate, newDate);

  // Old booking is terminal-rescheduled; new booking carries the same fees.
  const { data: origRow } = await client.from("bookings")
    .select("status")
    .eq("id", bookingId)
    .single();
  assertEquals((origRow as { status: string }).status, "rescheduled");

  const { data: newCol } = await client.from("bookings")
    .select(
      "appointment_date, status, platform_fee_snapshot, receptionist_fee_snapshot, hospital_fee_snapshot, carry_forwarded_from, assigned_doctor_id",
    )
    .eq("id", newBookingId)
    .single();
  const nb = newCol as Record<string, unknown>;
  assertEquals(nb.appointment_date, newDate);
  assertEquals(nb.status, "booked");
  assertEquals(Number(nb.platform_fee_snapshot), 25);
  assertEquals(Number(nb.receptionist_fee_snapshot), 10);
  assertEquals(Number(nb.hospital_fee_snapshot), 270);
  assertEquals(nb.carry_forwarded_from, bookingId);
  // No newDoctorId sent → the new booking keeps the original doctor.
  assertEquals(nb.assigned_doctor_id, f.doctorA);
});

Deno.test("g07: audit event and notification job are recorded exactly once", async () => {
  const client = await db();
  const f = fx();
  const { bookingId } = await newBooking(
    f.hospitalA,
    f.doctorA,
    isoAdd(3),
    11,
  );
  const res = await callReschedule(
    f.tok.admin,
    f.hospitalA,
    { bookingId, newDate: isoAdd(6) },
    crypto.randomUUID(),
  );
  assertEquals(res.status, 200);
  const newBookingId = (res.data as Record<string, unknown>)
    .newBookingId as string;

  const { data: audits, error: auditErr } = await client
    .from("audit_logs")
    .select("id, action_type, entity_type, actor_user_id")
    .eq("hospital_id", f.hospitalA)
    .eq("entity_id", bookingId)
    .eq("action_type", "booking_status_change");
  assertEquals(auditErr, null);
  assertEquals((audits ?? []).length, 1, "one audit event for the reschedule");

  const { data: jobs, error: jobsErr } = await client
    .from("job_queue")
    .select("id")
    .eq("idempotency_key", `wa_reschedule_${newBookingId}`);
  assertEquals(jobsErr, null);
  assertEquals((jobs ?? []).length, 1, "notification enqueued exactly once");
});

Deno.test("g07: replay of the same idempotency key creates no second booking", async () => {
  const client = await db();
  const f = fx();
  const { bookingId } = await newBooking(
    f.hospitalA,
    f.doctorA,
    isoAdd(3),
    12,
  );
  const idem = crypto.randomUUID();
  const body = { bookingId, newDate: isoAdd(7) };

  const first = await callReschedule(f.tok.reception, f.hospitalA, body, idem);
  assertEquals(first.status, 200);
  const second = await callReschedule(f.tok.reception, f.hospitalA, body, idem);
  assertEquals(second.status, 200);
  assertEquals(
    second.data?.newBookingId,
    first.data?.newBookingId,
    "replay returns the original result",
  );

  const { count: linked } = await client.from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("carry_forwarded_from", bookingId);
  assertEquals(linked, 1, "exactly one new booking from the replayed request");
});

Deno.test("g07: concurrent reschedule — one succeeds, one is rejected 409", async () => {
  const client = await db();
  const f = fx();
  const { bookingId } = await newBooking(
    f.hospitalA,
    f.doctorA,
    isoAdd(3),
    13,
  );

  const [a, b] = await Promise.all([
    callReschedule(
      f.tok.reception,
      f.hospitalA,
      { bookingId, newDate: isoAdd(8) },
      crypto.randomUUID(),
    ),
    callReschedule(
      f.tok.admin,
      f.hospitalA,
      { bookingId, newDate: isoAdd(9) },
      crypto.randomUUID(),
    ),
  ]);

  const statuses = [a.status, b.status].sort();
  assertEquals(statuses[0], 200, "exactly one attempt succeeds");
  assertEquals(statuses[1], 409, "the stale-status attempt is rejected");

  const { count: linked } = await client.from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("carry_forwarded_from", bookingId);
  assertEquals(linked, 1, "concurrency produces exactly one new booking");
});

// ─── 2. Rejections (server-side validation) ──────────────────────────────────

Deno.test("g07: invalid-state bookings are rejected", async () => {
  const client = await db();
  const f = fx();
  const { bookingId } = await newBooking(
    f.hospitalA,
    f.doctorA,
    isoAdd(3),
    14,
  );
  await client.from("bookings").update({ status: "completed" })
    .eq("id", bookingId);

  const res = await callReschedule(
    f.tok.reception,
    f.hospitalA,
    { bookingId, newDate: isoAdd(5) },
    crypto.randomUUID(),
  );
  assertEquals(res.status, 422);
  assertEquals(res.code, "VALIDATION_ERROR");
});

Deno.test("g07: past, same, and too-far dates are rejected", async () => {
  const client = await db();
  const f = fx();
  const origDate = isoAdd(3);
  const { bookingId } = await newBooking(f.hospitalA, f.doctorA, origDate, 15);

  const past = await callReschedule(
    f.tok.reception,
    f.hospitalA,
    { bookingId, newDate: isoAdd(-2) },
    crypto.randomUUID(),
  );
  assertEquals(past.status, 422);
  assertEquals(past.code, "VALIDATION_ERROR");

  const same = await callReschedule(
    f.tok.reception,
    f.hospitalA,
    { bookingId, newDate: origDate },
    crypto.randomUUID(),
  );
  assertEquals(same.status, 422);
  assertEquals(same.code, "VALIDATION_ERROR");

  const far = await callReschedule(
    f.tok.reception,
    f.hospitalA,
    { bookingId, newDate: isoAdd(400) },
    crypto.randomUUID(),
  );
  assertEquals(far.status, 422);
  assertEquals(far.code, "VALIDATION_ERROR");

  // None of the rejections touched the original booking.
  const { data } = await client.from("bookings").select("status")
    .eq("id", bookingId).single();
  assertEquals((data as { status: string }).status, "booked");
});

Deno.test("g07: holiday on the new date is rejected", async () => {
  const f = fx();
  const client = await db();
  const { bookingId } = await newBooking(
    f.hospitalA,
    f.doctorA,
    isoAdd(3),
    16,
  );
  const holidayDate = isoAdd(5);
  const { error: hErr } = await client.from("hospital_holidays").insert({
    hospital_id: f.hospitalA,
    holiday_date: holidayDate,
    description: `G07 holiday ${RUN}`,
  });
  assertEquals(hErr, null);

  const res = await callReschedule(
    f.tok.reception,
    f.hospitalA,
    { bookingId, newDate: holidayDate },
    crypto.randomUUID(),
  );
  assertEquals(res.status, 422);
  assertEquals(res.code, "HOSPITAL_CLOSED");

  // Remove the holiday so this fixture never leaks into a later test that
  // reschedules hospitalA onto the same date (the endpoint checks holidays
  // before doctor availability, so a stale row would mask DOCTOR_UNAVAILABLE).
  await client.from("hospital_holidays")
    .delete()
    .eq("hospital_id", f.hospitalA)
    .eq("holiday_date", holidayDate);
});

Deno.test("g07: doctor unavailable on the new date is rejected", async () => {
  const f = fx();
  const { bookingId } = await newBooking(
    f.hospitalA,
    f.doctorA,
    isoAdd(3),
    17,
  );
  const res = await callReschedule(
    f.tok.reception,
    f.hospitalA,
    { bookingId, newDate: isoAdd(4), newDoctorId: f.doctorNoSchedule },
    crypto.randomUUID(),
  );
  assertEquals(res.status, 422);
  assertEquals(res.code, "DOCTOR_UNAVAILABLE");
});

// ─── 3. Security: tenant + role boundaries ───────────────────────────────────

Deno.test("g07: cross-tenant booking is rejected 403 with no mutation", async () => {
  const client = await db();
  const f = fx();
  // A booking that belongs to hospital B.
  const { bookingId } = await newBooking(f.hospitalB, null, isoAdd(3), 18);

  // Hospital A's admin, header = A, targets B's booking.
  const res = await callReschedule(
    f.tok.admin,
    f.hospitalA,
    { bookingId, newDate: isoAdd(5) },
    crypto.randomUUID(),
  );
  assertEquals(res.status, 403);
  assertEquals(res.code, "FORBIDDEN");

  const { data } = await client.from("bookings").select("status")
    .eq("id", bookingId).single();
  assertEquals((data as { status: string }).status, "booked", "no mutation");
});

Deno.test("g07: a doctor is not authorized to staff-reschedule (403)", async () => {
  const f = fx();
  const { bookingId } = await newBooking(
    f.hospitalA,
    f.doctorA,
    isoAdd(3),
    19,
  );
  const res = await callReschedule(
    f.tok.doctor,
    f.hospitalA,
    { bookingId, newDate: isoAdd(5) },
    crypto.randomUUID(),
  );
  assert(
    res.status === 403 || res.status === 401,
    `doctor must be denied, got ${res.status}`,
  );
});

Deno.test("g07: missing X-Hospital-ID header is rejected", async () => {
  const f = fx();
  const { bookingId } = await newBooking(
    f.hospitalA,
    f.doctorA,
    isoAdd(3),
    20,
  );
  const res = await callReschedule(
    f.tok.reception,
    null,
    { bookingId, newDate: isoAdd(5) },
    crypto.randomUUID(),
  );
  assert(
    res.status >= 400 && res.status < 500,
    `expected 4xx, got ${res.status}`,
  );
});

// ─── 4. Cleanup ──────────────────────────────────────────────────────────────

Deno.test("g07: cleanup fixtures", async () => {
  if (!LOCAL_STATUS) return;
  const client = await db();
  const f = F;
  if (!f) return;

  // Bookings reference the audit trail only via the entity id, so remove the
  // job_queue and audit rows the fixtures produced before the tenants.
  await client.from("job_queue")
    .delete()
    .eq("hospital_id", f.hospitalA);
  await client.from("audit_logs").delete().eq("hospital_id", f.hospitalA);
  await client.from("audit_logs").delete().eq("hospital_id", f.hospitalB);
  await client.from("hospital_holidays").delete().eq(
    "hospital_id",
    f.hospitalA,
  );
  await client.from("doctor_schedules").delete().eq("hospital_id", f.hospitalA);
  await client.from("bookings").delete().eq("hospital_id", f.hospitalA);
  await client.from("bookings").delete().eq("hospital_id", f.hospitalB);

  for (
    const uid of [
      f.doctorA,
      f.doctorNoSchedule,
      f.receptionist,
      f.adminA,
      f.doctorUser,
    ]
  ) {
    await client.from("user_roles").delete().eq("user_id", uid);
    await client.from("profiles").delete().eq("id", uid);
    try {
      await fetch(`${LOCAL_STATUS.API_URL}/auth/v1/admin/users/${uid}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${LOCAL_STATUS.SERVICE_ROLE_KEY}` },
      });
    } catch {
      /* best-effort */
    }
  }
  // hospital_settings rows may leave config_versions FK references; delete best
  // effort and tolerate a residual undeletable tenant.
  for (const h of [f.hospitalA, f.hospitalB]) {
    await client.from("hospital_settings").delete().eq("hospital_id", h);
    try {
      await client.from("hospitals").delete().eq("id", h);
    } catch {
      /* tolerate residue */
    }
  }
});
