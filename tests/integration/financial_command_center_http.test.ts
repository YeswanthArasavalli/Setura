/**
 * tests/integration/financial_command_center_http.test.ts
 *
 * Phase 7 G-09 — REAL HTTP-path coverage for the EXISTING
 * `financial-command-center` Edge Function.
 *
 * This is the evidence gap G-09 exists to close: the three financial read
 * RPCs (`get_financial_command_center` / `get_revenue_forecast` /
 * `get_reconciliation_summary`) are already proven
 *   - correct against fixtures by the SQL-level suite
 *     (`ent: financial command center reconciles exactly`), and
 *   - privilege-denied to direct client callers by
 *     `privilege: Category D RPCs are refused ...` in
 *     privilege_isolation.test.ts,
 * but NO test previously drove the actual Edge Function HTTP endpoint
 * (HTTP → auth → role gate → tenant resolution → service-role RPC →
 * response). This file does exactly that, against the real local runtime.
 *
 * It is REAL, not mocked: every case below POSTs to
 * `<API_URL>/functions/v1/financial-command-center` with a genuine GoTrue
 * password-grant JWT and the `X-Hospital-ID` header the contract requires.
 * No case substitutes a direct RPC call for the HTTP invocation.
 *
 * Scope discipline (§3/§24): this test only PROVES the existing contract.
 * It asserts the response shapes the function actually returns today and
 * never mutates a migration, grant, RLS policy or business rule. If any
 * case exposes a genuine backend defect the implementation must STOP and
 * report it rather than paper over it here.
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
const FIXTURE_PASSWORD = `G09-${RUN}-fixture-pass`;

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const TODAY = todayIso();

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

/** POST /functions/v1/financial-command-center over real HTTP. */
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
    `${LOCAL_STATUS.API_URL}/functions/v1/financial-command-center`,
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

/** Asserts the application error envelope carries the expected code. */
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

// ─── Direct PostgREST RPC (privilege boundary, §7) ───────────────────────────

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
 * result — the same discipline privilege_isolation.test.ts applies.
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

Deno.test("g09 fin http: setup fixture hospitals, actors, source data", async () => {
  const { db } = await ctx();

  const { data: hA, error: hAErr } = await db
    .from("hospitals")
    .insert({ name: `G09 Fin ${RUN} A`, slug: `g09-fin-${RUN}-a` })
    .select("id")
    .single();
  assertEquals(hAErr, null);
  const { data: hB, error: hBErr } = await db
    .from("hospitals")
    .insert({ name: `G09 Fin ${RUN} B`, slug: `g09-fin-${RUN}-b` })
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
    const email = `g09-${tag}-${RUN}@setura.test`;
    await createAuthUser(userId, email);
    const { error: pErr } = await db.from("profiles").upsert({
      id: userId,
      full_name: `G09 ${tag} ${RUN}`,
      normalized_phone: `97${RUN}${phoneSuffix}`,
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

  // One real collection at A so the overview carries non-zero server figures
  // (the RPC aggregates over the default day). A fresh tenant means the amount
  // below is the ONLY money at hospital A for this run.
  const { error: dceErr } = await db.from("daily_collection_entries").insert({
    hospital_id: hospitalA,
    collection_date: TODAY,
    booking_source: "online",
    total_amount: 4200,
    platform_fee: 400,
    hospital_fee: 3400,
    receptionist_fee: 400,
  });
  assertEquals(dceErr, null);

  F = { hospitalA, hospitalB, adminA, adminB, recepA, doctorA, globalAdmin };
});

// ─── 1. Hospital admin: all three supported read actions succeed ─────────────

Deno.test("g09 fin http: hospital admin overview returns server aggregates", async () => {
  const f = fx();
  const data = okData(
    await callFn(f.adminA.token, f.hospitalA, { action: "overview" }),
  );
  assertEquals(data.action, "overview");
  const financial = data.financial as Record<string, unknown>;
  assertExists(financial);
  assertEquals(financial.hospital_id, f.hospitalA);
  // The server owns the aggregation; the console only renders these.
  const daily = financial.daily_collections as Record<string, unknown>;
  assertExists(daily);
  assertExists(financial.settlement_intelligence);
  // The seeded collection is the only money at A for this run → non-zero.
  assert(
    Number(daily.total_collected) === 4200,
    `overview total_collected should reflect the fixture: got ${
      String(daily.total_collected)
    }`,
  );
});

Deno.test("g09 fin http: hospital admin forecast returns server projection", async () => {
  const f = fx();
  const data = okData(
    await callFn(f.adminA.token, f.hospitalA, { action: "forecast" }),
  );
  assertEquals(data.action, "forecast");
  const forecast = data.forecast as Record<string, unknown>;
  assertExists(forecast);
  assertEquals(forecast.hospital_id, f.hospitalA);
  assertExists(forecast.inputs);
});

Deno.test("g09 fin http: hospital admin reconciliation returns summary array", async () => {
  const f = fx();
  const data = okData(
    await callFn(f.adminA.token, f.hospitalA, { action: "reconciliation" }),
  );
  assertEquals(data.action, "reconciliation");
  // The RPC is set-returning → the function returns an array of rows.
  const reconciliation = data.reconciliation;
  assertExists(reconciliation);
  assert(Array.isArray(reconciliation));
});

Deno.test("g09 fin http: explicit date inputs are honored (overview/forecast)", async () => {
  const f = fx();
  const data = okData(
    await callFn(f.adminA.token, f.hospitalA, {
      action: "overview",
      date: TODAY,
    }),
  );
  const financial = data.financial as Record<string, unknown>;
  assertEquals(financial.date, TODAY);

  const recon = okData(
    await callFn(f.adminA.token, f.hospitalA, {
      action: "reconciliation",
      fromDate: TODAY,
      toDate: TODAY,
    }),
  );
  assert(Array.isArray(recon.reconciliation));
});

// ─── 2. Global admin follows the existing header contract (G-08 pattern) ─────

Deno.test("g09 fin http: global admin with a valid header is permitted", async () => {
  const f = fx();
  // The function validates `X-Hospital-ID` BEFORE auth and requireRole lets
  // global_admin through for any resolvable hospital. This mirrors the
  // established G-08 bounded acting-context mechanism — no tenant is invented
  // and no backend authorization is changed.
  const data = okData(
    await callFn(f.globalAdmin.token, f.hospitalA, { action: "overview" }),
  );
  assertEquals(data.action, "overview");
  assertExists(data.financial);
});

// ─── 3. Role gate: receptionist and doctor denied (app-level 403) ────────────

Deno.test("g09 fin http: receptionist is denied all three actions", async () => {
  const f = fx();
  for (
    const action of ["overview", "forecast", "reconciliation"] as const
  ) {
    assertErrorCode(
      await callFn(f.recepA.token, f.hospitalA, { action }),
      403,
      "ROLE_INSUFFICIENT",
    );
  }
});

Deno.test("g09 fin http: doctor is denied all three actions", async () => {
  const f = fx();
  for (
    const action of ["overview", "forecast", "reconciliation"] as const
  ) {
    assertErrorCode(
      await callFn(f.doctorA.token, f.hospitalA, { action }),
      403,
      "ROLE_INSUFFICIENT",
    );
  }
});

// ─── 4. Missing tenant header → existing validation contract (422) ──────────

Deno.test("g09 fin http: missing X-Hospital-ID is a validation error", async () => {
  const f = fx();
  // The header is checked before auth, so even a valid admin token yields 422.
  assertErrorCode(
    await callFn(f.adminA.token, null, { action: "overview" }),
    422,
    "VALIDATION_ERROR",
  );
});

// ─── 5. Anonymous → 401 ──────────────────────────────────────────────────────

Deno.test("g09 fin http: anonymous request is unauthorized", async () => {
  const f = fx();
  // A valid header is supplied so the request is not rejected for the header;
  // with no Authorization token the call must not return financial data.
  const res = await callFn(null, f.hospitalA, { action: "overview" });
  assertEquals(res.status, 401);
  // Per AGENTS.md F16-05: do not assume WHICH layer answered 401 (the edge
  // runtime JWT gate can reject before the handler). Only assert the honest
  // invariant: no success envelope and no data leaked.
  if (res.json) {
    assertEquals(res.json.success !== true, true);
    assertEquals(res.json.data, undefined);
  }
});

// ─── 6. Cross-tenant isolation (fail-closed) ────────────────────────────────

Deno.test("g09 fin http: hospital B admin cannot read hospital A finances", async () => {
  const f = fx();
  // adminB holds a grant only at hospitalB; presenting hospitalA's header
  // resolves no role there → fail-closed tenant denial before any RPC runs.
  assertErrorCode(
    await callFn(f.adminB.token, f.hospitalA, { action: "overview" }),
    403,
    "HOSPITAL_ACCESS_DENIED",
  );
});

// ─── 7. Direct RPC privilege boundary (architecture stays Function-only) ────

Deno.test("g09 fin http: client roles cannot call the financial RPCs directly", async () => {
  const f = fx();
  // Self-contained re-proof of the invariant the frontend relies on: a
  // browser (anonymous or an authenticated admin) must never reach the
  // service-role-only RPCs directly. The canonical broad census lives in
  // privilege_isolation.test.ts (Category D); this keeps the G-09 evidence
  // honest without depending on that suite having run in the same process.
  const directProbes: Array<[string, Record<string, unknown>]> = [
    ["get_financial_command_center", { p_hospital_id: f.hospitalA }],
    ["get_revenue_forecast", { p_hospital_id: f.hospitalA }],
    [
      "get_reconciliation_summary",
      { p_hospital_id: f.hospitalA, p_from_date: TODAY, p_to_date: TODAY },
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

Deno.test("zz g09 fin http: cleanup removes fixture data", async () => {
  const { db } = await ctx();
  const f = F;
  if (!f || !LOCAL_STATUS) return;

  await db.from("daily_collection_entries").delete().eq(
    "hospital_id",
    f.hospitalA,
  );

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
