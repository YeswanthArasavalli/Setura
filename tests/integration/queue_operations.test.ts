/**
 * tests/integration/queue_operations.test.ts
 *
 * Phase 1.3 — Operations & exception management against the REAL
 * local Supabase stack (no mocks; Meta is never called).
 *
 * Covers:
 *   - doctor delay management (mark / change / clear, idempotent,
 *     event-recorded, patient notifications)
 *   - delay-aware snapshot + live queue health metrics
 *   - queue health evaluator: congestion, stall, pause-exceeded,
 *     SLA breach (alert fired once, deduped on re-run)
 *   - operational incident events (stalled / pause exceeded)
 *   - alert threshold overrides + multi-tenant attribution
 *   - admin WhatsApp operational notifications (idempotent)
 *   - audit action registry entries
 *
 * Run with:  deno task test:integration   (requires `supabase start`)
 */

import {
  assertEquals,
  assertExists,
  assertGreater,
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

/** The evaluator scans today's active sessions, so fixtures use TODAY. */
function todayLocal(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const TODAY = todayLocal();
const RUN_START = new Date().toISOString();

const fixtureSessions: string[] = [];
const fixtureHospitals: string[] = [];
const fixtureDoctors: string[] = [];
const fixtureThresholds: Array<{ hospital: string | null; key: string }> = [];

/**
 * queue_sessions has UNIQUE(hospital_id, doctor_id, session_date), so every
 * same-day fixture session for the seed hospital gets its own synthetic
 * doctor. profiles.id references auth.users, so the user is created through
 * the local GoTrue admin API and removed again during cleanup.
 */
async function fixtureDoctor(): Promise<string> {
  const { db } = await ctx();
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");

  const userId = crypto.randomUUID();
  const resp = await fetch(`${LOCAL_STATUS.API_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${LOCAL_STATUS.SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: userId,
      email: `p13-doc-${RUN}-${fixtureDoctors.length}@setura.test`,
      email_confirm: true,
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
      full_name: `P13 Doc ${RUN}`,
      normalized_phone: phone,
    });
  assertEquals(error, null);
  fixtureDoctors.push(userId);
  return userId;
}

async function deleteFixtureDoctors() {
  if (!LOCAL_STATUS) return;
  for (const userId of fixtureDoctors) {
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
  date: string;
  bookingIds: string[];
}

/** Creates an active queue session with `tokens` waiting bookings. */
async function makeSession(
  tokens: number,
  opts: {
    hospitalId?: string;
    doctorId?: string | null;
    createdAt?: string;
  } = {},
): Promise<SessionFixture> {
  const { db } = await ctx();

  const doctorId = opts.doctorId === undefined
    ? await fixtureDoctor()
    : opts.doctorId;

  const { data: session, error: sessErr } = await db
    .from("queue_sessions")
    .insert({
      hospital_id: opts.hospitalId ?? SEED.HOSPITAL_ID,
      doctor_id: doctorId,
      session_date: TODAY,
      session_name: `p13_${RUN}`,
      max_tokens: 50,
      ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
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
        patient_name: `P13 ${RUN} ${i}`,
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

  return { sessionId, date: TODAY, bookingIds };
}

async function sessionRow(sessionId: string) {
  const { db } = await ctx();
  const { data, error } = await db
    .from("queue_sessions")
    .select(
      "id, hospital_id, is_active, is_paused, delay_expected_minutes, delay_reason, delay_started_at",
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

async function alertRows(hospitalId: string, alertKey: string) {
  const { db } = await ctx();
  const { data, error } = await db
    .from("alert_events")
    .select("id, hospital_id, alert_key, severity, message, is_resolved")
    .eq("hospital_id", hospitalId)
    .eq("alert_key", alertKey)
    .gte("created_at", RUN_START);
  assertEquals(error, null);
  return (data ?? []) as Array<{
    id: string;
    hospital_id: string;
    alert_key: string;
    severity: string;
    message: string;
    is_resolved: boolean;
  }>;
}

async function setThreshold(
  hospitalId: string | null,
  key: string,
  value: number,
  severity = "warning",
) {
  const { db } = await ctx();
  const { error } = await db
    .from("alert_thresholds")
    .upsert({
      hospital_id: hospitalId,
      alert_key: key,
      threshold_value: value,
      threshold_unit: "count",
      severity,
      is_active: true,
    }, { onConflict: "hospital_id,alert_key" });
  assertEquals(error, null);
  fixtureThresholds.push({ hospital: hospitalId, key });
}

// ─── 1. Doctor delay management ──────────────────────────────────────────────

Deno.test("ops: mark doctor delay updates session, records event, notifies patients", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const fx = await makeSession(2);
  const session = (await sessionRow(fx.sessionId)) as never as Parameters<
    typeof runtime.runMarkDoctorDelayed
  >[1];

  const result = await runtime.runMarkDoctorDelayed(
    db,
    session,
    30,
    "doctor stuck in traffic",
    SEED.RECEPTIONIST_ID,
    logger,
  );

  assertEquals(result.ok, true);
  assertEquals(result.already_delayed, false);

  const row = await sessionRow(fx.sessionId);
  assertEquals(row.delay_expected_minutes, 30);
  assertEquals(row.delay_reason, "doctor stuck in traffic");
  assertExists(row.delay_started_at);

  const events = await queueEvents(fx.sessionId, "doctor_delayed");
  assertEquals(events.length, 1);
  assertEquals(events[0].metadata.minutes, 30);
  assertEquals(events[0].hospital_id, SEED.HOSPITAL_ID);
  assertEquals(events[0].actor_id, SEED.RECEPTIONIST_ID);

  // One WhatsApp delay notification per waiting patient.
  const jobs = await jobsByKeyPrefix(`wa_q_delay_${fx.sessionId}`);
  assertEquals(jobs.length, 2);
  assertStringIncludes(jobs[0].payload.text as string, "30 minutes late");
});

Deno.test("ops: repeat delay is idempotent; changed delay re-notifies", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const fx = await makeSession(2);
  const session = (await sessionRow(fx.sessionId)) as never as Parameters<
    typeof runtime.runMarkDoctorDelayed
  >[1];

  await runtime.runMarkDoctorDelayed(
    db,
    session,
    20,
    "delay",
    SEED.RECEPTIONIST_ID,
    logger,
  );

  // Same (minutes, reason): no new event, no new notifications.
  const repeat = await runtime.runMarkDoctorDelayed(
    db,
    session,
    20,
    "delay",
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(repeat.already_delayed, true);
  assertEquals((await queueEvents(fx.sessionId, "doctor_delayed")).length, 1);
  assertEquals(
    (await jobsByKeyPrefix(`wa_q_delay_${fx.sessionId}`)).length,
    2,
  );

  // Changed minutes: new event + new notification set keyed by minutes.
  const changed = await runtime.runMarkDoctorDelayed(
    db,
    session,
    45,
    "delay",
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(changed.already_delayed, false);
  assertEquals((await queueEvents(fx.sessionId, "doctor_delayed")).length, 2);
  assertEquals(
    (await jobsByKeyPrefix(`wa_q_delay_${fx.sessionId}`)).length,
    4,
  );
});

Deno.test("ops: clear delay is idempotent and records previous minutes", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const fx = await makeSession(1);
  const session = (await sessionRow(fx.sessionId)) as never as Parameters<
    typeof runtime.runClearDoctorDelay
  >[1];

  await runtime.runMarkDoctorDelayed(
    db,
    session,
    25,
    null,
    SEED.RECEPTIONIST_ID,
    logger,
  );

  const cleared = await runtime.runClearDoctorDelay(
    db,
    session,
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(cleared.already_clear, false);
  assertEquals(cleared.previous_minutes, 25);

  const row = await sessionRow(fx.sessionId);
  assertEquals(row.delay_expected_minutes, null);
  assertEquals(row.delay_reason, null);

  const events = await queueEvents(fx.sessionId, "delay_cleared");
  assertEquals(events.length, 1);
  assertEquals(events[0].metadata.previous_minutes, 25);

  // Idempotent repeat.
  const repeat = await runtime.runClearDoctorDelay(
    db,
    session,
    SEED.RECEPTIONIST_ID,
    logger,
  );
  assertEquals(repeat.already_clear, true);
  assertEquals((await queueEvents(fx.sessionId, "delay_cleared")).length, 1);
});

// ─── 2. Delay-aware snapshot + live health metrics ───────────────────────────

Deno.test("ops: snapshot exposes delay-aware estimates and health metrics", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();
  const fx = await makeSession(3);
  const session = (await sessionRow(fx.sessionId)) as never as Parameters<
    typeof runtime.runMarkDoctorDelayed
  >[1];

  // One completed consultation of ~6 minutes → actual avg observable.
  const { error: cErr } = await db
    .from("bookings")
    .update({
      status: "completed",
      consultation_started_at: new Date(Date.now() - 10 * 60_000)
        .toISOString(),
      consultation_completed_at: new Date(Date.now() - 4 * 60_000)
        .toISOString(),
    })
    .eq("id", fx.bookingIds[0]);
  assertEquals(cErr, null);

  await runtime.runMarkDoctorDelayed(
    db,
    session,
    15,
    null,
    SEED.RECEPTIONIST_ID,
    logger,
  );

  const snapshot = await runtime.getQueueSnapshot(db, fx.sessionId);
  assertExists(snapshot);

  assertEquals(snapshot.session.delay_expected_minutes, 15);
  assertExists(snapshot.health);

  const health = snapshot.health!;
  assertEquals(health.delay_active, true);
  assertEquals(health.delay_expected_minutes, 15);
  assertGreater(health.actual_avg_consultation_minutes, 4);
  assertGreater(health.throughput_per_hour, 0);
  assertExists(health.estimated_completion_at);
  assertGreater(health.avg_estimated_wait_minutes, 15);

  // Waiting estimates include the declared delay.
  const avg = snapshot.average_consultation_minutes;
  assertEquals(snapshot.estimated_wait_next_minutes, avg + 15);
  for (const entry of snapshot.waiting) {
    assertEquals(
      entry.estimated_wait_minutes,
      entry.position * avg + 15,
    );
  }
});

// ─── 3. Queue health evaluator: congestion ───────────────────────────────────

Deno.test("ops: evaluator fires congestion alert once and dedupes on re-run", async () => {
  const { db, runtime } = await ctx();
  const fx = await makeSession(3);

  // Hospital override: 3 waiting patients is already congestion.
  await setThreshold(SEED.HOSPITAL_ID, "queue_length_exceeded", 2);

  const first = await runtime.evaluateQueueHealth(db);
  assertGreater(first.sessions_evaluated, 0);

  const ours = first.new_alerts.filter((a) =>
    a.queue_session_id === fx.sessionId &&
    a.alert_key === "queue_length_exceeded"
  );
  assertEquals(ours.length, 1);
  assertEquals(ours[0].hospital_id, SEED.HOSPITAL_ID);
  assertEquals(ours[0].severity, "warning");
  assertStringIncludes(ours[0].message, fx.sessionId);

  const rows = await alertRows(SEED.HOSPITAL_ID, "queue_length_exceeded");
  assertGreater(rows.length, 0);

  // Re-run: alert is open → suppressed, nothing new for this session.
  const second = await runtime.evaluateQueueHealth(db);
  const again = second.new_alerts.filter((a) =>
    a.queue_session_id === fx.sessionId &&
    a.alert_key === "queue_length_exceeded"
  );
  assertEquals(again.length, 0);
});

// ─── 4. Stalled queue detection + incident event ─────────────────────────────

Deno.test("ops: evaluator detects stalled queue and records incident once", async () => {
  const { db, runtime } = await ctx();

  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  const fx = await makeSession(2, { createdAt: twoHoursAgo });

  // Last token progress was 2 hours ago.
  const { error: evErr } = await db
    .from("queue_runtime_events")
    .insert({
      queue_session_id: fx.sessionId,
      hospital_id: SEED.HOSPITAL_ID,
      event_type: "advanced",
      token_number: 1,
      created_at: twoHoursAgo,
    });
  assertEquals(evErr, null);

  const first = await runtime.evaluateQueueHealth(db);
  const stalled = first.new_alerts.filter((a) =>
    a.queue_session_id === fx.sessionId && a.alert_key === "queue_stalled"
  );
  assertEquals(stalled.length, 1);
  assertEquals(stalled[0].severity, "critical");

  // Incident event recorded with a recovery suggestion.
  const incidents = await queueEvents(fx.sessionId, "stalled_detected");
  assertEquals(incidents.length, 1);
  assertExists(incidents[0].metadata.recovery_suggestion);
  assertGreater(Number(incidents[0].metadata.stalled_minutes), 100);

  // Re-run: alert deduped → no duplicate incident.
  await runtime.evaluateQueueHealth(db);
  assertEquals(
    (await queueEvents(fx.sessionId, "stalled_detected")).length,
    1,
  );
});

// ─── 5. Pause-exceeded detection ─────────────────────────────────────────────

Deno.test("ops: evaluator fires pause-exceeded alert for long pauses", async () => {
  const { db, runtime } = await ctx();
  const fx = await makeSession(2);

  // Pause an hour ago (bypass pause_queue to control the timestamp).
  const { error: upErr } = await db
    .from("queue_sessions")
    .update({
      is_paused: true,
      paused_at: new Date(Date.now() - 3600_000).toISOString(),
      pause_reason: "lunch",
    })
    .eq("id", fx.sessionId);
  assertEquals(upErr, null);

  const summary = await runtime.evaluateQueueHealth(db);
  const paused = summary.new_alerts.filter((a) =>
    a.queue_session_id === fx.sessionId &&
    a.alert_key === "queue_pause_exceeded"
  );
  assertEquals(paused.length, 1);

  const incidents = await queueEvents(fx.sessionId, "pause_exceeded_detected");
  assertEquals(incidents.length, 1);
  assertGreater(Number(incidents[0].metadata.paused_minutes), 50);
});

// ─── 6. SLA breach alert ─────────────────────────────────────────────────────

Deno.test("ops: evaluator fires SLA breach when daily avg wait exceeds threshold", async () => {
  const { db, runtime } = await ctx();

  const { error: slaErr } = await db
    .from("sla_daily_tracking")
    .upsert({
      hospital_id: SEED.HOSPITAL_ID,
      tracking_date: TODAY,
      avg_wait_minutes: 90,
    }, { onConflict: "hospital_id,tracking_date" });
  assertEquals(slaErr, null);

  const summary = await runtime.evaluateQueueHealth(db);
  const breach = summary.new_alerts.filter((a) =>
    a.hospital_id === SEED.HOSPITAL_ID && a.alert_key === "sla_wait_breach"
  );
  assertEquals(breach.length, 1);
  assertEquals(breach[0].queue_session_id, null);
  assertStringIncludes(breach[0].message, "SLA breach");

  // Deduped on re-run.
  const second = await runtime.evaluateQueueHealth(db);
  assertEquals(
    second.new_alerts.filter((a) =>
      a.hospital_id === SEED.HOSPITAL_ID && a.alert_key === "sla_wait_breach"
    ).length,
    0,
  );
});

// ─── 7. Multi-tenant alert attribution ───────────────────────────────────────

Deno.test("ops: alerts are attributed to the right tenant with its own thresholds", async () => {
  const { db, runtime } = await ctx();

  const { data: hospB, error: hospErr } = await db
    .from("hospitals")
    .insert({
      name: `P13 ISO ${RUN}`,
      slug: `p13-iso-${RUN}`,
    })
    .select("id")
    .single();
  assertEquals(hospErr, null);
  assertExists(hospB);
  const hospitalB = hospB.id as string;
  fixtureHospitals.push(hospitalB);

  // Hospital B has a much tighter congestion threshold than tenant A.
  await setThreshold(hospitalB, "queue_length_exceeded", 1);

  const fxB = await makeSession(2, { hospitalId: hospitalB, doctorId: null });

  const summary = await runtime.evaluateQueueHealth(db);
  const bAlerts = summary.new_alerts.filter((a) =>
    a.queue_session_id === fxB.sessionId &&
    a.alert_key === "queue_length_exceeded"
  );
  assertEquals(bAlerts.length, 1);
  assertEquals(bAlerts[0].hospital_id, hospitalB);

  // The alert row itself carries tenant B attribution.
  const rows = await alertRows(hospitalB, "queue_length_exceeded");
  assertGreater(rows.length, 0);
  assertEquals(rows[0].hospital_id, hospitalB);
});

// ─── 8. Admin WhatsApp operational notifications ─────────────────────────────

Deno.test("ops: admin alert notifications are enqueued once per alert", async () => {
  const { db, runtime } = await ctx();
  const logger = await testLogger();

  const alertId = crypto.randomUUID();

  const alerts = [{
    alert_id: alertId,
    hospital_id: SEED.HOSPITAL_ID,
    queue_session_id: null,
    alert_key: "queue_stalled",
    severity: "critical",
    current_value: 42,
    threshold_value: 20,
    message: "Queue stalled: test alert",
  }];

  const first = await runtime.notifyAdminsOfQueueAlerts(db, alerts, logger);
  assertGreater(first, 0);

  const jobs = await jobsByKeyPrefix(`wa_ops_alert_${alertId}`);
  assertEquals(jobs.length, first);
  assertStringIncludes(jobs[0].payload.text as string, "CRITICAL");
  assertStringIncludes(jobs[0].payload.text as string, "Queue stalled");

  // Idempotent: repeating with the same alert id adds no jobs.
  const second = await runtime.notifyAdminsOfQueueAlerts(db, alerts, logger);
  assertEquals(second, jobs.length);
  assertEquals(
    (await jobsByKeyPrefix(`wa_ops_alert_${alertId}`)).length,
    jobs.length,
  );
});

// ─── 9. Audit action registry ────────────────────────────────────────────────

Deno.test("ops: queue_control and operational_alert are registered audit actions", async () => {
  const { db } = await ctx();

  const { data, error } = await db
    .from("audit_action_types")
    .select("action_type, category, is_active")
    .in("action_type", ["queue_control", "operational_alert"]);
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

// ─── 10. Cleanup ─────────────────────────────────────────────────────────────

Deno.test("zz ops: cleanup leaves no fixtures behind", async () => {
  const { db } = await ctx();

  // Jobs created by this suite.
  const { error: j1 } = await db.from("job_queue").delete().like(
    "idempotency_key",
    "wa_q_delay_%",
  );
  assertEquals(j1, null);
  const { error: j2 } = await db.from("job_queue").delete().like(
    "idempotency_key",
    "wa_ops_alert_%",
  );
  assertEquals(j2, null);

  // Alerts fired during this run for our tenants/keys.
  const alertKeys = [
    "queue_wait_exceeded",
    "queue_length_exceeded",
    "queue_stalled",
    "queue_pause_exceeded",
    "queue_throughput_low",
    "sla_wait_breach",
  ];
  for (const hospitalId of [SEED.HOSPITAL_ID, ...fixtureHospitals]) {
    const { error } = await db.from("alert_events").delete()
      .eq("hospital_id", hospitalId)
      .in("alert_key", alertKeys)
      .gte("created_at", RUN_START);
    assertEquals(error, null);
  }

  // SLA fixture row.
  const { error: slaErr } = await db.from("sla_daily_tracking").delete()
    .eq("hospital_id", SEED.HOSPITAL_ID)
    .eq("tracking_date", TODAY)
    .eq("avg_wait_minutes", 90);
  assertEquals(slaErr, null);

  // Threshold overrides (hospital-scoped ones only).
  for (const t of fixtureThresholds) {
    if (!t.hospital) continue;
    const { error } = await db.from("alert_thresholds").delete()
      .eq("hospital_id", t.hospital)
      .eq("alert_key", t.key);
    assertEquals(error, null);
  }
  // Restore the seeded default that test 5 replaced via upsert.
  const { error: thrErr } = await db.from("alert_thresholds").update({
    threshold_value: 25,
    threshold_unit: "count",
  })
    .eq("hospital_id", SEED.HOSPITAL_ID)
    .eq("alert_key", "queue_length_exceeded");
  assertEquals(thrErr, null);

  // Bookings → sessions (FK order), then fixture hospitals cascade.
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
    const { error } = await db.from("profiles").delete().eq("id", did);
    assertEquals(error, null);
  }
  await deleteFixtureDoctors();

  // Leftover guard.
  const { count } = await db
    .from("queue_sessions")
    .select("id", { count: "exact", head: true })
    .like("session_name", `p13_${RUN}%`);
  assertEquals(count, 0);
});
