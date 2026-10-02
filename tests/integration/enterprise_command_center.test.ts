/**
 * tests/integration/enterprise_command_center.test.ts
 *
 * Phase 1.5 — Hospital Command Center & Executive Operations
 * against the REAL local Supabase stack (no mocks; Meta is never
 * called — broadcasts only enqueue jobs).
 *
 * Covers:
 *   - command center overview accuracy vs fixture source data
 *   - operational scores (0-100 bounds + inputs)
 *   - hospital timeline with filters and tenant isolation
 *   - daily / weekly / monthly executive dashboards
 *   - doctor performance + rankings accuracy
 *   - financial command center exact reconciliation +
 *     deterministic forecasting
 *   - SLA dashboard + predictive insights
 *   - alert lifecycle: dedupe, acknowledge, assign, escalate,
 *     resolve, suppression windows
 *   - portfolio dashboard + cross-hospital benchmarks +
 *     cross-tenant isolation
 *   - reporting engine: all 8 report types + unknown type +
 *     CSV / PDF-ready output
 *   - governance: audit search + integrity verification RPCs
 *   - WhatsApp operational broadcasts (flag gating, idempotency)
 *   - HTTP endpoints: command-center, alert-center,
 *     enterprise-reports, executive-analytics + auth gates
 *
 * Residue policy: audit_logs are immutable. Hospital A and its
 * admin are audited by the HTTP mutation tests and stay as inert
 * residue (roles stripped); hospital B stays audit-free and is
 * fully removed.
 *
 * Run with:  deno task test:integration   (requires full
 * `supabase stop; supabase start` so the Phase 1.5 edge functions
 * are registered in the local edge runtime)
 */

import {
  assert,
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

// ─── One-time bootstrap: env → dynamic import of the real client ────────────

type DbClient = Awaited<ReturnType<typeof bootstrap>>["db"];

let _ctx: { db: DbClient } | null = null;

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
  return { db: getServiceClient() };
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

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "7");

function todayLocal(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const TODAY = todayLocal();
const RUN_START = new Date().toISOString();
const FIXTURE_PASSWORD = `P15-${RUN}-fixture-pass`;

/**
 * Action type used by the audit-search fixture. Must be a row that
 * actually exists in public.audit_action_types (registered by migration
 * 36) and must not be written by any RPC, so the cross-tenant "hospital
 * B sees nothing" assertion cannot be satisfied or broken by accident.
 */
const AUDIT_FIXTURE_ACTION = "CONFIG_UPDATE";

function minsAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

/** Run-scoped fixture state, built once by the setup test. */
interface FixtureState {
  hospitalA: string;
  hospitalB: string;
  adminA: { userId: string; email: string; token: string };
  adminB: { userId: string; email: string; token: string };
  recepA: { userId: string; email: string; token: string };
  globalAdmin: { userId: string; email: string; token: string };
  docD: string;
  docB: string;
  sessionA: string;
  sessionB: string;
  completedBooking: string;
  broadcastKeys: string[];
}

let F: FixtureState | null = null;

function fx(): FixtureState {
  if (!F) throw new Error("setup test not run");
  return F;
}

async function createAuthUser(
  userId: string,
  email: string,
): Promise<void> {
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

/** Password-grant sign-in against local GoTrue → real access token. */
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
  return json.access_token;
}

async function deleteAuthUser(userId: string): Promise<void> {
  if (!LOCAL_STATUS) return;
  try {
    await fetch(`${LOCAL_STATUS.API_URL}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${LOCAL_STATUS.SERVICE_ROLE_KEY}`,
      },
    });
  } catch {
    // Best-effort: leftover fixture users are inert test data.
  }
}

/** Calls a Phase 1.5 edge function over HTTP. */
async function callFn(
  fn: string,
  token: string | null,
  hospitalId: string | null,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (hospitalId) headers["X-Hospital-ID"] = hospitalId;

  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/functions/v1/${fn}`,
    { method: "POST", headers, body: JSON.stringify(body) },
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

/** Extracts `data` from a success envelope. */
function okData(
  res: { status: number; json: Record<string, unknown> | null },
): Record<string, unknown> {
  assertEquals(res.status, 200);
  assertExists(res.json);
  assertEquals(res.json.success, true);
  const data = res.json.data as Record<string, unknown>;
  assertExists(data);
  return data;
}

/** Asserts an error envelope carries the expected error code. */
function assertErrorCode(
  res: { status: number; json: Record<string, unknown> | null },
  status: number,
  code: string,
): void {
  assertEquals(res.status, status);
  assertExists(res.json);
  assertEquals(res.json.success, false);
  const err = res.json.error as { code?: string };
  assertExists(err);
  assertEquals(err.code, code);
}

async function rpc(
  fn: Parameters<DbClient["rpc"]>[0],
  args: Record<string, unknown>,
): Promise<unknown> {
  const { db } = await ctx();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (db.rpc as any)(fn, args);
  assertEquals(error, null);
  return data;
}

// ─── 0. Setup ────────────────────────────────────────────────────────────────

Deno.test("ent: setup fixture hospitals, actors and source data", async () => {
  const { db } = await ctx();

  // Two isolated tenants.
  const { data: hA, error: hAErr } = await db
    .from("hospitals")
    .insert({ name: `P15 Ent ${RUN} A`, slug: `p15-ent-${RUN}-a` })
    .select("id")
    .single();
  assertEquals(hAErr, null);
  const { data: hB, error: hBErr } = await db
    .from("hospitals")
    .insert({ name: `P15 Ent ${RUN} B`, slug: `p15-ent-${RUN}-b` })
    .select("id")
    .single();
  assertEquals(hBErr, null);
  assertExists(hA);
  assertExists(hB);
  const hospitalA = hA.id as string;
  const hospitalB = hB.id as string;

  // Fixture doctors: create auth users first (profiles has FK to auth.users).
  const docD = crypto.randomUUID();
  const docB = crypto.randomUUID();
  await createAuthUser(docD, `p15-docd-${RUN}@setura.test`);
  await createAuthUser(docB, `p15-docb-${RUN}@setura.test`);
  for (const [id, name] of [[docD, "D"], [docB, "B"]] as const) {
    const { error } = await db.from("profiles").upsert({
      id,
      full_name: `P15 Doc ${name} ${RUN}`,
      normalized_phone: `96${RUN}${name === "D" ? "01" : "02"}`,
    });
    assertEquals(error, null);
  }

  // Auth users: admins (A + B), receptionist A, global admin.
  async function fixtureActor(
    tag: string,
    role:
      | "global_admin"
      | "hospital_admin"
      | "doctor"
      | "receptionist",
    hospitalId: string | null,
    phoneSuffix: string,
  ) {
    const userId = crypto.randomUUID();
    const email = `p15-${tag}-${RUN}@setura.test`;
    await createAuthUser(userId, email);
    const { error: pErr } = await db.from("profiles").upsert({
      id: userId,
      full_name: `P15 ${tag} ${RUN}`,
      normalized_phone: `95${RUN}${phoneSuffix}`,
    });
    assertEquals(pErr, null);
    const { error: rErr } = await db.from("user_roles").insert({
      user_id: userId,
      hospital_id: hospitalId,
      role,
      is_primary: true,
    });
    assertEquals(rErr, null);
    return { userId, email, token: await tokenFor(email) };
  }

  const adminA = await fixtureActor(
    "admina",
    "hospital_admin",
    hospitalA,
    "01",
  );
  const adminB = await fixtureActor(
    "adminb",
    "hospital_admin",
    hospitalB,
    "02",
  );
  const recepA = await fixtureActor("recep", "receptionist", hospitalA, "03");
  const globalAdmin = await fixtureActor(
    "global",
    "global_admin",
    null,
    "04",
  );

  // Hospital A: one session for docD with 2 waiting + 1 completed
  // booking. Timestamps are explicit so wait/consultation averages
  // are deterministic (10 min wait, 12 min consultation).
  const { data: sA, error: sAErr } = await db
    .from("queue_sessions")
    .insert({
      hospital_id: hospitalA,
      doctor_id: docD,
      session_date: TODAY,
      session_name: `p15_${RUN}_a`,
      max_tokens: 50,
    })
    .select("id")
    .single();
  assertEquals(sAErr, null);
  assertExists(sA);
  const sessionA = sA.id as string;

  const bookingBase = {
    hospital_id: hospitalA,
    queue_session_id: sessionA,
    assigned_doctor_id: docD,
    appointment_date: TODAY,
    booking_source: "walkin" as const,
  };

  const waitIds: string[] = [];
  for (let i = 1; i <= 2; i++) {
    const { data, error } = await db
      .from("bookings")
      .insert({
        ...bookingBase,
        patient_name: `P15 ${RUN} W${i}`,
        patient_phone: `94${RUN}000${i}`,
        token_number: i,
        status: "waiting",
      })
      .select("id")
      .single();
    assertEquals(error, null);
    assertExists(data);
    waitIds.push(data.id as string);
  }

  const { data: cb, error: cbErr } = await db
    .from("bookings")
    .insert({
      ...bookingBase,
      patient_name: `P15 ${RUN} C1`,
      patient_phone: `94${RUN}0009`,
      token_number: 3,
      status: "completed",
      checked_in_at: minsAgo(35),
      consultation_started_at: minsAgo(25),
      consultation_completed_at: minsAgo(13),
      platform_fee_snapshot: 50,
      receptionist_fee_snapshot: 50,
      hospital_fee_snapshot: 400,
      total_amount_snapshot: 500,
    })
    .select("id")
    .single();
  assertEquals(cbErr, null);
  assertExists(cb);
  const completedBooking = cb.id as string;

  // Hospital B: broadcast session with two waiting patients.
  const { data: sB, error: sBErr } = await db
    .from("queue_sessions")
    .insert({
      hospital_id: hospitalB,
      doctor_id: docB,
      session_date: TODAY,
      session_name: `p15_${RUN}_b`,
      max_tokens: 50,
    })
    .select("id")
    .single();
  assertEquals(sBErr, null);
  assertExists(sB);
  const sessionB = sB.id as string;

  for (let i = 1; i <= 2; i++) {
    const { error } = await db.from("bookings").insert({
      hospital_id: hospitalB,
      queue_session_id: sessionB,
      assigned_doctor_id: docB,
      appointment_date: TODAY,
      booking_source: "walkin",
      patient_name: `P15 ${RUN} B${i}`,
      patient_phone: `93${RUN}000${i}`,
      token_number: i,
      status: "waiting",
    });
    assertEquals(error, null);
  }

  // Financial source data (exact amounts for reconciliation).
  // D16 (Q3/Q4, migration 59): the completed booking was never payment
  // -captured, so its trigger-written DCE row is a zero-value placeholder.
  // The manual online entry below is the only money SETURA collected.
  const dceA2 = {
    hospital_id: hospitalA,
    collection_date: TODAY,
    booking_source: "online" as const,
    total_amount: 300,
    platform_fee: 30,
    hospital_fee: 250,
    receptionist_fee: 20,
  };
  const { error: dceAErr } = await db
    .from("daily_collection_entries")
    .insert(dceA2);
  assertEquals(dceAErr, null);

  const { error: dceBErr } = await db
    .from("daily_collection_entries")
    .insert({
      hospital_id: hospitalB,
      collection_date: TODAY,
      booking_source: "walkin",
      total_amount: 700,
      platform_fee: 70,
      hospital_fee: 580,
      receptionist_fee: 50,
    });
  assertEquals(dceBErr, null);

  // Patient-facing broadcasts are flag-gated: enable only at B.
  // Explicitly disable at A (global flag is enabled by default).
  const { error: flagAErr } = await db.from("feature_flags").insert({
    hospital_id: hospitalA,
    flag_key: "whatsapp_queue_updates",
    is_enabled: false,
  });
  assertEquals(flagAErr, null);
  const { error: flagErr } = await db.from("feature_flags").insert({
    hospital_id: hospitalB,
    flag_key: "whatsapp_queue_updates",
    is_enabled: true,
  });
  assertEquals(flagErr, null);

  F = {
    hospitalA,
    hospitalB,
    adminA,
    adminB,
    recepA,
    globalAdmin,
    docD,
    docB,
    sessionA,
    sessionB,
    completedBooking,
    broadcastKeys: [],
  };
});

// ─── 1. Command center overview ─────────────────────────────────────────────

Deno.test("ent: command center overview is exact against fixtures", async () => {
  const f = fx();
  const overview = await rpc("get_hospital_command_center", {
    p_hospital_id: f.hospitalA,
    p_date: TODAY,
  }) as Record<string, unknown>;

  assertEquals(overview.hospital_id, f.hospitalA);

  const patients = overview.patients as Record<string, unknown>;
  assertEquals(patients.total_today, 3);
  assertEquals(patients.waiting, 2);
  assertEquals(patients.completed, 1);
  assertEquals(patients.cancelled, 0);
  assertEquals(patients.no_shows, 0);
  assertEquals(Number(patients.avg_wait_minutes), 10);
  assertEquals(Number(patients.avg_consultation_minutes), 12);

  const queues = overview.queues as Record<string, unknown>;
  assertEquals(queues.active_sessions, 1);
  const availability = queues.doctor_availability as unknown[];
  assertEquals(availability.length, 1);

  // Finance of the day mirrors the DCE fixture exactly (D16: only the
  // captured/manual rows carry money; see the fixture comment above).
  const finance = overview.finance as Record<string, unknown>;
  assertEquals(Number(finance.revenue_today), 300);
  assertEquals(Number(finance.platform_fee_today), 30);
  assertEquals(Number(finance.refunds_today), 0);
});

Deno.test("ent: operational scores stay within 0-100 bounds", async () => {
  const f = fx();
  const scores = await rpc("get_operational_scores", {
    p_hospital_id: f.hospitalA,
    p_date: TODAY,
  }) as Record<string, unknown>;

  for (
    const key of [
      "congestion_score",
      "delay_score",
      "risk_score",
      "health_score",
      "patient_experience_score",
    ]
  ) {
    const v = Number(scores[key]);
    assert(v >= 0 && v <= 100, `${key} out of bounds: ${v}`);
  }

  const inputs = scores.inputs as Record<string, unknown>;
  assertEquals(inputs.waiting, 2);
  assertEquals(inputs.active_sessions, 1);
});

// ─── 2. Operational timeline ────────────────────────────────────────────────

Deno.test("ent: timeline streams fired alerts with filters and isolation", async () => {
  const { db } = await ctx();
  const f = fx();

  const key = `p15_tl_${RUN}`;
  const alertId = await rpc("fire_managed_alert", {
    p_hospital_id: f.hospitalA,
    p_alert_key: key,
    p_severity: "warning",
    p_current_value: 10,
    p_threshold_value: 5,
    p_threshold_unit: "count",
    p_message: `timeline test ${RUN}`,
  });
  assertExists(alertId);
  f.broadcastKeys.push(key);

  const timeline = await rpc("get_hospital_timeline", {
    p_hospital_id: f.hospitalA,
    p_from_ts: RUN_START,
    p_to_ts: new Date(Date.now() + 60_000).toISOString(),
    p_event_types: [key],
  }) as Record<string, unknown>;

  const events = timeline.events as Array<Record<string, unknown>>;
  assertEquals(events.length, 1);
  assertEquals(events[0].event_type, key);
  assertEquals(events[0].category, "alert");
  assertEquals(events[0].severity, "warning");

  // Severity filter drops info-only views of the same window.
  const critOnly = await rpc("get_hospital_timeline", {
    p_hospital_id: f.hospitalA,
    p_from_ts: RUN_START,
    p_to_ts: new Date(Date.now() + 60_000).toISOString(),
    p_severity: "critical",
  }) as Record<string, unknown>;
  const critEvents = critOnly.events as Array<Record<string, unknown>>;
  assertEquals(
    critEvents.filter((e) => e.event_type === key).length,
    0,
  );

  // Tenant isolation: hospital B never sees hospital A's alert.
  const timelineB = await rpc("get_hospital_timeline", {
    p_hospital_id: f.hospitalB,
    p_from_ts: RUN_START,
    p_to_ts: new Date(Date.now() + 60_000).toISOString(),
  }) as Record<string, unknown>;
  const eventsB = timelineB.events as Array<Record<string, unknown>>;
  assertEquals(eventsB.filter((e) => e.event_type === key).length, 0);

  // Cleanup keeps hospital A alert-free so the residue is inert.
  const { error } = await db.from("alert_events").delete().eq("id", alertId);
  assertEquals(error, null);
});

// ─── 3. Executive dashboards ────────────────────────────────────────────────

Deno.test("ent: daily / weekly / monthly dashboards return shaped data", async () => {
  const f = fx();

  const daily = await rpc("get_daily_operations_dashboard", {
    p_hospital_id: f.hospitalA,
    p_date: TODAY,
  }) as Record<string, unknown>;
  assertEquals(daily.hospital_id, f.hospitalA);
  for (const key of ["hourly_trend", "operations", "sla"]) {
    assert(key in daily, `daily dashboard missing ${key}`);
  }

  const weekly = await rpc("get_weekly_dashboard", {
    p_hospital_id: f.hospitalA,
    p_week_start: TODAY,
  }) as Record<string, unknown>;
  assertEquals(weekly.week_start, TODAY);
  assert("rollup" in weekly);
  assert("incidents" in weekly);
  const productivity = weekly.doctor_productivity as Array<
    Record<string, unknown>
  >;
  assertEquals(productivity.length, 1);
  assertEquals(productivity[0].doctor_id, f.docD);
  assertEquals(Number(productivity[0].completed), 1);

  const monthly = await rpc("get_monthly_dashboard", {
    p_hospital_id: f.hospitalA,
    p_month_start: `${TODAY.slice(0, 8)}01`,
  }) as Record<string, unknown>;
  assert("rollup" in monthly);
  assert(Array.isArray(monthly.sla_trend));
  const settlements = monthly.settlements as Record<string, unknown>;
  assertEquals(Number(settlements.created), 0);
});

// ─── 4. Doctor performance intelligence ─────────────────────────────────────

Deno.test("ent: doctor performance and rankings match fixture bookings", async () => {
  const f = fx();

  const perf = await rpc("get_doctor_performance", {
    p_doctor_id: f.docD,
    p_hospital_id: f.hospitalA,
    p_from_date: TODAY,
    p_to_date: TODAY,
  }) as Record<string, unknown>;
  assertEquals(perf.doctor_id, f.docD);

  const metrics = perf.metrics as Record<string, unknown>;
  assertEquals(Number(metrics.consultations_completed), 1);
  assertEquals(Number(metrics.total_assigned), 3);
  assertEquals(Number(metrics.patients_seen), 1);
  assertEquals(Number(metrics.avg_consultation_minutes), 12);
  assertEquals(Number(metrics.avg_wait_caused_minutes), 10);
  assertEquals(Number(metrics.completion_rate_pct), 33.3);

  const utilization = perf.session_utilization as Record<string, unknown>;
  assertEquals(utilization.sessions, 1);
  assertEquals(utilization.capacity, 50);

  const rankings = await rpc("get_doctor_rankings", {
    p_hospital_id: f.hospitalA,
    p_from_date: TODAY,
    p_to_date: TODAY,
  }) as Record<string, unknown>;
  const rows = rankings.rankings as Array<Record<string, unknown>>;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].doctor_id, f.docD);
  assertEquals(Number(rows[0].throughput_rank), 1);
});

// ─── 5. Financial command center ────────────────────────────────────────────

Deno.test("ent: financial command center reconciles exactly", async () => {
  const f = fx();

  const fin = await rpc("get_financial_command_center", {
    p_hospital_id: f.hospitalA,
    p_date: TODAY,
  }) as Record<string, unknown>;

  const dc = fin.daily_collections as Record<string, unknown>;
  // D16 (Q4, migration 59): revenue appears only at capture. Hospital A's
  // completed walk-in booking was never captured, so its DCE placeholder
  // contributes 0; only the manual online entry (300) carries money.
  assertEquals(Number(dc.total_collected), 300);
  assertEquals(Number(dc.platform_fee), 30);
  assertEquals(Number(dc.hospital_fee), 250);
  assertEquals(Number(dc.receptionist_fee), 20);
  assertEquals(Number(dc.refunds), 0);
  assertEquals(Number(dc.net_collections), 300);

  // Payment-count semantics after decision D-3 (migration 49):
  // online_payments / offline_payments count entries that actually
  // carried money, not DCE rows. Hospital A has FOUR DCE rows today --
  // three written by trg_auto_create_collection (one per booking) plus
  // one manual online entry -- but only the manual online entry carries
  // a non-zero total_amount: under D16 the uncaptured completed walk-in
  // booking is a zero placeholder, and the two waiting bookings never
  // paid. So exactly one payment is counted.
  assertEquals(dc.online_payments, 1);
  assertEquals(dc.offline_payments, 0);

  const si = fin.settlement_intelligence as Record<string, unknown>;
  assertEquals(Number(si.outstanding_balance), 0);
  const buckets = si.aging_buckets as Record<string, unknown>;
  for (const bucket of ["current", "overdue_8_30", "overdue_31_plus"]) {
    assertEquals(Number(buckets[bucket]), 0);
  }

  assertExists(fin.reconciliation);
});

Deno.test("ent: revenue forecast is deterministic", async () => {
  const f = fx();
  const args = { p_hospital_id: f.hospitalA, p_date: TODAY };
  const first = await rpc("get_revenue_forecast", args);
  const second = await rpc("get_revenue_forecast", args);
  assertEquals(JSON.stringify(first), JSON.stringify(second));
  assertExists(first);
});

Deno.test("ent: financial isolation between tenants", async () => {
  const f = fx();

  const finA = await rpc("get_financial_command_center", {
    p_hospital_id: f.hospitalA,
    p_date: TODAY,
  }) as Record<string, unknown>;
  const finB = await rpc("get_financial_command_center", {
    p_hospital_id: f.hospitalB,
    p_date: TODAY,
  }) as Record<string, unknown>;

  const dcA = finA.daily_collections as Record<string, unknown>;
  const dcB = finB.daily_collections as Record<string, unknown>;
  assertEquals(Number(dcA.total_collected), 300);
  assertEquals(Number(dcB.total_collected), 700);
});

// ─── 6. SLA + predictive ────────────────────────────────────────────────────

Deno.test("ent: SLA dashboard and predictive insights return shaped data", async () => {
  const f = fx();

  const sla = await rpc("get_sla_dashboard", {
    p_hospital_id: f.hospitalA,
    p_date: TODAY,
  }) as Record<string, unknown>;
  const summary = sla.summary as Record<string, unknown>;
  for (const key of ["tracked", "in_breach"]) {
    assert(key in summary, `sla summary missing ${key}`);
  }
  assert(Array.isArray(sla.hospitals_in_breach));
  assert(Array.isArray(sla.trend_14d));

  const predictions = await rpc("get_predictive_insights", {
    p_hospital_id: f.hospitalA,
    p_date: TODAY,
  }) as Record<string, unknown>;
  assertEquals(predictions.hospital_id, f.hospitalA);
});

// ─── 7. Alert lifecycle ─────────────────────────────────────────────────────

Deno.test("ent: alert dedupe, acknowledge, assign, escalate, resolve", async () => {
  const { db } = await ctx();
  const f = fx();
  const key = `p15_lc_${RUN}`;
  f.broadcastKeys.push(key);

  const alertArgs = {
    p_hospital_id: f.hospitalA,
    p_alert_key: key,
    p_severity: "warning",
    p_current_value: 20,
    p_threshold_value: 10,
    p_threshold_unit: "minutes",
    p_message: `lifecycle test ${RUN}`,
  };

  // Fire + 1-hour dedupe window returns the same alert.
  const id1 = await rpc("fire_managed_alert", alertArgs);
  assertExists(id1);
  const id2 = await rpc("fire_managed_alert", alertArgs);
  assertEquals(id2, id1);

  // Acknowledge is idempotent.
  const ack1 = await rpc("acknowledge_alert", {
    p_alert_id: id1,
    p_actor_id: f.adminA.userId,
  }) as Record<string, unknown>;
  assertEquals(ack1.ok, true);
  assertEquals(ack1.already_acknowledged, false);
  const ack2 = await rpc("acknowledge_alert", {
    p_alert_id: id1,
    p_actor_id: f.adminA.userId,
  }) as Record<string, unknown>;
  assertEquals(ack2.already_acknowledged, true);

  // Assign.
  const assign = await rpc("assign_alert", {
    p_alert_id: id1,
    p_assignee_id: f.adminB.userId,
    p_actor_id: f.adminA.userId,
  }) as Record<string, unknown>;
  assertEquals(assign.ok, true);
  assertEquals(assign.already_assigned, false);

  // Escalate bumps severity to critical, once.
  const esc = await rpc("escalate_alert", {
    p_alert_id: id1,
    p_actor_id: f.adminA.userId,
    p_notes: `escalated by test ${RUN}`,
  }) as Record<string, unknown>;
  assertEquals(esc.ok, true);
  const esc2 = await rpc("escalate_alert", {
    p_alert_id: id1,
    p_actor_id: f.adminA.userId,
  }) as Record<string, unknown>;
  assertEquals(esc2.already_escalated, true);

  const { data: row, error: rowErr } = await db
    .from("alert_events")
    .select("severity, assigned_to, acknowledged_at, escalated_at")
    .eq("id", id1)
    .single();
  assertEquals(rowErr, null);
  assertExists(row);
  assertEquals(row.severity, "critical");
  assertEquals(row.assigned_to, f.adminB.userId);
  assertExists(row.acknowledged_at);
  assertExists(row.escalated_at);

  // Resolve records notes; repeats are idempotent.
  const res1 = await rpc("resolve_alert", {
    p_alert_id: id1,
    p_actor_id: f.adminA.userId,
    p_notes: `resolved by test ${RUN}`,
  }) as Record<string, unknown>;
  assertEquals(res1.ok, true);
  assertEquals(res1.already_resolved, false);
  const res2 = await rpc("resolve_alert", {
    p_alert_id: id1,
    p_actor_id: f.adminA.userId,
  }) as Record<string, unknown>;
  assertEquals(res2.already_resolved, true);

  const { data: resolvedRow, error: resErr } = await db
    .from("alert_events")
    .select("is_resolved, resolution_notes")
    .eq("id", id1)
    .single();
  assertEquals(resErr, null);
  assertExists(resolvedRow);
  assertEquals(resolvedRow.is_resolved, true);
  assertEquals(resolvedRow.resolution_notes, `resolved by test ${RUN}`);

  // Resolved alerts no longer dedupe: a refire creates a new row.
  const id3 = await rpc("fire_managed_alert", alertArgs);
  assertExists(id3);
  assert(id3 !== id1, "refire after resolve must create a new alert");

  // Unknown alerts report structured failures, never exceptions.
  const missing = crypto.randomUUID();
  const ackMissing = await rpc("acknowledge_alert", {
    p_alert_id: missing,
    p_actor_id: f.adminA.userId,
  }) as Record<string, unknown>;
  assertEquals(ackMissing.ok, false);
  assertEquals(ackMissing.reason, "alert_not_found");
});

// ─── 7b. C2 locked-snapshot concurrency (two real RPC connections) ──────────
//
// These are genuine two-connection tests: each parallel db.rpc(...) is served
// by PostgREST on its OWN backend database session, so two in-flight RPCs
// really contend on the alert row's FOR UPDATE lock. No case simulates
// concurrency by issuing sequential calls on a single connection.
//
// They are self-contained (own tenant + alert + cleanup) so they can be run in
// isolation with `--filter "c2:"`. They assert the approved OD-d=D1 semantics:
// post-resolve ACK/ASSIGN/ESCALATE remain PERMITTED, so cases 1/2 expect BOTH
// fields to persist (a D2 expectation would be wrong here).

interface C2Tenant {
  hospital: string;
  actor: string;
}

async function c2MkTenant(tag: string): Promise<C2Tenant> {
  const { db } = await ctx();
  const { data: h, error: hErr } = await db
    .from("hospitals")
    .insert({ name: `C2 ${tag} ${RUN}`, slug: `c2-${tag}-${RUN}` })
    .select("id")
    .single();
  assertEquals(hErr, null);
  assertExists(h);
  const hospital = h.id as string;

  const actor = crypto.randomUUID();
  await createAuthUser(actor, `c2-${tag}-${RUN}@setura.test`);
  const { error: pErr } = await db.from("profiles").upsert({
    id: actor,
    full_name: `C2 ${tag} ${RUN}`,
    normalized_phone: `97${RUN}${String(C2_SEQ++).padStart(2, "0")}`,
  });
  assertEquals(pErr, null);
  const { error: rErr } = await db.from("user_roles").insert({
    user_id: actor,
    hospital_id: hospital,
    role: "hospital_admin",
    is_primary: true,
  });
  assertEquals(rErr, null);
  return { hospital, actor };
}

async function c2Cleanup(t: C2Tenant): Promise<void> {
  const { db } = await ctx();
  await db.from("alert_events").delete().eq("hospital_id", t.hospital);
  await db.from("user_roles").delete().eq("user_id", t.actor);
  await db.from("profiles").delete().eq("id", t.actor);
  await deleteAuthUser(t.actor);
  await db.from("hospitals").delete().eq("id", t.hospital);
}

async function c2MkAlert(
  t: C2Tenant,
  key: string,
): Promise<string> {
  const id = await rpc("fire_managed_alert", {
    p_hospital_id: t.hospital,
    p_alert_key: key,
    p_severity: "warning",
    p_current_value: 20,
    p_threshold_value: 10,
    p_threshold_unit: "minutes",
    p_message: `c2 concurrency ${RUN} ${key}`,
  });
  assert(typeof id === "string", "fire_managed_alert must return an id");
  return id as string;
}

async function c2Actions(alertId: string): Promise<string[]> {
  const { db } = await ctx();
  const { data, error } = await db
    .from("alert_activity_log")
    .select("action")
    .eq("alert_id", alertId);
  assertEquals(error, null);
  return (data ?? []).map((r: { action: string }) => r.action);
}

async function c2Row(
  alertId: string,
  cols: string,
): Promise<Record<string, unknown>> {
  const { db } = await ctx();
  const { data, error } = await db
    .from("alert_events")
    .select(cols)
    .eq("id", alertId)
    .single();
  assertEquals(error, null);
  assertExists(data);
  return data as unknown as Record<string, unknown>;
}

async function c2RpcCall(
  db: DbClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<{ data: Record<string, unknown>; error: unknown }> {
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (db.rpc as any)(fn, args);
  return { data: (data ?? {}) as Record<string, unknown>, error };
}

const SNAPSHOT_COLS =
  "id, hospital_id, acknowledged_at, acknowledged_by, assigned_to, escalated_at, escalated_by, is_resolved, resolved_at, resolved_by, severity";

let C2_SEQ = 0;

Deno.test("c2: concurrency case 1 RESOLVE || ACKNOWLEDGE both persist (D1)", async () => {
  const { db } = await ctx();
  const t = await c2MkTenant("cc1");
  try {
    const id = await c2MkAlert(t, `c2cc1_${RUN}`);
    const [res, ack] = await Promise.all([
      c2RpcCall(db, "resolve_alert", {
        p_alert_id: id,
        p_actor_id: t.actor,
      }),
      c2RpcCall(db, "acknowledge_alert", {
        p_alert_id: id,
        p_actor_id: t.actor,
      }),
    ]);
    assertEquals(res.error, null);
    assertEquals(ack.error, null);
    // Both are REAL transitions under D1 (no post-resolve rejection).
    assertEquals(res.data.ok, true);
    assertEquals(res.data.already_resolved, false);
    assertEquals(ack.data.ok, true);
    assertEquals(ack.data.already_acknowledged, false);

    const row = await c2Row(id, SNAPSHOT_COLS);
    assertEquals(row.is_resolved, true);
    assertExists(row.acknowledged_at);

    const acts = await c2Actions(id);
    assertEquals(acts.length, 2, "no lost update: both transitions logged");
    assert(acts.includes("resolved"));
    assert(acts.includes("acknowledged"));

    // Locked snapshot truthfulness (not mere key presence).
    const resBefore = res.data.before as Record<string, unknown>;
    const resAfter = res.data.after as Record<string, unknown>;
    const ackBefore = ack.data.before as Record<string, unknown>;
    const ackAfter = ack.data.after as Record<string, unknown>;
    assertEquals(resBefore.is_resolved, false);
    assertEquals(resAfter.is_resolved, true);
    assertEquals(ackBefore.acknowledged_at, null);
    assertExists(ackAfter.acknowledged_at);
  } finally {
    await c2Cleanup(t);
  }
});

Deno.test("c2: concurrency case 2 RESOLVE || ESCALATE both persist (D1)", async () => {
  const { db } = await ctx();
  const t = await c2MkTenant("cc2");
  try {
    const id = await c2MkAlert(t, `c2cc2_${RUN}`);
    const [res, esc] = await Promise.all([
      c2RpcCall(db, "resolve_alert", { p_alert_id: id, p_actor_id: t.actor }),
      c2RpcCall(db, "escalate_alert", { p_alert_id: id, p_actor_id: t.actor }),
    ]);
    assertEquals(res.error, null);
    assertEquals(esc.error, null);
    assertEquals(res.data.already_resolved, false);
    assertEquals(esc.data.already_escalated, false);

    const row = await c2Row(id, SNAPSHOT_COLS);
    assertEquals(row.is_resolved, true);
    assertExists(row.escalated_at);
    assertEquals(row.severity, "critical");

    const acts = await c2Actions(id);
    assertEquals(acts.length, 2);
    assert(acts.includes("resolved"));
    assert(acts.includes("escalated"));

    assertEquals(
      (res.data.before as Record<string, unknown>).is_resolved,
      false,
    );
    assertEquals((res.data.after as Record<string, unknown>).is_resolved, true);
    assertEquals(
      (esc.data.before as Record<string, unknown>).escalated_at,
      null,
    );
    assertEquals(
      (esc.data.after as Record<string, unknown>).severity,
      "critical",
    );
  } finally {
    await c2Cleanup(t);
  }
});

Deno.test("c2: concurrency case 3 RESOLVE || RESOLVE -> one real transition", async () => {
  const { db } = await ctx();
  const t = await c2MkTenant("cc3");
  try {
    const id = await c2MkAlert(t, `c2cc3_${RUN}`);
    const [a, b] = await Promise.all([
      c2RpcCall(db, "resolve_alert", { p_alert_id: id, p_actor_id: t.actor }),
      c2RpcCall(db, "resolve_alert", { p_alert_id: id, p_actor_id: t.actor }),
    ]);
    assertEquals(a.error, null);
    assertEquals(b.error, null);
    const reals = [a, b].filter((r) => r.data.already_resolved === false);
    const softs = [a, b].filter((r) => r.data.already_resolved === true).length;
    assertEquals(reals.length, 1, "exactly one real resolve transition");
    assertEquals(softs, 1, "exactly one already_resolved soft-success");
    // Soft-success path preserves the existing contract (no snapshot).
    const soft = [a, b].find((r) => r.data.already_resolved === true)!;
    assert(!("before" in soft.data) && !("after" in soft.data));

    const row = await c2Row(id, SNAPSHOT_COLS);
    assertEquals(row.is_resolved, true);
    assertEquals((await c2Actions(id)).length, 1);
  } finally {
    await c2Cleanup(t);
  }
});

Deno.test("c2: concurrency case 4 ESCALATE || ESCALATE -> one real transition", async () => {
  const { db } = await ctx();
  const t = await c2MkTenant("cc4");
  try {
    const id = await c2MkAlert(t, `c2cc4_${RUN}`);
    const [a, b] = await Promise.all([
      c2RpcCall(db, "escalate_alert", { p_alert_id: id, p_actor_id: t.actor }),
      c2RpcCall(db, "escalate_alert", { p_alert_id: id, p_actor_id: t.actor }),
    ]);
    assertEquals(a.error, null);
    assertEquals(b.error, null);
    const reals = [a, b].filter((r) => r.data.already_escalated === false);
    assertEquals(reals.length, 1);
    assertEquals(
      [a, b].filter((r) => r.data.already_escalated === true).length,
      1,
    );

    const row = await c2Row(id, SNAPSHOT_COLS);
    assertExists(row.escalated_at);
    assertEquals(row.severity, "critical");
    assertEquals((await c2Actions(id)).length, 1);
  } finally {
    await c2Cleanup(t);
  }
});

Deno.test("c2: concurrency case 5 ASSIGN X || ASSIGN Y -> serialized, no lost update", async () => {
  const { db } = await ctx();
  const t = await c2MkTenant("cc5");
  try {
    const id = await c2MkAlert(t, `c2cc5_${RUN}`);
    const x = crypto.randomUUID();
    const y = crypto.randomUUID();
    const [rx, ry] = await Promise.all([
      c2RpcCall(db, "assign_alert", {
        p_alert_id: id,
        p_assignee_id: x,
        p_actor_id: t.actor,
      }),
      c2RpcCall(db, "assign_alert", {
        p_alert_id: id,
        p_assignee_id: y,
        p_actor_id: t.actor,
      }),
    ]);
    assertEquals(rx.error, null);
    assertEquals(ry.error, null);
    // X != Y so both are distinct real transitions.
    assertEquals(rx.data.already_assigned, false);
    assertEquals(ry.data.already_assigned, false);

    const row = await c2Row(id, SNAPSHOT_COLS);
    assert(
      row.assigned_to === x || row.assigned_to === y,
      "last committed assignment is authoritative",
    );
    assertEquals((await c2Actions(id)).length, 2);

    // Serialized ordering: exactly one txn saw null; the other saw the first
    // txn's assignee (proof the second re-read under the held lock).
    const beforeX = (rx.data.before as Record<string, unknown>).assigned_to;
    const beforeY = (ry.data.before as Record<string, unknown>).assigned_to;
    const nulls = [beforeX, beforeY].filter((v) => v === null).length;
    assertEquals(nulls, 1, "exactly one assignment started from null");
    const seen = beforeX === null ? beforeY : beforeX;
    assert(
      seen === x || seen === y,
      "the serialized txn observed the first commit",
    );
  } finally {
    await c2Cleanup(t);
  }
});

Deno.test("c2: concurrency case 6 ACKNOWLEDGE || ACKNOWLEDGE -> one real transition", async () => {
  const { db } = await ctx();
  const t = await c2MkTenant("cc6");
  try {
    const id = await c2MkAlert(t, `c2cc6_${RUN}`);
    const [a, b] = await Promise.all([
      c2RpcCall(db, "acknowledge_alert", {
        p_alert_id: id,
        p_actor_id: t.actor,
      }),
      c2RpcCall(db, "acknowledge_alert", {
        p_alert_id: id,
        p_actor_id: t.actor,
      }),
    ]);
    assertEquals(a.error, null);
    assertEquals(b.error, null);
    assertEquals(
      [a, b].filter((r) => r.data.already_acknowledged === false).length,
      1,
    );
    assertEquals(
      [a, b].filter((r) => r.data.already_acknowledged === true).length,
      1,
    );

    const row = await c2Row(id, SNAPSHOT_COLS);
    assertExists(row.acknowledged_at);
    assertEquals((await c2Actions(id)).length, 1);
  } finally {
    await c2Cleanup(t);
  }
});

// ─── 7c. C2 rollback / failure injection ────────────────────────────────────
//
// Proves the atomicity invariant: if log_alert_activity fails, the UPDATE and
// the activity INSERT roll back together, leaving NO state change and NO
// activity row. The only reachable activity-log failure is injected with a
// scoped BEFORE-INSERT trigger (dropped immediately). A thrown error alone is
// not accepted — the test asserts the DB state AFTER the failure.

async function c2DbQuery(sql: string): Promise<void> {
  const cmd = new Deno.Command("docker", {
    args: [
      "exec",
      "supabase_db_setura",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(
      `docker psql failed (${code}): ${new TextDecoder().decode(stderr)}`,
    );
  }
}

Deno.test("c2: rollback — activity-log failure rolls back the state change", async () => {
  const { db } = await ctx();
  const t = await c2MkTenant("rbk");
  const id = await c2MkAlert(t, `c2rbk_${RUN}`);
  const trgFn = "public.c2_rb_raise()";
  const trg = "c2_rb_trg";
  try {
    await c2DbQuery(
      `CREATE OR REPLACE FUNCTION ${trgFn} RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected activity failure'; END $$;`,
    );
    await c2DbQuery(
      `CREATE TRIGGER ${trg} BEFORE INSERT ON public.alert_activity_log FOR EACH ROW WHEN (NEW.alert_id = '${id}') EXECUTE FUNCTION ${trgFn};`,
    );

    const ack = await c2RpcCall(db, "acknowledge_alert", {
      p_alert_id: id,
      p_actor_id: t.actor,
    });
    assert(ack.error !== null, "injected activity failure must abort the RPC");

    // State after failure: no acknowledged_at, no activity row (both rolled
    // back together — the transactional atomicity guarantee).
    const row = await c2Row(id, SNAPSHOT_COLS);
    assertEquals(row.acknowledged_at, null, "state change must roll back");
    assertEquals(
      (await c2Actions(id)).length,
      0,
      "activity row must roll back",
    );
  } finally {
    await c2DbQuery(
      `DROP TRIGGER IF EXISTS ${trg} ON public.alert_activity_log;`,
    );
    await c2DbQuery(`DROP FUNCTION IF EXISTS ${trgFn};`);
    await c2Cleanup(t);
  }
});

Deno.test("ent: suppression windows gate alert firing", async () => {
  const f = fx();
  const key = `p15_sup_${RUN}`;
  f.broadcastKeys.push(key);

  // Windows in the past are rejected.
  const past = await rpc("suppress_alerts", {
    p_alert_key: key,
    p_active_until: new Date(Date.now() - 60_000).toISOString(),
    p_actor_id: f.adminA.userId,
    p_hospital_id: f.hospitalA,
  }) as Record<string, unknown>;
  assertEquals(past.ok, false);
  assertEquals(past.reason, "window_in_past");

  // Active window: suppressed key fires to NULL.
  const window = await rpc("suppress_alerts", {
    p_alert_key: key,
    p_active_until: new Date(Date.now() + 3_600_000).toISOString(),
    p_actor_id: f.adminA.userId,
    p_hospital_id: f.hospitalA,
    p_reason: `maintenance ${RUN}`,
  }) as Record<string, unknown>;
  assertEquals(window.ok, true);
  assertExists(window.suppression_id);

  const suppressed = await rpc("fire_managed_alert", {
    p_hospital_id: f.hospitalA,
    p_alert_key: key,
    p_severity: "warning",
    p_current_value: 1,
    p_threshold_value: 0,
    p_threshold_unit: "count",
    p_message: `suppressed ${RUN}`,
  });
  assertEquals(suppressed, null);

  // Same key at a different hospital is unaffected (scoped window).
  const other = await rpc("fire_managed_alert", {
    p_hospital_id: f.hospitalB,
    p_alert_key: key,
    p_severity: "warning",
    p_current_value: 1,
    p_threshold_value: 0,
    p_threshold_unit: "count",
    p_message: `unscoped ${RUN}`,
  });
  assertExists(other);
});

Deno.test("ent: alert center listing and analytics are tenant-scoped", async () => {
  const { db } = await ctx();
  const f = fx();

  const key = `p15_ctr_${RUN}`;
  f.broadcastKeys.push(key);
  const alertId = await rpc("fire_managed_alert", {
    p_hospital_id: f.hospitalA,
    p_alert_key: key,
    p_severity: "warning",
    p_current_value: 5,
    p_threshold_value: 2,
    p_threshold_unit: "count",
    p_message: `center test ${RUN}`,
  });
  assertExists(alertId);

  // get_alert_center returns an OBJECT, not an array: migration 47
  // builds jsonb_build_object('alerts', <array>, 'counts', <object>).
  // This test used to assert Array.isArray on the envelope, which is a
  // wrong assertion about a correct implementation.
  const center = await rpc("get_alert_center", {
    p_hospital_id: f.hospitalA,
    p_status: "open",
  }) as Record<string, unknown>;
  assertExists(center);

  const alerts = center.alerts as Array<Record<string, unknown>>;
  assert(Array.isArray(alerts), "center.alerts must be an array");
  assert(
    alerts.map((a) => a.alert_key).includes(key),
    "open alert missing from alert center",
  );

  // Tenant scoping is the point of this test: every row belongs to A.
  for (const a of alerts) {
    assertEquals(a.hospital_id, f.hospitalA, "alert center leaked a tenant");
  }

  // counts is a sibling object, and the alert fired above is open.
  const counts = center.counts as Record<string, unknown>;
  assertExists(counts);
  assertGreater(Number(counts.open), 0);

  const analytics = await rpc("get_alert_analytics", {
    p_hospital_id: f.hospitalA,
    p_from_date: TODAY,
    p_to_date: TODAY,
  }) as Record<string, unknown>;
  assertExists(analytics);

  // Resolve + delete keeps hospital A's alert residue inert.
  await rpc("resolve_alert", {
    p_alert_id: alertId,
    p_actor_id: f.adminA.userId,
  });
  const { error } = await db.from("alert_events").delete().eq("id", alertId);
  assertEquals(error, null);
});

// ─── 8. Portfolio + benchmarks ──────────────────────────────────────────────

Deno.test("ent: portfolio and benchmarks aggregate both tenants", async () => {
  const f = fx();

  const portfolio = await rpc("get_portfolio_dashboard", {
    p_date: TODAY,
  }) as Record<string, unknown>;
  assertGreater(Number(portfolio.total_hospitals), 1);
  const hospitals = portfolio.hospitals as Array<Record<string, unknown>>;
  const rowA = hospitals.find((h) => h.hospital_id === f.hospitalA);
  const rowB = hospitals.find((h) => h.hospital_id === f.hospitalB);
  assertExists(rowA);
  assertExists(rowB);
  assertEquals(Number(rowA.bookings_today), 3);
  assertEquals(Number(rowA.revenue_today), 300);
  assertEquals(Number(rowB.revenue_today), 700);

  const benchmarks = await rpc("get_cross_hospital_benchmarks", {
    p_from_date: TODAY,
    p_to_date: TODAY,
  }) as Record<string, unknown>;
  const rows = benchmarks.benchmarks as Array<Record<string, unknown>>;
  const benchA = rows.find((b) => b.hospital_id === f.hospitalA);
  assertExists(benchA);
  assertEquals(Number(benchA.bookings), 3);
  assertEquals(Number(benchA.completed), 1);
  assertEquals(Number(benchA.avg_consultation_minutes), 12);
  assertEquals(Number(benchA.revenue_inr), 300);
});

// ─── 9. Reporting engine ────────────────────────────────────────────────────

Deno.test("ent: report engine supports all 8 report types", async () => {
  const f = fx();
  const types = [
    "daily_hospital",
    "weekly_operations",
    "monthly_executive",
    "doctor_performance",
    "financial",
    "settlement",
    "sla",
    "audit",
  ];

  for (const reportType of types) {
    const payload = await rpc("generate_executive_report", {
      p_report_type: reportType,
      p_hospital_id: f.hospitalA,
      p_from_date: TODAY,
      p_to_date: TODAY,
    }) as Record<string, unknown>;
    assertEquals(payload.ok, true, `${reportType} should succeed`);
    assertEquals(payload.report_type, reportType);
    assertEquals(payload.hospital_id, f.hospitalA);
    assert(
      ((payload.columns as unknown[]) ?? []).length > 0,
      `${reportType} should declare columns`,
    );
    assertExists(payload.data, `${reportType} should carry data`);
    assertExists(payload.generated_at);
  }

  // Financial report embeds the forecast section.
  const financial = await rpc("generate_executive_report", {
    p_report_type: "financial",
    p_hospital_id: f.hospitalA,
    p_from_date: TODAY,
    p_to_date: TODAY,
  }) as Record<string, unknown>;
  const finData = financial.data as Record<string, unknown>;
  assert("daily_collections" in finData);
  assert("forecast" in finData);

  const unknown = await rpc("generate_executive_report", {
    p_report_type: "not_a_report",
    p_hospital_id: f.hospitalA,
    p_from_date: TODAY,
    p_to_date: TODAY,
  }) as Record<string, unknown>;
  assertEquals(unknown.ok, false);
  assertEquals(unknown.reason, "unknown_report_type");
  assertEquals((unknown.supported as unknown[]).length, 8);
});

// ─── 10. Governance & compliance ────────────────────────────────────────────

Deno.test("ent: integrity verification RPCs pass on fixture data", async () => {
  const f = fx();

  const audit = await rpc("verify_audit_integrity", {
    p_hospital_id: f.hospitalA,
    p_from_ts: RUN_START,
  }) as Record<string, unknown>;
  assertEquals(audit.ok, true);
  assertEquals(audit.orphan_actors, 0);
  assertEquals(audit.unknown_action_types, 0);

  const settlement = await rpc("verify_settlement_integrity", {
    p_hospital_id: f.hospitalA,
  }) as Record<string, unknown>;
  assertEquals(settlement.ok, true);

  const queue = await rpc("verify_queue_integrity", {
    p_queue_session_id: f.sessionA,
  }) as Record<string, unknown>;
  assertEquals(queue.ok, true);
  assertEquals(queue.cross_hospital_bookings, 0);
  assertEquals(queue.duplicate_tokens, 0);
  assertEquals(queue.parallel_consultations, 0);

  const docOps = await rpc("verify_doctor_operations_integrity", {
    p_doctor_id: f.docD,
    p_date: TODAY,
  }) as Record<string, unknown>;
  assertEquals(docOps.ok, true);

  const matrix = await rpc("verify_integration_matrix", {
    p_hospital_id: f.hospitalA,
    p_date: TODAY,
  }) as Record<string, unknown>;
  assertEquals(matrix.ok, true);
  assertEquals(matrix.collections_without_booking, 0);
  assertEquals(matrix.ledger_without_source, 0);
});

Deno.test("ent: executive audit search filters by action and actor", async () => {
  const { db } = await ctx();
  const f = fx();

  // Seed one accountable audit row via the registered writer.
  //
  // Two things this fixture must get right, both of which it used to
  // get wrong:
  //   - p_severity is public.audit_action_severity, whose members are
  //     low / medium / high / critical. "info" belongs to the OTHER
  //     enum, alert_severity_level, and fails the cast.
  //   - the action type must be one actually registered in
  //     audit_action_types. "admin_action" is registered nowhere
  //     (migrations 36/39/45/46/47), so the row carried an action type
  //     the audit taxonomy does not know. CONFIG_UPDATE is registered
  //     (migration 36, category 'configuration') and no RPC writes it,
  //     which keeps the cross-tenant assertion below deterministic.
  const { error: wErr } = await db.rpc("write_audit_log", {
    p_hospital_id: f.hospitalA,
    p_actor_id: f.adminA.userId,
    p_entity_type: "test_fixture",
    p_action: AUDIT_FIXTURE_ACTION,
    p_severity: "medium",
    p_new_data: { run: RUN },
    p_notes: `p15 audit search fixture ${RUN}`,
  });
  assertEquals(wErr, null);

  const results = await rpc("search_audit_logs", {
    p_hospital_id: f.hospitalA,
    p_action_type: AUDIT_FIXTURE_ACTION,
    p_from_ts: RUN_START,
  }) as Record<string, unknown>;
  const entries = results.entries as Array<Record<string, unknown>>;
  assertGreater(entries.length, 0);
  assertEquals(entries[0].entity_type, "test_fixture");

  const byActor = await rpc("search_audit_logs", {
    p_hospital_id: f.hospitalA,
    p_actor_id: f.adminA.userId,
    p_from_ts: RUN_START,
  }) as Record<string, unknown>;
  assertGreater(
    (byActor.entries as unknown[]).length,
    0,
  );

  // Tenant isolation: hospital B sees none of A's audit trail.
  const crossTenant = await rpc("search_audit_logs", {
    p_hospital_id: f.hospitalB,
    p_action_type: AUDIT_FIXTURE_ACTION,
    p_from_ts: RUN_START,
  }) as Record<string, unknown>;
  assertEquals((crossTenant.entries as unknown[]).length, 0);
});

// ─── 11. WhatsApp operational broadcasts ────────────────────────────────────

Deno.test("ent: broadcasts respect flag gating and idempotency", async () => {
  const { db } = await ctx();
  const logger = await testLogger();
  const broadcasts = await import(
    "../../supabase/functions/_shared/enterprise/broadcasts.ts"
  );
  const f = fx();

  // Flag off at hospital A → queue summary is a no-op.
  const gated = await broadcasts.broadcastQueueSummary(
    db,
    { id: f.sessionA, hospital_id: f.hospitalA, current_live_token: 0 },
    logger,
  );
  assertEquals(gated, 0);

  // Flag on at hospital B → one message per queue-active patient.
  const enqueued = await broadcasts.broadcastQueueSummary(
    db,
    { id: f.sessionB, hospital_id: f.hospitalB, current_live_token: 0 },
    logger,
  );
  assertEquals(enqueued, 2);

  // Deterministic keys: repeating the identical broadcast adds nothing.
  const { count: afterFirst } = await db
    .from("job_queue")
    .select("id", { count: "exact", head: true })
    .like("idempotency_key", `wa_q_summary_${f.sessionB}%`);
  const repeat = await broadcasts.broadcastQueueSummary(
    db,
    { id: f.sessionB, hospital_id: f.hospitalB, current_live_token: 0 },
    logger,
  );
  assertEquals(repeat, 2); // enqueue attempts are made …
  const { count: afterRepeat } = await db
    .from("job_queue")
    .select("id", { count: "exact", head: true })
    .like("idempotency_key", `wa_q_summary_${f.sessionB}%`);
  assertEquals(afterRepeat, afterFirst); // … but dedupe holds.

  // Doctor delay + admin notice + alert delivery orchestration.
  const delay = await broadcasts.broadcastDoctorDelay(
    db,
    { id: f.sessionB, hospital_id: f.hospitalB, current_live_token: 0 },
    15,
    `test ${RUN}`,
    logger,
  );
  assertEquals(delay, 2);

  const adminNotice = await broadcasts.broadcastAdminOperational(
    db,
    f.hospitalB,
    "operational_notice",
    `p15 notice ${RUN}`,
    logger,
  );
  assertEquals(adminNotice, 1); // adminB carries a deliverable phone.

  const alertId = await rpc("fire_managed_alert", {
    p_hospital_id: f.hospitalB,
    p_alert_key: `p15_bcast_${RUN}`,
    p_severity: "critical",
    p_current_value: 1,
    p_threshold_value: 0,
    p_threshold_unit: "count",
    p_message: `broadcast alert ${RUN}`,
  });
  assertExists(alertId);
  f.broadcastKeys.push(`p15_bcast_${RUN}`);

  const { data: alertRow, error: alertErr } = await db
    .from("alert_events")
    .select("id, hospital_id, alert_key, severity, message")
    .eq("id", alertId)
    .single();
  assertEquals(alertErr, null);
  assertExists(alertRow);
  const alertBroadcast = await broadcasts.broadcastAlertToAdmins(
    db,
    alertRow as {
      id: string;
      hospital_id: string;
      alert_key: string;
      severity: string;
      message: string | null;
    },
    logger,
  );
  assertEquals(alertBroadcast, 1);

  // E.164 normalization applied to every enqueued phone.
  const { data: jobs, error: jobsErr } = await db
    .from("job_queue")
    .select("payload, metadata")
    .like("idempotency_key", `wa_q_summary_${f.sessionB}%`);
  assertEquals(jobsErr, null);
  assertExists(jobs);
  assertEquals(jobs.length, 2);
  for (const job of jobs) {
    const payload = job.payload as { phone?: string };
    assert(
      payload.phone?.startsWith("+919"),
      `expected +91 E.164 phone, got ${payload.phone}`,
    );
    assertEquals(job.metadata, { source: "enterprise_broadcasts" });
  }
});

// ─── 12. HTTP: command-center endpoint ──────────────────────────────────────

Deno.test("ent http: command-center overview and timeline", async () => {
  const f = fx();

  const overview = okData(
    await callFn(
      "command-center",
      f.adminA.token,
      f.hospitalA,
      { action: "overview" },
    ),
  );
  const ccOverview = overview.overview as Record<string, unknown>;
  assertEquals(ccOverview.hospital_id, f.hospitalA);
  assertExists(overview.scores);

  const timeline = okData(
    await callFn(
      "command-center",
      f.adminA.token,
      f.hospitalA,
      { action: "timeline", fromTs: RUN_START },
    ),
  );
  const tl = timeline.timeline as Record<string, unknown>;
  assert(Array.isArray(tl.events));
});

Deno.test("ent http: auth gates enforce roles and portfolio scope", async () => {
  const f = fx();

  // Receptionist cannot open the command center.
  assertErrorCode(
    await callFn(
      "command-center",
      f.recepA.token,
      f.hospitalA,
      { action: "overview" },
    ),
    403,
    "ROLE_INSUFFICIENT",
  );

  // Portfolio analytics are global-admin only.
  assertErrorCode(
    await callFn(
      "executive-analytics",
      f.adminA.token,
      f.hospitalA,
      { action: "portfolio" },
    ),
    403,
    "FORBIDDEN",
  );
  const portfolio = okData(
    await callFn(
      "executive-analytics",
      f.globalAdmin.token,
      f.hospitalA,
      { action: "portfolio" },
    ),
  );
  assertExists(portfolio.portfolio);

  // Hospital-scoped analytics stay open to the tenant admin.
  const daily = okData(
    await callFn(
      "executive-analytics",
      f.adminA.token,
      f.hospitalA,
      { action: "daily_operations", date: TODAY },
    ),
  );
  assertExists(daily.dashboard);

  // Missing hospital header is a validation failure.
  assertErrorCode(
    await callFn("command-center", f.adminA.token, null, {
      action: "overview",
    }),
    422,
    "VALIDATION_ERROR",
  );
});

// ─── 13. HTTP: alert-center endpoint ────────────────────────────────────────

Deno.test("ent http: alert acknowledgment is audited", async () => {
  const { db } = await ctx();
  const f = fx();
  const key = `p15_http_${RUN}`;
  f.broadcastKeys.push(key);

  const alertId = await rpc("fire_managed_alert", {
    p_hospital_id: f.hospitalA,
    p_alert_key: key,
    p_severity: "warning",
    p_current_value: 3,
    p_threshold_value: 1,
    p_threshold_unit: "count",
    p_message: `http lifecycle ${RUN}`,
  });
  assertExists(alertId);

  const ack = okData(
    await callFn("alert-center", f.adminA.token, f.hospitalA, {
      action: "acknowledge",
      alertId,
    }),
  );
  const result = ack.result as Record<string, unknown>;
  assertEquals(result.ok, true);
  assertEquals(result.already_acknowledged, false);

  // Cross-tenant: hospital B's admin cannot touch A's alert.
  assertErrorCode(
    await callFn("alert-center", f.adminB.token, f.hospitalB, {
      action: "acknowledge",
      alertId,
    }),
    403,
    "FORBIDDEN",
  );

  // The mutation landed in the immutable audit trail.
  const { data: auditRows, error: auditErr } = await db
    .from("audit_logs")
    .select("id, action_type, entity_type, actor_user_id")
    .eq("hospital_id", f.hospitalA)
    .eq("action_type", "alert_center")
    .gte("created_at", RUN_START);
  assertEquals(auditErr, null);
  assertExists(auditRows);
  assertGreater(auditRows.length, 0);
  assertEquals(auditRows[0].actor_user_id, f.adminA.userId);

  // Resolve + delete keeps the residue inert.
  await rpc("resolve_alert", {
    p_alert_id: alertId,
    p_actor_id: f.adminA.userId,
  });
  const { error } = await db.from("alert_events").delete().eq("id", alertId);
  assertEquals(error, null);
});

// ─── 14. HTTP: enterprise-reports endpoint ──────────────────────────────────

Deno.test("ent http: report generation in json, csv and pdf-ready", async () => {
  const { db } = await ctx();
  const f = fx();

  const jsonRes = okData(
    await callFn("enterprise-reports", f.adminA.token, f.hospitalA, {
      action: "generate",
      reportType: "daily_hospital",
      fromDate: TODAY,
      toDate: TODAY,
    }),
  );
  const report = jsonRes.report as Record<string, unknown>;
  assertEquals(report.ok, true);
  assertEquals(report.report_type, "daily_hospital");

  const csvRes = okData(
    await callFn("enterprise-reports", f.adminA.token, f.hospitalA, {
      action: "generate",
      reportType: "daily_hospital",
      format: "csv",
      fromDate: TODAY,
      toDate: TODAY,
    }),
  );
  assertEquals(typeof csvRes.csv, "string");
  assertGreater((csvRes.csv as string).length, 0);

  const pdfRes = okData(
    await callFn("enterprise-reports", f.adminA.token, f.hospitalA, {
      action: "generate",
      reportType: "sla",
      format: "pdf_ready",
      fromDate: TODAY,
      toDate: TODAY,
    }),
  );
  assertExists(pdfRes.pdf);

  // Unknown report type surfaces the RPC reason as validation.
  assertErrorCode(
    await callFn("enterprise-reports", f.adminA.token, f.hospitalA, {
      action: "generate",
      reportType: "not_a_report",
    }),
    422,
    "VALIDATION_ERROR",
  );

  // Generation is audited as executive_report.
  const { data: auditRows, error: auditErr } = await db
    .from("audit_logs")
    .select("id, action_type, actor_user_id")
    .eq("hospital_id", f.hospitalA)
    .eq("action_type", "executive_report")
    .gte("created_at", RUN_START);
  assertEquals(auditErr, null);
  assertExists(auditRows);
  assertGreater(auditRows.length, 0);

  // Audit reconciliation: every logged action type is registered.
  const integrity = await rpc("verify_audit_integrity", {
    p_hospital_id: f.hospitalA,
    p_from_ts: RUN_START,
  }) as Record<string, unknown>;
  assertEquals(integrity.ok, true);
  assertGreater(Number(integrity.total_entries), 0);
});

// ─── 15. Cleanup ────────────────────────────────────────────────────────────

Deno.test("zz ent: cleanup removes non-audited fixtures", async () => {
  const { db } = await ctx();
  const f = fx();

  // Broadcast jobs enqueued by this suite.
  for (
    const prefix of [
      "wa_q_summary_",
      "wa_q_delay_",
      "wa_closure_",
      "wa_admin_ops_",
      "wa_ops_alert_bcast_",
    ]
  ) {
    const { error } = await db.from("job_queue").delete().like(
      "idempotency_key",
      `${prefix}%`,
    );
    assertEquals(error, null);
  }

  // Flags, alerts (activity rows cascade), collections.
  const { error: flagErr } = await db.from("feature_flags").delete()
    .eq("hospital_id", f.hospitalB)
    .eq("flag_key", "whatsapp_queue_updates");
  assertEquals(flagErr, null);

  for (const hid of [f.hospitalA, f.hospitalB]) {
    const { error: alertErr } = await db.from("alert_events").delete().eq(
      "hospital_id",
      hid,
    );
    assertEquals(alertErr, null);
    const { error: supErr } = await db.from("alert_suppressions").delete().eq(
      "hospital_id",
      hid,
    );
    assertEquals(supErr, null);
    const { error: dceErr } = await db
      .from("daily_collection_entries")
      .delete()
      .eq("hospital_id", hid);
    assertEquals(dceErr, null);
    // Bookings with financial_ledger entries cannot be deleted (immutable ledger).
    // They will be cleaned up when the hospital is deleted (CASCADE).
    await db.from("bookings").delete().eq("hospital_id", hid);
  }

  const { error: sessErr } = await db.from("queue_sessions").delete().like(
    "session_name",
    `p15_${RUN}%`,
  );
  assertEquals(sessErr, null);

  // Hospital A is audited by the HTTP tests: the immutability
  // trigger blocks its deletion, so it stays as inert residue.
  const { count: aAuditCount, error: aAuditErr } = await db
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("hospital_id", f.hospitalA);
  assertEquals(aAuditErr, null);
  if ((aAuditCount ?? 0) === 0) {
    const { error } = await db.from("hospitals").delete().eq(
      "id",
      f.hospitalA,
    );
    assertEquals(error, null);
  }

  // Hospital B stayed audit-free and is fully removed.
  const { error: hBErr } = await db.from("hospitals").delete().eq(
    "id",
    f.hospitalB,
  );
  assertEquals(hBErr, null);

  // Roles are stripped for every fixture actor; audited profiles
  // (adminA) keep their profile + auth user as inert residue.
  const actors = [
    f.adminA.userId,
    f.adminB.userId,
    f.recepA.userId,
    f.globalAdmin.userId,
  ];
  for (const userId of actors) {
    const { error } = await db.from("user_roles").delete().eq(
      "user_id",
      userId,
    );
    assertEquals(error, null);
  }

  const { data: auditedRows, error: auditedErr } = await db
    .from("audit_logs")
    .select("actor_user_id")
    .in("actor_user_id", actors);
  assertEquals(auditedErr, null);
  const auditedActors = new Set(
    (auditedRows ?? []).map((r) => r.actor_user_id as string),
  );

  for (const userId of actors) {
    if (auditedActors.has(userId)) continue;
    const { error } = await db.from("profiles").delete().eq("id", userId);
    assertEquals(error, null);
    await deleteAuthUser(userId);
  }

  // Fixture doctors: docB's hospital is gone; docD is referenced
  // only by deleted bookings and can go as well.
  for (const did of [f.docD, f.docB]) {
    const { error } = await db.from("profiles").delete().eq("id", did);
    assertEquals(error, null);
    await deleteAuthUser(did);
  }

  // Leftover guard.
  const { count } = await db
    .from("queue_sessions")
    .select("id", { count: "exact", head: true })
    .like("session_name", `p15_${RUN}%`);
  assertEquals(count, 0);
});
