/**
 * tests/integration/doctor_operations.test.ts
 *
 * Phase 1.4 — Doctor & Clinical Operations against the REAL local
 * Supabase stack (no mocks; Meta is never called).
 *
 * Covers:
 *   - doctor session lifecycle (open / close / early closure,
 *     idempotent, event-recorded, reopen refused after end)
 *   - consultation lifecycle (start / complete / return to waiting,
 *     trigger-stamped timestamps, duration, idempotent repeats)
 *   - one active consultation per doctor (concurrent race)
 *   - emergency insertion (priority, token, event, key dedupe)
 *   - pause/resume (doctor break blocks advance, resume restores)
 *   - SLA refresh enqueue on consultation completion
 *   - clinical notes (INSERT-only grants for service_role,
 *     hospital attribution, cascade with booking deletion)
 *   - doctor dashboard accuracy across the day
 *   - doctor-operations HTTP endpoint: end-to-end doctor flow with
 *     audit trail, doctor isolation, hospital isolation
 *
 * Run with:  deno task test:integration   (requires `supabase start`)
 */

import {
  assertEquals,
  assertExists,
  assertGreater,
  assertNotEquals,
  assertStringIncludes,
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

// ─── One-time bootstrap: env → dynamic imports of real modules ──────────────

type DbClient = Awaited<ReturnType<typeof bootstrap>>["db"];
type Runtime = Awaited<ReturnType<typeof bootstrap>>["runtime"];

let _ctx: { db: DbClient; runtime: Runtime } | null = null;

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
  const runtime = await import(
    "../../supabase/functions/_shared/queue/queue_runtime.ts"
  );
  return { db: getServiceClient(), runtime };
}

async function ctx() {
  if (!_ctx) _ctx = await bootstrap();
  return _ctx;
}

async function testLogger() {
  const { rootLogger } = await import(
    "../../supabase/functions/_shared/logger.ts"
  );
  return rootLogger;
}

// ─── Per-run fixture isolation ───────────────────────────────────────────────

// Digits-only run id: fixture phones must pass E.164 validation.
const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "7");

/** The dashboard and SLA refresh key off today's sessions. */
function todayLocal(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const TODAY = todayLocal();
const RUN_START = new Date().toISOString();
const FIXTURE_PASSWORD = `P14-${RUN}-fixture-pass`;

const fixtureSessions: string[] = [];
const fixtureHospitals: string[] = [];
const fixtureDoctors: string[] = [];

interface DoctorFixture {
  userId: string;
  email: string;
}

/**
 * queue_sessions has UNIQUE(hospital_id, doctor_id, session_date), so every
 * same-day fixture session for the seed hospital gets its own synthetic
 * doctor. profiles.id references auth.users, so the user is created through
 * the local GoTrue admin API and removed again during cleanup.
 */
async function fixtureDoctor(
  opts: { password?: boolean } = {},
): Promise<DoctorFixture> {
  const { db } = await ctx();
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");

  const userId = crypto.randomUUID();
  const email = `p14-doc-${RUN}-${fixtureDoctors.length}@setura.test`;

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
      ...(opts.password ? { password: FIXTURE_PASSWORD } : {}),
    }),
  });
  if (resp.status >= 300) {
    throw new Error(`admin user create failed: ${resp.status}`);
  }

  const phone = `98${RUN}${String(fixtureDoctors.length).padStart(2, "0")}`;
  const { error } = await db
    .from("profiles")
    .upsert({
      id: userId,
      full_name: `P14 Doc ${RUN}`,
      normalized_phone: phone,
    });
  assertEquals(error, null);
  fixtureDoctors.push(userId);
  return { userId, email };
}

/** Password-grant sign-in against local GoTrue → real access token. */
async function doctorToken(email: string): Promise<string> {
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
  return json.access_token;
}

async function grantDoctorRole(userId: string, hospitalId: string) {
  const { db } = await ctx();
  const { error } = await db
    .from("user_roles")
    .insert({
      user_id: userId,
      hospital_id: hospitalId,
      role: "doctor",
      is_primary: true,
    });
  assertEquals(error, null);
}

async function deleteFixtureDoctors(skip: Set<string> = new Set()) {
  if (!LOCAL_STATUS) return;
  for (const userId of fixtureDoctors) {
    if (skip.has(userId)) continue;
    try {
      await fetch(
        `${LOCAL_STATUS.API_URL}/auth/v1/admin/users/${userId}`,
        {
          method: "DELETE",
          headers: {
            "Authorization": `Bearer ${LOCAL_STATUS.SERVICE_ROLE_KEY}`,
          },
        },
      );
    } catch {
      // Best-effort: leftover fixture users are inert test data.
    }
  }
}

interface SessionFixture {
  sessionId: string;
  doctorId: string | null;
  date: string;
  bookingIds: string[];
}

/** Creates an active queue session with `tokens` waiting bookings. */
async function makeSession(
  tokens: number,
  opts: {
    hospitalId?: string;
    doctorId?: string | null;
  } = {},
): Promise<SessionFixture> {
  const { db } = await ctx();

  const doctorId = opts.doctorId === undefined
    ? (await fixtureDoctor()).userId
    : opts.doctorId;

  const { data: session, error: sessErr } = await db
    .from("queue_sessions")
    .insert({
      hospital_id: opts.hospitalId ?? SEED.HOSPITAL_ID,
      doctor_id: doctorId,
      session_date: TODAY,
      session_name: `p14_${RUN}`,
      max_tokens: 50,
    })
    .select("id")
    .single();
  assertEquals(sessErr, null);
  assertExists(session);
  const sessionId = session.id as string;
  fixtureSessions.push(sessionId);

  const bookingIds: string[] = [];

  for (let i = 1; i <= tokens; i++) {
    const { data: booking, error: bErr } = await db
      .from("bookings")
      .insert({
        hospital_id: opts.hospitalId ?? SEED.HOSPITAL_ID,
        queue_session_id: sessionId,
        patient_name: `P14 ${RUN} ${i}`,
        patient_phone: `97${RUN}${String(i).padStart(4, "0")}`,
        token_number: i,
        status: "waiting",
        booking_source: "walkin",
        appointment_date: TODAY,
        assigned_doctor_id: doctorId,
      })
      .select("id")
      .single();
    assertEquals(bErr, null);
    assertExists(booking);
    bookingIds.push(booking.id as string);
  }

  return { sessionId, doctorId, date: TODAY, bookingIds };
}

async function sessionRow(sessionId: string) {
  const { db } = await ctx();
  const { data, error } = await db
    .from("queue_sessions")
    .select(
      "id, hospital_id, doctor_id, session_date, is_active, is_paused, pause_reason, current_live_token, max_tokens",
    )
    .eq("id", sessionId)
    .single();
  assertEquals(error, null);
  assertExists(data);
  return data as never as Parameters<
    typeof import("../../supabase/functions/_shared/queue/queue_runtime.ts").runStartConsultation
  >[1];
}

async function bookingRow(bookingId: string) {
  const { db } = await ctx();
  const { data, error } = await db
    .from("bookings")
    .select(
      "id, status, token_number, priority_score, priority_flag, booking_source, assigned_doctor_id, consultation_started_at, consultation_completed_at",
    )
    .eq("id", bookingId)
    .single();
  assertEquals(error, null);
  assertExists(data);
  return data;
}

async function queueEvents(sessionId: string, eventType?: string) {
  const { db } = await ctx();
  let q = db
    .from("queue_runtime_events")
    .select("event_type, token_number, hospital_id, actor_id, metadata")
    .eq("queue_session_id", sessionId)
    .order("created_at", { ascending: true });
  if (eventType) q = q.eq("event_type", eventType);
  const { data, error } = await q;
  assertEquals(error, null);
  return (data ?? []) as Array<{
    event_type: string;
    token_number: number | null;
    hospital_id: string;
    actor_id: string | null;
    metadata: Record<string, unknown>;
  }>;
}

async function jobsByKeyPrefix(prefix: string) {
  const { db } = await ctx();
  const { data, error } = await db
    .from("job_queue")
    .select("id, idempotency_key, job_type, payload")
    .like("idempotency_key", `${prefix}%`)
    .order("created_at", { ascending: true });
  assertEquals(error, null);
  return (data ?? []) as Array<{
    id: string;
    idempotency_key: string;
    job_type: string;
    payload: Record<string, unknown>;
  }>;
}

async function advanceQueue(sessionId: string): Promise<number | null> {
  const { db } = await ctx();
  const { data, error } = await db.rpc("advance_queue", {
    p_queue_session_id: sessionId,
  });
  assertEquals(error, null);
  return data as number | null;
}

/** Calls the doctor-operations edge function over HTTP. */
async function docOps(
  token: string,
  hospitalId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");

  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/functions/v1/doctor-operations`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "X-Hospital-ID": hospitalId,
      },
      body: JSON.stringify(body),
    },
  );

  const text = await resp.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Non-JSON error body (e.g. gateway refusal) — status still checked.
  }
  return { status: resp.status, json };
}

// ─── 1. Doctor session lifecycle ─────────────────────────────────────────────

Deno.test("doc: open session is idempotent and records session_started", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const doctor = await fixtureDoctor();

  const open1 = await runtime.runOpenDoctorSession(
    db,
    SEED.HOSPITAL_ID,
    doctor.userId,
    doctor.userId,
    logger,
  );
  assertEquals(open1.ok, true);
  assertEquals(open1.already_open, false);
  assertExists(open1.queue_session_id);
  fixtureSessions.push(open1.queue_session_id!);

  const row = await sessionRow(open1.queue_session_id!);
  assertEquals(row.is_active, true);
  assertEquals(row.doctor_id, doctor.userId);

  // Duplicate open converges on the same session.
  const open2 = await runtime.runOpenDoctorSession(
    db,
    SEED.HOSPITAL_ID,
    doctor.userId,
    doctor.userId,
    logger,
  );
  assertEquals(open2.ok, true);
  assertEquals(open2.already_open, true);
  assertEquals(open2.queue_session_id, open1.queue_session_id);

  const events = await queueEvents(open1.queue_session_id!, "session_started");
  assertEquals(events.length, 1);
  assertEquals(events[0].hospital_id, SEED.HOSPITAL_ID);
});

Deno.test("doc: early closure records event, notifies patients, refuses reopen", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const fx = await makeSession(2);
  const session = await sessionRow(fx.sessionId);

  const closed = await runtime.runCloseDoctorSession(
    db,
    session,
    SEED.DOCTOR_ID,
    "closing early",
    logger,
  );
  assertEquals(closed.ok, true);
  assertEquals(closed.already_closed, false);
  assertEquals(closed.waiting_remaining, 2);

  const row = await sessionRow(fx.sessionId);
  assertEquals(row.is_active, false);

  const events = await queueEvents(fx.sessionId, "session_ended");
  assertEquals(events.length, 1);
  assertEquals(events[0].metadata.early, true);
  assertEquals(events[0].metadata.waiting_remaining, 2);
  assertEquals(events[0].metadata.reason, "closing early");

  // One WhatsApp early-closure notification per remaining patient.
  const jobs = await jobsByKeyPrefix(`wa_q_close_${fx.sessionId}`);
  assertEquals(jobs.length, 2);

  // Idempotent repeat: no new event, no new notifications.
  const repeat = await runtime.runCloseDoctorSession(
    db,
    session,
    SEED.DOCTOR_ID,
    "closing early",
    logger,
  );
  assertEquals(repeat.ok, true);
  assertEquals(repeat.already_closed, true);
  assertEquals((await queueEvents(fx.sessionId, "session_ended")).length, 1);
  assertEquals(
    (await jobsByKeyPrefix(`wa_q_close_${fx.sessionId}`)).length,
    2,
  );

  // An ended session cannot be reopened the same day.
  const reopen = await runtime.runOpenDoctorSession(
    db,
    SEED.HOSPITAL_ID,
    fx.doctorId!,
    fx.doctorId!,
    logger,
  );
  assertEquals(reopen.ok, false);
  assertEquals(reopen.reason, "session_already_ended");
});

// ─── 2. Consultation lifecycle ───────────────────────────────────────────────

Deno.test("doc: consultation start stamps timestamp and is idempotent", async () => {
  const { db, runtime } = await ctx();
  const fx = await makeSession(1);
  const session = await sessionRow(fx.sessionId);

  assertEquals(await advanceQueue(fx.sessionId), 1);

  const started = await runtime.runStartConsultation(
    db,
    session,
    fx.bookingIds[0],
    SEED.DOCTOR_ID,
  );
  assertEquals(started.ok, true);
  assertEquals(started.already_started, false);
  assertEquals(started.token_number, 1);

  const booking = await bookingRow(fx.bookingIds[0]);
  assertEquals(booking.status, "in_consultation");
  assertExists(booking.consultation_started_at);

  // Duplicate request converges.
  const repeat = await runtime.runStartConsultation(
    db,
    session,
    fx.bookingIds[0],
    SEED.DOCTOR_ID,
  );
  assertEquals(repeat.ok, true);
  assertEquals(repeat.already_started, true);

  // A waiting booking cannot jump straight into consultation.
  const fx2 = await makeSession(1);
  const fresh = await runtime.runStartConsultation(
    db,
    await sessionRow(fx2.sessionId),
    fx2.bookingIds[0],
    SEED.DOCTOR_ID,
  );
  assertEquals(fresh.ok, false);
  assertEquals(fresh.reason, "booking_status_waiting");
});

Deno.test("doc: completion returns duration, stamps timestamp, enqueues SLA refresh", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const fx = await makeSession(1);
  const session = await sessionRow(fx.sessionId);

  await advanceQueue(fx.sessionId);
  const started = await runtime.runStartConsultation(
    db,
    session,
    fx.bookingIds[0],
    SEED.DOCTOR_ID,
  );
  assertEquals(started.ok, true);

  // Backdate the trigger-stamped start so duration is observable.
  const backdated = new Date(Date.now() - 7 * 60_000).toISOString();
  const { error: bdErr } = await db
    .from("bookings")
    .update({ consultation_started_at: backdated })
    .eq("id", fx.bookingIds[0]);
  assertEquals(bdErr, null);

  const done = await runtime.runCompleteConsultation(
    db,
    session,
    fx.bookingIds[0],
    SEED.DOCTOR_ID,
    logger,
  );
  assertEquals(done.ok, true);
  assertEquals(done.already_completed, false);
  assertGreater(Number(done.duration_minutes), 6.5);

  const booking = await bookingRow(fx.bookingIds[0]);
  assertEquals(booking.status, "completed");
  assertExists(booking.consultation_completed_at);

  // SLA refresh integration: a compute_sla job was enqueued.
  const slaJobs = await jobsByKeyPrefix(
    `sla_${SEED.HOSPITAL_ID}_${TODAY}`,
  );
  assertGreater(slaJobs.length, 0);
  assertEquals(slaJobs[0].job_type, "compute_sla");

  // Idempotent repeat: no new completion.
  const repeat = await runtime.runCompleteConsultation(
    db,
    session,
    fx.bookingIds[0],
    SEED.DOCTOR_ID,
    logger,
  );
  assertEquals(repeat.ok, true);
  assertEquals(repeat.already_completed, true);
});

Deno.test("doc: return to waiting clears stale start timestamp and is idempotent", async () => {
  const { db, runtime } = await ctx();
  const fx = await makeSession(1);
  const session = await sessionRow(fx.sessionId);

  await advanceQueue(fx.sessionId);
  const started = await runtime.runStartConsultation(
    db,
    session,
    fx.bookingIds[0],
    SEED.DOCTOR_ID,
  );
  assertEquals(started.ok, true);

  const returned = await runtime.runReturnToWaiting(
    db,
    session,
    fx.bookingIds[0],
    SEED.DOCTOR_ID,
  );
  assertEquals(returned.ok, true);
  assertEquals(returned.already_waiting, false);

  const booking = await bookingRow(fx.bookingIds[0]);
  assertEquals(booking.status, "waiting");
  assertEquals(booking.consultation_started_at, null);

  // Idempotent repeat.
  const repeat = await runtime.runReturnToWaiting(
    db,
    session,
    fx.bookingIds[0],
    SEED.DOCTOR_ID,
  );
  assertEquals(repeat.ok, true);
  assertEquals(repeat.already_waiting, true);

  // The patient re-enters the queue and is callable again.
  assertEquals(await advanceQueue(fx.sessionId), 1);
});

// ─── 3. Concurrency safeguard ────────────────────────────────────────────────

Deno.test("doc: concurrent consultation starts — exactly one wins", async () => {
  const { db, runtime } = await ctx();
  const fx = await makeSession(2);
  const session = await sessionRow(fx.sessionId);

  // Call both patients first.
  assertEquals(await advanceQueue(fx.sessionId), 1);
  assertEquals(await advanceQueue(fx.sessionId), 2);

  const [r1, r2] = await Promise.all([
    runtime.runStartConsultation(db, session, fx.bookingIds[0], SEED.DOCTOR_ID),
    runtime.runStartConsultation(db, session, fx.bookingIds[1], SEED.DOCTOR_ID),
  ]);

  const results = [r1, r2];
  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok);

  assertEquals(winners.length, 1, "exactly one consultation may start");
  assertEquals(losers.length, 1);
  assertEquals(losers[0].reason, "another_consultation_active");
});

// ─── 4. Emergency insertion ──────────────────────────────────────────────────

Deno.test("doc: emergency insertion jumps the queue and dedupes on key", async () => {
  const { db, runtime } = await ctx();
  const fx = await makeSession(2);
  const session = await sessionRow(fx.sessionId);
  const key = `emg_${RUN}`;

  const ins = await runtime.runInsertEmergencyPatient(
    db,
    session,
    `Emergency ${RUN}`,
    `91${RUN}0001`,
    "chest pain",
    SEED.DOCTOR_ID,
    key,
  );
  assertEquals(ins.ok, true);
  assertEquals(ins.already_inserted, false);
  assertEquals(ins.token_number, 3);
  assertExists(ins.booking_id);

  const booking = await bookingRow(ins.booking_id!);
  assertEquals(booking.priority_score, 100);
  assertEquals(booking.priority_flag, true);
  assertEquals(booking.status, "waiting");
  assertEquals(booking.booking_source, "walkin");
  assertEquals(booking.assigned_doctor_id, fx.doctorId);

  const events = await queueEvents(fx.sessionId, "emergency_inserted");
  assertEquals(events.length, 1);
  assertEquals(events[0].token_number, 3);
  assertEquals(events[0].metadata.reason, "chest pain");

  // advance_queue ordering (priority DESC) calls the emergency first.
  assertEquals(await advanceQueue(fx.sessionId), 3);

  // Duplicate request with the same idempotency key converges.
  const repeat = await runtime.runInsertEmergencyPatient(
    db,
    session,
    `Emergency ${RUN}`,
    `91${RUN}0001`,
    "chest pain",
    SEED.DOCTOR_ID,
    key,
  );
  assertEquals(repeat.ok, true);
  assertEquals(repeat.already_inserted, true);
  assertEquals(repeat.booking_id, ins.booking_id);
  assertEquals(
    (await queueEvents(fx.sessionId, "emergency_inserted")).length,
    1,
  );
});

// ─── 5. Pause / resume (doctor break) ────────────────────────────────────────

Deno.test("doc: break pauses consultations and resume restores them", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const fx = await makeSession(2);
  const session = await sessionRow(fx.sessionId);

  const paused = await runtime.runPauseQueue(
    db,
    session,
    "doctor_break",
    SEED.DOCTOR_ID,
    logger,
  );
  assertEquals(paused.paused, true);

  const row = await sessionRow(fx.sessionId);
  assertEquals(row.is_paused, true);
  assertEquals(row.pause_reason, "doctor_break");

  // A paused queue refuses to call the next patient.
  const { error: advErr } = await db.rpc("advance_queue", {
    p_queue_session_id: fx.sessionId,
  });
  assertExists(advErr);
  assertStringIncludes(advErr.message, "QUEUE_PAUSED");

  const resumed = await runtime.runResumeQueue(
    db,
    session,
    SEED.DOCTOR_ID,
    logger,
  );
  assertEquals(resumed.resumed, true);

  assertEquals(await advanceQueue(fx.sessionId), 1);

  assertGreater(
    (await queueEvents(fx.sessionId, "paused")).length,
    0,
  );
  assertGreater(
    (await queueEvents(fx.sessionId, "resumed")).length,
    0,
  );
});

// ─── 6. Dashboard accuracy ───────────────────────────────────────────────────

Deno.test("doc: dashboard reflects the full consultation day accurately", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const fx = await makeSession(4);

  const d0 = await runtime.getDoctorDashboard(
    db,
    fx.doctorId!,
    SEED.HOSPITAL_ID,
  );
  assertEquals(d0.has_session, true);
  assertEquals(d0.queue_session_id, fx.sessionId);
  assertEquals(d0.current_patient, null);
  assertEquals(d0.counts?.waiting, 4);
  assertEquals(d0.counts?.completed, 0);
  assertEquals(d0.next_patients?.length, 4);
  assertEquals(d0.delay_status?.delayed, false);
  assertEquals(d0.pause_status?.paused, false);
  assertExists(d0.session_health);
  assertEquals(d0.queue_utilization, 0);

  // Call + start token 1.
  await advanceQueue(fx.sessionId);
  const session = await sessionRow(fx.sessionId);
  const started = await runtime.runStartConsultation(
    db,
    session,
    fx.bookingIds[0],
    SEED.DOCTOR_ID,
  );
  assertEquals(started.ok, true);

  const d1 = await runtime.getDoctorDashboard(
    db,
    fx.doctorId!,
    SEED.HOSPITAL_ID,
  );
  assertEquals(d1.current_patient?.booking_id, fx.bookingIds[0]);
  assertEquals(d1.current_patient?.status, "in_consultation");
  assertEquals(d1.counts?.waiting, 3);
  assertEquals(d1.counts?.in_consultation, 1);
  assertEquals(d1.next_patients?.length, 3);

  // Complete with a backdated start so averages are observable.
  const { error: bdErr } = await db
    .from("bookings")
    .update({
      consultation_started_at: new Date(Date.now() - 5 * 60_000)
        .toISOString(),
    })
    .eq("id", fx.bookingIds[0]);
  assertEquals(bdErr, null);

  const done = await runtime.runCompleteConsultation(
    db,
    session,
    fx.bookingIds[0],
    SEED.DOCTOR_ID,
    logger,
  );
  assertEquals(done.ok, true);

  const d2 = await runtime.getDoctorDashboard(
    db,
    fx.doctorId!,
    SEED.HOSPITAL_ID,
  );
  assertEquals(d2.current_patient, null);
  assertEquals(d2.counts?.completed, 1);
  assertEquals(d2.counts?.waiting, 3);
  assertGreater(Number(d2.avg_consultation_minutes), 4.5);
  assertExists(d2.avg_wait_minutes);
  assertEquals(d2.queue_utilization, 0.02); // 1 / max_tokens(50)

  // Delay + pause flow into the dashboard status blocks.
  const { error: dErr } = await db
    .from("queue_sessions")
    .update({ delay_expected_minutes: 20 })
    .eq("id", fx.sessionId);
  assertEquals(dErr, null);
  await runtime.runPauseQueue(db, session, "lunch", SEED.DOCTOR_ID, logger);

  const d3 = await runtime.getDoctorDashboard(
    db,
    fx.doctorId!,
    SEED.HOSPITAL_ID,
  );
  assertEquals(d3.delay_status?.delayed, true);
  assertEquals(d3.delay_status?.delay_expected_minutes, 20);
  assertEquals(d3.pause_status?.paused, true);

  // A doctor with no session gets an empty dashboard.
  const idle = await fixtureDoctor();
  const dNone = await runtime.getDoctorDashboard(
    db,
    idle.userId,
    SEED.HOSPITAL_ID,
  );
  assertEquals(dNone.has_session, false);
});

// ─── 7. Clinical notes ───────────────────────────────────────────────────────

Deno.test("doc: clinical notes are append-only and attributed to the hospital", async () => {
  const { db, runtime } = await ctx();
  const fx = await makeSession(1);

  const followUp = new Date(Date.now() + 7 * 24 * 3600_000)
    .toISOString()
    .slice(0, 10);

  const saved = await runtime.runSaveConsultationNote(
    db,
    fx.bookingIds[0],
    fx.doctorId!,
    {
      notes: `Fever and cough since two days. ${RUN}`,
      diagnosisSummary: "Viral fever",
      prescription: [{ drug: "Paracetamol", dose: "500mg" }],
      followUpDate: followUp,
      attachments: [],
    },
  );
  assertEquals(saved.ok, true);
  assertExists(saved.note_id);
  assertEquals(saved.hospital_id, SEED.HOSPITAL_ID);

  const { data: note, error: nErr } = await db
    .from("consultation_notes")
    .select("*")
    .eq("id", saved.note_id!)
    .single();
  assertEquals(nErr, null);
  assertExists(note);
  assertEquals(note.hospital_id, SEED.HOSPITAL_ID);
  assertEquals(note.doctor_id, fx.doctorId);
  assertEquals(note.booking_id, fx.bookingIds[0]);
  assertEquals(note.diagnosis_summary, "Viral fever");
  assertEquals((note.prescription as unknown[]).length, 1);
  assertEquals(note.follow_up_date, followUp);

  // Immutability: service_role holds INSERT-only grants, so direct
  // UPDATE and DELETE are refused at the privilege layer.
  const upd = await db
    .from("consultation_notes")
    .update({ notes: "tampered" })
    .eq("id", saved.note_id!);
  assertExists(upd.error);
  assertStringIncludes(upd.error.message, "permission denied");

  const del = await db
    .from("consultation_notes")
    .delete()
    .eq("id", saved.note_id!);
  assertExists(del.error);
  assertStringIncludes(del.error.message, "permission denied");

  // Multiple notes per booking are allowed (append, not replace).
  const second = await runtime.runSaveConsultationNote(
    db,
    fx.bookingIds[0],
    fx.doctorId!,
    { notes: `Follow-up observation. ${RUN}` },
  );
  assertEquals(second.ok, true);
  assertNotEquals(second.note_id, saved.note_id);
});

Deno.test("doc: consultation notes cascade with booking deletion", async () => {
  const { db, runtime } = await ctx();
  const fx = await makeSession(1);

  const saved = await runtime.runSaveConsultationNote(
    db,
    fx.bookingIds[0],
    fx.doctorId!,
    { notes: `Cascade check ${RUN}` },
  );
  assertEquals(saved.ok, true);

  const { error: bErr } = await db
    .from("bookings")
    .delete()
    .eq("id", fx.bookingIds[0]);
  assertEquals(bErr, null);

  const { count } = await db
    .from("consultation_notes")
    .select("id", { count: "exact", head: true })
    .eq("booking_id", fx.bookingIds[0]);
  assertEquals(count, 0);
});

// ─── 8. Audit registry ───────────────────────────────────────────────────────

Deno.test("doc: clinical_action and clinical_note are registered audit actions", async () => {
  const { db } = await ctx();

  const { data, error } = await db
    .from("audit_action_types")
    .select("action_type, category, is_active")
    .in("action_type", ["clinical_action", "clinical_note"]);
  assertEquals(error, null);

  const rows = (data ?? []) as Array<{
    action_type: string;
    category: string;
    is_active: boolean;
  }>;
  assertEquals(rows.length, 2);
  for (const row of rows) {
    assertEquals(row.category, "operations");
    assertEquals(row.is_active, true);
  }
});

// ─── 9. HTTP endpoint: end-to-end doctor flow + audit trail ─────────────────

Deno.test("doc http: doctor runs a full consultation day with audit trail", async () => {
  const { db } = await ctx();

  const docA = await fixtureDoctor({ password: true });
  await grantDoctorRole(docA.userId, SEED.HOSPITAL_ID);
  const tokenA = await doctorToken(docA.email);

  // Open today's session.
  const r1 = await docOps(tokenA, SEED.HOSPITAL_ID, {
    action: "start_session",
  });
  assertEquals(r1.status, 200);
  const data1 = (r1.json?.data ?? {}) as Record<string, unknown>;
  const result1 = data1.result as Record<string, unknown>;
  assertEquals(result1.ok, true);
  const sessionId = result1.queue_session_id as string;
  assertExists(sessionId);
  fixtureSessions.push(sessionId);

  // Two walk-in patients join the session.
  const bookingIds: string[] = [];
  for (let i = 1; i <= 2; i++) {
    const { data: booking, error: bErr } = await db
      .from("bookings")
      .insert({
        hospital_id: SEED.HOSPITAL_ID,
        queue_session_id: sessionId,
        patient_name: `P14 HTTP ${RUN} ${i}`,
        patient_phone: `96${RUN}${String(i).padStart(4, "0")}`,
        token_number: i,
        status: "waiting",
        booking_source: "walkin",
        appointment_date: TODAY,
        assigned_doctor_id: docA.userId,
      })
      .select("id")
      .single();
    assertEquals(bErr, null);
    assertExists(booking);
    bookingIds.push(booking.id as string);
  }

  // Call next → start → complete, each with a fresh snapshot.
  const r2 = await docOps(tokenA, SEED.HOSPITAL_ID, {
    action: "call_next",
    queueSessionId: sessionId,
  });
  assertEquals(r2.status, 200);
  const result2 = ((r2.json?.data ?? {}) as Record<string, unknown>)
    .result as Record<string, unknown>;
  assertEquals(result2.token, 1);
  assertEquals(result2.called, true);

  const r3 = await docOps(tokenA, SEED.HOSPITAL_ID, {
    action: "start_consultation",
    queueSessionId: sessionId,
    bookingId: bookingIds[0],
  });
  assertEquals(r3.status, 200);
  const result3 = ((r3.json?.data ?? {}) as Record<string, unknown>)
    .result as Record<string, unknown>;
  assertEquals(result3.ok, true);

  const r4 = await docOps(tokenA, SEED.HOSPITAL_ID, {
    action: "complete_consultation",
    queueSessionId: sessionId,
    bookingId: bookingIds[0],
  });
  assertEquals(r4.status, 200);
  const result4 = ((r4.json?.data ?? {}) as Record<string, unknown>)
    .result as Record<string, unknown>;
  assertEquals(result4.ok, true);

  // Dashboard confirms the day so far.
  const r5 = await docOps(tokenA, SEED.HOSPITAL_ID, { action: "dashboard" });
  assertEquals(r5.status, 200);
  const dash = ((r5.json?.data ?? {}) as Record<string, unknown>)
    .dashboard as Record<string, unknown>;
  assertEquals(dash.has_session, true);
  assertEquals((dash.counts as Record<string, number>).completed, 1);

  // Every clinical action left an immutable audit trail.
  const { data: audits, error: aErr } = await db
    .from("audit_logs")
    .select("id, entity_type, action_type, hospital_id, actor_user_id")
    .eq("actor_user_id", docA.userId)
    .eq("action_type", "clinical_action")
    .gte("created_at", RUN_START);
  assertEquals(aErr, null);
  const rows = audits ?? [];
  assertGreater(rows.length, 3);
  for (const row of rows) {
    assertEquals(row.hospital_id, SEED.HOSPITAL_ID);
    assertExists(row.entity_type);
  }
});

// ─── 10. HTTP endpoint: doctor isolation ─────────────────────────────────────

Deno.test("doc http: a doctor cannot operate another doctor's session", async () => {
  const docA = await fixtureDoctor({ password: true });
  await grantDoctorRole(docA.userId, SEED.HOSPITAL_ID);

  const docB = await fixtureDoctor({ password: true });
  await grantDoctorRole(docB.userId, SEED.HOSPITAL_ID);
  const tokenB = await doctorToken(docB.email);

  // Session A belongs to doctor A.
  const fx = await makeSession(1, { doctorId: docA.userId });

  const r1 = await docOps(tokenB, SEED.HOSPITAL_ID, {
    action: "call_next",
    queueSessionId: fx.sessionId,
  });
  assertEquals(r1.status, 403);

  const r2 = await docOps(tokenB, SEED.HOSPITAL_ID, {
    action: "start_consultation",
    queueSessionId: fx.sessionId,
    bookingId: fx.bookingIds[0],
  });
  assertEquals(r2.status, 403);

  // Doctor B's dashboard sees only their own (nonexistent) session.
  const r3 = await docOps(tokenB, SEED.HOSPITAL_ID, { action: "dashboard" });
  assertEquals(r3.status, 200);
  const dash = ((r3.json?.data ?? {}) as Record<string, unknown>)
    .dashboard as Record<string, unknown>;
  assertEquals(dash.has_session, false);
});

// ─── 11. Hospital isolation ──────────────────────────────────────────────────

Deno.test("doc: hospital isolation holds at the endpoint and RPC layers", async () => {
  const { db, runtime } = await ctx();

  const { data: hospB, error: hospErr } = await db
    .from("hospitals")
    .insert({
      name: `P14 ISO ${RUN}`,
      slug: `p14-iso-${RUN}`,
    })
    .select("id")
    .single();
  assertEquals(hospErr, null);
  assertExists(hospB);
  const hospitalB = hospB.id as string;
  fixtureHospitals.push(hospitalB);

  // Endpoint layer: doctor C has a role only at hospital B.
  const docC = await fixtureDoctor({ password: true });
  await grantDoctorRole(docC.userId, hospitalB);
  const tokenC = await doctorToken(docC.email);

  const r1 = await docOps(tokenC, SEED.HOSPITAL_ID, { action: "dashboard" });
  assertEquals(r1.status, 403);

  // RPC layer: a hospital-A booking cannot transition inside a
  // hospital-B session.
  const fxA = await makeSession(1);
  const fxB = await makeSession(0, { hospitalId: hospitalB });

  const cross = await runtime.runStartConsultation(
    db,
    await sessionRow(fxB.sessionId),
    fxA.bookingIds[0],
    SEED.DOCTOR_ID,
  );
  assertEquals(cross.ok, false);
  assertEquals(cross.reason, "booking_not_in_session");

  const booking = await bookingRow(fxA.bookingIds[0]);
  assertEquals(booking.status, "waiting");
});

// ─── 12. Cleanup ─────────────────────────────────────────────────────────────

Deno.test("zz doc: cleanup leaves no fixtures behind", async () => {
  const { db } = await ctx();

  // Jobs created by this suite.
  for (
    const prefix of [
      "wa_q_close_",
      "wa_q_paused_",
      "wa_q_resumed_",
    ]
  ) {
    const { error } = await db.from("job_queue").delete().like(
      "idempotency_key",
      `${prefix}%`,
    );
    assertEquals(error, null);
  }
  for (
    const hospitalId of [SEED.HOSPITAL_ID, ...fixtureHospitals]
  ) {
    const { error } = await db.from("job_queue").delete().like(
      "idempotency_key",
      `sla_${hospitalId}_${TODAY}%`,
    );
    assertEquals(error, null);
  }

  // Audit rows written by fixture actors are intentionally kept:
  // audit_logs are immutable by design, and actor_user_id is
  // ON DELETE SET NULL - deleting such a profile fires an UPDATE
  // on audit_logs, which prevent_audit_log_modification() refuses.
  // Those profiles (and their auth users) stay as inert residue.
  const { data: auditedRows, error: auditedErr } = await db
    .from("audit_logs")
    .select("actor_user_id")
    .in("actor_user_id", fixtureDoctors);
  assertEquals(auditedErr, null);
  const auditedActors = new Set(
    (auditedRows ?? []).map((r) => r.actor_user_id as string),
  );

  // Bookings → sessions (FK order; consultation_notes cascade),
  // then fixture hospitals, profiles (user_roles cascade).
  for (const sid of fixtureSessions) {
    const { error: bErr } = await db.from("bookings").delete().eq(
      "queue_session_id",
      sid,
    );
    assertEquals(bErr, null);
    const { error: sErr } = await db.from("queue_sessions").delete().eq(
      "id",
      sid,
    );
    assertEquals(sErr, null);
  }
  for (const hid of fixtureHospitals) {
    const { error } = await db.from("hospitals").delete().eq("id", hid);
    assertEquals(error, null);
  }
  for (const did of fixtureDoctors) {
    if (auditedActors.has(did)) continue;
    const { error } = await db.from("profiles").delete().eq("id", did);
    assertEquals(error, null);
  }
  // Retained (audited) doctors keep their profile + auth user but lose
  // their role rows: roles are not referenced by audit_logs, and an
  // inert role would pollute role counts and subscription gauges.
  for (const did of auditedActors) {
    const { error } = await db.from("user_roles").delete().eq("user_id", did);
    assertEquals(error, null);
  }
  await deleteFixtureDoctors(auditedActors);

  // Leftover guard.
  const { count } = await db
    .from("queue_sessions")
    .select("id", { count: "exact", head: true })
    .like("session_name", `p14_${RUN}%`);
  assertEquals(count, 0);
});
