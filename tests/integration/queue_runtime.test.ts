/**
 * tests/integration/queue_runtime.test.ts
 *
 * Phase 1.2 - Queue Runtime & Live Operations against the REAL local
 * Supabase stack (no mocks; Meta is never called).
 *
 * Covers:
 *   - queue advancement (advance_queue SKIP LOCKED semantics)
 *   - concurrent advancement stress (5-way race)
 *   - pause / resume (idempotent, state visible for Realtime)
 *   - recall, skip, restore, mark absent, manual call (idempotent)
 *   - doctor workflow state machine (shared transition table)
 *   - snapshot reconstruction (queue recovery + wait estimates)
 *   - queue completion events (idempotent)
 *   - WhatsApp queue intelligence job enqueues (stable idem keys)
 *   - debounced SLA refresh enqueue
 *   - skip-vs-terminal race (exactly one writer wins)
 *   - analytics event feed (booking_events trigger)
 *   - cross-session / tenant isolation
 *
 * Run with:  deno task test:integration   (requires `supabase start`)
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertFalse,
  assertGreater,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { SEED } from "../utils/seed_constants.ts";

interface LocalStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

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
type BookingState = Awaited<ReturnType<typeof bootstrap>>["bookingState"];

let _ctx:
  | { db: DbClient; runtime: Runtime; bookingState: BookingState }
  | null = null;

async function bootstrap() {
  const status = await getLocalStatus();
  if (!status) {
    throw new Error(
      "Local Supabase stack is not running. Run `supabase start` first.",
    );
  }
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
  const bookingState = await import(
    "../../supabase/functions/_shared/booking_state.ts"
  );
  return { db: getServiceClient(), runtime, bookingState };
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

const RUN = crypto.randomUUID().slice(0, 8);

// Far-future dates keep fixtures clear of real OP days and of the
// unique (hospital_id, doctor_id, session_date) constraint.
let dateOffset = 0;

function nextDate(): string {
  dateOffset += 1;
  const day = String(dateOffset).padStart(2, "0");
  return `2030-01-${day}`;
}

const fixtureSessions: string[] = [];
const fixtureHospitals: string[] = [];

interface SessionFixture {
  sessionId: string;
  date: string;
  bookingIds: string[];
}

/** Creates a queue session with `tokens` waiting bookings. */
async function makeSession(tokens: number): Promise<SessionFixture> {
  const { db } = await ctx();
  const date = nextDate();

  const { data: session, error: sessErr } = await db
    .from("queue_sessions")
    .insert({
      hospital_id: SEED.HOSPITAL_ID,
      doctor_id: SEED.DOCTOR_ID,
      session_date: date,
      session_name: `p12_${RUN}`,
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
        hospital_id: SEED.HOSPITAL_ID,
        queue_session_id: sessionId,
        patient_name: `P12 ${RUN} ${i}`,
        patient_phone: `98${RUN}${String(i).padStart(4, "0")}`,
        token_number: i,
        status: "waiting",
        booking_source: "walkin",
        appointment_date: date,
        assigned_doctor_id: SEED.DOCTOR_ID,
      })
      .select("id")
      .single();
    assertEquals(bErr, null);
    assertExists(booking);
    bookingIds.push(booking.id as string);
  }

  return { sessionId, date, bookingIds };
}

async function bookingStatus(bookingId: string): Promise<string> {
  const { db } = await ctx();
  const { data, error } = await db
    .from("bookings")
    .select("status")
    .eq("id", bookingId)
    .single();
  assertEquals(error, null);
  assertExists(data);
  return data.status as string;
}

async function sessionRow(sessionId: string) {
  const { db } = await ctx();
  const { data, error } = await db
    .from("queue_sessions")
    .select(
      "id, hospital_id, is_active, is_paused, pause_reason, current_live_token, ended_at",
    )
    .eq("id", sessionId)
    .single();
  assertEquals(error, null);
  assertExists(data);
  return data;
}

async function queueEvents(sessionId: string, eventType?: string) {
  const { db } = await ctx();
  let q = db
    .from("queue_runtime_events")
    .select("event_type, token_number, booking_id, hospital_id, actor_id")
    .eq("queue_session_id", sessionId)
    .order("created_at", { ascending: true });
  if (eventType) q = q.eq("event_type", eventType);
  const { data, error } = await q;
  assertEquals(error, null);
  return (data ?? []) as Array<{
    event_type: string;
    token_number: number | null;
    booking_id: string | null;
    hospital_id: string;
    actor_id: string | null;
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

// ─── 1. Advancement ──────────────────────────────────────────────────────────

Deno.test("queue: advance_queue calls the next token and records an event", async () => {
  const { db } = await ctx();
  const fx = await makeSession(3);

  const { data: token, error } = await db.rpc("advance_queue", {
    p_queue_session_id: fx.sessionId,
  });
  assertEquals(error, null);
  assertEquals(token, 1);

  const session = await sessionRow(fx.sessionId);
  assertEquals(session.current_live_token, 1);
  assertEquals(await bookingStatus(fx.bookingIds[0]), "called");

  const events = await queueEvents(fx.sessionId, "advanced");
  assertEquals(events.length, 1);
  assertEquals(events[0].token_number, 1);
  assertEquals(events[0].booking_id, fx.bookingIds[0]);
  // Tenant attribution: event inherits the session's hospital.
  assertEquals(events[0].hospital_id, SEED.HOSPITAL_ID);
});

Deno.test("queue: advance respects priority_score over token order", async () => {
  const { db } = await ctx();
  const fx = await makeSession(3);

  // Boost token 3 to priority 10; it must be called first.
  const { error: upErr } = await db
    .from("bookings")
    .update({ priority_score: 10 })
    .eq("id", fx.bookingIds[2]);
  assertEquals(upErr, null);

  const { data: token, error } = await db.rpc("advance_queue", {
    p_queue_session_id: fx.sessionId,
  });
  assertEquals(error, null);
  assertEquals(token, 3);
});

// ─── 2. Concurrent advancement stress ────────────────────────────────────────

Deno.test("queue: 5-way concurrent advance picks 5 distinct tokens", async () => {
  const { db } = await ctx();
  const fx = await makeSession(10);

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      db.rpc("advance_queue", {
        p_queue_session_id: fx.sessionId,
      })),
  );

  const tokens = results.map((r) => {
    assertEquals(r.error, null);
    return r.data as number;
  });

  assertEquals(new Set(tokens).size, 5, "no duplicate token may be called");
  assertEquals([...tokens].sort((a, b) => a - b), [1, 2, 3, 4, 5]);

  const { count } = await db
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("queue_session_id", fx.sessionId)
    .eq("status", "called");
  assertEquals(count, 5);

  const events = await queueEvents(fx.sessionId, "advanced");
  assertEquals(events.length, 5);
});

// ─── 3. Pause / resume ───────────────────────────────────────────────────────

Deno.test("queue: pause blocks advance, is idempotent, and resume restores flow", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const fx = await makeSession(2);
  const session = (await sessionRow(fx.sessionId)) as never as Parameters<
    typeof runtime.runPauseQueue
  >[1];

  // Pause
  const paused = await runtime.runPauseQueue(
    db,
    session,
    "doctor break",
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(paused.paused, true);
  assertEquals(paused.already_paused, false);

  const after = await sessionRow(fx.sessionId);
  assertEquals(after.is_paused, true);
  assertEquals(after.pause_reason, "doctor break");

  // Idempotent repeat pause
  const pausedAgain = await runtime.runPauseQueue(
    db,
    session,
    "doctor break",
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(pausedAgain.paused, false);
  assertEquals(pausedAgain.already_paused, true);

  // Advance must be refused while paused (RPC-level guard)
  const { error: advErr } = await db.rpc("advance_queue", {
    p_queue_session_id: fx.sessionId,
  });
  assertExists(advErr, "advance must fail while paused");
  assertStringIncludes(advErr.message, "QUEUE_PAUSED");

  // Pause/resume events recorded with actor attribution
  const pauseEvents = await queueEvents(fx.sessionId, "paused");
  assertEquals(pauseEvents.length, 1);
  assertEquals(pauseEvents[0].actor_id, SEED.RECEPTIONIST_ID);

  // Resume
  const resumed = await runtime.runResumeQueue(
    db,
    { ...session, is_paused: true, pause_reason: "doctor break" },
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(resumed.resumed, true);

  const resumedAgain = await runtime.runResumeQueue(
    db,
    session,
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(resumedAgain.resumed, false);
  assertEquals(resumedAgain.already_running, true);

  const afterResume = await sessionRow(fx.sessionId);
  assertEquals(afterResume.is_paused, false);
  assertEquals(afterResume.pause_reason, null);

  // Advance works again
  const { data: token, error } = await db.rpc("advance_queue", {
    p_queue_session_id: fx.sessionId,
  });
  assertEquals(error, null);
  assertEquals(token, 1);
});

// ─── 4. Recall ───────────────────────────────────────────────────────────────

Deno.test("queue: recall returns the called booking and repeats safely", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const fx = await makeSession(2);

  await db.rpc("advance_queue", { p_queue_session_id: fx.sessionId });

  const session = (await sessionRow(fx.sessionId)) as never as Parameters<
    typeof runtime.runRecallCurrentToken
  >[1];

  const first = await runtime.runRecallCurrentToken(
    db,
    session,
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(first.ok, true);
  assertEquals(first.booking_id, fx.bookingIds[0]);
  assertEquals(first.token_number, 1);

  // Repeat: still succeeds, no state corruption
  const second = await runtime.runRecallCurrentToken(
    db,
    session,
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(second.ok, true);
  assertEquals(second.booking_id, fx.bookingIds[0]);
  assertEquals(await bookingStatus(fx.bookingIds[0]), "called");

  // Each distinct recall sends exactly one please_come_now job
  const jobs = await jobsByKeyPrefix(`wa_q_recall_${fx.bookingIds[0]}_`);
  assertEquals(jobs.length, 2);
  for (const job of jobs) {
    assertEquals(job.job_type, "send_whatsapp_message");
    assertEquals(job.payload.template_name, "please_come_now");
  }

  // Recall with no called token fails gracefully
  const empty = await makeSession(1);
  const emptySession =
    (await sessionRow(empty.sessionId)) as never as Parameters<
      typeof runtime.runRecallCurrentToken
    >[1];
  const none = await runtime.runRecallCurrentToken(
    db,
    emptySession,
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(none.ok, false);
  assertEquals(none.reason, "no_called_token");
});

// ─── 5. Skip / restore / absent ──────────────────────────────────────────────

Deno.test("queue: skip marks skipped, refuses re-skip, restore brings it back", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const fx = await makeSession(3);
  const session = (await sessionRow(fx.sessionId)) as never as Parameters<
    typeof runtime.runSkipToken
  >[1];

  const skipped = await runtime.runSkipToken(
    db,
    session,
    fx.bookingIds[1],
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(skipped.ok, true);
  assertEquals(skipped.token_number, 2);
  assertEquals(await bookingStatus(fx.bookingIds[1]), "skipped");

  // Idempotent: second skip refuses
  const again = await runtime.runSkipToken(
    db,
    session,
    fx.bookingIds[1],
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(again.ok, false);
  assertEquals(again.reason, "not_skippable");

  // Skipped patient notified once
  const skipJobs = await jobsByKeyPrefix(`wa_q_skipped_${fx.bookingIds[1]}`);
  assertEquals(skipJobs.length, 1);

  // Skipped token is excluded from advancement
  const { data: token } = await db.rpc("advance_queue", {
    p_queue_session_id: fx.sessionId,
  });
  assertEquals(token, 1);
  const { data: token2 } = await db.rpc("advance_queue", {
    p_queue_session_id: fx.sessionId,
  });
  assertEquals(token2, 3, "skipped token 2 must not be advanced");

  // Restore back into the waiting pool
  const restored = await runtime.runRestoreToken(
    db,
    session,
    fx.bookingIds[1],
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(restored.ok, true);
  assertEquals(await bookingStatus(fx.bookingIds[1]), "waiting");

  const restoreAgain = await runtime.runRestoreToken(
    db,
    session,
    fx.bookingIds[1],
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(restoreAgain.ok, false);
  assertEquals(restoreAgain.reason, "not_skipped");

  // Analytics feed: the bookings trigger recorded both transitions
  const { data: events } = await db
    .from("booking_events")
    .select("old_status, new_status")
    .eq("booking_id", fx.bookingIds[1])
    .order("created_at", { ascending: true });
  assertExists(events);
  const pairs = events.map((e) => `${e.old_status}->${e.new_status}`);
  assert(pairs.includes("waiting->skipped"));
  assert(pairs.includes("skipped->waiting"));
});

Deno.test("queue: mark absent sets no_show and refuses repeats", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const fx = await makeSession(2);
  const session = (await sessionRow(fx.sessionId)) as never as Parameters<
    typeof runtime.runMarkAbsent
  >[1];

  const absent = await runtime.runMarkAbsent(
    db,
    session,
    fx.bookingIds[0],
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(absent.ok, true);
  assertEquals(await bookingStatus(fx.bookingIds[0]), "no_show");

  const again = await runtime.runMarkAbsent(
    db,
    session,
    fx.bookingIds[0],
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(again.ok, false);
  assertEquals(again.reason, "not_markable");
});

// ─── 6. Manual call ──────────────────────────────────────────────────────────

Deno.test("queue: manual call overrides order and is idempotent", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const fx = await makeSession(3);
  const session = (await sessionRow(fx.sessionId)) as never as Parameters<
    typeof runtime.runCallToken
  >[1];

  const called = await runtime.runCallToken(
    db,
    session,
    3,
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(called.ok, true);
  assertEquals(called.idempotent, false);
  assertEquals(called.booking_id, fx.bookingIds[2]);
  assertEquals(await bookingStatus(fx.bookingIds[2]), "called");

  const live = await sessionRow(fx.sessionId);
  assertEquals(live.current_live_token, 3);

  // patient_called WhatsApp job (same key family as queue-next-patient)
  const jobs = await jobsByKeyPrefix(`wa_called_${fx.bookingIds[2]}`);
  assertEquals(jobs.length, 1);
  assertEquals(jobs[0].payload.template_name, "patient_called");

  // Repeat: idempotent flag, no duplicate notification
  const again = await runtime.runCallToken(
    db,
    session,
    3,
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(again.ok, true);
  assertEquals(again.idempotent, true);
  assertEquals(
    (await jobsByKeyPrefix(`wa_called_${fx.bookingIds[2]}`)).length,
    1,
  );

  // Unknown token fails gracefully
  const missing = await runtime.runCallToken(
    db,
    session,
    99,
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(missing.ok, false);
  assertEquals(missing.reason, "token_not_found");
});

// ─── 7. Doctor workflow state machine ────────────────────────────────────────

Deno.test("queue: shared state machine enforces the doctor workflow", async () => {
  const { bookingState } = await ctx();

  // Happy path: waiting → called → in_consultation → completed
  assert(bookingState.isValidTransition("waiting", "called"));
  assert(bookingState.isValidTransition("called", "in_consultation"));
  assert(bookingState.isValidTransition("in_consultation", "completed"));

  // Invalid shortcuts are rejected
  assertFalse(bookingState.isValidTransition("waiting", "completed"));
  assertFalse(bookingState.isValidTransition("called", "completed"));
  assertFalse(bookingState.isValidTransition("booked", "in_consultation"));

  // Terminal states stay terminal
  assert(bookingState.isTerminalState("completed"));
  assertFalse(bookingState.isValidTransition("completed", "waiting"));
  assertFalse(bookingState.isValidTransition("no_show", "waiting"));

  // Restore path: skipped → waiting only
  assert(bookingState.isValidTransition("skipped", "waiting"));
  assertFalse(bookingState.isValidTransition("skipped", "called"));
});

// ─── 8. Snapshot (recovery + wait-time engine) ───────────────────────────────

Deno.test("queue: snapshot reconstructs full state with wait estimates", async () => {
  const { db, runtime } = await ctx();
  const fx = await makeSession(3);

  // Advance one, complete none: called=1, waiting=2
  await db.rpc("advance_queue", { p_queue_session_id: fx.sessionId });

  const snapshot = await runtime.getQueueSnapshot(db, fx.sessionId);
  assertExists(snapshot);

  assertEquals(snapshot.session.id, fx.sessionId);
  assertEquals(snapshot.session.hospital_id, SEED.HOSPITAL_ID);
  assertEquals(snapshot.session.is_paused, false);
  assertEquals(snapshot.session.current_live_token, 1);

  // Called booking visible
  assertExists(snapshot.currently_called);
  assertEquals(snapshot.currently_called.booking_id, fx.bookingIds[0]);
  assertEquals(snapshot.currently_called.token_number, 1);

  // Waiting list ordered with positions and estimates
  assertEquals(snapshot.waiting.length, 2);
  assertEquals(snapshot.waiting[0].token_number, 2);
  assertEquals(snapshot.waiting[0].position, 1);
  assertEquals(snapshot.waiting[1].token_number, 3);
  assertEquals(snapshot.waiting[1].position, 2);

  // Estimates scale linearly with doctor throughput
  const avg = snapshot.average_consultation_minutes;
  assertGreater(avg, 0);
  assertEquals(snapshot.waiting[0].estimated_wait_minutes, 1 * avg);
  assertEquals(snapshot.waiting[1].estimated_wait_minutes, 2 * avg);

  // Status counts
  assertEquals(snapshot.counts.waiting, 2);
  assertEquals(snapshot.counts.called, 1);
  assertEquals(snapshot.counts.completed, 0);

  // Missing session returns null (clean recovery contract)
  const missing = await runtime.getQueueSnapshot(
    db,
    crypto.randomUUID(),
  );
  assertEquals(missing, null);
});

// ─── 9. Queue completion ─────────────────────────────────────────────────────

Deno.test("queue: completion event recorded exactly once on exhaustion", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const fx = await makeSession(1);

  // Drain the queue
  const first = await db.rpc("advance_queue", {
    p_queue_session_id: fx.sessionId,
  });
  assertEquals(first.data, 1);
  const empty = await db.rpc("advance_queue", {
    p_queue_session_id: fx.sessionId,
  });
  assertEquals(empty.data, null);

  // First completion marks; repeat is a no-op
  const marked = await runtime.markQueueCompleted(
    db,
    fx.sessionId,
    logger,
  );
  assertEquals(marked, true);

  const again = await runtime.markQueueCompleted(
    db,
    fx.sessionId,
    logger,
  );
  assertEquals(again, false);

  const events = await queueEvents(fx.sessionId, "queue_completed");
  assertEquals(events.length, 1);
});

// ─── 10. WhatsApp pause/resume intelligence ──────────────────────────────────

Deno.test("queue: pause/resume enqueue one WhatsApp job per waiting patient", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const fx = await makeSession(2);
  const session = (await sessionRow(fx.sessionId)) as never as Parameters<
    typeof runtime.runPauseQueue
  >[1];

  await runtime.runPauseQueue(
    db,
    session,
    "delay",
    SEED.RECEPTIONIST_ID,
    logger,
  );

  const pauseJobs = await jobsByKeyPrefix(`wa_q_paused_${fx.sessionId}_`);
  assertEquals(pauseJobs.length, 2, "one job per waiting patient");
  for (const job of pauseJobs) {
    assertEquals(job.job_type, "send_whatsapp_message");
    assertStringIncludes(String(job.payload.text), "paused");
  }

  await runtime.runResumeQueue(
    db,
    { ...session, is_paused: true, pause_reason: "delay" },
    SEED.RECEPTIONIST_ID,
    logger,
  );

  const resumeJobs = await jobsByKeyPrefix(`wa_q_resumed_${fx.sessionId}_`);
  assertEquals(resumeJobs.length, 2);
  for (const job of resumeJobs) {
    assertStringIncludes(String(job.payload.text), "resumed");
  }

  // Repeat pause: idempotent, no duplicate notifications
  await runtime.runPauseQueue(
    db,
    { ...session, is_paused: true, pause_reason: "delay" },
    "delay",
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(
    (await jobsByKeyPrefix(`wa_q_paused_${fx.sessionId}_`)).length,
    2,
  );
});

// ─── 11. SLA refresh debounce ────────────────────────────────────────────────

Deno.test("queue: trigger_sla_refresh collapses bursts into one job", async () => {
  const { db } = await ctx();
  const fxDate = nextDate();

  const first = await db.rpc("trigger_sla_refresh", {
    p_hospital_id: SEED.HOSPITAL_ID,
    p_date: fxDate,
  });
  assertEquals(first.error, null);
  assertExists(first.data);

  const second = await db.rpc("trigger_sla_refresh", {
    p_hospital_id: SEED.HOSPITAL_ID,
    p_date: fxDate,
  });
  assertEquals(second.error, null);

  // Same 5-minute bucket → same job row
  assertEquals(second.data, first.data);

  const { count } = await db
    .from("job_queue")
    .select("id", { count: "exact", head: true })
    .eq("job_type", "compute_sla")
    .like("idempotency_key", `sla_${SEED.HOSPITAL_ID}_${fxDate}_%`);
  assertEquals(count, 1, "burst must collapse into a single compute_sla job");
});

// ─── 12. Concurrency: skip vs terminal transition ────────────────────────────

Deno.test("queue: skip racing a terminal transition - exactly one wins", async () => {
  const { db } = await ctx();
  const fx = await makeSession(1);

  await db.rpc("advance_queue", { p_queue_session_id: fx.sessionId });
  assertEquals(await bookingStatus(fx.bookingIds[0]), "called");

  // Race: optimistic completion (doctor path) vs skip (reception path)
  const [skipRes, completeRes] = await Promise.all([
    db.rpc("skip_queue_token", {
      p_queue_session_id: fx.sessionId,
      p_booking_id: fx.bookingIds[0],
    }),
    db
      .from("bookings")
      .update({ status: "completed" })
      .eq("id", fx.bookingIds[0])
      .eq("status", "called")
      .select("id"),
  ]);

  assertEquals(skipRes.error, null);
  assertEquals(completeRes.error, null);

  const skipOk = (skipRes.data as { ok: boolean }).ok === true;
  const completeOk = (completeRes.data as Array<{ id: string }>).length === 1;

  assert(
    skipOk !== completeOk,
    "exactly one writer may win the race",
  );

  const finalStatus = await bookingStatus(fx.bookingIds[0]);
  assert(
    finalStatus === "skipped" || finalStatus === "completed",
    `unexpected final status ${finalStatus}`,
  );
});

// ─── 13. Isolation ───────────────────────────────────────────────────────────

Deno.test("queue: foreign bookings cannot be controlled through another session", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();

  // Tenant B: own hospital, session and booking
  const { data: hospB, error: hospErr } = await db
    .from("hospitals")
    .insert({
      name: `P12 ISO ${RUN}`,
      slug: `p12-iso-${RUN}`,
    })
    .select("id")
    .single();
  assertEquals(hospErr, null);
  assertExists(hospB);
  const hospitalB = hospB.id as string;
  fixtureHospitals.push(hospitalB);

  const dateB = nextDate();

  const { data: sessB, error: sessBErr } = await db
    .from("queue_sessions")
    .insert({
      hospital_id: hospitalB,
      session_date: dateB,
      session_name: `p12_iso_${RUN}`,
      max_tokens: 10,
    })
    .select("id")
    .single();
  assertEquals(sessBErr, null);
  assertExists(sessB);

  const { data: bookingB, error: bookingBErr } = await db
    .from("bookings")
    .insert({
      hospital_id: hospitalB,
      queue_session_id: sessB.id,
      patient_name: `ISO ${RUN}`,
      patient_phone: `97${RUN}0001`,
      token_number: 1,
      status: "waiting",
      booking_source: "walkin",
      appointment_date: dateB,
    })
    .select("id")
    .single();
  assertEquals(bookingBErr, null);
  assertExists(bookingB);

  // Session A (seeded hospital) must not control tenant B's booking
  const fxA = await makeSession(1);
  const sessionA = (await sessionRow(fxA.sessionId)) as never as Parameters<
    typeof runtime.runSkipToken
  >[1];

  const cross = await runtime.runSkipToken(
    db,
    sessionA,
    bookingB.id as string,
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(cross.ok, false);
  assertEquals(cross.reason, "not_skippable");
  assertEquals(await bookingStatus(bookingB.id as string), "waiting");
});

// ─── 14. Cleanup ─────────────────────────────────────────────────────────────

Deno.test("zz: fixture cleanup", async () => {
  const { db } = await ctx();

  // WhatsApp/SLA jobs created by this run (keyed by session/date)
  for (const sid of fixtureSessions) {
    await db
      .from("job_queue")
      .delete()
      .like("idempotency_key", `%${sid}%`);
  }
  await db
    .from("job_queue")
    .delete()
    .eq("job_type", "compute_sla")
    .like("idempotency_key", `sla_${SEED.HOSPITAL_ID}_2030%`);

  // Sessions cascade runtime events; bookings cascade with them via
  // the FK chain (bookings.queue_session_id ON DELETE SET NULL first,
  // then delete by hospital+date scope).
  for (const sid of fixtureSessions) {
    await db.from("bookings").delete().eq("queue_session_id", sid);
    await db.from("queue_sessions").delete().eq("id", sid);
  }

  // Tenant B fixtures cascade from the hospital row.
  for (const hid of fixtureHospitals) {
    await db.from("hospitals").delete().eq("id", hid);
  }

  // Guard: no leftover fixtures
  const { count: leftoverSessions } = await db
    .from("queue_sessions")
    .select("id", { count: "exact", head: true })
    .like("session_name", `p12_${RUN}%`);
  assertEquals(leftoverSessions, 0);
});
