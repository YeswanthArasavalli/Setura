/**
 * tests/integration/command_center_broadcast_http.test.ts
 *
 * WS-C2b — REAL HTTP-path coverage for the five `broadcast_*` WRITE actions of
 * the EXISTING `command-center` Edge Function:
 *   broadcast_queue_summary · broadcast_doctor_delay · broadcast_closure ·
 *   broadcast_admin_notice · broadcast_alert
 *
 * The broadcast fan-out primitive (`_shared/enterprise/broadcasts.ts`) is
 * already proven by DIRECT import in `enterprise_command_center.test.ts`
 * ("ent: broadcasts respect flag gating and idempotency"). What NO test
 * previously drove is the actual `command-center` HTTP WRITE surface that the
 * C2b composer uses end-to-end:
 *   HTTP → Edge Function → X-Hospital-ID → resolveAuth → requireRole →
 *   Zod validation → tenant ownership → broadcasts.ts → enqueue_job → audit.
 * The composer (C2b) dispatches here, so this file verifies the write path the
 * real client depends on. It is REAL, not mocked: every case POSTs to
 * `<API_URL>/functions/v1/command-center` with a genuine GoTrue password-grant
 * JWT and the `X-Hospital-ID` header. No case substitutes a direct primitive
 * call for the HTTP invocation.
 *
 * ENQUEUED != DELIVERED: a successful broadcast only enqueues a WhatsApp job.
 * There are NO provider credentials and NO processing worker in this local
 * environment, so enqueued jobs stay pending and NO WhatsApp is ever sent. No
 * case asserts provider delivery; delivery remains UNPROVEN by design.
 *
 * Denial discipline (P3-01 analogue): a denied role or a cross-tenant target
 * MUST be refused at the application boundary (401/403/422), NEVER a 500. A 500
 * here is raised loudly as a backend authorization defect, never papered over.
 *
 * Run with:
 *   deno test --allow-net --allow-env --allow-run \
 *     tests/integration/command_center_broadcast_http.test.ts
 * (requires `supabase start` AND the Edge Runtime actually serving — verify
 *  before trusting any result; F16-01 exit-code lies.)
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

type DbClient = Awaited<ReturnType<typeof bootstrap>>["db"];
let _ctx: { db: DbClient } | null = null;

async function bootstrap() {
  const status = await getLocalStatus();
  if (!status) {
    throw new Error("Local Supabase stack is not running. `supabase start`.");
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

// ─── Per-run fixture isolation ───────────────────────────────────────────────

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "7");
const FIXTURE_PASSWORD = `C2b-${RUN}-fixture-pass`;
const TODAY = new Date().toISOString().slice(0, 10);

interface Actor {
  userId: string;
  email: string;
  token: string;
}

interface FixtureState {
  hospitalA: string;
  hospitalB: string;
  adminA: Actor;
  adminB: Actor;
  recepA: Actor;
  doctorA: Actor;
  globalAdmin: Actor;
  sessionA: string;
  sessionB: string;
  alertA: string;
  alertB: string;
  userIds: string[];
}

let F: FixtureState | null = null;

function fx(): FixtureState {
  if (!F) throw new Error("setup test not run");
  return F;
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
  return json.access_token;
}

/** POST /functions/v1/command-center over real HTTP. */
async function callFn(
  token: string | null,
  hospitalId: string | null,
  body: Record<string, unknown>,
): Promise<
  { status: number; json: Record<string, unknown> | null; text: string }
> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (hospitalId) headers["X-Hospital-ID"] = hospitalId;
  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/functions/v1/command-center`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
  const text = await resp.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Non-JSON body (gateway refusal) — status still checked.
  }
  return { status: resp.status, json, text };
}

/** Reads `data` from a 200 success envelope and returns the broadcast result. */
function broadcastData(
  res: { status: number; json: Record<string, unknown> | null },
): { action: string; kind: string; enqueued: number } {
  assertEquals(res.status, 200);
  assertExists(res.json);
  assertEquals(res.json.success, true);
  const data = res.json.data as Record<string, unknown>;
  assertExists(data);
  const bc = data.broadcast as Record<string, unknown>;
  assertExists(bc);
  return {
    action: data.action as string,
    kind: bc.kind as string,
    enqueued: bc.enqueued as number,
  };
}

/** Asserts a refusal is a real application-level fail-closed denial (never 500). */
function assertDenied(
  res: { status: number; text: string },
  expected: number[],
): void {
  if (res.status === 500) {
    throw new Error(
      `backend authorization defect: denial surfaced HTTP 500, expected ${
        expected.join("/")
      }. body=${res.text}`,
    );
  }
  assert(
    expected.includes(res.status),
    `expected status in [${
      expected.join(",")
    }] but got ${res.status}: ${res.text}`,
  );
}

async function countJobs(keyPrefix: string): Promise<number> {
  const { db } = await ctx();
  const { count } = await db
    .from("job_queue")
    .select("id", { count: "exact", head: true })
    .like("idempotency_key", `${keyPrefix}%`);
  return count ?? 0;
}

async function auditCount(hospitalId: string): Promise<number> {
  const { db } = await ctx();
  const { count } = await db
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("hospital_id", hospitalId)
    .eq("entity_type", "whatsapp_broadcast")
    .eq("action_type", "operational_alert");
  return count ?? 0;
}

// ─── Setup ──────────────────────────────────────────────────────────────────

Deno.test("ccbc: setup fixture hospitals, actors, sessions, alerts", async () => {
  const { db } = await ctx();

  const { data: hA, error: hAErr } = await db
    .from("hospitals")
    .insert({ name: `C2b ${RUN} A`, slug: `c2b-${RUN}-a` })
    .select("id").single();
  assertEquals(hAErr, null);
  const { data: hB, error: hBErr } = await db
    .from("hospitals")
    .insert({ name: `C2b ${RUN} B`, slug: `c2b-${RUN}-b` })
    .select("id").single();
  assertEquals(hBErr, null);
  assertExists(hA);
  assertExists(hB);
  const hospitalA = hA.id as string;
  const hospitalB = hB.id as string;

  const userIds: string[] = [];
  async function actor(
    tag: string,
    role: "global_admin" | "hospital_admin" | "doctor" | "receptionist",
    hospitalId: string | null,
    phoneSuffix: string,
  ): Promise<Actor> {
    const userId = crypto.randomUUID();
    const email = `c2b-${tag}-${RUN}@setura.test`;
    await createAuthUser(userId, email);
    const { error: pErr } = await db.from("profiles").upsert({
      id: userId,
      full_name: `C2b ${tag} ${RUN}`,
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
    userIds.push(userId);
    return { userId, email, token: await tokenFor(email) };
  }

  const adminA = await actor("adma", "hospital_admin", hospitalA, "01");
  const adminB = await actor("admb", "hospital_admin", hospitalB, "02");
  const recepA = await actor("recep", "receptionist", hospitalA, "03");
  const doctorA = await actor("doc", "doctor", hospitalA, "04");
  const globalAdmin = await actor("glob", "global_admin", null, "05");

  // Doctors own profiles already via actor(); create queue sessions referencing
  // a doctor user id (queue_sessions.doctor_id FK -> profiles).
  const { data: sA, error: sAErr } = await db.from("queue_sessions").insert({
    hospital_id: hospitalA,
    doctor_id: doctorA.userId,
    session_date: TODAY,
    session_name: `c2b_${RUN}_a`,
    max_tokens: 50,
  }).select("id").single();
  assertEquals(sAErr, null);
  assertExists(sA);
  const sessionA = sA.id as string;

  const { data: sB, error: sBErr } = await db.from("queue_sessions").insert({
    hospital_id: hospitalB,
    doctor_id: doctorA.userId,
    session_date: TODAY,
    session_name: `c2b_${RUN}_b`,
    max_tokens: 50,
  }).select("id").single();
  assertEquals(sBErr, null);
  assertExists(sB);
  const sessionB = sB.id as string;

  // Two queue-active (waiting) patients at A, one at B, each with a phone and a
  // today appointment_date (needed by the closure broadcast).
  for (let i = 1; i <= 2; i++) {
    const { error } = await db.from("bookings").insert({
      hospital_id: hospitalA,
      queue_session_id: sessionA,
      assigned_doctor_id: doctorA.userId,
      appointment_date: TODAY,
      booking_source: "walkin",
      patient_name: `C2b ${RUN} A${i}`,
      patient_phone: `94${RUN}000${i}`,
      token_number: i,
      status: "waiting",
    });
    assertEquals(error, null);
  }
  const { error: bBErr } = await db.from("bookings").insert({
    hospital_id: hospitalB,
    queue_session_id: sessionB,
    assigned_doctor_id: doctorA.userId,
    appointment_date: TODAY,
    booking_source: "walkin",
    patient_name: `C2b ${RUN} B1`,
    patient_phone: `93${RUN}0001`,
    token_number: 1,
    status: "waiting",
  });
  assertEquals(bBErr, null);

  // Patient broadcasts gated ON at A, OFF at B.
  const { error: fAErr } = await db.from("feature_flags").insert({
    hospital_id: hospitalA,
    flag_key: "whatsapp_queue_updates",
    is_enabled: true,
  });
  assertEquals(fAErr, null);
  const { error: fBErr } = await db.from("feature_flags").insert({
    hospital_id: hospitalB,
    flag_key: "whatsapp_queue_updates",
    is_enabled: false,
  });
  assertEquals(fBErr, null);

  // One alert per hospital (service-role direct insert; broadcast_alert loads by
  // id and enforces hospital ownership at the edge).
  const { data: alA, error: alAErr } = await db.from("alert_events").insert({
    hospital_id: hospitalA,
    alert_key: `c2b_open_${RUN}_a`,
    severity: "warning",
    message: `c2b alert A ${RUN}`,
  }).select("id").single();
  assertEquals(alAErr, null);
  assertExists(alA);
  const { data: alB, error: alBErr } = await db.from("alert_events").insert({
    hospital_id: hospitalB,
    alert_key: `c2b_open_${RUN}_b`,
    severity: "critical",
    message: `c2b alert B ${RUN}`,
  }).select("id").single();
  assertEquals(alBErr, null);
  assertExists(alB);

  F = {
    hospitalA,
    hospitalB,
    adminA,
    adminB,
    recepA,
    doctorA,
    globalAdmin,
    sessionA,
    sessionB,
    alertA: alA.id as string,
    alertB: alB.id as string,
    userIds,
  };
});

// ─── 1. Authorized success: enqueue + audit ─────────────────────────────────

Deno.test("ccbc H1: broadcast_admin_notice (flag-independent) enqueues + audits", async () => {
  const f = fx();
  const res = await callFn(f.adminA.token, f.hospitalA, {
    action: "broadcast_admin_notice",
    kind: "daily_summary",
    message: `ops notice ${RUN}`,
  });
  const bc = broadcastData(res);
  assertEquals(bc.action, "broadcast_admin_notice");
  assertEquals(bc.kind, "admin_daily_summary");
  assert(bc.enqueued >= 1, `expected >=1 enqueued, got ${bc.enqueued}`);
  assert(
    (await countJobs(`wa_admin_ops_${f.hospitalA}_daily_summary`)) >= 1,
    "admin notice job not enqueued",
  );
  assert((await auditCount(f.hospitalA)) >= 1, "broadcast not audited");
});

Deno.test("ccbc H2: broadcast_alert enqueues to admins", async () => {
  const f = fx();
  const res = await callFn(f.adminA.token, f.hospitalA, {
    action: "broadcast_alert",
    alertId: f.alertA,
  });
  const bc = broadcastData(res);
  assertEquals(bc.kind, "alert_broadcast");
  assert(bc.enqueued >= 1, `expected >=1 enqueued, got ${bc.enqueued}`);
  assert(
    (await countJobs(`wa_ops_alert_bcast_${f.alertA}`)) >= 1,
    "alert broadcast job not enqueued",
  );
});

Deno.test("ccbc H3: broadcast_queue_summary respects flag ON at A (2 patients)", async () => {
  const f = fx();
  const res = await callFn(f.adminA.token, f.hospitalA, {
    action: "broadcast_queue_summary",
    queueSessionId: f.sessionA,
  });
  const bc = broadcastData(res);
  assertEquals(bc.kind, "queue_summary");
  assertEquals(bc.enqueued, 2);
});

Deno.test("ccbc H4: broadcast_doctor_delay fans out to queue-active patients", async () => {
  const f = fx();
  const res = await callFn(f.adminA.token, f.hospitalA, {
    action: "broadcast_doctor_delay",
    queueSessionId: f.sessionA,
    delayMinutes: 15,
    reason: `doctor running late ${RUN}`,
  });
  const bc = broadcastData(res);
  assertEquals(bc.kind, "doctor_delay");
  assertEquals(bc.enqueued, 2);
});

Deno.test("ccbc H5: patient broadcast honest no-op when flag OFF at B (200, enqueued 0)", async () => {
  const f = fx();
  const res = await callFn(f.adminB.token, f.hospitalB, {
    action: "broadcast_queue_summary",
    queueSessionId: f.sessionB,
  });
  const bc = broadcastData(res);
  assertEquals(bc.enqueued, 0); // gated, but still a successful 200.
});

Deno.test("ccbc H6: broadcast_closure reaches today's active patients (POSITIVE CONTROL)", async () => {
  const f = fx();
  const res = await callFn(f.adminA.token, f.hospitalA, {
    action: "broadcast_closure",
    date: TODAY,
    reason: `early closure ${RUN}`,
  });
  const bc = broadcastData(res);
  assertEquals(bc.kind, "hospital_closure");
  // A has 2 queue-active patients with appointment_date = TODAY and the flag on,
  // so a correct closure broadcast MUST notify them.
  assertEquals(
    bc.enqueued,
    2,
    "closure broadcast must enqueue one per today's active patient",
  );
  assert(
    (await countJobs(`wa_closure_${f.hospitalA}_${TODAY}`)) >= 1,
    "closure broadcast enqueued no job",
  );
});

Deno.test("ccbc H7: global_admin scoped via X-Hospital-ID succeeds", async () => {
  const f = fx();
  const res = await callFn(f.globalAdmin.token, f.hospitalA, {
    action: "broadcast_admin_notice",
    kind: "sla_breach",
    message: `sla breach ${RUN}`,
  });
  const bc = broadcastData(res);
  assert(bc.enqueued >= 1, `expected >=1 enqueued, got ${bc.enqueued}`);
});

// ─── 2. Authorization / validation / tenant matrix ──────────────────────────

Deno.test("ccbc H8: receptionist denied broadcast write (403, not 500)", async () => {
  const f = fx();
  const res = await callFn(f.recepA.token, f.hospitalA, {
    action: "broadcast_admin_notice",
    kind: "operational_notice",
    message: `nope ${RUN}`,
  });
  assertDenied(res, [403]);
});

Deno.test("ccbc H9: doctor denied broadcast write (403, not 500)", async () => {
  const f = fx();
  const res = await callFn(f.doctorA.token, f.hospitalA, {
    action: "broadcast_queue_summary",
    queueSessionId: f.sessionA,
  });
  assertDenied(res, [403]);
});

Deno.test("ccbc H10: anonymous write is unauthorized (401)", async () => {
  const f = fx();
  const res = await callFn(null, f.hospitalA, {
    action: "broadcast_admin_notice",
    kind: "congestion",
    message: `anon ${RUN}`,
  });
  assertDenied(res, [401]);
});

Deno.test("ccbc H11: missing X-Hospital-ID -> 422", async () => {
  const f = fx();
  const res = await callFn(f.adminA.token, null, {
    action: "broadcast_admin_notice",
    kind: "operational_notice",
    message: `no hdr ${RUN}`,
  });
  assertDenied(res, [422]);
});

Deno.test("ccbc H12: GET is method-not-allowed (405)", async () => {
  const f = fx();
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/functions/v1/command-center`,
    {
      method: "GET",
      headers: { "Authorization": `Bearer ${f.adminA.token}` },
    },
  );
  assertEquals(resp.status, 405);
});

Deno.test("ccbc H13: cross-tenant queue session -> 403 + zero side-effect", async () => {
  const { db } = await ctx();
  const f = fx();
  const before = await countJobs(`wa_q_summary_${f.sessionB}`);
  const res = await callFn(f.adminA.token, f.hospitalA, {
    action: "broadcast_queue_summary",
    queueSessionId: f.sessionB, // belongs to hospital B
  });
  assertDenied(res, [403]);
  const after = await countJobs(`wa_q_summary_${f.sessionB}`);
  assertEquals(after, before, "cross-tenant refusal must not enqueue any job");
  // And the session still belongs to B (no state change to B patients).
  const { data: sess } = await db.from("queue_sessions")
    .select("hospital_id").eq("id", f.sessionB).single();
  assertEquals(sess?.hospital_id, f.hospitalB);
});

Deno.test("ccbc H14: cross-tenant alert -> 403 + zero side-effect", async () => {
  const f = fx();
  const before = await countJobs(`wa_ops_alert_bcast_${f.alertB}`);
  const res = await callFn(f.adminA.token, f.hospitalA, {
    action: "broadcast_alert",
    alertId: f.alertB, // belongs to hospital B
  });
  assertDenied(res, [403]);
  assertEquals(await countJobs(`wa_ops_alert_bcast_${f.alertB}`), before);
});

Deno.test("ccbc H15: doctor_delay missing delayMinutes -> 422", async () => {
  const f = fx();
  const res = await callFn(f.adminA.token, f.hospitalA, {
    action: "broadcast_doctor_delay",
    queueSessionId: f.sessionA,
  });
  assertDenied(res, [422]);
});

Deno.test("ccbc H16: not-found queue session -> 422", async () => {
  const f = fx();
  const res = await callFn(f.adminA.token, f.hospitalA, {
    action: "broadcast_queue_summary",
    queueSessionId: crypto.randomUUID(),
  });
  assertDenied(res, [422]);
});

Deno.test("ccbc H17: oversized message (>500) -> 422", async () => {
  const f = fx();
  const res = await callFn(f.adminA.token, f.hospitalA, {
    action: "broadcast_admin_notice",
    kind: "operational_notice",
    message: "x".repeat(501),
  });
  assertDenied(res, [422]);
});

Deno.test("ccbc H18: unknown admin-notice kind -> 422", async () => {
  const f = fx();
  const res = await callFn(f.adminA.token, f.hospitalA, {
    action: "broadcast_admin_notice",
    kind: "not_a_real_kind",
    message: `bad kind ${RUN}`,
  });
  assertDenied(res, [422]);
});

Deno.test("ccbc H19: malformed action name -> 422", async () => {
  const f = fx();
  const res = await callFn(f.adminA.token, f.hospitalA, {
    action: "broadcast_nonsense",
  });
  assertDenied(res, [422]);
});

// ─── 3. Idempotency / replay ────────────────────────────────────────────────

Deno.test("ccbc H20: identical replay does not duplicate the job_queue row", async () => {
  const f = fx();
  const body = {
    action: "broadcast_admin_notice",
    kind: "congestion",
    message: `replay ${RUN}`,
  };
  const r1 = broadcastData(await callFn(f.adminA.token, f.hospitalA, body));
  assert(r1.enqueued >= 1, "first broadcast should enqueue");
  const after1 = await countJobs(`wa_admin_ops_${f.hospitalA}_congestion`);
  // Second identical dispatch: same deterministic key -> enqueue_job dedups.
  broadcastData(await callFn(f.adminA.token, f.hospitalA, body));
  const after2 = await countJobs(`wa_admin_ops_${f.hospitalA}_congestion`);
  assertEquals(
    after2,
    after1,
    "replayed broadcast must not create a duplicate job_queue row",
  );
});

// ─── 4. Hygiene: no PII in the response ─────────────────────────────────────

Deno.test("ccbc H21: response carries no patient/admin phone number", async () => {
  const f = fx();
  const res = await callFn(f.adminA.token, f.hospitalA, {
    action: "broadcast_queue_summary",
    queueSessionId: f.sessionA,
  });
  assertEquals(res.status, 200);
  // The patient phone fixture pattern must never appear in the HTTP body.
  assert(!res.text.includes(`94${RUN}`), "response leaked a patient phone");
});

// ─── Cleanup (audit_logs are immutable and intentionally retained) ───────────

Deno.test("zz ccbc: cleanup removes transient fixtures", async () => {
  const { db } = await ctx();
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const f = fx();

  await db.from("job_queue").delete().eq("hospital_id", f.hospitalA);
  await db.from("job_queue").delete().eq("hospital_id", f.hospitalB);
  await db.from("alert_events").delete().in("id", [f.alertA, f.alertB]);
  await db.from("feature_flags").delete().in("hospital_id", [
    f.hospitalA,
    f.hospitalB,
  ]);
  await db.from("bookings").delete().in("hospital_id", [
    f.hospitalA,
    f.hospitalB,
  ]);
  await db.from("queue_sessions").delete().in("id", [f.sessionA, f.sessionB]);
  await db.from("user_roles").delete().in("user_id", f.userIds);
  await db.from("profiles").delete().in("id", f.userIds);
  await db.from("hospitals").delete().in("id", [f.hospitalA, f.hospitalB]);

  for (const uid of f.userIds) {
    await fetch(`${LOCAL_STATUS.API_URL}/auth/v1/admin/users/${uid}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${LOCAL_STATUS.SERVICE_ROLE_KEY}` },
    });
  }
  assert(true);
});
