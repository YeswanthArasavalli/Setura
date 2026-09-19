/**
 * tests/integration/hospital_core_journey.test.ts
 *
 * Phase 4 — Gate E1: the complete hospital core journey against the
 * REAL local Supabase stack (no mocks; Meta and Razorpay are never
 * called — see tests/utils/setup_env.ts for the strategy).
 *
 *   PATIENT → REGISTRATION → APPOINTMENT / WALK-IN → TOKEN → QUEUE
 *   → DOCTOR → CONSULTATION → BILLING → PAYMENT → NOTIFICATION
 *   → HISTORY
 *
 * Every internal stage runs through the canonical entry points:
 *   - create-booking / update-booking-status / queue-control /
 *     doctor-operations / cancel-booking Edge Functions over REAL
 *     HTTP with real GoTrue JWTs (receptionist + doctor roles),
 *   - the payment leg through the same RPC chain verify-payment
 *     calls (idempotent_capture_payment → capture_payment →
 *     financial_ledger), because REAL RAZORPAY = BLOCKED locally,
 *   - token allocation through the create_booking RPC (the atomic
 *     upsert every creation path funnels through).
 *
 * Isolation (Phase 2's hospital_holidays lesson, spec §23): the
 * whole journey runs inside two fresh fixture hospitals, never the
 * seed hospital, with per-RUN users, patients, phones and
 * idempotency keys. Teardown proves the real platform contract:
 * the audit-free tenant CASCADE-deletes completely, while the
 * ledger-bearing tenant is PERMANENT (immutability trigger fires on
 * cascade) and stays as inert, documented residue.
 *
 * Defects this suite pins (Phase 4):
 *   - patient find-or-create persisted the raw 10-digit phone while
 *     the dedupe lookup filtered on E.164 → rebooking 500'd or
 *     duplicated the patient (fixed in create-booking/index.ts).
 *   - get_remaining_token_capacity counted only the FIRST shift of
 *     an extended-hours day (fixed in migration 55; the fixture
 *     doctor has two shifts totalling 50 tokens).
 *
 * Run with:  deno task test:integration   (requires `supabase start`
 * plus a running Edge Runtime — verify with `supabase status`).
 */

import {
  assertEquals,
  assertExists,
  assertGreater,
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

// ─── One-time bootstrap: env → dynamic imports of real modules ──────────────

let _ctx: Awaited<ReturnType<typeof bootstrap>> | null = null;

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

  const { getServiceClient, createAuthClient } = await import(
    "../../supabase/functions/_shared/db.ts"
  );
  return { db: getServiceClient(), createAuthClient };
}

async function ctx() {
  if (!_ctx) _ctx = await bootstrap();
  return _ctx;
}

// ─── Per-run fixture isolation ───────────────────────────────────────────────

// Digits-only run id: fixture phones must be exactly 10 digits.
const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "7");
const FIXTURE_PASSWORD = `E1-${RUN}-fixture-pass`;

/**
 * Clinic date = today when today is a Mon-Sat working day (the
 * fixture doctor schedules Mon-Sat), else tomorrow. isValidAdvance-
 * BookingDate accepts diffDays >= 0, and running the queue/doctor
 * legs on TODAY is what the session-scoped operations require.
 */
function clinicDate(): { date: string; weekday: number } {
  const d = new Date();
  if (d.getDay() === 0) d.setDate(d.getDate() + 1);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return { date: `${d.getFullYear()}-${m}-${day}`, weekday: d.getDay() };
}

const CLINIC = clinicDate();

/** Distinct valid 10-digit Indian mobile numbers per run (tag < 100). */
function phoneOf(tag: number): string {
  return String(6 + (tag % 4)) + RUN + String(tag).padStart(2, "0");
}

interface Journey {
  hospitalA: string;
  hospitalB: string;
  receptionA: string;
  doctorA: string;
  receptionB: string;
  tokens: Record<string, string>;
  patientId: string;
  booking1: string; // appointment (online), full doctor leg + payment
  booking2: string; // walk-in, reception check-in + explicit call
  booking3: string; // cancelled — cross-module consistency
  booking4: string; // manual_whatsapp — fee-split proof
  sessionId: string;
  token1: number;
  token2: number;
  token3: number;
  token4: number;
  paymentOrderId: string;
  captured: boolean;
  replayBooking: string;
  concurrencyBookings: string[];
}

const J = {} as Journey;

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

  const { error: profErr } = await db
    .from("profiles")
    .upsert({
      id: userId,
      full_name: `E1 ${role} ${RUN}`,
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

// ─── Edge Function HTTP helper ───────────────────────────────────────────────

async function callFunction(
  name: string,
  token: string,
  hospitalId: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{
  status: number;
  json: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");

  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/functions/v1/${name}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "X-Hospital-ID": hospitalId,
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
    // Non-JSON body (gateway refusal) — status is still checked.
  }
  return {
    status: resp.status,
    json,
    data: (json?.data ?? null) as Record<string, unknown> | null,
  };
}

function bookingBody(source: string, tag: number, name: string) {
  return {
    hospitalId: J.hospitalA,
    patientName: name,
    patientPhone: phoneOf(tag),
    patientAge: 40,
    patientGender: "M",
    village: `e1-village-${RUN}`,
    hasDiabetes: false,
    hasBp: false,
    bookingSource: source,
    doctorId: J.doctorA,
    appointmentDate: CLINIC.date,
  };
}

// ─── DB read helpers (service role) ─────────────────────────────────────────

async function row(table: string, id: string, cols = "*") {
  const { db } = await ctx();
  const { data, error } = await db
    .from(table)
    .select(cols)
    .eq("id", id)
    .maybeSingle();
  assertEquals(error, null);
  return data as Record<string, unknown> | null;
}

async function rowCount(table: string, filters: Array<[string, string]> = []) {
  const { db } = await ctx();
  let q = db.from(table).select("id", { count: "exact", head: true });
  for (const [col, val] of filters) q = q.eq(col, val);
  const { count, error } = await q;
  assertEquals(error, null);
  return count ?? 0;
}

// ─── 0. Fixtures: two isolated tenants, three actors, schedules ─────────────

Deno.test("E1 00: provision isolated fixture tenants and actors", async () => {
  const { db } = await ctx();

  const { data: hA, error: hAErr } = await db
    .from("hospitals")
    .insert({ name: `E1 Journey ${RUN} A`, slug: `e1-journey-${RUN}-a` })
    .select("id")
    .single();
  assertEquals(hAErr, null);
  const { data: hB, error: hBErr } = await db
    .from("hospitals")
    .insert({ name: `E1 Journey ${RUN} B`, slug: `e1-journey-${RUN}-b` })
    .select("id")
    .single();
  assertEquals(hBErr, null);
  assertExists(hA);
  assertExists(hB);
  J.hospitalA = hA.id;
  J.hospitalB = hB.id;

  // Hospital A settings: online booking + WhatsApp confirmation on.
  // The auto-provisioning triggers (trg_auto_hospital_settings /
  // trg_auto_booking_fee_policy) already created the default rows on
  // hospital insert — the fixture only adjusts values, which also
  // proves the platform's per-tenant provisioning behaviour. NOTE:
  // every hospital_settings UPDATE is versioned into the append-only
  // config_versions table, which makes THIS tenant permanently
  // undeletable (E1 99 pins that contract). Hospital B is therefore
  // left completely unconfigured so it stays fully deletable.
  assertEquals(
    await rowCount("hospital_settings", [["hospital_id", J.hospitalA]]),
    1,
  );
  assertEquals(
    await rowCount("booking_fee_policies", [["hospital_id", J.hospitalA]]),
    1,
  );

  const { error: setErr } = await db
    .from("hospital_settings")
    .update({
      allow_online_booking: true,
      send_whatsapp_confirmation: true,
      send_whatsapp_reminder: true,
      reminder_before_minutes: 30,
      max_tokens_per_day: 100,
      receptionist_fee: 5,
    })
    .eq("hospital_id", J.hospitalA);
  assertEquals(setErr, null);

  const { error: feeErr } = await db
    .from("booking_fee_policies")
    .update({
      booking_fee_online: 20,
      booking_fee_whatsapp: 10,
      booking_fee_walkin: 5,
    })
    .eq("hospital_id", J.hospitalA);
  assertEquals(feeErr, null);

  J.receptionA = await createUserWithRole(
    `e1-recep-a-${RUN}@setura.test`,
    J.hospitalA,
    "receptionist",
    1,
  );
  J.doctorA = await createUserWithRole(
    `e1-doc-a-${RUN}@setura.test`,
    J.hospitalA,
    "doctor",
    2,
  );
  J.receptionB = await createUserWithRole(
    `e1-recep-b-${RUN}@setura.test`,
    J.hospitalB,
    "receptionist",
    3,
  );

  // Extended-hours doctor: two shifts, 30 + 20 = 50 daily tokens.
  // This is also the live fixture for the migration 55 cap fix.
  const { error: schedErr } = await db.from("doctor_schedules").insert([
    {
      doctor_id: J.doctorA,
      hospital_id: J.hospitalA,
      weekday: CLINIC.weekday,
      start_time: "09:00:00",
      end_time: "13:00:00",
      max_tokens: 30,
    },
    {
      doctor_id: J.doctorA,
      hospital_id: J.hospitalA,
      weekday: CLINIC.weekday,
      start_time: "17:00:00",
      end_time: "21:00:00",
      max_tokens: 20,
    },
  ]);
  assertEquals(schedErr, null);

  J.tokens = {
    receptionA: await signIn(`e1-recep-a-${RUN}@setura.test`),
    doctorA: await signIn(`e1-doc-a-${RUN}@setura.test`),
    receptionB: await signIn(`e1-recep-b-${RUN}@setura.test`),
  };
});

// ─── 1. PATIENT REGISTRATION + APPOINTMENT (reception, real HTTP) ───────────

Deno.test("E1 01: registration + appointment over HTTP create a linked booked token", async () => {
  const { db } = await ctx();

  const resp = await callFunction(
    "create-booking",
    J.tokens.receptionA,
    J.hospitalA,
    bookingBody("online", 10, `E1 Patient ${RUN}`),
    crypto.randomUUID(),
  );
  assertEquals(resp.status, 201, JSON.stringify(resp.json));
  assertExists(resp.data);

  J.booking1 = resp.data.bookingId as string;
  J.token1 = resp.data.tokenNumber as number;
  J.patientId = resp.data.patientId as string;
  J.sessionId = resp.data.queueSessionId as string;

  // Patient created correctly, right tenant.
  const patient = await row("patients", J.patientId);
  assertExists(patient);
  assertEquals(patient.hospital_id, J.hospitalA);
  assertEquals(patient.full_name, `E1 Patient ${RUN}`);

  // Booking links: patient + doctor + hospital + date + session.
  const booking = await row("bookings", J.booking1);
  assertExists(booking);
  assertEquals(booking.hospital_id, J.hospitalA);
  assertEquals(booking.patient_id, J.patientId);
  assertEquals(booking.assigned_doctor_id, J.doctorA);
  assertEquals(booking.appointment_date, CLINIC.date);
  assertEquals(booking.status, "booked");
  assertEquals(booking.booking_source, "online");

  // Fee boundary: SETURA collects the platform fee only; the hospital
  // fee is ALWAYS 0 (consultation money is collected by the hospital).
  assertEquals(Number(booking.platform_fee_snapshot), 20);
  assertEquals(Number(booking.hospital_fee_snapshot), 0);
  assertEquals(
    Number(booking.booking_fee_inr),
    20,
    "P0-04 observable at E1: refund basis persisted at creation > 0",
  );

  // Queue session auto-created for the doctor's clinic date.
  const session = await row("queue_sessions", J.sessionId);
  assertExists(session);
  assertEquals(session.hospital_id, J.hospitalA);
  assertEquals(session.doctor_id, J.doctorA);
  assertEquals(session.session_date, CLINIC.date);
  assertGreater(session.max_tokens as number, 0);

  // Token belongs to the daily counter, not a client guess.
  const { data: counter } = await db
    .from("hospital_daily_counters")
    .select("last_token")
    .eq("hospital_id", J.hospitalA)
    .eq("visit_date", CLINIC.date)
    .single();
  assertExists(counter);
  assertEquals(counter.last_token as number, J.token1);
});

// ─── 2. Registration validation + authorization ─────────────────────────────

Deno.test("E1 02: invalid input, tenant mismatch and unauthorized access are refused", async () => {
  // Invalid input: name too short (the edge maps ValidationError to
  // HTTP 422 with a VALIDATION_ERROR body).
  const bad = await callFunction(
    "create-booking",
    J.tokens.receptionA,
    J.hospitalA,
    { ...bookingBody("online", 11, "x"), hospitalId: J.hospitalA },
    crypto.randomUUID(),
  );
  assertEquals(bad.status, 422, JSON.stringify(bad.json));

  // Body hospitalId does not match the header (cross-hospital injection).
  const mismatch = await callFunction(
    "create-booking",
    J.tokens.receptionA,
    J.hospitalA,
    {
      ...bookingBody("online", 11, `E1 Mismatch ${RUN}`),
      hospitalId: J.hospitalB,
    },
    crypto.randomUUID(),
  );
  assertEquals(mismatch.status, 422, JSON.stringify(mismatch.json));

  // Hospital B receptionist cannot book into Hospital A (membership
  // check). A valid JWT that simply lacks the tenant role must be
  // refused at authz, not by a JWT-layer rejection.
  const cross = await callFunction(
    "create-booking",
    J.tokens.receptionB,
    J.hospitalA,
    bookingBody("online", 12, `E1 Cross ${RUN}`),
    crypto.randomUUID(),
  );
  assertEquals(cross.status, 403, JSON.stringify(cross.json));

  // No booking from any refused attempt.
  const { db } = await ctx();
  const { count } = await db
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .in("patient_name", [
      `E1 Mismatch ${RUN}`,
      `E1 Cross ${RUN}`,
      "x",
    ]);
  assertEquals(count ?? 0, 0);
});

// ─── 3. Canonical patient identity: duplicate handling (§6) ─────────────────

Deno.test("E1 03: walk-in rebooking reuses the canonical patient (no duplicate identity)", async () => {
  const resp = await callFunction(
    "create-booking",
    J.tokens.receptionA,
    J.hospitalA,
    bookingBody("walkin", 10, `E1 Patient ${RUN}`), // SAME phone + name
    crypto.randomUUID(),
  );
  assertEquals(resp.status, 201, JSON.stringify(resp.json));
  assertExists(resp.data);
  J.booking2 = resp.data.bookingId as string;
  J.token2 = resp.data.tokenNumber as number;

  assertEquals(
    resp.data.patientId,
    J.patientId,
    "find-or-create must reuse the canonical patient row",
  );

  const { db } = await ctx();
  const { data: patients } = await db
    .from("patients")
    .select("id")
    .eq("hospital_id", J.hospitalA)
    .eq("full_name", `E1 Patient ${RUN}`);
  assertEquals((patients ?? []).length, 1, "exactly one patient row");

  // Walk-in stays inside every invariant: same tenant, same session,
  // walkin fee policy (platform 5), hospital fee still 0.
  const booking = await row("bookings", J.booking2);
  assertExists(booking);
  assertEquals(booking.booking_source, "walkin");
  assertEquals(booking.queue_session_id, J.sessionId);
  assertEquals(Number(booking.platform_fee_snapshot), 5);
  assertEquals(Number(booking.booking_fee_inr), 5);
  assertEquals(Number(booking.hospital_fee_snapshot), 0);
});

// ─── 4. Idempotent HTTP replay (§19) ────────────────────────────────────────

Deno.test("E1 04: replaying the registration request returns the same booking, no second token", async () => {
  const key = crypto.randomUUID();
  const body = bookingBody("online", 20, `E1 Replay ${RUN}`);

  const first = await callFunction(
    "create-booking",
    J.tokens.receptionA,
    J.hospitalA,
    body,
    key,
  );
  assertEquals(first.status, 201, JSON.stringify(first.json));
  assertExists(first.data);
  const replayBooking = first.data.bookingId as string;
  const replayToken = first.data.tokenNumber as number;

  const { db } = await ctx();
  const { data: c1 } = await db
    .from("hospital_daily_counters")
    .select("last_token")
    .eq("hospital_id", J.hospitalA)
    .eq("visit_date", CLINIC.date)
    .single();

  const replay = await callFunction(
    "create-booking",
    J.tokens.receptionA,
    J.hospitalA,
    body,
    key,
  );
  assertExists(replay.data);
  assertEquals(
    replay.data.bookingId,
    replayBooking,
    "same Idempotency-Key must return the same booking",
  );
  assertEquals(replay.data.tokenNumber, replayToken);

  const { data: c2 } = await db
    .from("hospital_daily_counters")
    .select("last_token")
    .eq("hospital_id", J.hospitalA)
    .eq("visit_date", CLINIC.date)
    .single();
  assertEquals(
    c2?.last_token,
    c1?.last_token,
    "replay must not consume a token",
  );

  // Exactly one WhatsApp confirmation job for that booking (no
  // duplicate side effect on replay).
  const { data: jobs } = await db
    .from("job_queue")
    .select("id")
    .eq("idempotency_key", `wa_confirm_${replayBooking}`);
  assertEquals((jobs ?? []).length, 1);

  // The replay booking is cleaned with the tenant; remember it.
  J.replayBooking = replayBooking;
});

// ─── 5. Atomic token engine under concurrency (§9) ─────────────────────────

Deno.test("E1 05: 8 concurrent create_booking calls allocate distinct gapless tokens", async () => {
  const { db } = await ctx();

  const { data: before } = await db
    .from("hospital_daily_counters")
    .select("last_token")
    .eq("hospital_id", J.hospitalA)
    .eq("visit_date", CLINIC.date)
    .single();
  const beforeCount = (before?.last_token ?? 0) as number;

  const N = 8;
  const calls = Array.from({ length: N }, (_, i) =>
    db.rpc("create_booking", {
      p_hospital_id: J.hospitalA,
      p_patient_name: `E1 Concurrent ${RUN} ${i}`,
      p_patient_phone: phoneOf(30 + i),
      p_booking_source: "walkin",
      p_appointment_date: CLINIC.date,
      p_platform_fee: 5,
      p_idempotency_key: `e1c-${RUN}-${i}`,
    }));

  const results = await Promise.all(calls);
  const tokens: number[] = [];
  const bookings: string[] = [];
  for (const r of results) {
    assertEquals(r.error, null);
    assertExists(r.data);
    const rowOut = (Array.isArray(r.data) ? r.data[0] : r.data) as {
      booking_id: string;
      token_number: number;
    };
    tokens.push(rowOut.token_number);
    bookings.push(rowOut.booking_id);
  }
  J.concurrencyBookings = bookings;

  // One valid token per request: distinct, no duplicate under race.
  assertEquals(new Set(tokens).size, N, "tokens must be distinct");
  assertEquals(new Set(bookings).size, N);

  // Gapless: the counter advanced by exactly N and every allocated
  // token lies inside the contiguous (before, before+N] window.
  const { data: after } = await db
    .from("hospital_daily_counters")
    .select("last_token")
    .eq("hospital_id", J.hospitalA)
    .eq("visit_date", CLINIC.date)
    .single();
  assertEquals((after?.last_token ?? 0) - beforeCount, N, "no gap, no reuse");
  for (const t of tokens) {
    assertGreater(t, beforeCount);
    assertEquals(t <= beforeCount + N, true, `token ${t} outside window`);
  }

  // Duplicate idempotency-key RPC replay returns the same booking.
  const dup = await db.rpc("create_booking", {
    p_hospital_id: J.hospitalA,
    p_patient_name: `E1 Concurrent ${RUN} 0`,
    p_patient_phone: phoneOf(30),
    p_booking_source: "walkin",
    p_appointment_date: CLINIC.date,
    p_platform_fee: 5,
    p_idempotency_key: `e1c-${RUN}-0`,
  });
  assertEquals(dup.error, null);
  const dupRow = (Array.isArray(dup.data) ? dup.data[0] : dup.data) as {
    booking_id: string;
    token_number: number;
  };
  assertEquals(dupRow.booking_id, bookings[0]);
});

// ─── 6. WALK-IN CHECK-IN (reception) ────────────────────────────────────────

Deno.test("E1 06: reception check-in moves the walk-in to checked_in", async () => {
  const resp = await callFunction(
    "update-booking-status",
    J.tokens.receptionA,
    J.hospitalA,
    { bookingId: J.booking2, newStatus: "checked_in" },
  );
  assertEquals(resp.status, 200, JSON.stringify(resp.json));

  const booking = await row("bookings", J.booking2);
  assertExists(booking);
  assertEquals(booking.status, "checked_in");
});

// ─── 7. CANCELLATION + cross-module consistency (§10, §20) ──────────────────

Deno.test("E1 07: a cancelled booking keeps its token but is NOT callable", async () => {
  const { db } = await ctx();

  // Third patient, online, then cancelled before the queue reaches it.
  const created = await callFunction(
    "create-booking",
    J.tokens.receptionA,
    J.hospitalA,
    bookingBody("online", 13, `E1 Cancelled ${RUN}`),
    crypto.randomUUID(),
  );
  assertEquals(created.status, 201, JSON.stringify(created.json));
  assertExists(created.data);
  J.booking3 = created.data.bookingId as string;
  J.token3 = created.data.tokenNumber as number;

  const cancelled = await callFunction(
    "cancel-booking",
    J.tokens.receptionA,
    J.hospitalA,
    {
      bookingId: J.booking3,
      cancellationReason: `e1 journey cancel ${RUN}`,
      initiateRefund: false,
    },
  );
  assertEquals(cancelled.status, 200, JSON.stringify(cancelled.json));

  const booking = await row("bookings", J.booking3);
  assertExists(booking);
  assertEquals(booking.status, "cancelled");

  // Idempotent replay of the cancel: 200 + alreadyCancelled, no state churn.
  const replay = await callFunction(
    "cancel-booking",
    J.tokens.receptionA,
    J.hospitalA,
    {
      bookingId: J.booking3,
      cancellationReason: `e1 journey cancel replay ${RUN}`,
      initiateRefund: false,
    },
  );
  assertEquals(replay.status, 200, JSON.stringify(replay.json));
  assertEquals(replay.data?.alreadyCancelled, true);

  // Queue module refuses to call a cancelled token (no contradictory
  // "cancelled + active in queue" state possible).
  const call = await db.rpc("call_queue_token", {
    p_queue_session_id: J.sessionId,
    p_token_number: J.token3,
  });
  assertEquals(call.error, null);
  const callOut = (Array.isArray(call.data) ? call.data[0] : call.data) as {
    ok: boolean;
    reason?: string;
  };
  assertEquals(callOut.ok, false);
  assertEquals(callOut.reason, "token_not_callable");

  // Still cancelled after the refused call (not resurrected to called).
  assertEquals((await row("bookings", J.booking3))?.status, "cancelled");

  // No payment side effects for an unpaid cancelled booking.
  const { count: orders } = await db
    .from("payment_orders")
    .select("id", { count: "exact", head: true })
    .eq("booking_id", J.booking3);
  assertEquals(orders ?? 0, 0);
  const { count: refundRows } = await db
    .from("financial_ledger")
    .select("id", { count: "exact", head: true })
    .eq("booking_id", J.booking3)
    .eq("entry_type", "refund_debit");
  assertEquals(refundRows ?? 0, 0);
});

// ─── 8. QUEUE: explicit call + duplicate-call idempotency (§9) ──────────────

Deno.test("E1 08: queue-control calls the checked-in walk-in; repeat call is idempotent", async () => {
  const resp = await callFunction(
    "queue-control",
    J.tokens.receptionA,
    J.hospitalA,
    {
      queueSessionId: J.sessionId,
      action: "call",
      tokenNumber: J.token2,
    },
  );
  assertEquals(resp.status, 200, JSON.stringify(resp.json));

  const booking = await row("bookings", J.booking2);
  assertExists(booking);
  assertEquals(booking.status, "called");
  assertExists(booking.called_at);

  const session = await row("queue_sessions", J.sessionId);
  assertExists(session);
  assertEquals(session.current_live_token, J.token2);

  // Duplicate call: same token, still called, no error, no second
  // transition (call_queue_token short-circuits with idempotent=true).
  const again = await callFunction(
    "queue-control",
    J.tokens.receptionA,
    J.hospitalA,
    {
      queueSessionId: J.sessionId,
      action: "call",
      tokenNumber: J.token2,
    },
  );
  assertEquals(again.status, 200, JSON.stringify(again.json));
  assertEquals((await row("bookings", J.booking2))?.status, "called");
});

// ─── 9. DOCTOR LEG over HTTP: consult → note → complete (§5, gate criterion 2)
Deno.test("E1 09: doctor-operations refuses non-doctors and runs the full consult leg", async () => {
  // Authorization: receptionist is NOT allowed on the clinical entry point.
  const denied = await callFunction(
    "doctor-operations",
    J.tokens.receptionA,
    J.hospitalA,
    { action: "start_session" },
  );
  assertEquals(denied.status, 403, JSON.stringify(denied.json));

  // Doctor opens today's session (converges on the booking-created one).
  const opened = await callFunction(
    "doctor-operations",
    J.tokens.doctorA,
    J.hospitalA,
    { action: "start_session" },
  );
  assertEquals(opened.status, 200, JSON.stringify(opened.json));
  const startResult = opened.data?.result as Record<string, unknown>;
  assertExists(startResult);
  assertEquals(startResult.queue_session_id, J.sessionId);

  // called -> in_consultation.
  const started = await callFunction(
    "doctor-operations",
    J.tokens.doctorA,
    J.hospitalA,
    {
      action: "start_consultation",
      queueSessionId: J.sessionId,
      bookingId: J.booking2,
    },
  );
  assertEquals(started.status, 200, JSON.stringify(started.json));
  assertEquals((await row("bookings", J.booking2))?.status, "in_consultation");

  // Replay is idempotent (already_started), not a second transition.
  const replayStart = await callFunction(
    "doctor-operations",
    J.tokens.doctorA,
    J.hospitalA,
    {
      action: "start_consultation",
      queueSessionId: J.sessionId,
      bookingId: J.booking2,
    },
  );
  assertEquals(replayStart.status, 200, JSON.stringify(replayStart.json));

  // Clinical note (append-only consultation_notes).
  const noted = await callFunction(
    "doctor-operations",
    J.tokens.doctorA,
    J.hospitalA,
    {
      action: "save_note",
      queueSessionId: J.sessionId,
      bookingId: J.booking2,
      notes: `E1 examination note ${RUN}`,
      diagnosisSummary: `e1 summary ${RUN}`,
    },
  );
  assertEquals(noted.status, 200, JSON.stringify(noted.json));

  const { db } = await ctx();
  const { data: notes } = await db
    .from("consultation_notes")
    .select("id,notes,doctor_id")
    .eq("booking_id", J.booking2);
  assertEquals((notes ?? []).length, 1);
  assertEquals((notes ?? [])[0]?.notes, `E1 examination note ${RUN}`);
  assertEquals((notes ?? [])[0]?.doctor_id, J.doctorA);

  // in_consultation -> completed.
  const completed = await callFunction(
    "doctor-operations",
    J.tokens.doctorA,
    J.hospitalA,
    {
      action: "complete_consultation",
      queueSessionId: J.sessionId,
      bookingId: J.booking2,
    },
  );
  assertEquals(completed.status, 200, JSON.stringify(completed.json));

  const final = await row("bookings", J.booking2);
  assertExists(final);
  assertEquals(final.status, "completed");
  assertExists(final.consultation_completed_at);

  // Completion replay: already_completed, state unchanged (terminal).
  const replayComplete = await callFunction(
    "doctor-operations",
    J.tokens.doctorA,
    J.hospitalA,
    {
      action: "complete_consultation",
      queueSessionId: J.sessionId,
      bookingId: J.booking2,
    },
  );
  assertEquals(replayComplete.status, 200, JSON.stringify(replayComplete.json));
  assertEquals((await row("bookings", J.booking2))?.status, "completed");
});

// ─── 10. QUEUE: doctor call_next picks the lowest active token ───────────────

Deno.test("E1 10: call_next advances to the lowest active token (booking 1)", async () => {
  const resp = await callFunction(
    "doctor-operations",
    J.tokens.doctorA,
    J.hospitalA,
    { action: "call_next", queueSessionId: J.sessionId },
  );
  assertEquals(resp.status, 200, JSON.stringify(resp.json));
  const result = resp.data?.result as Record<string, unknown>;
  assertExists(result);
  assertEquals(result.token, J.token1);

  const booking = await row("bookings", J.booking1);
  assertExists(booking);
  assertEquals(booking.status, "called");
});

// ─── 11. BILLING: manual_whatsapp fee split (platform + receptionist) ───────

Deno.test("E1 11: manual_whatsapp booking snapshots platform 10 + receptionist 5", async () => {
  const resp = await callFunction(
    "create-booking",
    J.tokens.receptionA,
    J.hospitalA,
    bookingBody("manual_whatsapp", 14, `E1 WhatsApp ${RUN}`),
    crypto.randomUUID(),
  );
  assertEquals(resp.status, 201, JSON.stringify(resp.json));
  assertExists(resp.data);
  J.booking4 = resp.data.bookingId as string;
  J.token4 = resp.data.tokenNumber as number;

  const booking = await row("bookings", J.booking4);
  assertExists(booking);
  assertEquals(booking.booking_source, "manual_whatsapp");
  assertEquals(Number(booking.platform_fee_snapshot), 10);
  assertEquals(Number(booking.receptionist_fee_snapshot), 5);
  assertEquals(Number(booking.hospital_fee_snapshot), 0);
  // Refund basis (P0-04) is the PLATFORM fee only, never the split total.
  assertEquals(Number(booking.booking_fee_inr), 10);
});

// ─── 12. PAYMENT LEG: capture → ledger → callback replay (§9, §19) ──────────
// INTERNAL PAYMENT FLOW = TESTABLE / REAL RAZORPAY = BLOCKED (no gateway
// call is made; the RPC chain below is the exact chain verify-payment
// drives after its HMAC check, which is TS-edge behaviour).

Deno.test("E1 12: capture writes order+booking+ledger atomically and dedupes replay", async () => {
  const { db } = await ctx();

  const { data: order, error: ordErr } = await db
    .from("payment_orders")
    .insert({
      hospital_id: J.hospitalA,
      booking_id: J.booking1,
      amount_inr: 20, // booking1 platform fee (P0-04 refund basis)
      gateway_order_id: `e1o_${RUN}`,
    })
    .select("id")
    .single();
  assertEquals(ordErr, null);
  assertExists(order);
  J.paymentOrderId = order.id as string;

  const captureArgs = {
    p_provider_event_id: `e1evt_${RUN}`,
    p_payload_hash: `e1hash_${RUN}`,
    p_raw_payload: {
      event: "payment.captured",
      order_id: `e1o_${RUN}`,
      payment_id: `e1pay_${RUN}`,
    },
    p_gateway_order_id: `e1o_${RUN}`,
    p_gateway_payment_id: `e1pay_${RUN}`,
    p_gateway_signature: `e1-fixture-signature-${RUN}`,
  };

  const first = await db.rpc("idempotent_capture_payment", captureArgs);
  assertEquals(first.error, null);
  const out1 = (Array.isArray(first.data) ? first.data[0] : first.data) as {
    success: boolean;
    was_duplicate: boolean;
    message: string;
  };
  assertEquals(out1.success, true);
  assertEquals(out1.was_duplicate, false);

  // Cross-module state after capture.
  const orderRow = await row("payment_orders", J.paymentOrderId);
  assertExists(orderRow);
  assertEquals(orderRow.payment_status, "captured");

  const booking = await row("bookings", J.booking1);
  assertExists(booking);
  assertEquals(booking.payment_completed, true);
  assertEquals(booking.payment_reference, `e1pay_${RUN}`);

  const { data: ledger } = await db
    .from("financial_ledger")
    .select("entry_type,amount_inr,is_credit")
    .eq("booking_id", J.booking1)
    .order("entry_type");
  const entries = (ledger ?? []) as Array<{
    entry_type: string;
    amount_inr: string | number;
    is_credit: boolean;
  }>;
  const collected = entries.find((e) =>
    e.entry_type === "booking_fee_collected"
  );
  assertExists(collected, "booking_fee_collected ledger entry");
  assertEquals(Number(collected!.amount_inr), 20);
  assertEquals(collected!.is_credit, true);
  // Gateway fee = 2% estimate when the webhook omits it.
  const fee = entries.find((e) => e.entry_type === "gateway_fee_debit");
  assertExists(fee, "gateway_fee_debit ledger entry");
  assertEquals(Number(fee!.amount_inr), 0.4);

  // Duplicate webhook delivery: same event id → was_duplicate, and the
  // immutable ledger must NOT grow (no double credit).
  const before = entries.length;
  const replay = await db.rpc("idempotent_capture_payment", captureArgs);
  assertEquals(replay.error, null);
  const out2 = (Array.isArray(replay.data) ? replay.data[0] : replay.data) as {
    success: boolean;
    was_duplicate: boolean;
  };
  assertEquals(out2.was_duplicate, true);

  const { count: after } = await db
    .from("financial_ledger")
    .select("id", { count: "exact", head: true })
    .eq("booking_id", J.booking1);
  assertEquals(after ?? 0, before, "replay must not duplicate ledger rows");

  // Capture against an unknown gateway order: refused, no state churn.
  const ghost = await db.rpc("idempotent_capture_payment", {
    ...captureArgs,
    p_provider_event_id: `e1evt_ghost_${RUN}`,
    p_gateway_order_id: `e1o_ghost_${RUN}`,
    p_gateway_payment_id: `e1pay_ghost_${RUN}`,
  });
  assertEquals(ghost.error, null);
  const out3 = (Array.isArray(ghost.data) ? ghost.data[0] : ghost.data) as {
    success: boolean;
  };
  assertEquals(out3.success, false);
});

// ─── 13. NOTIFICATION: dedup + E.164 payload (CODE PATH; META = BLOCKED) ────

Deno.test("E1 13: every booking enqueued exactly one confirmation job", async () => {
  const { db } = await ctx();
  const ids = [
    J.booking1,
    J.booking2,
    J.booking3,
    J.booking4,
    J.replayBooking,
  ];

  const { data: jobs } = await db
    .from("job_queue")
    .select("id,idempotency_key,payload")
    .in("idempotency_key", ids.map((b) => `wa_confirm_${b}`));
  assertEquals((jobs ?? []).length, ids.length, "one confirm job per booking");
  assertEquals(
    new Set((jobs ?? []).map((j) => j.idempotency_key)).size,
    ids.length,
    "no duplicated notification side effects",
  );

  // Payload carries the canonical E.164 phone (the create-booking fix
  // made edge persistence and notification routing agree).
  const b1Key = `wa_confirm_${J.booking1}`;
  const b1Job = (jobs ?? []).find((j) => j.idempotency_key === b1Key);
  assertExists(b1Job);
  const payload = b1Job.payload as Record<string, unknown>;
  const phone = String(payload.phone);
  assertEquals(phone.startsWith("+"), true, `E.164 payload phone: ${phone}`);
  assertEquals(phone.endsWith(phoneOf(10)), true);
  assertEquals(payload.template_name, "booking_confirmation");

  // REAL META DELIVERY = BLOCKED locally (no credentials, worker trigger
  // disabled): enqueued-not-sent is the honest state asserted here.
});

// ─── 14. TENANT ISOLATION: RLS on the read path (§7) ────────────────────────

Deno.test("E1 14: patient history reads respect tenant isolation (real RLS)", async () => {
  const { createAuthClient } = await ctx();

  const clientA = createAuthClient(J.tokens.receptionA);
  const clientB = createAuthClient(J.tokens.receptionB);

  // Hospital A receptionist sees the canonical patient's whole journey.
  const { data: historyA, error: errA } = await clientA
    .from("bookings")
    .select("id,status,hospital_id")
    .eq("patient_id", J.patientId);
  assertEquals(errA, null);
  const idsA = (historyA ?? []).map((b: { id: string }) => b.id);
  assertEquals(idsA.includes(J.booking1), true);
  assertEquals(idsA.includes(J.booking2), true);
  for (const b of historyA ?? []) {
    assertEquals(b.hospital_id, J.hospitalA);
  }

  // Hospital B (different tenant, valid JWT) sees nothing of A's data.
  const { data: historyB, error: errB } = await clientB
    .from("bookings")
    .select("id")
    .eq("patient_id", J.patientId);
  assertEquals(errB, null);
  assertEquals((historyB ?? []).length, 0, "RLS must not leak cross-tenant");

  const { data: patientB } = await clientB
    .from("patients")
    .select("id")
    .eq("id", J.patientId)
    .maybeSingle();
  assertEquals(patientB, null, "patient row invisible to other tenant");
});

// ─── 15. CAPACITY: migration 55 daily-sum fix, live proof ───────────────────

Deno.test("E1 15: remaining capacity sums BOTH shifts (50), not just the first", async () => {
  const { db } = await ctx();

  const { count: booked } = await db
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("hospital_id", J.hospitalA)
    .eq("assigned_doctor_id", J.doctorA)
    .eq("appointment_date", CLINIC.date)
    .not("status", "in", "(cancelled,no_show)")
    .eq("is_deleted", false);
  const bookedCount = (booked ?? 0) as number;

  const { data, error } = await db.rpc("get_remaining_token_capacity", {
    p_doctor_id: J.doctorA,
    p_hospital_id: J.hospitalA,
    p_date: CLINIC.date,
  });
  assertEquals(error, null);

  // Two fixture shifts: 30 + 20 = 50. Pre-fix LIMIT-1 behaviour would
  // report 30 − booked (and 0 for any doctor whose FIRST shift is
  // smaller than the day's demand), the drift this migration removes.
  assertEquals(50 - bookedCount > 30 - bookedCount, true);
  assertEquals(
    data as number,
    50 - bookedCount,
    `capacity must be the SUM of shifts (booked=${bookedCount})`,
  );
});

// ─── 16. FAILURE / COMPENSATION (§21): bad writes leave no partial state ────

Deno.test("E1 16: invalid writes are refused without side effects", async () => {
  const { db } = await ctx();

  // create_booking against a non-existent hospital: FK refusal.
  const ghostHospital = crypto.randomUUID();
  const bad = await db.rpc("create_booking", {
    p_hospital_id: ghostHospital,
    p_patient_name: `E1 Ghost ${RUN}`,
    p_patient_phone: phoneOf(40),
    p_booking_source: "walkin",
    p_appointment_date: CLINIC.date,
    p_idempotency_key: `e1ghost-${RUN}`,
  });
  assertEquals(bad.error !== null, true, "FK must reject unknown hospital");
  const { count: ghostCounters } = await db
    .from("hospital_daily_counters")
    .select("id", { count: "exact", head: true })
    .eq("hospital_id", ghostHospital);
  assertEquals(
    ghostCounters ?? 0,
    0,
    "refused booking must not mint a counter",
  );

  // Clinical refusal: start_consultation on a still-'booked' token.
  const early = await callFunction(
    "doctor-operations",
    J.tokens.doctorA,
    J.hospitalA,
    {
      action: "start_consultation",
      queueSessionId: J.sessionId,
      bookingId: J.booking4,
    },
  );
  assertEquals(early.status >= 400, true, JSON.stringify(early.json));
  assertEquals((await row("bookings", J.booking4))?.status, "booked");
});

// ─── 17. CLEANUP: audit-free tenant fully deletes; ledger tenant is ────────
//     PERMANENT by design — pinned as real platform behaviour (§23).

Deno.test("E1 99: cleanup — hospital B fully removed, hospital A stays inert ledger residue", async () => {
  const { db } = await ctx();
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");

  const bestEffort = async (fn: () => unknown) => {
    try {
      await fn();
    } catch {
      // Cleanup must not mask the assertions below.
    }
  };

  // Audit logs block UPDATE, not DELETE; clear them before user
  // teardown (actor FK). Webhook + idempotency rows are deletable.
  await bestEffort(() =>
    db.from("audit_logs").delete().in("hospital_id", [J.hospitalA, J.hospitalB])
  );
  await bestEffort(() =>
    db
      .from("audit_logs")
      .delete()
      .in("actor_user_id", [J.receptionA, J.doctorA, J.receptionB])
  );
  await bestEffort(() =>
    db.from("webhook_events").delete().like(
      "provider_event_id",
      `e1evt_%${RUN}`,
    )
  );
  await bestEffort(() =>
    db.from("api_idempotency_keys").delete().in("hospital_id", [
      J.hospitalA,
      J.hospitalB,
    ])
  );

  // Auth users (GoTrue admin API); profiles/user_roles cascade.
  for (const uid of [J.receptionA, J.doctorA, J.receptionB]) {
    await bestEffort(() =>
      fetch(`${LOCAL_STATUS!.API_URL}/auth/v1/admin/users/${uid}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${LOCAL_STATUS!.SERVICE_ROLE_KEY}`,
        },
      })
    );
  }

  // Hospital B never transacted: full CASCADE removal must succeed.
  const { error: bErr } = await db.from("hospitals").delete().eq(
    "id",
    J.hospitalB,
  );
  assertEquals(bErr, null, "financially-inactive tenant must fully delete");
  assertEquals(await rowCount("hospitals", [["id", J.hospitalB]]), 0);
  assertEquals(
    await rowCount("bookings", [["hospital_id", J.hospitalB]]),
    0,
  );

  // Hospital A has captured payments AND versioned config: both the
  // ledger immutability trigger and the config_versions append-only
  // trigger fire even on the CASCADE from hospitals, so the tenant is
  // PERMANENTLY undeletable. That is by-design financial/config
  // permanence (and it disproves the residue comment in
  // enterprise_command_center.test.ts — recorded as a Phase 4
  // finding); the fixture remains as inert residue.
  const { error: aErr } = await db.from("hospitals").delete().eq(
    "id",
    J.hospitalA,
  );
  assertEquals(
    /immutable|append-only/.test(String(aErr?.message ?? "")),
    true,
    `permanence triggers must refuse tenant deletion, got: ${
      JSON.stringify(aErr)
    }`,
  );

  // The journey's financial history survives the teardown:
  const { count: ledgerRows } = await db
    .from("financial_ledger")
    .select("id", { count: "exact", head: true })
    .eq("hospital_id", J.hospitalA);
  assertGreater(ledgerRows ?? 0, 0, "captured payments stay queryable");
});
