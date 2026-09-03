/**
 * tests/integration/privilege_isolation.test.ts
 *
 * SECURITY REGRESSION SUITE — the database privilege boundary itself.
 *
 * This suite exists because of one specific attack shape:
 *
 *     Edge Function authorization
 *              |
 *              v  bypass
 *              |
 *       direct RPC call
 *
 * Every request in this file therefore goes straight to PostgREST with a
 * deliberately chosen role. No Edge Function is invoked, no authorization
 * is mocked, and nothing is stubbed: if the database does not defend
 * itself, these tests fail.
 *
 * How the role is pinned (this is the whole trick, so it is spelled out):
 *
 *   anon           apikey: <ANON_KEY>, no Authorization header.
 *                  PostgREST switches to `anon`.
 *   authenticated  apikey: <ANON_KEY> + Authorization: Bearer <user JWT>.
 *                  PostgREST switches to the JWT's `role` claim, which
 *                  GoTrue sets to `authenticated`.
 *   service_role   apikey: <SERVICE_ROLE_KEY> + Authorization: Bearer
 *                  <SERVICE_ROLE_KEY>. PostgREST switches to
 *                  `service_role`, which is what Edge Functions, the
 *                  workers and cron actually run as.
 *
 * The service_role half is not decoration. Migration 48 revokes EXECUTE
 * from anon and authenticated and grants it to service_role; a revoke
 * that also broke the worker path would be a regression, so every
 * category asserts BOTH directions.
 *
 * What is covered:
 *   1. Category A helpers stay callable by authenticated (RLS needs them).
 *   2. Category B/C/D privileged RPCs are refused for anon AND
 *      authenticated, and still work for service_role.
 *   3. Tenant isolation on the five hardened tables: hospital A must not
 *      see hospital B.
 *   4. D-4: system_settings and role_permissions are not anon-readable.
 *   5. Cross-hospital alert mutation is refused by the DATABASE (42501),
 *      not merely by the Edge layer.
 *
 * Residue policy: fire_managed_alert writes no audit_logs and nothing
 * here calls a financial mutation successfully, so the teardown test
 * removes every fixture row it created.
 *
 * Run with:  deno task test:integration
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

// ─── One-time bootstrap ──────────────────────────────────────────────────────

type Shared = Awaited<ReturnType<typeof bootstrap>>;

let _ctx: Shared | null = null;

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

  // The service client is used ONLY to build and tear down fixtures.
  // Every assertion below goes through the raw REST helpers so the
  // acting role is unambiguous.
  const { getServiceClient } = await import(
    "../../supabase/functions/_shared/db.ts"
  );
  return { db: getServiceClient(), status };
}

async function ctx(): Promise<Shared> {
  if (!_ctx) _ctx = await bootstrap();
  return _ctx;
}

// ─── Role-pinned PostgREST access ────────────────────────────────────────────

type CallerKind = "anon" | "authenticated" | "service";

interface Caller {
  kind: CallerKind;
  /** Appears in every assertion message. */
  label: string;
  /** Required for `authenticated`, ignored otherwise. */
  token?: string;
}

interface RestResult {
  status: number;
  body: unknown;
  raw: string;
}

function headersFor(caller: Caller, withBody: boolean): HeadersInit {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const h: Record<string, string> = { "Accept": "application/json" };
  if (withBody) h["Content-Type"] = "application/json";

  switch (caller.kind) {
    case "anon":
      // No Authorization header at all: PostgREST falls back to the
      // anon role. This is the unauthenticated internet.
      h["apikey"] = LOCAL_STATUS.ANON_KEY;
      break;
    case "authenticated":
      if (!caller.token) {
        throw new Error(`caller ${caller.label} has no JWT`);
      }
      h["apikey"] = LOCAL_STATUS.ANON_KEY;
      h["Authorization"] = `Bearer ${caller.token}`;
      break;
    case "service":
      h["apikey"] = LOCAL_STATUS.SERVICE_ROLE_KEY;
      h["Authorization"] = `Bearer ${LOCAL_STATUS.SERVICE_ROLE_KEY}`;
      break;
  }
  return h;
}

async function readResult(resp: Response): Promise<RestResult> {
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

/** POST /rest/v1/rpc/<fn> as exactly one role. */
async function rpcAs(
  caller: Caller,
  fn: string,
  args: Record<string, unknown> = {},
): Promise<RestResult> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const resp = await fetch(`${LOCAL_STATUS.API_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: headersFor(caller, true),
    body: JSON.stringify(args),
  });
  return await readResult(resp);
}

/** GET /rest/v1/<table>?<query> as exactly one role. */
async function selectAs(
  caller: Caller,
  table: string,
  query = "select=*",
): Promise<RestResult> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/rest/v1/${table}?${query}`,
    { method: "GET", headers: headersFor(caller, false) },
  );
  return await readResult(resp);
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
 * Asserts that a direct RPC call was refused by the DATABASE.
 *
 * A 404 is treated as a TEST defect rather than a pass. PostgREST answers
 * 404/PGRST202 when it cannot resolve the argument names, and a suite
 * that accepted that would report "denied" for a function it never
 * actually called — the exact false sense of security this remediation
 * is meant to remove.
 */
function assertRpcDenied(res: RestResult, what: string): void {
  const msg = messageOf(res);

  if (res.status === 404) {
    throw new Error(
      `${what}: PostgREST could not resolve the function (${msg}). ` +
        `This is a TEST DEFECT (wrong argument names), NOT a security ` +
        `result: the privilege boundary was never exercised.`,
    );
  }

  assert(
    res.status === 401 || res.status === 403,
    `${what}: expected 401/403 from the database, got ${res.status} (${msg})`,
  );

  const lower = msg.toLowerCase();
  assert(
    lower.includes("permission denied") ||
      lower.includes("insufficient") ||
      lower.includes("jwt") ||
      lower.includes("not authorized") ||
      lower.includes("42501"),
    `${what}: denied with ${res.status} but the reason does not look like ` +
      `a privilege failure: ${msg}`,
  );
}

/** Asserts the call was NOT refused, i.e. the worker path still works. */
function assertRpcAllowed(res: RestResult, what: string): void {
  const msg = messageOf(res);
  assert(
    res.status !== 401 && res.status !== 403,
    `${what}: service_role must retain EXECUTE, got ${res.status} (${msg})`,
  );
  assert(
    res.status !== 404,
    `${what}: PostgREST could not resolve the function (${msg}) — test ` +
      `defect, the signature in this suite does not match the migration.`,
  );
}

// ─── Per-run fixture isolation ───────────────────────────────────────────────

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "7");
const FIXTURE_PASSWORD = `PI-${RUN}-fixture-pass`;

const ALERT_KEY_A = `pi_open_${RUN}_a`;
const ALERT_KEY_B = `pi_open_${RUN}_b`;
const SUPPRESS_KEY_A = `pi_supp_${RUN}_a`;
const SUPPRESS_KEY_B = `pi_supp_${RUN}_b`;

interface Actor {
  userId: string;
  email: string;
  token: string;
  caller: Caller;
}

interface FixtureState {
  hospitalA: string;
  hospitalB: string;
  /** hospital_admin, primary at A. */
  adminA: Actor;
  /** hospital_admin, primary at B. The cross-tenant attacker. */
  adminB: Actor;
  /** receptionist, primary at A. Lowest-privilege authenticated user. */
  clerkA: Actor;
  /** global_admin (hospital_id IS NULL). */
  gadmin: Actor;
  sessionA: string;
  sessionB: string;
  alertA: string;
  alertB: string;
  eventA: string;
  eventB: string;
  activityA: string;
  activityB: string;
  suppressionA: string;
  suppressionB: string;
}

let F: FixtureState | null = null;

function fx(): FixtureState {
  if (!F) throw new Error("setup test did not run");
  return F;
}

const ANON: Caller = { kind: "anon", label: "anon" };
const SERVICE: Caller = { kind: "service", label: "service_role" };

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

async function deleteAuthUser(userId: string): Promise<void> {
  if (!LOCAL_STATUS) return;
  try {
    await fetch(`${LOCAL_STATUS.API_URL}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${LOCAL_STATUS.SERVICE_ROLE_KEY}` },
    });
  } catch {
    // Best-effort: a leftover fixture user is inert test data.
  }
}

// ─── 0. Setup ────────────────────────────────────────────────────────────────

Deno.test("privilege: setup two tenants with real tokens and real rows", async () => {
  const { db } = await ctx();

  const { data: hA, error: hAErr } = await db
    .from("hospitals")
    .insert({ name: `PI ${RUN} A`, slug: `pi-${RUN}-a` })
    .select("id")
    .single();
  assertEquals(hAErr, null);
  const { data: hB, error: hBErr } = await db
    .from("hospitals")
    .insert({ name: `PI ${RUN} B`, slug: `pi-${RUN}-b` })
    .select("id")
    .single();
  assertEquals(hBErr, null);
  assertExists(hA);
  assertExists(hB);
  const hospitalA = hA.id as string;
  const hospitalB = hB.id as string;

  type RoleName = "global_admin" | "hospital_admin" | "receptionist";

  async function actor(
    tag: string,
    phoneSuffix: string,
    role: RoleName,
    hospitalId: string | null,
  ): Promise<Actor> {
    const userId = crypto.randomUUID();
    const email = `pi-${tag}-${RUN}@setura.test`;
    await createAuthUser(userId, email);

    const { error: pErr } = await db.from("profiles").upsert({
      id: userId,
      full_name: `PI ${tag} ${RUN}`,
      normalized_phone: `96${RUN}${phoneSuffix}`,
    });
    assertEquals(pErr, null);

    const { error: rErr } = await db.from("user_roles").insert({
      user_id: userId,
      hospital_id: hospitalId,
      role,
      is_primary: true,
    });
    assertEquals(rErr, null, `grant ${role} for ${tag}`);

    const token = await tokenFor(email);
    return {
      userId,
      email,
      token,
      caller: { kind: "authenticated", label: `authenticated:${tag}`, token },
    };
  }

  const adminA = await actor("admina", "21", "hospital_admin", hospitalA);
  const adminB = await actor("adminb", "22", "hospital_admin", hospitalB);
  const clerkA = await actor("clerka", "23", "receptionist", hospitalA);
  const gadmin = await actor("gadmin", "24", "global_admin", null);

  // Queue sessions: queue_runtime_events.queue_session_id is NOT NULL and
  // FK-constrained, so a real session per hospital is required.
  const today = new Date().toISOString().slice(0, 10);
  const sessions: string[] = [];
  for (
    const [hid, doctor] of [[hospitalA, adminA], [hospitalB, adminB]] as Array<
      [string, Actor]
    >
  ) {
    const { data, error } = await db
      .from("queue_sessions")
      .insert({
        hospital_id: hid,
        doctor_id: doctor.userId,
        session_date: today,
        session_name: `PI ${RUN}`,
        max_tokens: 10,
      })
      .select("id")
      .single();
    assertEquals(error, null);
    assertExists(data);
    sessions.push(data.id as string);
  }

  // One runtime event per tenant. 'paused' is in the event_type CHECK list.
  const events: string[] = [];
  for (let i = 0; i < 2; i++) {
    const { data, error } = await db
      .from("queue_runtime_events")
      .insert({
        queue_session_id: sessions[i],
        hospital_id: i === 0 ? hospitalA : hospitalB,
        event_type: "paused",
        metadata: { run: RUN },
      })
      .select("id")
      .single();
    assertEquals(error, null);
    assertExists(data);
    events.push(data.id as string);
  }

  // Alerts come from the managed engine, not a raw insert, so the rows
  // look exactly like production rows. fire_managed_alert is service-only.
  const alerts: string[] = [];
  for (
    const [hid, key] of [[hospitalA, ALERT_KEY_A], [
      hospitalB,
      ALERT_KEY_B,
    ]] as Array<[string, string]>
  ) {
    const res = await rpcAs(SERVICE, "fire_managed_alert", {
      p_hospital_id: hid,
      p_alert_key: key,
      p_severity: "warning",
      p_current_value: 9,
      p_threshold_value: 5,
      p_threshold_unit: "count",
      p_message: `privilege fixture ${RUN}`,
      p_category: "operational",
    });
    assertRpcAllowed(res, "fire_managed_alert as service_role");
    assertExists(res.body, "fire_managed_alert returned no alert id");
    alerts.push(res.body as string);
  }

  // Activity rows and suppressions, one per tenant, so every isolation
  // assertion below has something it COULD leak.
  const activities: string[] = [];
  for (let i = 0; i < 2; i++) {
    const { data, error } = await db
      .from("alert_activity_log")
      .insert({
        alert_id: alerts[i],
        hospital_id: i === 0 ? hospitalA : hospitalB,
        actor_user_id: i === 0 ? adminA.userId : adminB.userId,
        action: "fixture_seeded",
        notes: `run ${RUN}`,
      })
      .select("id")
      .single();
    assertEquals(error, null);
    assertExists(data);
    activities.push(data.id as string);
  }

  const until = new Date(Date.now() + 3_600_000).toISOString();
  const suppressions: string[] = [];
  for (
    const [hid, key, actorId] of [
      [hospitalA, SUPPRESS_KEY_A, adminA.userId],
      [hospitalB, SUPPRESS_KEY_B, adminB.userId],
    ] as Array<[string, string, string]>
  ) {
    const { data, error } = await db
      .from("alert_suppressions")
      .insert({
        hospital_id: hid,
        alert_key: key,
        reason: `fixture ${RUN}`,
        active_until: until,
        created_by: actorId,
      })
      .select("id")
      .single();
    assertEquals(error, null);
    assertExists(data);
    suppressions.push(data.id as string);
  }

  F = {
    hospitalA,
    hospitalB,
    adminA,
    adminB,
    clerkA,
    gadmin,
    sessionA: sessions[0],
    sessionB: sessions[1],
    alertA: alerts[0],
    alertB: alerts[1],
    eventA: events[0],
    eventB: events[1],
    activityA: activities[0],
    activityB: activities[1],
    suppressionA: suppressions[0],
    suppressionB: suppressions[1],
  };
});

// ─── 1. Category A — the RLS helpers must stay reachable ─────────────────────

/**
 * Migration 48 section 3 keeps exactly four SECURITY DEFINER helpers
 * executable by anon and authenticated, because 193 RLS policies call
 * them. Revoking these would lock every legitimate user out, so the
 * suite proves they still work before proving anything is closed.
 */
Deno.test("privilege: Category A RLS helpers remain callable", async () => {
  const f = fx();
  await ctx();

  for (const caller of [ANON, f.adminA.caller, f.clerkA.caller]) {
    const res = await rpcAs(caller, "is_global_admin");
    assertEquals(
      res.status,
      200,
      `is_global_admin must stay callable by ${caller.label}: ` +
        `${res.status} ${messageOf(res)}`,
    );
  }

  // The helpers must also give the RIGHT answer for a real token, or the
  // grant is present but the function is broken.
  const role = await rpcAs(f.adminA.caller, "current_user_role", {
    p_hospital_id: f.hospitalA,
  });
  assertEquals(role.status, 200, messageOf(role));
  assertEquals(role.body, "hospital_admin");

  const accessOwn = await rpcAs(f.adminA.caller, "user_has_hospital_access", {
    p_hospital_id: f.hospitalA,
  });
  assertEquals(accessOwn.status, 200, messageOf(accessOwn));
  assertEquals(accessOwn.body, true);

  const accessOther = await rpcAs(f.adminA.caller, "user_has_hospital_access", {
    p_hospital_id: f.hospitalB,
  });
  assertEquals(accessOther.status, 200, messageOf(accessOther));
  assertEquals(accessOther.body, false, "helper leaked access to hospital B");

  const hasRole = await rpcAs(f.adminA.caller, "user_has_hospital_role", {
    p_hospital_id: f.hospitalA,
    p_roles: ["hospital_admin"],
  });
  assertEquals(hasRole.status, 200, messageOf(hasRole));
  assertEquals(hasRole.body, true);

  // anon must resolve to "no privilege", never to a default role.
  const anonGlobal = await rpcAs(ANON, "is_global_admin");
  assertEquals(anonGlobal.body, false, "anon must not be a global admin");
  const anonRole = await rpcAs(ANON, "current_user_role", {
    p_hospital_id: f.hospitalA,
  });
  assertEquals(anonRole.status, 200, messageOf(anonRole));
  assertEquals(anonRole.body, null, "anon must resolve to NULL role");
});

// ─── 2. Category D — financial and security-sensitive RPCs ───────────────────

interface Probe {
  fn: string;
  args: Record<string, unknown>;
  /** true when calling it for real would write. Never sent as service_role. */
  mutating: boolean;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function weekAgoIso(): string {
  return new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Every Category D routine from docs/security/RPC_PRIVILEGE_CLASSIFICATION.tsv.
 *
 * All parameters are always sent, even the ones that have defaults. That
 * is deliberate: PostgREST resolves overloads by the payload key set, and
 * a partial payload can either resolve to a different overload or be
 * rejected as ambiguous, either of which would make the denial assertion
 * meaningless.
 *
 * The one function that cannot be addressed unambiguously here is the
 * 4-argument capture_payment overload: any 4-key payload also matches the
 * 5-argument overload through its default, so PostgREST cannot be forced
 * to pick it. Both overloads are revoked and verified at the catalog
 * level by migration 48 (section 4 grants, section 11 check 3); the
 * 5-argument form is probed over the wire below.
 */
const CATEGORY_D: Probe[] = [
  {
    fn: "calculate_refund_amount",
    args: {
      p_booking_id: "00000000-0000-4000-8000-000000000001",
      p_cancellation_time: new Date().toISOString(),
    },
    mutating: false,
  },
  {
    fn: "capture_payment",
    args: {
      p_gateway_order_id: "order_privilege_probe",
      p_gateway_payment_id: "pay_privilege_probe",
      p_gateway_signature: "deadbeef",
      p_gateway_response: {},
      p_gateway_fee_inr: 0,
    },
    mutating: true,
  },
  {
    fn: "confirm_refund_processed",
    args: {
      p_refund_id: "00000000-0000-4000-8000-000000000002",
      p_gateway_refund_id: "rfnd_privilege_probe",
      p_gateway_response: {},
    },
    mutating: true,
  },
  {
    fn: "create_hospital_settlement",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-000000000003",
      p_start_date: weekAgoIso(),
      p_end_date: todayIso(),
      p_collected_by: "00000000-0000-4000-8000-000000000004",
    },
    mutating: true,
  },
  {
    fn: "create_platform_revenue_summary",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-000000000005",
      p_start_date: weekAgoIso(),
      p_end_date: todayIso(),
      p_performed_by: "00000000-0000-4000-8000-000000000006",
    },
    mutating: true,
  },
  {
    fn: "current_user_has_permission",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-000000000007",
      p_permission: "MANAGE_HOSPITAL",
    },
    mutating: false,
  },
  {
    fn: "generate_audit_log_partition_ddl",
    args: { p_months: 1 },
    mutating: false,
  },
  {
    fn: "get_audit_coverage_report",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-000000000008",
      p_from_date: weekAgoIso(),
      p_to_date: todayIso(),
    },
    mutating: false,
  },
  {
    fn: "get_booking_fee",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-000000000009",
      p_booking_source: "online",
    },
    mutating: false,
  },
  {
    fn: "get_effective_fees",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-00000000000a",
      p_booking_source: "online",
    },
    mutating: false,
  },
  {
    fn: "get_financial_command_center",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-00000000000b",
      p_date: todayIso(),
    },
    mutating: false,
  },
  {
    fn: "get_platform_revenue_breakdown",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-00000000000c",
      p_from_date: weekAgoIso(),
      p_to_date: todayIso(),
    },
    mutating: false,
  },
  {
    fn: "get_reconciliation_summary",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-00000000000d",
      p_from_date: weekAgoIso(),
      p_to_date: todayIso(),
    },
    mutating: false,
  },
  {
    fn: "get_revenue_forecast",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-00000000000e",
      p_date: todayIso(),
    },
    mutating: false,
  },
  {
    fn: "get_user_permissions",
    args: { p_hospital_id: "00000000-0000-4000-8000-00000000000f" },
    mutating: false,
  },
  {
    fn: "has_permission",
    args: {
      p_user_id: "00000000-0000-4000-8000-000000000010",
      p_hospital_id: "00000000-0000-4000-8000-000000000011",
      p_permission: "MANAGE_HOSPITAL",
    },
    mutating: false,
  },
  {
    fn: "idempotent_capture_payment",
    args: {
      p_provider_event_id: "evt_privilege_probe",
      p_payload_hash: "hash_privilege_probe",
      p_raw_payload: {},
      p_gateway_order_id: "order_privilege_probe",
      p_gateway_payment_id: "pay_privilege_probe",
      p_gateway_signature: "deadbeef",
    },
    mutating: true,
  },
  {
    fn: "initiate_refund",
    args: {
      p_booking_id: "00000000-0000-4000-8000-000000000012",
      p_refund_amount_inr: 1,
      p_refund_reason: "privilege probe",
      p_initiated_by: "00000000-0000-4000-8000-000000000013",
    },
    mutating: true,
  },
  {
    fn: "record_settlement_payment",
    args: {
      p_settlement_id: "00000000-0000-4000-8000-000000000014",
      p_paid_amount: 1,
      p_performed_by: "00000000-0000-4000-8000-000000000015",
    },
    mutating: true,
  },
  {
    fn: "search_audit_logs",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-000000000016",
      p_actor_id: null,
      p_entity_type: null,
      p_action_type: null,
      p_from_ts: new Date(Date.now() - 86_400_000).toISOString(),
      p_to_ts: new Date().toISOString(),
      p_correlation_id: null,
      p_limit: 1,
    },
    mutating: false,
  },
  {
    fn: "verify_audit_integrity",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-000000000017",
      p_from_ts: new Date(Date.now() - 86_400_000).toISOString(),
    },
    mutating: false,
  },
  {
    fn: "verify_settlement_integrity",
    args: { p_hospital_id: "00000000-0000-4000-8000-000000000018" },
    mutating: false,
  },
  {
    fn: "write_audit_log",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-000000000019",
      p_actor_id: null,
      p_entity_type: "privilege_probe",
      p_entity_id: "00000000-0000-4000-8000-00000000001a",
      p_action: "CONFIG_UPDATE",
      p_severity: "low",
      p_old_data: null,
      p_new_data: null,
      p_notes: "privilege probe must never be written",
      p_metadata: null,
    },
    mutating: true,
  },
];

Deno.test("privilege: Category D RPCs are refused for anon", async () => {
  await ctx();
  for (const p of CATEGORY_D) {
    const res = await rpcAs(ANON, p.fn, p.args);
    assertRpcDenied(res, `anon -> ${p.fn}`);
  }
});

Deno.test("privilege: Category D RPCs are refused for authenticated", async () => {
  const f = fx();
  // Both a hospital_admin and a receptionist: the point is that NO
  // authenticated role reaches these, not merely that low roles do not.
  for (const caller of [f.adminA.caller, f.clerkA.caller]) {
    for (const p of CATEGORY_D) {
      const res = await rpcAs(caller, p.fn, p.args);
      assertRpcDenied(res, `${caller.label} -> ${p.fn}`);
    }
  }
});

Deno.test("privilege: Category D refusal wrote nothing", async () => {
  const { db } = await ctx();
  // write_audit_log was probed 3 times above. If the revoke had failed,
  // an audit row would exist for it — and audit_logs is append-only, so
  // this is the assertion that proves the denial happened BEFORE the
  // function body ran.
  const { data, error } = await db
    .from("audit_logs")
    .select("id")
    .eq("entity_type", "privilege_probe");
  assertEquals(error, null);
  assertEquals(
    (data ?? []).length,
    0,
    "a denied write_audit_log call still wrote an audit row",
  );
});

Deno.test("privilege: Category D read-only RPCs still work for service_role", async () => {
  const f = fx();
  const probes: Array<[string, Record<string, unknown>]> = [
    ["get_financial_command_center", {
      p_hospital_id: f.hospitalA,
      p_date: todayIso(),
    }],
    ["get_reconciliation_summary", {
      p_hospital_id: f.hospitalA,
      p_from_date: weekAgoIso(),
      p_to_date: todayIso(),
    }],
    ["get_platform_revenue_breakdown", {
      p_hospital_id: f.hospitalA,
      p_from_date: weekAgoIso(),
      p_to_date: todayIso(),
    }],
    ["get_revenue_forecast", {
      p_hospital_id: f.hospitalA,
      p_date: todayIso(),
    }],
    ["verify_settlement_integrity", { p_hospital_id: f.hospitalA }],
    ["get_booking_fee", {
      p_hospital_id: f.hospitalA,
      p_booking_source: "online",
    }],
    ["get_effective_fees", {
      p_hospital_id: f.hospitalA,
      p_booking_source: "online",
    }],
    ["has_permission", {
      p_user_id: f.adminA.userId,
      p_hospital_id: f.hospitalA,
      p_permission: "MANAGE_HOSPITAL",
    }],
    ["get_audit_coverage_report", {
      p_hospital_id: f.hospitalA,
      p_from_date: weekAgoIso(),
      p_to_date: todayIso(),
    }],
    ["generate_audit_log_partition_ddl", { p_months: 1 }],
  ];

  for (const [fn, args] of probes) {
    const res = await rpcAs(SERVICE, fn, args);
    assertRpcAllowed(res, `service_role -> ${fn}`);
    assertEquals(
      res.status,
      200,
      `service_role -> ${fn} should succeed: ${res.status} ${messageOf(res)}`,
    );
  }

  // And the answer must be real, not an empty shell.
  const perm = await rpcAs(SERVICE, "has_permission", {
    p_user_id: f.adminA.userId,
    p_hospital_id: f.hospitalA,
    p_permission: "MANAGE_HOSPITAL",
  });
  assertEquals(perm.body, true, "hospital_admin lost MANAGE_HOSPITAL");
});

// ─── 3. Category C — administrative / global scope ────────────────────────────

const CATEGORY_C: Probe[] = [
  {
    fn: "change_subscription_plan",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-000000000020",
      p_new_plan_name: "growth",
      p_billing_cycle: "monthly",
      p_performed_by: "00000000-0000-4000-8000-000000000021",
    },
    mutating: true,
  },
  {
    fn: "compute_global_metrics",
    args: { p_report_date: todayIso() },
    mutating: true,
  },
  {
    fn: "generate_executive_report",
    args: {
      p_report_type: "operations",
      p_hospital_id: "00000000-0000-4000-8000-000000000022",
      p_from_date: weekAgoIso(),
      p_to_date: todayIso(),
    },
    mutating: false,
  },
  {
    fn: "get_cross_hospital_benchmarks",
    args: { p_from_date: weekAgoIso(), p_to_date: todayIso() },
    mutating: false,
  },
  {
    fn: "get_portfolio_dashboard",
    args: { p_date: todayIso() },
    mutating: false,
  },
  {
    fn: "get_subscription_limits",
    args: { p_hospital_id: "00000000-0000-4000-8000-000000000023" },
    mutating: false,
  },
  {
    fn: "get_subscription_usage",
    args: { p_hospital_id: "00000000-0000-4000-8000-000000000024" },
    mutating: false,
  },
  {
    fn: "is_subscription_active",
    args: { p_hospital_id: "00000000-0000-4000-8000-000000000025" },
    mutating: false,
  },
  {
    fn: "record_subscription_usage",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-000000000026",
      p_metric: "bookings",
      p_increment: 1,
    },
    mutating: true,
  },
  {
    fn: "sync_subscription_usage",
    args: { p_hospital_id: "00000000-0000-4000-8000-000000000027" },
    mutating: true,
  },
];

Deno.test("privilege: Category C RPCs are refused for anon and authenticated", async () => {
  const f = fx();
  // The global admin is included on purpose. Category C is global-scope
  // administration, and the mandate is explicit that the database
  // boundary must hold even for a privileged user: authorization for
  // these belongs to the Edge layer running as service_role, so a
  // global_admin JWT hitting PostgREST directly must still be refused.
  for (const caller of [ANON, f.adminA.caller, f.gadmin.caller]) {
    for (const p of CATEGORY_C) {
      const res = await rpcAs(caller, p.fn, p.args);
      assertRpcDenied(res, `${caller.label} -> ${p.fn}`);
    }
  }
});

Deno.test("privilege: Category C RPCs still work for service_role", async () => {
  const f = fx();
  const probes: Array<[string, Record<string, unknown>]> = [
    ["get_portfolio_dashboard", { p_date: todayIso() }],
    ["get_cross_hospital_benchmarks", {
      p_from_date: weekAgoIso(),
      p_to_date: todayIso(),
    }],
    ["get_subscription_limits", { p_hospital_id: f.hospitalA }],
    ["get_subscription_usage", { p_hospital_id: f.hospitalA }],
    ["is_subscription_active", { p_hospital_id: f.hospitalA }],
  ];
  for (const [fn, args] of probes) {
    const res = await rpcAs(SERVICE, fn, args);
    assertRpcAllowed(res, `service_role -> ${fn}`);
    assertEquals(
      res.status,
      200,
      `service_role -> ${fn} should succeed: ${res.status} ${messageOf(res)}`,
    );
  }
});

// ─── 4. Category B — edge / worker / cron internals ──────────────────────────

const CATEGORY_B: Probe[] = [
  {
    fn: "get_hospital_command_center",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-000000000030",
      p_date: todayIso(),
    },
    mutating: false,
  },
  {
    fn: "get_daily_operations_dashboard",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-000000000031",
      p_date: todayIso(),
    },
    mutating: false,
  },
  {
    fn: "get_alert_center",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-000000000032",
      p_status: "open",
      p_severity: null,
      p_category: null,
      p_limit: 10,
    },
    mutating: false,
  },
  {
    fn: "get_queue_snapshot",
    args: { p_queue_session_id: "00000000-0000-4000-8000-000000000033" },
    mutating: false,
  },
  {
    fn: "advance_queue",
    args: { p_queue_session_id: "00000000-0000-4000-8000-000000000034" },
    mutating: true,
  },
  {
    fn: "acknowledge_alert",
    args: {
      p_alert_id: "00000000-0000-4000-8000-000000000035",
      p_actor_id: "00000000-0000-4000-8000-000000000036",
    },
    mutating: true,
  },
  {
    fn: "fire_managed_alert",
    args: {
      p_hospital_id: "00000000-0000-4000-8000-000000000037",
      p_alert_key: "privilege_probe",
      p_severity: "warning",
      p_current_value: 1,
      p_threshold_value: 0,
      p_threshold_unit: "count",
      p_message: "privilege probe",
      p_category: "operational",
    },
    mutating: true,
  },
];

Deno.test("privilege: Category B internal RPCs are refused for anon and authenticated", async () => {
  const f = fx();
  for (const caller of [ANON, f.adminA.caller, f.clerkA.caller]) {
    for (const p of CATEGORY_B) {
      const res = await rpcAs(caller, p.fn, p.args);
      assertRpcDenied(res, `${caller.label} -> ${p.fn}`);
    }
  }
});

Deno.test("privilege: Category B RPCs still work for service_role", async () => {
  const f = fx();
  const probes: Array<[string, Record<string, unknown>]> = [
    ["get_hospital_command_center", {
      p_hospital_id: f.hospitalA,
      p_date: todayIso(),
    }],
    ["get_daily_operations_dashboard", {
      p_hospital_id: f.hospitalA,
      p_date: todayIso(),
    }],
    ["get_alert_center", {
      p_hospital_id: f.hospitalA,
      p_status: "open",
      p_severity: null,
      p_category: null,
      p_limit: 10,
    }],
    ["get_queue_snapshot", { p_queue_session_id: f.sessionA }],
  ];
  for (const [fn, args] of probes) {
    const res = await rpcAs(SERVICE, fn, args);
    assertRpcAllowed(res, `service_role -> ${fn}`);
    assertEquals(
      res.status,
      200,
      `service_role -> ${fn} should succeed: ${res.status} ${messageOf(res)}`,
    );
  }
});

// ─── 5. INVOKER operational functions (migration 48 section 7) ───────────────

Deno.test("privilege: INVOKER operational functions are service-only", async () => {
  const f = fx();
  const probes: Array<[string, Record<string, unknown>]> = [
    ["get_queue_health", {}],
    ["get_mv_refresh_health", {}],
    ["get_stuck_jobs", { p_stuck_threshold_minutes: 10 }],
    ["is_hospital_online", { p_hospital_id: f.hospitalA }],
    ["is_alert_suppressed", {
      p_hospital_id: f.hospitalA,
      p_alert_key: SUPPRESS_KEY_A,
    }],
  ];

  for (const caller of [ANON, f.adminA.caller]) {
    for (const [fn, args] of probes) {
      const res = await rpcAs(caller, fn, args);
      assertRpcDenied(res, `${caller.label} -> ${fn}`);
    }
  }

  for (const [fn, args] of probes) {
    const res = await rpcAs(SERVICE, fn, args);
    assertRpcAllowed(res, `service_role -> ${fn}`);
    assertEquals(
      res.status,
      200,
      `service_role -> ${fn} should succeed: ${res.status} ${messageOf(res)}`,
    );
  }

  // The suppression seeded for hospital A must be visible to the engine
  // and must not be reported for hospital B.
  const suppA = await rpcAs(SERVICE, "is_alert_suppressed", {
    p_hospital_id: f.hospitalA,
    p_alert_key: SUPPRESS_KEY_A,
  });
  assertEquals(suppA.body, true);
  const suppCross = await rpcAs(SERVICE, "is_alert_suppressed", {
    p_hospital_id: f.hospitalB,
    p_alert_key: SUPPRESS_KEY_A,
  });
  assertEquals(
    suppCross.body,
    false,
    "hospital A's suppression leaked into hospital B",
  );
});

// ─── 6. Tenant isolation on the five hardened tables ─────────────────────────

function assertTableDenied(res: RestResult, what: string): void {
  const msg = messageOf(res);
  assert(
    res.status === 401 || res.status === 403,
    `${what}: expected 401/403 from the database, got ${res.status} (${msg})`,
  );
  const lower = msg.toLowerCase();
  assert(
    lower.includes("permission denied") || lower.includes("42501") ||
      lower.includes("jwt") || lower.includes("no suitable key"),
    `${what}: denied with ${res.status} but the reason does not look like ` +
      `a privilege failure: ${msg}`,
  );
}

function rowsOf(
  res: RestResult,
  what: string,
): Array<Record<string, unknown>> {
  assertEquals(res.status, 200, `${what}: ${messageOf(res)}`);
  assert(Array.isArray(res.body), `${what}: expected a row array`);
  return res.body as Array<Record<string, unknown>>;
}

/**
 * whatsapp_conversation_states holds patient conversation state and had
 * `ALL` granted to anon before migration 48. It has no legitimate
 * client-side reader, so the hardening is a full grant removal rather
 * than a policy: the assertion is at the GRANT level and needs no rows.
 */
Deno.test("isolation: whatsapp_conversation_states is unreachable by clients", async () => {
  const f = fx();

  for (const caller of [ANON, f.adminA.caller, f.gadmin.caller]) {
    const res = await selectAs(
      caller,
      "whatsapp_conversation_states",
      "select=id&limit=1",
    );
    assertTableDenied(res, `${caller.label} -> whatsapp_conversation_states`);
  }

  // The worker path must survive the revoke.
  const svc = await selectAs(
    SERVICE,
    "whatsapp_conversation_states",
    "select=id&limit=1",
  );
  assertEquals(
    svc.status,
    200,
    `service_role lost access to whatsapp_conversation_states: ` +
      `${messageOf(svc)}`,
  );
});

/**
 * queue_runtime_events carried `queue_events_read USING (true)` from
 * migration 43 together with an anon ALL grant, so every tenant's
 * operational event stream was world-readable. Migration 48 replaces the
 * policy with a hospital-scoped one built from the SAME tenant-resolution
 * helpers the rest of SETURA uses (is_global_admin / user_has_hospital_access).
 */
Deno.test("isolation: queue_runtime_events is scoped to the caller's hospital", async () => {
  const f = fx();

  const anonRes = await selectAs(
    ANON,
    "queue_runtime_events",
    "select=id&limit=1",
  );
  assertTableDenied(anonRes, "anon -> queue_runtime_events");

  const aRows = rowsOf(
    await selectAs(
      f.adminA.caller,
      "queue_runtime_events",
      "select=id,hospital_id",
    ),
    "adminA -> queue_runtime_events",
  );
  assert(
    aRows.some((r) => r.id === f.eventA),
    "hospital A admin cannot see hospital A's own event",
  );
  for (const r of aRows) {
    assertEquals(
      r.hospital_id,
      f.hospitalA,
      "queue_runtime_events leaked another tenant to hospital A",
    );
  }

  const bRows = rowsOf(
    await selectAs(
      f.adminB.caller,
      "queue_runtime_events",
      "select=id,hospital_id",
    ),
    "adminB -> queue_runtime_events",
  );
  assert(
    bRows.some((r) => r.id === f.eventB),
    "hospital B admin cannot see hospital B's own event",
  );
  assert(
    !bRows.some((r) => r.id === f.eventA),
    "hospital B READ hospital A's queue event — tenant isolation broken",
  );

  // Targeting the other tenant's row by primary key must also return
  // nothing: RLS, not a client-side filter, is doing the work.
  const targeted = rowsOf(
    await selectAs(
      f.adminB.caller,
      "queue_runtime_events",
      `select=id&id=eq.${f.eventA}`,
    ),
    "adminB -> queue_runtime_events by A's id",
  );
  assertEquals(targeted.length, 0, "direct PK fetch crossed the tenant line");

  // Global admin retains the portfolio view.
  const gRows = rowsOf(
    await selectAs(
      f.gadmin.caller,
      "queue_runtime_events",
      "select=id,hospital_id",
    ),
    "gadmin -> queue_runtime_events",
  );
  assert(
    gRows.some((r) => r.id === f.eventA) &&
      gRows.some((r) => r.id === f.eventB),
    "global admin lost the cross-hospital view",
  );
});

/**
 * analytics_refresh_logs has NO hospital_id column, so there is nothing
 * to scope by; the only correct boundary is global-admin-only.
 */
Deno.test("isolation: analytics_refresh_logs is global-admin only", async () => {
  const f = fx();
  const { db } = await ctx();

  const marker = `pi-fixture-${RUN}`;
  const { data: seeded, error: seedErr } = await db
    .from("analytics_refresh_logs")
    .insert({
      success: true,
      refresh_completed_at: new Date().toISOString(),
      error_message: marker,
    })
    .select("id")
    .single();
  assertEquals(seedErr, null);
  assertExists(seeded);

  const anonRes = await selectAs(
    ANON,
    "analytics_refresh_logs",
    "select=id&limit=1",
  );
  assertTableDenied(anonRes, "anon -> analytics_refresh_logs");

  for (const actor of [f.adminA, f.adminB, f.clerkA]) {
    const rows = rowsOf(
      await selectAs(
        actor.caller,
        "analytics_refresh_logs",
        `select=id&error_message=eq.${marker}`,
      ),
      `${actor.caller.label} -> analytics_refresh_logs`,
    );
    assertEquals(
      rows.length,
      0,
      `${actor.caller.label} read a platform analytics log`,
    );
  }

  const gRows = rowsOf(
    await selectAs(
      f.gadmin.caller,
      "analytics_refresh_logs",
      `select=id&error_message=eq.${marker}`,
    ),
    "gadmin -> analytics_refresh_logs",
  );
  assertEquals(gRows.length, 1, "global admin lost the analytics log view");

  await db.from("analytics_refresh_logs").delete().eq("id", seeded.id);
});

Deno.test("isolation: alert_activity_log and alert_suppressions are hospital scoped", async () => {
  const f = fx();

  for (const table of ["alert_activity_log", "alert_suppressions"]) {
    const anonRes = await selectAs(ANON, table, "select=id&limit=1");
    assertTableDenied(anonRes, `anon -> ${table}`);
  }

  const actA = rowsOf(
    await selectAs(
      f.adminA.caller,
      "alert_activity_log",
      "select=id,hospital_id",
    ),
    "adminA -> alert_activity_log",
  );
  assert(
    actA.some((r) => r.id === f.activityA),
    "hospital A admin cannot see its own alert activity",
  );
  for (const r of actA) {
    assertEquals(r.hospital_id, f.hospitalA, "alert_activity_log leaked");
  }

  const actB = rowsOf(
    await selectAs(
      f.adminB.caller,
      "alert_activity_log",
      `select=id&id=eq.${f.activityA}`,
    ),
    "adminB -> alert_activity_log by A's id",
  );
  assertEquals(
    actB.length,
    0,
    "hospital B READ hospital A's alert activity — isolation broken",
  );

  const supA = rowsOf(
    await selectAs(
      f.adminA.caller,
      "alert_suppressions",
      "select=id,hospital_id,alert_key",
    ),
    "adminA -> alert_suppressions",
  );
  assert(
    supA.some((r) => r.alert_key === SUPPRESS_KEY_A),
    "hospital A admin cannot see its own suppression",
  );
  assert(
    !supA.some((r) => r.alert_key === SUPPRESS_KEY_B),
    "hospital A READ hospital B's suppression — isolation broken",
  );

  const supB = rowsOf(
    await selectAs(
      f.adminB.caller,
      "alert_suppressions",
      `select=id&id=eq.${f.suppressionA}`,
    ),
    "adminB -> alert_suppressions by A's id",
  );
  assertEquals(supB.length, 0, "direct PK fetch crossed the tenant line");
});

Deno.test("isolation: alert_events is not client-readable across tenants", async () => {
  const f = fx();

  const anonRes = await selectAs(ANON, "alert_events", "select=id&limit=1");
  assertTableDenied(anonRes, "anon -> alert_events");

  // Migration 24's alert_events policies are global-admin only, so a
  // hospital admin sees nothing at all through PostgREST. Alert data
  // reaches hospital staff via get_alert_center, which runs as
  // service_role inside an Edge Function that has already authorized.
  const aRows = rowsOf(
    await selectAs(
      f.adminA.caller,
      "alert_events",
      `select=id&id=eq.${f.alertA}`,
    ),
    "adminA -> alert_events",
  );
  assertEquals(aRows.length, 0, "alert_events became client-readable");

  const gRows = rowsOf(
    await selectAs(
      f.gadmin.caller,
      "alert_events",
      `select=id&id=in.(${f.alertA},${f.alertB})`,
    ),
    "gadmin -> alert_events",
  );
  assertEquals(gRows.length, 2, "global admin lost the alert_events view");
});

// ─── 7. D-4 — system_settings and role_permissions ───────────────────────────

/**
 * Product decision D-4. system_settings held GST configuration, gateway
 * fee configuration and internal operational settings behind
 * `system_settings_read USING (true)` plus an anon grant, i.e. the entire
 * table was published to anyone holding the anon key.
 *
 * The fix is removal, not a new public surface: the only repository
 * consumer is supabase/functions/_shared/phone.ts, which reads
 * default_country_code through the SERVICE client. This test therefore
 * asserts both halves — sensitive settings are unreachable
 * anonymously, and the one real consumer's path still works.
 */
Deno.test("d4: system_settings cannot be read anonymously", async () => {
  const f = fx();

  const anonAll = await selectAs(ANON, "system_settings", "select=*");
  assertTableDenied(anonAll, "anon -> system_settings");

  // Targeting individual sensitive keys must fail the same way, so the
  // denial cannot be an artifact of selecting every column. These are the
  // real keys present in the seeded table: GST configuration, the Razorpay
  // gateway fee, and the platform fee.
  for (
    const key of [
      "gst_percentage_default",
      "gst_enabled_platform",
      "razorpay_gateway_fee_pct",
      "default_platform_fee_online",
      "default_country_code",
    ]
  ) {
    const res = await selectAs(
      ANON,
      "system_settings",
      `select=key,value&key=eq.${key}`,
    );
    assertTableDenied(res, `anon -> system_settings[${key}]`);
    assert(
      !res.raw.includes('"value"'),
      `anon received a system_settings value for ${key}`,
    );
  }

  // An ordinary authenticated user sees zero rows: the grant exists so a
  // global admin console can work, RLS does the filtering.
  for (const actor of [f.adminA, f.clerkA]) {
    const rows = rowsOf(
      await selectAs(actor.caller, "system_settings", "select=key"),
      `${actor.caller.label} -> system_settings`,
    );
    assertEquals(
      rows.length,
      0,
      `${actor.caller.label} read system_settings`,
    );
  }

  // The real consumer runs as service_role and must keep working.
  const svc = rowsOf(
    await selectAs(
      SERVICE,
      "system_settings",
      "select=key,value&key=eq.default_country_code",
    ),
    "service_role -> system_settings",
  );
  assertEquals(
    svc.length,
    1,
    "phone.ts would break: default_country_code is unreadable by service_role",
  );
});

Deno.test("d4: role_permissions (the authorization matrix) is not public", async () => {
  const f = fx();

  const anonRes = await selectAs(ANON, "role_permissions", "select=*");
  assertTableDenied(anonRes, "anon -> role_permissions");
  assert(
    !anonRes.raw.includes("MANAGE_HOSPITAL"),
    "anon received the permission matrix",
  );

  const rows = rowsOf(
    await selectAs(f.adminA.caller, "role_permissions", "select=role"),
    "adminA -> role_permissions",
  );
  assertEquals(rows.length, 0, "hospital admin read the permission matrix");

  // The SECURITY DEFINER consumers still resolve permissions correctly,
  // which is what makes the table grant unnecessary.
  const perm = await rpcAs(SERVICE, "has_permission", {
    p_user_id: f.adminA.userId,
    p_hospital_id: f.hospitalA,
    p_permission: "MANAGE_HOSPITAL",
  });
  assertEquals(perm.status, 200, messageOf(perm));
  assertEquals(
    perm.body,
    true,
    "revoking the table grant broke has_permission",
  );
});

// ─── 8. Cross-hospital alert mutation must fail in the DATABASE ──────────────

function assertNotAuthorized(res: RestResult, what: string): void {
  const msg = messageOf(res);
  assert(
    res.status === 401 || res.status === 403 || res.status === 400,
    `${what}: expected a rejection, got ${res.status} (${msg})`,
  );
  assert(
    msg.includes("not_authorized"),
    `${what}: rejected with ${res.status} but not by the authorization ` +
      `guard: ${msg}`,
  );
}

/**
 * These RPCs are service_role-only after migration 48, so they are called
 * here exactly as an Edge Function calls them: as service_role, with
 * p_actor_id naming the acting user. That is the point — the guard being
 * tested lives in the FUNCTION, so a compromised or buggy Edge Function
 * that passes the wrong actor still cannot mutate another tenant's alert.
 */
Deno.test("alerts: cross-hospital mutation is refused by the database", async () => {
  const f = fx();

  // Hospital B's admin against hospital A's alert.
  assertNotAuthorized(
    await rpcAs(SERVICE, "acknowledge_alert", {
      p_alert_id: f.alertA,
      p_actor_id: f.adminB.userId,
    }),
    "adminB acknowledge_alert(alertA)",
  );
  assertNotAuthorized(
    await rpcAs(SERVICE, "assign_alert", {
      p_alert_id: f.alertA,
      p_assignee_id: f.adminB.userId,
      p_actor_id: f.adminB.userId,
    }),
    "adminB assign_alert(alertA)",
  );
  assertNotAuthorized(
    await rpcAs(SERVICE, "escalate_alert", {
      p_alert_id: f.alertA,
      p_actor_id: f.adminB.userId,
      p_notes: "cross tenant",
    }),
    "adminB escalate_alert(alertA)",
  );
  assertNotAuthorized(
    await rpcAs(SERVICE, "resolve_alert", {
      p_alert_id: f.alertA,
      p_actor_id: f.adminB.userId,
      p_notes: "cross tenant",
    }),
    "adminB resolve_alert(alertA)",
  );

  // A receptionist at the RIGHT hospital also lacks MANAGE_HOSPITAL, so
  // the guard is a permission check, not merely a tenant check.
  assertNotAuthorized(
    await rpcAs(SERVICE, "acknowledge_alert", {
      p_alert_id: f.alertA,
      p_actor_id: f.clerkA.userId,
    }),
    "clerkA acknowledge_alert(alertA)",
  );

  // Nothing above may have mutated the alert.
  const { db } = await ctx();
  const { data: untouched, error: uErr } = await db
    .from("alert_events")
    .select("acknowledged_at, assigned_to, escalated_at, is_resolved")
    .eq("id", f.alertA)
    .single();
  assertEquals(uErr, null);
  assertExists(untouched);
  assertEquals(untouched.acknowledged_at, null, "rejected call still acked");
  assertEquals(untouched.assigned_to, null, "rejected call still assigned");
  assertEquals(untouched.escalated_at, null, "rejected call still escalated");
  assertEquals(untouched.is_resolved, false, "rejected call still resolved");
});

Deno.test("alerts: the legitimate hospital admin path still works", async () => {
  const f = fx();

  const ack = await rpcAs(SERVICE, "acknowledge_alert", {
    p_alert_id: f.alertA,
    p_actor_id: f.adminA.userId,
  });
  assertEquals(ack.status, 200, messageOf(ack));
  assertEquals(
    (ack.body as Record<string, unknown>).ok,
    true,
    `adminA must be able to acknowledge its own alert: ${messageOf(ack)}`,
  );

  const assign = await rpcAs(SERVICE, "assign_alert", {
    p_alert_id: f.alertA,
    p_assignee_id: f.adminA.userId,
    p_actor_id: f.adminA.userId,
  });
  assertEquals((assign.body as Record<string, unknown>).ok, true);

  const resolve = await rpcAs(SERVICE, "resolve_alert", {
    p_alert_id: f.alertA,
    p_actor_id: f.adminA.userId,
    p_notes: "handled",
  });
  assertEquals((resolve.body as Record<string, unknown>).ok, true);

  // Global admin acts across hospitals by design (has_permission matches
  // on role = 'global_admin' regardless of hospital).
  const esc = await rpcAs(SERVICE, "escalate_alert", {
    p_alert_id: f.alertB,
    p_actor_id: f.gadmin.userId,
    p_notes: "platform escalation",
  });
  assertEquals(esc.status, 200, messageOf(esc));
  assertEquals(
    (esc.body as Record<string, unknown>).ok,
    true,
    "global admin lost cross-hospital alert authority",
  );

  // A missing alert is reported as a result, not as an authorization
  // failure, and must not reveal anything else.
  const missing = await rpcAs(SERVICE, "acknowledge_alert", {
    p_alert_id: "00000000-0000-4000-8000-0000000000ff",
    p_actor_id: f.adminA.userId,
  });
  assertEquals(missing.status, 200, messageOf(missing));
  const mBody = missing.body as Record<string, unknown>;
  assertEquals(mBody.ok, false);
  assertEquals(mBody.reason, "alert_not_found");
});

const CREATED_SUPPRESSION_KEYS: string[] = [];

Deno.test("alerts: suppress_alerts enforces scope before it reports anything", async () => {
  const f = fx();
  const until = new Date(Date.now() + 3_600_000).toISOString();

  const crossKey = `pi_cross_${RUN}`;
  assertNotAuthorized(
    await rpcAs(SERVICE, "suppress_alerts", {
      p_alert_key: crossKey,
      p_active_until: until,
      p_actor_id: f.adminB.userId,
      p_hospital_id: f.hospitalA,
      p_reason: "cross tenant",
    }),
    "adminB suppress_alerts(hospitalA)",
  );

  assertNotAuthorized(
    await rpcAs(SERVICE, "suppress_alerts", {
      p_alert_key: crossKey,
      p_active_until: until,
      p_actor_id: f.clerkA.userId,
      p_hospital_id: f.hospitalA,
      p_reason: "no permission",
    }),
    "clerkA suppress_alerts(hospitalA)",
  );

  // A NULL hospital_id is PLATFORM-WIDE suppression. A hospital admin
  // must not reach it: has_permission(actor, NULL, ...) matches only the
  // global_admin row, so this is refused by the same guard.
  assertNotAuthorized(
    await rpcAs(SERVICE, "suppress_alerts", {
      p_alert_key: crossKey,
      p_active_until: until,
      p_actor_id: f.adminA.userId,
      p_hospital_id: null,
      p_reason: "attempted global suppression",
    }),
    "adminA suppress_alerts(global scope)",
  );

  // Nothing was written by any of the three rejected calls.
  const { db } = await ctx();
  const { data: none, error: nErr } = await db
    .from("alert_suppressions")
    .select("id")
    .eq("alert_key", crossKey);
  assertEquals(nErr, null);
  assertEquals(
    (none ?? []).length,
    0,
    "a rejected suppress_alerts call still inserted a row",
  );

  // The owning hospital admin may suppress its own scope.
  const ownKey = `pi_own_${RUN}`;
  const own = await rpcAs(SERVICE, "suppress_alerts", {
    p_alert_key: ownKey,
    p_active_until: until,
    p_actor_id: f.adminA.userId,
    p_hospital_id: f.hospitalA,
    p_reason: "own scope",
  });
  assertEquals(own.status, 200, messageOf(own));
  const ownBody = own.body as Record<string, unknown>;
  assertEquals(ownBody.ok, true, `own-scope suppression failed: ${own.raw}`);
  assertExists(ownBody.suppression_id);
  CREATED_SUPPRESSION_KEYS.push(ownKey);

  // The global admin may suppress platform-wide.
  const globalKey = `pi_global_${RUN}`;
  const global = await rpcAs(SERVICE, "suppress_alerts", {
    p_alert_key: globalKey,
    p_active_until: until,
    p_actor_id: f.gadmin.userId,
    p_hospital_id: null,
    p_reason: "platform scope",
  });
  assertEquals(global.status, 200, messageOf(global));
  assertEquals(
    (global.body as Record<string, unknown>).ok,
    true,
    `global-scope suppression failed: ${global.raw}`,
  );
  CREATED_SUPPRESSION_KEYS.push(globalKey);

  // A window that already closed is rejected as data, not as privilege —
  // proving the authorization check runs FIRST and independently.
  const pastKey = `pi_past_${RUN}`;
  const past = await rpcAs(SERVICE, "suppress_alerts", {
    p_alert_key: pastKey,
    p_active_until: new Date(Date.now() - 3_600_000).toISOString(),
    p_actor_id: f.adminA.userId,
    p_hospital_id: f.hospitalA,
    p_reason: "past window",
  });
  assertEquals(past.status, 200, messageOf(past));
  const pastBody = past.body as Record<string, unknown>;
  assertEquals(pastBody.ok, false);
  assertEquals(pastBody.reason, "window_in_past");
});

// ─── 9. Teardown ─────────────────────────────────────────────────────────────

Deno.test("privilege: teardown removes every fixture row", async () => {
  const f = fx();
  const { db } = await ctx();

  const alertIds = [f.alertA, f.alertB];
  await db.from("alert_activity_log").delete().in("alert_id", alertIds);
  await db.from("alert_suppressions").delete().in("alert_key", [
    SUPPRESS_KEY_A,
    SUPPRESS_KEY_B,
    ...CREATED_SUPPRESSION_KEYS,
  ]);
  await db.from("alert_events").delete().in("id", alertIds);
  await db.from("queue_runtime_events").delete().in("id", [f.eventA, f.eventB]);
  await db.from("queue_sessions").delete().in("id", [f.sessionA, f.sessionB]);

  const actors = [f.adminA, f.adminB, f.clerkA, f.gadmin];
  const userIds = actors.map((a) => a.userId);
  await db.from("user_roles").delete().in("user_id", userIds);
  await db.from("profiles").delete().in("id", userIds);
  for (const id of userIds) await deleteAuthUser(id);

  await db.from("hospitals").delete().in("id", [f.hospitalA, f.hospitalB]);

  const { data: leftover, error } = await db
    .from("hospitals")
    .select("id")
    .in("id", [f.hospitalA, f.hospitalB]);
  assertEquals(error, null);
  assertEquals((leftover ?? []).length, 0, "fixture hospitals survived");
});
