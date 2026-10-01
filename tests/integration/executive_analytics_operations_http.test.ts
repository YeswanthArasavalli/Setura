/**
 * tests/integration/executive_analytics_operations_http.test.ts
 *
 * Phase 7 G-11 — REAL HTTP-path coverage for the EXISTING `executive-analytics`
 * Edge Function, restricted to the two TENANT-SCOPED READ actions the new
 * frontend surface reaches: `daily_operations` and `doctor_rankings`.
 *
 * The backend is UNMODIFIED by G-11 (investigation §15/§16): the RPCs
 * (`get_daily_operations_dashboard` / `get_doctor_rankings`) already exist
 * (migration 47), are already proven service-role-only for client roles
 * (privilege_isolation.test.ts) and already covered for aggregate correctness
 * (enterprise_command_center.test.ts). What was NOT previously driven
 * end-to-end over real HTTP for these two actions is the full path the G-11
 * frontend actually uses:
 *   HTTP → Edge Function → header check → authentication → role gate →
 *   tenant resolution → service-role RPC → server response.
 * This file does exactly that, against the real local runtime. It is REAL,
 * not mocked: every case POSTs to `<API_URL>/functions/v1/executive-analytics`
 * with a genuine GoTrue password-grant JWT and the `X-Hospital-ID` header the
 * contract requires. No case substitutes a direct RPC call for the HTTP
 * invocation (the direct probes only ADD the privilege-boundary regression
 * check), and no case exercises any other action — `portfolio` /
 * `benchmarks` are G-08's and `weekly_operations` / `monthly_executive` /
 * `doctor_performance` are out of this surface's boundary (§3/§4).
 *
 * Empty-data truthfulness (§16/§37): a fresh fixture tenant has no bookings,
 * so the daily dashboard's hourly trend and the rankings arrays are
 * legitimately empty and the `ROUND(AVG(...))` / rate fields are NULL. The
 * RPCs `COALESCE` the arrays to `[]`, so the HTTP reads must still succeed
 * with a well-formed response. This suite asserts the response CONTRACT and
 * the authorization matrix; it never seeds bookings and never requires a
 * mutating migration — the reads are STABLE and side-effect-free.
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
const FIXTURE_PASSWORD = `G11-${RUN}-fixture-pass`;

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

/** POST /functions/v1/executive-analytics over real HTTP. */
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
    `${LOCAL_STATUS.API_URL}/functions/v1/executive-analytics`,
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
 * Asserts the read-path denial is a real application-level fail-closed
 * refusal. A 500 here would be a backend authorization defect (same P3-01
 * discipline as the G-10 suite): raised explicitly so the gate is loud —
 * STOP, never paper over it in the frontend.
 */
function assertDenied(
  res: { status: number; json: Record<string, unknown> | null },
  status: number,
  code: string,
  what: string,
): void {
  if (res.status >= 500) {
    throw new Error(
      `BACKEND AUTHORIZATION DEFECT — ${what}: read-path denial returned ` +
        `${res.status} (expected fail-closed ${status} ${code}), not an ` +
        `application refusal. STOP; do not build a frontend on it. ` +
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

// ─── Direct PostgREST RPC (privilege boundary regression, §24) ──────────────

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
 * result — the same discipline privilege_isolation.test.ts and the G-09/G-10
 * suites apply (F16-05: do not accept a non-database rejection as proof).
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

// ─── PII walk (§25) ──────────────────────────────────────────────────────────

/** Patient-level key fragments that must never appear in an analytics
 *  response, at ANY nesting depth. The RPCs are aggregate over bookings and
 *  select only hours, counts, doctor ids and rates — never a patient column. */
const PII_KEY_FRAGMENTS = [
  "patient",
  "name",
  "phone",
  "email",
  "address",
  "mrn",
  "medical",
  "diagnosis",
  "notes",
] as const;

function collectKeys(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectKeys(item, out);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      out.push(key);
      collectKeys(value, out);
    }
  }
}

function assertNoPatientPii(payload: unknown, what: string): void {
  const keys: string[] = [];
  collectKeys(payload, keys);
  for (const key of keys) {
    const lower = key.toLowerCase();
    for (const fragment of PII_KEY_FRAGMENTS) {
      assert(
        !lower.includes(fragment),
        `${what}: analytics response exposed a patient-level key ` +
          `'${key}' (matched '${fragment}') — STOP per §25.`,
      );
    }
  }
}

// ─── 0. Setup ────────────────────────────────────────────────────────────────

Deno.test("g11 operations http: setup fixture hospitals and actors", async () => {
  const { db } = await ctx();

  const { data: hA, error: hAErr } = await db
    .from("hospitals")
    .insert({ name: `G11 Ops ${RUN} A`, slug: `g11-ops-${RUN}-a` })
    .select("id")
    .single();
  assertEquals(hAErr, null);
  const { data: hB, error: hBErr } = await db
    .from("hospitals")
    .insert({ name: `G11 Ops ${RUN} B`, slug: `g11-ops-${RUN}-b` })
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
    const email = `g11-${tag}-${RUN}@setura.test`;
    await createAuthUser(userId, email);
    const { error: pErr } = await db.from("profiles").upsert({
      id: userId,
      full_name: `G11 ${tag} ${RUN}`,
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

  // No `bookings` are seeded: the two actions are tenant-scoped STABLE reads
  // over whatever the tenant has, and a fresh tenant legitimately aggregates
  // to empty arrays and NULL rates (§16/§37). The suite proves the READ PATH
  // and authorization matrix, not aggregate values (those are
  // enterprise_command_center.test.ts's job).
  F = { hospitalA, hospitalB, adminA, adminB, recepA, doctorA, globalAdmin };
});

// ─── 1. Hospital admin: both tenant-scoped reads succeed with the contract ───

Deno.test("g11 operations http: hospital admin daily_operations returns server-shaped dashboard", async () => {
  const f = fx();
  const data = okData(
    await callFn(f.adminA.token, f.hospitalA, { action: "daily_operations" }),
  );
  assertEquals(data.action, "daily_operations");
  const dashboard = data.dashboard as Record<string, unknown>;
  assertExists(dashboard, "daily_operations must return the RPC dashboard");
  // The echoed tenant is the header's hospital — server-side scoping, not a
  // client filter.
  assertEquals(dashboard.hospital_id, f.hospitalA);
  assert(
    Array.isArray(dashboard.hourly_trend),
    `hourly_trend must be an array, got ${typeof dashboard.hourly_trend}`,
  );
  const ops = dashboard.operations as Record<string, unknown>;
  assertExists(ops, "operations must be present");
  for (
    const key of [
      "total_bookings",
      "completed",
      "cancellation_rate_pct",
      "no_show_rate_pct",
      "avg_wait_minutes",
      "avg_consultation_minutes",
    ]
  ) {
    assert(key in ops, `operations is missing the server field '${key}'`);
  }
  // A fresh tenant: real zero counts, NULL rates (division by NULLIF(0,0)).
  assertEquals(Number(ops.total_bookings), 0);
  assertEquals(Number(ops.completed), 0);
  assert("sla" in dashboard, "sla key must be present (may be null)");
});

Deno.test("g11 operations http: hospital admin doctor_rankings returns server-shaped rankings", async () => {
  const f = fx();
  const data = okData(
    await callFn(f.adminA.token, f.hospitalA, { action: "doctor_rankings" }),
  );
  assertEquals(data.action, "doctor_rankings");
  const rankings = data.rankings as Record<string, unknown>;
  assertExists(rankings, "doctor_rankings must return the RPC payload");
  assertEquals(rankings.hospital_id, f.hospitalA);
  assert(
    Array.isArray(rankings.rankings),
    `rankings must be an array, got ${typeof rankings.rankings}`,
  );
  assert(
    Array.isArray(rankings.utilization_heatmap),
    `utilization_heatmap must be an array, got ${typeof rankings
      .utilization_heatmap}`,
  );
  // Backend defaults (CURRENT_DATE - 29 → CURRENT_DATE) apply when the body
  // carries no dates — echoed back by the RPC, never invented by the client.
  assertExists(rankings.from_date);
  assertExists(rankings.to_date);
});

Deno.test("g11 operations http: date parameters map through the HTTP path", async () => {
  const f = fx();
  // daily_operations takes ONE date (§14): an explicit day is accepted and
  // echoed by the server.
  const daily = okData(
    await callFn(f.adminA.token, f.hospitalA, {
      action: "daily_operations",
      date: "2020-01-01",
    }),
  );
  assertEquals(
    (daily.dashboard as Record<string, unknown>).date,
    "2020-01-01",
  );

  // doctor_rankings takes a from/to window; absent bounds fall to the RPC
  // defaults rather than a browser-invented range.
  const ranged = okData(
    await callFn(f.adminA.token, f.hospitalA, {
      action: "doctor_rankings",
      fromDate: "2020-01-01",
      toDate: "2020-12-31",
    }),
  );
  const rangedData = ranged.rankings as Record<string, unknown>;
  assertEquals(rangedData.from_date, "2020-01-01");
  assertEquals(rangedData.to_date, "2020-12-31");

  const halfOpen = okData(
    await callFn(f.adminA.token, f.hospitalA, {
      action: "doctor_rankings",
      toDate: "2020-06-30",
    }),
  );
  assertEquals(
    (halfOpen.rankings as Record<string, unknown>).to_date,
    "2020-06-30",
  );
});

// ─── 2. Global admin acts against ONE hospital context (no aggregation) ─────

Deno.test("g11 operations http: global admin with a valid acting context is permitted", async () => {
  const f = fx();
  // `X-Hospital-ID` is checked before auth and `resolveAuth` lets a
  // global_admin act with no grant at the hospital (the no-native-tenant
  // seeded reality). This mirrors the established G-08/G-09/G-10 bounded
  // acting-context mechanism. The response is scoped to the ONE acting
  // hospital — `hospital_id` echo proves it is NOT an all-hospitals
  // aggregate (§18/§27).
  const daily = okData(
    await callFn(f.globalAdmin.token, f.hospitalA, {
      action: "daily_operations",
    }),
  );
  assertEquals(daily.action, "daily_operations");
  assertEquals(
    (daily.dashboard as Record<string, unknown>).hospital_id,
    f.hospitalA,
  );

  const rankings = okData(
    await callFn(f.globalAdmin.token, f.hospitalA, {
      action: "doctor_rankings",
    }),
  );
  assertEquals(rankings.action, "doctor_rankings");
  assertEquals(
    (rankings.rankings as Record<string, unknown>).hospital_id,
    f.hospitalA,
  );
});

// ─── 3. Role gate: receptionist and doctor denied (app-level 403) ────────────

Deno.test("g11 operations http: receptionist is denied both read actions (403, not 500)", async () => {
  const f = fx();
  for (const action of ["daily_operations", "doctor_rankings"] as const) {
    assertDenied(
      await callFn(f.recepA.token, f.hospitalA, { action }),
      403,
      "ROLE_INSUFFICIENT",
      `receptionist ${action}`,
    );
  }
});

Deno.test("g11 operations http: doctor is denied both read actions (403, not 500)", async () => {
  const f = fx();
  for (const action of ["daily_operations", "doctor_rankings"] as const) {
    assertDenied(
      await callFn(f.doctorA.token, f.hospitalA, { action }),
      403,
      "ROLE_INSUFFICIENT",
      `doctor ${action}`,
    );
  }
});

// ─── 4. Missing tenant header → existing validation contract (422) ──────────

Deno.test("g11 operations http: missing X-Hospital-ID is a validation error", async () => {
  const f = fx();
  // The header is checked before auth, so even a valid admin token yields 422.
  const res = await callFn(f.adminA.token, null, {
    action: "daily_operations",
  });
  assertDenied(res, 422, "VALIDATION_ERROR", "missing X-Hospital-ID");
});

// ─── 5. Anonymous → 401 ──────────────────────────────────────────────────────

Deno.test("g11 operations http: anonymous request is unauthorized", async () => {
  const f = fx();
  // A valid header is supplied so the request is not rejected for the header;
  // with no Authorization token the call must not return analytics data.
  const res = await callFn(null, f.hospitalA, { action: "daily_operations" });
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

Deno.test("g11 operations http: tenant A admin cannot read tenant B analytics", async () => {
  const f = fx();
  // adminA holds a grant only at hospitalA; presenting hospitalB's header
  // resolves no role there → fail-closed tenant denial BEFORE any RPC runs.
  // This is a real tenant denial, not a JWT-layer 401: the actor is fully
  // authenticated and authorized as a hospital_admin, yet refused for the
  // other tenant specifically (§26).
  for (const action of ["daily_operations", "doctor_rankings"] as const) {
    const res = await callFn(f.adminA.token, f.hospitalB, { action });
    assertDenied(res, 403, "HOSPITAL_ACCESS_DENIED", `adminA -> B ${action}`);
    // No cross-tenant payload may leak even inside the failure envelope.
    assertEquals(res.json?.data, undefined);
  }
});

Deno.test("g11 operations http: tenant B admin cannot read tenant A analytics", async () => {
  const f = fx();
  for (const action of ["daily_operations", "doctor_rankings"] as const) {
    const res = await callFn(f.adminB.token, f.hospitalA, { action });
    assertDenied(res, 403, "HOSPITAL_ACCESS_DENIED", `adminB -> A ${action}`);
    assertEquals(res.json?.data, undefined);
  }
});

// ─── 7. PII safety of the actual returned payloads (§25) ────────────────────

Deno.test("g11 operations http: responses carry no patient-level fields", async () => {
  const f = fx();
  const daily = okData(
    await callFn(f.adminA.token, f.hospitalA, { action: "daily_operations" }),
  );
  assertNoPatientPii(daily.dashboard, "daily_operations");

  const rankings = okData(
    await callFn(f.adminA.token, f.hospitalA, { action: "doctor_rankings" }),
  );
  assertNoPatientPii(rankings.rankings, "doctor_rankings");
});

// ─── 8. Direct RPC privilege boundary (Function-only architecture stands) ───

Deno.test("g11 operations http: client roles cannot call the analytics RPCs directly", async () => {
  const f = fx();
  // Self-contained re-proof of the invariant the G-11 frontend relies on: a
  // browser (anonymous or an authenticated admin) must never reach the
  // service-role-only analytics RPCs directly. The canonical broad census
  // lives in privilege_isolation.test.ts; this keeps the G-11 evidence honest
  // without depending on that suite having run in the same process.
  const directProbes: Array<[string, Record<string, unknown>]> = [
    ["get_daily_operations_dashboard", { p_hospital_id: f.hospitalA }],
    [
      "get_doctor_rankings",
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

// ─── 9. Cleanup ──────────────────────────────────────────────────────────────

Deno.test("zz g11 operations http: cleanup removes fixture data", async () => {
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
