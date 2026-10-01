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

// ─── 8. Cleanup ──────────────────────────────────────────────────────────────

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
