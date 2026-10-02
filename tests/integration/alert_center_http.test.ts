/**
 * tests/integration/alert_center_http.test.ts
 *
 * Phase 7 G-10 — REAL HTTP-path coverage for the EXISTING `alert-center`
 * Edge Function, restricted to its two READ actions (`list` / `analytics`).
 *
 * The alert RPCs (`get_alert_center` / `get_alert_analytics`) are already
 * proven service-role-only at the database (migration 47 §13 grants + the
 * migration 48 privilege hardening) and the broad privilege census lives in
 * privilege_isolation.test.ts, but NO test previously drove the actual
 * `alert-center` Edge Function HTTP endpoint end-to-end:
 *   HTTP → Edge Function → authentication → role gate → tenant resolution →
 *   service-role RPC → server response.
 * This file does exactly that, against the real local runtime. It is REAL, not
 * mocked: every case POSTs to `<API_URL>/functions/v1/alert-center` with a
 * genuine GoTrue password-grant JWT and the `X-Hospital-ID` header the contract
 * requires. No case substitutes a direct RPC call for the HTTP invocation, and
 * no case exercises a mutation action (§3/§8 — acknowledge/assign/resolve/
 * escalate/suppress are a separate future workstream).
 *
 * P3-01 (§6): the roadmap caveat is that some alert authorization SQL paths
 * historically returned 500 instead of a fail-closed 403. This suite re-verifies
 * the ACTUAL current read-path behavior rather than assuming it is fixed. The
 * edge layer runs `requireRole` and `resolveAuth` BEFORE any RPC, so a denied
 * role or a cross-tenant header must be refused at the application boundary
 * (403) without ever reaching the SQL that P3-01 concerns. If any read-path
 * denial instead surfaces a 500, the implementation must STOP and report a
 * backend authorization defect — never paper over it here or build a frontend
 * on top of it.
 *
 * Read surface with zero organic alert rows (§10/§37): `check_queue_backlog_
 * alerts()` has no runtime scheduler caller, so a fresh fixture tenant has no
 * `alert_events` and the reads legitimately return empty. That is NOT a defect:
 * `list` returns a successful empty center and `analytics` a successful summary.
 * This suite therefore asserts the response CONTRACT and the authorization
 * matrix; it never seeds an alert row and never requires a mutating migration.
 *
 * Run with:  deno task test:integration
 * (requires `supabase start` with the Phase 1.5 edge functions registered,
 *  AND the Edge Runtime actually serving — verify before trusting a result).
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

// ─── Per-run fixture isolation ───────────────────────────────────────────────

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "9");
const FIXTURE_PASSWORD = `G10-${RUN}-fixture-pass`;

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

/** POST /functions/v1/alert-center over real HTTP. */
async function callFn(
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
    `${LOCAL_STATUS.API_URL}/functions/v1/alert-center`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );

  const text = await resp.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Non-JSON body (gateway refusal) — status still checked.
  }
  return { status: resp.status, json };
}

/** Extracts `data` from a 200 success envelope. */
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

/**
 * Asserts the read-path denial is a real application-level fail-closed refusal.
 * A 500 here is the P3-01 backend authorization defect the prompt says to STOP
 * on, never something to accept — it is raised explicitly so the gate is loud.
 */
function assertDenied(
  res: { status: number; json: Record<string, unknown> | null },
  status: number,
  code: string,
  what: string,
): void {
  if (res.status >= 500) {
    throw new Error(
      `P3-01 BACKEND AUTHORIZATION DEFECT — ${what}: read-path denial ` +
        `returned ${res.status} (expected fail-closed ${status} ${code}), ` +
        `not an application refusal. STOP; do not build a frontend on it. ` +
        `Body: ${JSON.stringify(res.json)}`,
    );
  }
  assertEquals(res.status, status, `${what}: unexpected status`);
  assertExists(res.json, `${what}: expected an error envelope`);
  assertEquals(res.json.success, false, `${what}: expected failure`);
  const err = res.json.error as { code?: string };
  assertExists(err, `${what}: expected an error object`);
  assertEquals(err.code, code, `${what}: unexpected error code`);
}

// ─── Direct PostgREST RPC (privilege boundary, §25) ─────────────────────────

interface RestResult {
  status: number;
  body: unknown;
  raw: string;
}

async function rpcAsAuthenticated(
  token: string | null,
  fn: string,
  args: Record<string, unknown>,
): Promise<RestResult> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "apikey": LOCAL_STATUS.ANON_KEY,
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const resp = await fetch(`${LOCAL_STATUS.API_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
  const raw = await resp.text();
  let body: unknown = raw;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  return { status: resp.status, body, raw };
}

function messageOf(res: RestResult): string {
  if (res.body && typeof res.body === "object") {
    const b = res.body as Record<string, unknown>;
    return [b.message, b.hint, b.details, b.code]
      .filter((v) => typeof v === "string")
      .join(" | ");
  }
  return res.raw;
}

/**
 * A denied direct RPC must be refused by the DATABASE. A 404 is a TEST
 * DEFECT (PostgREST could not resolve the signature), never a security
 * result — the same discipline privilege_isolation.test.ts and the G-09
 * suite apply (F16-05: do not accept a non-database rejection as proof).
 */
function assertRpcDenied(res: RestResult, what: string): void {
  const msg = messageOf(res);
  if (res.status === 404) {
    throw new Error(
      `${what}: PostgREST could not resolve the function (${msg}). ` +
        `TEST DEFECT, not a security result: the boundary was never ` +
        `exercised (wrong argument names).`,
    );
  }
  assert(
    res.status === 401 || res.status === 403,
    `${what}: expected 401/403 from the database, got ${res.status} (${msg})`,
  );
  const lower = msg.toLowerCase();
  assert(
    lower.includes("permission denied") ||
      lower.includes("does not exist") ||
      lower.includes("42501") ||
      lower.includes("insufficient") ||
      lower.includes("not authorized"),
    `${what}: denial did not look privilege-based (${res.status}: ${msg})`,
  );
}

// ─── 0. Setup ────────────────────────────────────────────────────────────────

Deno.test("g10 alert http: setup fixture hospitals and actors", async () => {
  const { db } = await ctx();

  const { data: hA, error: hAErr } = await db
    .from("hospitals")
    .insert({ name: `G10 Alert ${RUN} A`, slug: `g10-alert-${RUN}-a` })
    .select("id")
    .single();
  assertEquals(hAErr, null);
  const { data: hB, error: hBErr } = await db
    .from("hospitals")
    .insert({ name: `G10 Alert ${RUN} B`, slug: `g10-alert-${RUN}-b` })
    .select("id")
    .single();
  assertEquals(hBErr, null);
  assertExists(hA);
  assertExists(hB);
  const hospitalA = hA.id as string;
  const hospitalB = hB.id as string;

  async function fixtureActor(
    tag: string,
    role: "global_admin" | "hospital_admin" | "doctor" | "receptionist",
    hospitalId: string | null,
    phoneSuffix: string,
  ): Promise<Actor> {
    const userId = crypto.randomUUID();
    const email = `g10-${tag}-${RUN}@setura.test`;
    await createAuthUser(userId, email);
    const { error: pErr } = await db.from("profiles").upsert({
      id: userId,
      full_name: `G10 ${tag} ${RUN}`,
      normalized_phone: `98${RUN}${phoneSuffix}`,
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

  const adminA = await fixtureActor("adma", "hospital_admin", hospitalA, "01");
  const adminB = await fixtureActor("admb", "hospital_admin", hospitalB, "02");
  const recepA = await fixtureActor("recp", "receptionist", hospitalA, "03");
  const doctorA = await fixtureActor("drta", "doctor", hospitalA, "04");
  const globalAdmin = await fixtureActor("glbl", "global_admin", null, "05");

  // No `alert_events` are seeded: the generator `check_queue_backlog_alerts()`
  // has no runtime scheduler caller (§10), so a fresh tenant legitimately has
  // zero rows. The reads must still succeed with a well-formed empty response
  // (§37) — proving the READ SURFACE, not fabricating alert data.
  F = { hospitalA, hospitalB, adminA, adminB, recepA, doctorA, globalAdmin };
});

// ─── 1. Hospital admin: both read actions succeed with the server contract ───

Deno.test("g10 alert http: hospital admin list returns server-authoritative center", async () => {
  const f = fx();
  const data = okData(
    await callFn(f.adminA.token, f.hospitalA, { action: "list" }),
  );
  assertEquals(data.action, "list");
  const center = data.center as Record<string, unknown>;
  assertExists(center, "list must return the get_alert_center object");
  assert(
    Array.isArray(center.alerts),
    `center.alerts must be an array, got ${typeof center.alerts}`,
  );
  // The server owns the counts; the console renders them, never recomputes.
  const counts = center.counts as Record<string, unknown>;
  assertExists(counts, "center.counts must be present");
  for (const key of ["open", "acknowledged", "escalated", "critical_open"]) {
    assert(
      key in counts,
      `center.counts is missing the server field '${key}'`,
    );
  }
});

Deno.test("g10 alert http: hospital admin analytics returns server summary + by-key", async () => {
  const f = fx();
  const data = okData(
    await callFn(f.adminA.token, f.hospitalA, { action: "analytics" }),
  );
  assertEquals(data.action, "analytics");
  const analytics = data.analytics as Record<string, unknown>;
  assertExists(
    analytics,
    "analytics must return the get_alert_analytics object",
  );
  assertExists(analytics.summary, "analytics.summary must be present");
  assert(
    Array.isArray(analytics.by_alert_key),
    `analytics.by_alert_key must be an array, got ${typeof analytics
      .by_alert_key}`,
  );
});

Deno.test("g10 alert http: list filters and analytics range map to server params", async () => {
  const f = fx();
  // Supported filters (§17): status / severity / category / limit for list.
  const filtered = okData(
    await callFn(f.adminA.token, f.hospitalA, {
      action: "list",
      status: "all",
      severity: "critical",
      limit: 10,
    }),
  );
  assertExists((filtered.center as Record<string, unknown>).alerts);

  // Supported analytics range (§13): from/to dates are accepted and echoed by a
  // successful (empty) response; absent bounds use the backend trailing-30-day
  // default rather than a browser-invented window.
  const ranged = okData(
    await callFn(f.adminA.token, f.hospitalA, {
      action: "analytics",
      fromDate: "2020-01-01",
      toDate: "2020-12-31",
    }),
  );
  assertExists((ranged.analytics as Record<string, unknown>).summary);
});

// ─── 2. Global admin follows the existing header contract (G-08 pattern) ─────

Deno.test("g10 alert http: global admin with a valid header is permitted", async () => {
  const f = fx();
  // `X-Hospital-ID` is validated before auth and requireRole admits global_admin
  // for any resolvable hospital. This mirrors the established G-08 bounded
  // acting-context mechanism — no tenant is invented and no authorization is
  // changed.
  const data = okData(
    await callFn(f.globalAdmin.token, f.hospitalA, { action: "list" }),
  );
  assertEquals(data.action, "list");
  assertExists(data.center);

  const analytics = okData(
    await callFn(f.globalAdmin.token, f.hospitalA, { action: "analytics" }),
  );
  assertEquals(analytics.action, "analytics");
  assertExists(analytics.analytics);
});

// ─── 3. Role gate: receptionist and doctor denied (app-level 403, P3-01) ─────

Deno.test("g10 alert http: receptionist is denied both read actions (403, not 500)", async () => {
  const f = fx();
  for (const action of ["list", "analytics"] as const) {
    assertDenied(
      await callFn(f.recepA.token, f.hospitalA, { action }),
      403,
      "ROLE_INSUFFICIENT",
      `receptionist ${action}`,
    );
  }
});

Deno.test("g10 alert http: doctor is denied both read actions (403, not 500)", async () => {
  const f = fx();
  for (const action of ["list", "analytics"] as const) {
    assertDenied(
      await callFn(f.doctorA.token, f.hospitalA, { action }),
      403,
      "ROLE_INSUFFICIENT",
      `doctor ${action}`,
    );
  }
});

// ─── 4. Missing tenant header → existing validation contract (422) ──────────

Deno.test("g10 alert http: missing X-Hospital-ID is a validation error", async () => {
  const f = fx();
  // The header is checked before auth, so even a valid admin token yields 422.
  const res = await callFn(f.adminA.token, null, { action: "list" });
  assertDenied(res, 422, "VALIDATION_ERROR", "missing X-Hospital-ID");
});

// ─── 5. Anonymous → 401 ──────────────────────────────────────────────────────

Deno.test("g10 alert http: anonymous request is unauthorized", async () => {
  const f = fx();
  // A valid header is supplied so the request is not rejected for the header;
  // with no Authorization token the call must not return alert data.
  const res = await callFn(null, f.hospitalA, { action: "list" });
  assertEquals(res.status, 401);
  // Per AGENTS.md F16-05: do not assume WHICH layer answered 401 (the edge
  // runtime JWT gate can reject before the handler). Only assert the honest
  // invariant: no success envelope and no data leaked.
  if (res.json) {
    assertEquals(res.json.success !== true, true);
    assertEquals(res.json.data, undefined);
  }
});

// ─── 6. Cross-tenant isolation (fail-closed, no B payload leakage) ──────────

Deno.test("g10 alert http: hospital B admin cannot read hospital A alerts", async () => {
  const f = fx();
  // adminB holds a grant only at hospitalB; presenting hospitalA's header
  // resolves no role there → fail-closed tenant denial BEFORE any RPC runs.
  // This is a real tenant denial, not a JWT-layer 401 (§9): the actor is fully
  // authenticated and authorized as a hospital_admin, yet refused for the other
  // tenant specifically.
  for (const action of ["list", "analytics"] as const) {
    const res = await callFn(f.adminB.token, f.hospitalA, { action });
    assertDenied(res, 403, "HOSPITAL_ACCESS_DENIED", `adminB -> A ${action}`);
    // No cross-tenant payload may leak even inside the failure envelope.
    assertEquals(res.json?.data, undefined);
  }
});

Deno.test("g10 alert http: read path never mutates (empty reads, no state change)", async () => {
  const f = fx();
  // The two read actions are STABLE RPCs. Prove a read leaves no alert rows and
  // touches no mutation: reading A's center must not create/resolve/ack anything
  // for either tenant.
  const beforeCount = await countAlerts();
  okData(await callFn(f.adminA.token, f.hospitalA, { action: "list" }));
  okData(await callFn(f.adminA.token, f.hospitalA, { action: "analytics" }));
  const afterCount = await countAlerts();
  assertEquals(
    afterCount,
    beforeCount,
    "the read surface must not change alert_events row count",
  );
});

async function countAlerts(): Promise<number> {
  const { db } = await ctx();
  const { count, error } = await db
    .from("alert_events")
    .select("id", { count: "exact", head: true });
  assertEquals(error, null);
  return count ?? 0;
}

// ─── 7. Direct RPC privilege boundary (architecture stays Function-only) ────

Deno.test("g10 alert http: client roles cannot call the alert RPCs directly", async () => {
  const f = fx();
  // Self-contained re-proof of the invariant the frontend relies on: a browser
  // (anonymous or an authenticated admin) must never reach the service-role-only
  // alert RPCs directly. The canonical broad census lives in
  // privilege_isolation.test.ts; this keeps the G-10 evidence honest without
  // depending on that suite having run in the same process.
  const directProbes: Array<[string, Record<string, unknown>]> = [
    ["get_alert_center", { p_hospital_id: f.hospitalA }],
    [
      "get_alert_analytics",
      {
        p_hospital_id: f.hospitalA,
        p_from_date: "2020-01-01",
        p_to_date: "2020-12-31",
      },
    ],
  ];
  for (const [fn, args] of directProbes) {
    assertRpcDenied(await rpcAsAuthenticated(null, fn, args), `anon -> ${fn}`);
    assertRpcDenied(
      await rpcAsAuthenticated(f.adminA.token, fn, args),
      `authenticated(adminA) -> ${fn}`,
    );
  }
});

// ─── 8. Write-path coverage H1–H15 (C2) ─────────────────────────────────────
//
// These cases drive the REAL mutation actions over HTTP (acknowledge / assign /
// resolve / escalate) end-to-end: HTTP -> Edge authz -> tenant gate -> service-
// role RPC (migration 64) -> server response. The 13 read cases above are kept
// unchanged. They must be read against the frozen write contract:
//   200 success / soft already_* | 401 anonymous | 403 role/tenant/42501 |
//   422 validation/not-found | 500 unexpected DB. No 404/409/428.

/** Seeds an alert directly (service role) and returns its id. */
async function mkAlert(
  hospitalId: string,
  key: string,
  message: string,
): Promise<string> {
  const { db } = await ctx();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (db.rpc as any)("fire_managed_alert", {
    p_hospital_id: hospitalId,
    p_alert_key: key,
    p_severity: "warning",
    p_current_value: 20,
    p_threshold_value: 10,
    p_threshold_unit: "minutes",
    p_message: message,
  });
  assertEquals(error, null);
  assert(typeof data === "string", "fire_managed_alert must return an id");
  return data as string;
}

function resultOf(data: Record<string, unknown>): Record<string, unknown> {
  const result = data.result as Record<string, unknown>;
  assertExists(result, "expected a result object");
  return result;
}

/** Asserts a real lifecycle transition: 200 ok:true + locked snapshot. */
function assertMutationOk(
  data: Record<string, unknown>,
  action: string,
): Record<string, unknown> {
  assertEquals(data.action, action);
  const result = resultOf(data);
  assertEquals(result.ok, true, `${action}: expected ok true`);
  assert(
    "before" in result && "after" in result,
    `${action}: a real transition must carry before/after snapshot`,
  );
  return result;
}

async function countActivity(alertId: string): Promise<number> {
  const { db } = await ctx();
  const { count, error } = await db
    .from("alert_activity_log")
    .select("id", { count: "exact", head: true })
    .eq("alert_id", alertId);
  assertEquals(error, null);
  return count ?? 0;
}

async function ackState(alertId: string): Promise<Record<string, unknown>> {
  const { db } = await ctx();
  const { data, error } = await db
    .from("alert_events")
    .select("acknowledged_at, is_resolved, severity")
    .eq("id", alertId)
    .single();
  assertEquals(error, null);
  assertExists(data);
  return data as Record<string, unknown>;
}

async function countJobs(): Promise<number> {
  const { db } = await ctx();
  const { count, error } = await db
    .from("job_queue")
    .select("id", { count: "exact", head: true });
  assertEquals(error, null);
  return count ?? 0;
}

/** Runs DDL on the local stack via the DB container (H15 fault injection). */
async function dbDdl(sql: string): Promise<void> {
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
      `docker psql DDL failed (${code}): ${new TextDecoder().decode(stderr)}`,
    );
  }
}

Deno.test("g10 alert http H1: hospital admin lifecycle success (200 ok + snapshot)", async () => {
  const f = fx();
  let id = await mkAlert(f.hospitalA, `h1_ack_${RUN}`, "h1 ack");
  assertMutationOk(
    okData(
      await callFn(f.adminA.token, f.hospitalA, {
        action: "acknowledge",
        alertId: id,
      }),
    ),
    "acknowledge",
  );

  id = await mkAlert(f.hospitalA, `h1_assign_${RUN}`, "h1 assign");
  assertMutationOk(
    okData(
      await callFn(f.adminA.token, f.hospitalA, {
        action: "assign",
        alertId: id,
        assigneeId: crypto.randomUUID(),
      }),
    ),
    "assign",
  );

  id = await mkAlert(f.hospitalA, `h1_resolve_${RUN}`, "h1 resolve");
  assertMutationOk(
    okData(
      await callFn(f.adminA.token, f.hospitalA, {
        action: "resolve",
        alertId: id,
        notes: "h1 notes",
      }),
    ),
    "resolve",
  );

  id = await mkAlert(f.hospitalA, `h1_esc_${RUN}`, "h1 escalate");
  assertMutationOk(
    okData(
      await callFn(f.adminA.token, f.hospitalA, {
        action: "escalate",
        alertId: id,
      }),
    ),
    "escalate",
  );
});

Deno.test("g10 alert http H2: global admin scoped through X-Hospital-ID succeeds", async () => {
  const f = fx();
  const id = await mkAlert(f.hospitalA, `h2_${RUN}`, "h2");
  assertMutationOk(
    okData(
      await callFn(f.globalAdmin.token, f.hospitalA, {
        action: "acknowledge",
        alertId: id,
      }),
    ),
    "acknowledge",
  );
});

Deno.test("g10 alert http H3: receptionist denied write (403, not 500)", async () => {
  const f = fx();
  assertDenied(
    await callFn(f.recepA.token, f.hospitalA, {
      action: "acknowledge",
      alertId: crypto.randomUUID(),
    }),
    403,
    "ROLE_INSUFFICIENT",
    "receptionist acknowledge",
  );
});

Deno.test("g10 alert http H4: doctor denied write (403, not 500)", async () => {
  const f = fx();
  assertDenied(
    await callFn(f.doctorA.token, f.hospitalA, {
      action: "escalate",
      alertId: crypto.randomUUID(),
    }),
    403,
    "ROLE_INSUFFICIENT",
    "doctor escalate",
  );
});

Deno.test("g10 alert http H5: anonymous write is unauthorized (401)", async () => {
  const f = fx();
  const res = await callFn(null, f.hospitalA, {
    action: "acknowledge",
    alertId: crypto.randomUUID(),
  });
  assertEquals(res.status, 401);
  if (res.json) {
    assertEquals(res.json.success !== true, true);
    assertEquals(res.json.data, undefined);
  }
});

Deno.test("g10 alert http H6: missing X-Hospital-ID on write -> 422", async () => {
  const f = fx();
  assertDenied(
    await callFn(f.adminA.token, null, {
      action: "acknowledge",
      alertId: crypto.randomUUID(),
    }),
    422,
    "VALIDATION_ERROR",
    "missing header write",
  );
});

Deno.test("g10 alert http H7: cross-tenant write -> 403 + zero mutation", async () => {
  const f = fx();
  const idB = await mkAlert(f.hospitalB, `h7_${RUN}`, "h7 cross");
  assertDenied(
    await callFn(f.adminA.token, f.hospitalA, {
      action: "acknowledge",
      alertId: idB,
    }),
    403,
    "FORBIDDEN",
    "adminA -> B alert",
  );
  const row = await ackState(idB);
  assertEquals(row.acknowledged_at, null, "cross-tenant write must not mutate");
});

Deno.test("g10 alert http H8: malformed write body -> 422", async () => {
  const f = fx();
  // acknowledge requires alertId (schema refine); omitted -> validation.
  assertDenied(
    await callFn(f.adminA.token, f.hospitalA, { action: "acknowledge" }),
    422,
    "VALIDATION_ERROR",
    "missing alertId",
  );
});

Deno.test("g10 alert http H9: already_* replay -> 200 soft-success, one activity", async () => {
  const f = fx();
  const id = await mkAlert(f.hospitalA, `h9_${RUN}`, "h9 replay");
  assertMutationOk(
    okData(
      await callFn(f.adminA.token, f.hospitalA, {
        action: "acknowledge",
        alertId: id,
      }),
    ),
    "acknowledge",
  );
  const replay = resultOf(
    okData(
      await callFn(f.adminA.token, f.hospitalA, {
        action: "acknowledge",
        alertId: id,
      }),
    ),
  );
  assertEquals(replay.ok, true);
  assertEquals(replay.already_acknowledged, true);
  assert(
    !("before" in replay) && !("after" in replay),
    "soft-success keeps existing semantics (no snapshot)",
  );
  assertEquals(
    await countActivity(id),
    1,
    "replay must not add an activity row",
  );
});

Deno.test("g10 alert http H10: concurrent writes serialize (both 200, one real)", async () => {
  const f = fx();
  const id = await mkAlert(f.hospitalA, `h10_${RUN}`, "h10 concurrent");
  const [ra, rb] = await Promise.all([
    callFn(f.adminA.token, f.hospitalA, {
      action: "acknowledge",
      alertId: id,
    }),
    callFn(f.adminA.token, f.hospitalA, {
      action: "acknowledge",
      alertId: id,
    }),
  ]);
  assertEquals(ra.status, 200);
  assertEquals(rb.status, 200);
  const already = [ra, rb].filter(
    (r) =>
      (r.json?.data as { result?: Record<string, unknown> })?.result
        ?.already_acknowledged === true,
  ).length;
  assertEquals(already, 1, "exactly one acknowledge reports already_*");
  assertEquals(await countActivity(id), 1, "serialized: one real transition");
});

Deno.test("g10 alert http H11: post-resolve acknowledge is permitted (D1)", async () => {
  const f = fx();
  const id = await mkAlert(f.hospitalA, `h11_${RUN}`, "h11 d1");
  assertMutationOk(
    okData(
      await callFn(f.adminA.token, f.hospitalA, {
        action: "resolve",
        alertId: id,
      }),
    ),
    "resolve",
  );
  // D1: RESOLVE is not terminal; ACK on a resolved alert succeeds (200).
  assertMutationOk(
    okData(
      await callFn(f.adminA.token, f.hospitalA, {
        action: "acknowledge",
        alertId: id,
      }),
    ),
    "acknowledge",
  );
  const row = await ackState(id);
  assertEquals(row.is_resolved, true);
  assertExists(row.acknowledged_at, "post-resolve ACK must persist (not D2)");
});

Deno.test("g10 alert http H12: activity rows equal real transitions", async () => {
  const f = fx();
  const id = await mkAlert(f.hospitalA, `h12_${RUN}`, "h12 audit");
  assertMutationOk(
    okData(
      await callFn(f.adminA.token, f.hospitalA, {
        action: "acknowledge",
        alertId: id,
      }),
    ),
    "acknowledge",
  );
  assertMutationOk(
    okData(
      await callFn(f.adminA.token, f.hospitalA, {
        action: "escalate",
        alertId: id,
      }),
    ),
    "escalate",
  );
  assertEquals(await countActivity(id), 2, "two real transitions -> two rows");
});

Deno.test("g10 alert http H13: lifecycle write queues no jobs", async () => {
  const f = fx();
  const id = await mkAlert(f.hospitalA, `h13_${RUN}`, "h13 side effects");
  const before = await countJobs();
  assertMutationOk(
    okData(
      await callFn(f.adminA.token, f.hospitalA, {
        action: "escalate",
        alertId: id,
      }),
    ),
    "escalate",
  );
  assertEquals(
    await countJobs(),
    before,
    "lifecycle mutation must not enqueue jobs / WhatsApp / financial work",
  );
});

Deno.test("g10 alert http H14: response carries no message/notes PII", async () => {
  const f = fx();
  const secret = `PIISECRET_${RUN}`;
  const noteSecret = `NOTESENTINEL_${RUN}`;
  const id = await mkAlert(f.hospitalA, `h14_${RUN}`, secret);
  const res = await callFn(f.adminA.token, f.hospitalA, {
    action: "resolve",
    alertId: id,
    notes: noteSecret,
  });
  const text = JSON.stringify(res.json);
  assert(
    !text.includes(secret),
    "snapshot/response must not echo alert_events.message",
  );
  assert(
    !text.includes(noteSecret),
    "snapshot/response must not echo resolution_notes",
  );
});

Deno.test("g10 alert http H15: DB 42501 -> 403 and unexpected DB fault -> 500", async () => {
  const { db } = await ctx();
  const f = fx();

  // (a) 42501 -> 403: remove the role grant so requireRole (which reads
  // user_roles) still passes but the RPC's has_permission raises 42501.
  const id15a = await mkAlert(f.hospitalA, `h15a_${RUN}`, "h15 privilege");
  const { error: delErr } = await db
    .from("role_permissions")
    .delete()
    .match({ role: "hospital_admin", permission: "MANAGE_HOSPITAL" });
  assertEquals(delErr, null);
  try {
    assertDenied(
      await callFn(f.adminA.token, f.hospitalA, {
        action: "acknowledge",
        alertId: id15a,
      }),
      403,
      "FORBIDDEN",
      "42501 must fail closed as 403, not 500",
    );
    assertEquals(
      (await ackState(id15a)).acknowledged_at,
      null,
      "privilege denial must not mutate",
    );
  } finally {
    await db.from("role_permissions").insert({
      role: "hospital_admin",
      permission: "MANAGE_HOSPITAL",
    });
  }

  // (b) unexpected DB fault -> 500: a scoped BEFORE-UPDATE trigger raises a
  // non-42501 exception, which must surface as 500 with no committed change.
  const id15b = await mkAlert(f.hospitalA, `h15b_${RUN}`, "h15 fault");
  await dbDdl(
    `CREATE OR REPLACE FUNCTION public.c2_http_500() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected db fault'; END $$;`,
  );
  await dbDdl(
    `CREATE TRIGGER c2_http_500_trg BEFORE UPDATE ON public.alert_events FOR EACH ROW WHEN (NEW.id = '${id15b}') EXECUTE FUNCTION public.c2_http_500();`,
  );
  try {
    const res = await callFn(f.adminA.token, f.hospitalA, {
      action: "acknowledge",
      alertId: id15b,
    });
    assertEquals(res.status, 500, "unexpected DB fault must surface 500");
    assertEquals(
      (await ackState(id15b)).acknowledged_at,
      null,
      "unexpected fault must roll back",
    );
  } finally {
    await dbDdl(
      `DROP TRIGGER IF EXISTS c2_http_500_trg ON public.alert_events;`,
    );
    await dbDdl(`DROP FUNCTION IF EXISTS public.c2_http_500();`);
  }
});

// ─── 9. Cleanup ──────────────────────────────────────────────────────────────

Deno.test("zz g10 alert http: cleanup removes fixture data", async () => {
  const { db } = await ctx();
  const f = F;
  if (!f || !LOCAL_STATUS) return;

  for (const a of [f.adminA, f.adminB, f.recepA, f.doctorA, f.globalAdmin]) {
    await db.from("user_roles").delete().eq("user_id", a.userId);
    await db.from("profiles").delete().eq("id", a.userId);
    try {
      await fetch(`${LOCAL_STATUS.API_URL}/auth/v1/admin/users/${a.userId}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${LOCAL_STATUS.SERVICE_ROLE_KEY}`,
        },
      });
    } catch {
      // Best-effort: leftover fixture users are inert test data.
    }
  }

  await db.from("hospitals").delete().in("id", [f.hospitalA, f.hospitalB]);
});
