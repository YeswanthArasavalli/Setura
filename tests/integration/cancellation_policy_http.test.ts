/**
 * tests/integration/cancellation_policy_http.test.ts
 *
 * WS-CONF-1 - REAL HTTP-path coverage for the `cancellation-policy` Edge
 * Function, end-to-end against the live local runtime:
 *   HTTP -> resolveAuth(JWT + X-Hospital-ID) -> requireRole(['global_admin',
 *   'hospital_admin']) -> parseBody(discriminated union on mode) ->
 *   (read: get_cancellation_policy RPC |
 *    update: Idempotency-Key gate -> api_idempotency_keys registry ->
 *    withIdempotency -> update_cancellation_policy RPC -> logAuditEvent
 *    inside the handler) -> server-authoritative response.
 *
 * Every case POSTs to <API_URL>/functions/v1/cancellation-policy with a
 * genuine GoTrue password-grant JWT and the correct X-Hospital-ID header.
 * No case substitutes a direct RPC call for the HTTP invocation. The
 * Edge-layer concerns the DB suite cannot reach - JWT + role gating, the
 * tenant cross-check at resolveAuth, the missing Idempotency-Key 400, replay
 * returning the stored version + a single audit event, SQLSTATE P0001 mapped
 * to HTTP 409 DB_CONCURRENCY_ERROR and SQLSTATE 22023 / strict-Zod refusals
 * mapped to HTTP 422 - are exactly what this file proves.
 *
 * Run with:  deno task test:integration
 * (requires `supabase start` AND the Edge Runtime actually serving; verify
 *  the runtime is up before trusting a result - F16-01).
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

  const { getServiceClient } = await import(
    "../../supabase/functions/_shared/db.ts"
  );
  return { db: getServiceClient() };
}

async function ctx(): Promise<Shared> {
  if (!_ctx) _ctx = await bootstrap();
  return _ctx;
}

// deno-lint-ignore no-explicit-any
type AnyClient = any;

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "9");
const FIXTURE_PASSWORD = `P72H-${RUN}-fixture-pass`;

interface Actor {
  userId: string;
  email: string;
  token: string;
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
  return json.access_token!;
}

async function fixtureActor(
  tag: string,
  role: "global_admin" | "hospital_admin" | "doctor",
  hospitalId: string | null,
  phoneSuffix: string,
): Promise<Actor> {
  const { db } = await ctx();
  const userId = crypto.randomUUID();
  const email = `p72h-${tag}-${RUN}@setura.test`;
  await createAuthUser(userId, email);
  const { error: pErr } = await (db.from as AnyClient)("profiles").upsert({
    id: userId,
    full_name: `P72H ${tag} ${RUN}`,
    normalized_phone: `98${RUN}${phoneSuffix}`,
  });
  assertEquals(pErr, null);
  const { error: rErr } = await (db.from as AnyClient)("user_roles").insert({
    user_id: userId,
    hospital_id: hospitalId,
    role,
    is_primary: true,
  });
  assertEquals(rErr, null);
  return { userId, email, token: await tokenFor(email) };
}

async function provisionAs(
  actorId: string,
  name: string,
  slug: string,
): Promise<string> {
  const { db } = await ctx();
  const { data, error } = await (db.rpc as AnyClient)("provision_hospital", {
    p_actor_user_id: actorId,
    p_name: name,
    p_slug: slug,
  });
  assertEquals(error, null, `provision failed: ${JSON.stringify(error)}`);
  const id = (data as { hospital_id: string }).hospital_id;
  assertExists(id);
  return id;
}

interface HttpResult {
  status: number;
  json: Record<string, unknown> | null;
}

/** POST /functions/v1/cancellation-policy over real HTTP. */
async function callPolicy(
  token: string | null,
  hospitalId: string | null,
  idempotencyKey: string | null,
  body: Record<string, unknown>,
): Promise<HttpResult> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (hospitalId) headers["X-Hospital-ID"] = hospitalId;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/functions/v1/cancellation-policy`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
  const text = await resp.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Non-JSON body (gateway refusal) - status is still checked.
  }
  return { status: resp.status, json };
}

function errCode(json: Record<string, unknown> | null): string | undefined {
  if (!json) return undefined;
  const err = json.error as { code?: string } | undefined;
  return err?.code;
}

async function policyRow(
  hospitalId: string,
): Promise<Record<string, unknown> | null> {
  const { db } = await ctx();
  const { data } = await (db.from as AnyClient)("cancellation_policies")
    .select("*")
    .eq("hospital_id", hospitalId)
    .maybeSingle();
  return (data ?? null) as Record<string, unknown> | null;
}

async function historyCount(hospitalId: string): Promise<number> {
  const { db } = await ctx();
  const { count } = await (db.from as AnyClient)("cancellation_policy_history")
    .select("id", { count: "exact", head: true })
    .eq("hospital_id", hospitalId);
  return count ?? 0;
}

async function auditCountFor(hospitalId: string): Promise<number> {
  const { db } = await ctx();
  const { count } = await (db.from as AnyClient)("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("action_type", "cancellation_policy_update")
    .eq("entity_id", hospitalId);
  return count ?? 0;
}

interface FixtureState {
  globalAdmin: Actor;
  adminA: Actor;
  adminB: Actor;
  doctorA: Actor;
  hospitalA: string;
  hospitalB: string;
}

let F: FixtureState | null = null;

function fx(): FixtureState {
  if (!F) throw new Error("setup test not run");
  return F;
}

// ─── 0. Setup ────────────────────────────────────────────────────────────────

Deno.test("p72http: setup two tenants + global/hospital admin + doctor fixtures", async () => {
  const globalAdmin = await fixtureActor("ga", "global_admin", null, "01");
  const hospitalA = await provisionAs(
    globalAdmin.userId,
    `P72H A ${RUN}`,
    `p72http-a-${RUN}`,
  );
  const hospitalB = await provisionAs(
    globalAdmin.userId,
    `P72H B ${RUN}`,
    `p72http-b-${RUN}`,
  );
  const adminA = await fixtureActor("ha-a", "hospital_admin", hospitalA, "02");
  const adminB = await fixtureActor("ha-b", "hospital_admin", hospitalB, "03");
  const doctorA = await fixtureActor("dr-a", "doctor", hospitalA, "04");
  F = { globalAdmin, adminA, adminB, doctorA, hospitalA, hospitalB };
});

// ─── 1. Read happy path ─────────────────────────────────────────────────────

Deno.test("p72http: hospital_admin reads their own tenant policy (200)", async () => {
  const f = fx();
  const res = await callPolicy(f.adminA.token, f.hospitalA, null, {
    mode: "read",
  });
  assertEquals(res.status, 200, `body: ${JSON.stringify(res.json)}`);
  assertExists(res.json);
  assertEquals(res.json!.success, true);
  const data = res.json!.data as Record<string, unknown>;
  assertExists(data);
  assertEquals(data.hospitalId, f.hospitalA);
  assertEquals(data.version, 1, "fresh tenant policy row starts at version 1");
  const policy = data.policy as Record<string, unknown>;
  assertExists(policy, "policy snapshot present");
  assertEquals(policy.full_refund_within_minutes, 30, "schema default window");
  assertExists(data.history, "history array present");
  assertEquals((data.history as unknown[]).length, 0, "no prior versions yet");
});

Deno.test("p72http: global_admin reads ANY tenant policy (200)", async () => {
  const f = fx();
  const res = await callPolicy(f.globalAdmin.token, f.hospitalB, null, {
    mode: "read",
  });
  assertEquals(res.status, 200, `body: ${JSON.stringify(res.json)}`);
  const data = res.json!.data as Record<string, unknown>;
  assertEquals(data.hospitalId, f.hospitalB);
});

// ─── 2. Update happy path (version bump + row persists + history + audit) ───

Deno.test("p72http: hospital_admin update bumps version, lands columns, records history + audit", async () => {
  const f = fx();
  const key = crypto.randomUUID();
  const res = await callPolicy(f.adminA.token, f.hospitalA, key, {
    mode: "update",
    expectedVersion: 1,
    patch: {
      full_refund_within_minutes: 45,
      same_day_refund_percentage: 25,
      notes: "HTTP-suite window",
    },
  });
  assertEquals(res.status, 200, `body: ${JSON.stringify(res.json)}`);
  const data = res.json!.data as Record<string, unknown>;
  assertEquals(data.hospitalId, f.hospitalA);
  assertEquals(data.version, 2);
  assertEquals(data.updated, true);

  // Server-side truth: the row genuinely persisted.
  const row = await policyRow(f.hospitalA);
  assertExists(row);
  assertEquals(row!.full_refund_within_minutes, 45);
  assertEquals(Number(row!.same_day_refund_percentage), 25);
  assertEquals(row!.notes, "HTTP-suite window");
  assertEquals(row!.version, 2);

  // The EXISTING trg_cancel_policy_history trigger captured the v1 snapshot.
  assertEquals(await historyCount(f.hospitalA), 1);
  // One audit row landed (from the Edge handler, not from the RPC).
  assertEquals(await auditCountFor(f.hospitalA), 1);
});

// ─── 3. Idempotent replay: same key returns stored result, no double-write ───

Deno.test("p72http: replaying the same Idempotency-Key returns stored version + does not double-audit", async () => {
  const f = fx();
  const key = crypto.randomUUID();
  const body = {
    mode: "update",
    expectedVersion: 2,
    patch: { notes: "Replay notes" },
  };
  const first = await callPolicy(f.adminA.token, f.hospitalA, key, body);
  assertEquals(first.status, 200, `body: ${JSON.stringify(first.json)}`);
  assertEquals((first.json!.data as Record<string, unknown>).version, 3);

  const replay = await callPolicy(f.adminA.token, f.hospitalA, key, body);
  assertEquals(
    replay.status,
    200,
    `replay body: ${JSON.stringify(replay.json)}`,
  );
  assertEquals(
    (replay.json!.data as Record<string, unknown>).version,
    3,
    "replay must return the SAME stored version",
  );

  // The RPC ran only once: the row is at v3 and there is exactly one audit
  // row for this mutation (audit lives inside the idempotency envelope).
  const row = await policyRow(f.hospitalA);
  assertEquals(row!.version, 3);
  assertEquals(row!.notes, "Replay notes");
  assertEquals(
    await auditCountFor(f.hospitalA),
    2,
    "one audit per successful mutation, replay does not double-record",
  );
  assertEquals(await historyCount(f.hospitalA), 2);
});

// ─── 4. Missing Idempotency-Key on update → 400 ─────────────────────────────

Deno.test("p72http: update without Idempotency-Key is refused with 400 (no DB write)", async () => {
  const f = fx();
  const before = await policyRow(f.hospitalA);
  const res = await callPolicy(f.adminA.token, f.hospitalA, null, {
    mode: "update",
    expectedVersion: before!.version as number,
    patch: { notes: "should never land" },
  });
  assertEquals(res.status, 400, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "IDEMPOTENCY_KEY_REQUIRED");
  const after = await policyRow(f.hospitalA);
  assertEquals(
    after!.notes,
    before!.notes,
    "refused mutation must not touch the policy row",
  );
});

// ─── 5. Cross-tenant hospital_admin is refused at resolveAuth (403) ─────────

Deno.test("p72http: hospital_admin of B reading A is refused (403, HOSPITAL_ACCESS_DENIED)", async () => {
  const f = fx();
  const res = await callPolicy(f.adminB.token, f.hospitalA, null, {
    mode: "read",
  });
  assertEquals(res.status, 403, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "HOSPITAL_ACCESS_DENIED");
});

Deno.test("p72http: hospital_admin of B writing A is refused (403, no DB write)", async () => {
  const f = fx();
  const before = await policyRow(f.hospitalA);
  const res = await callPolicy(
    f.adminB.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      mode: "update",
      expectedVersion: before!.version as number,
      patch: { full_refund_within_minutes: 1 },
    },
  );
  assertEquals(res.status, 403, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "HOSPITAL_ACCESS_DENIED");
  const after = await policyRow(f.hospitalA);
  assertEquals(
    after!.full_refund_within_minutes,
    before!.full_refund_within_minutes,
  );
  assertEquals(after!.version, before!.version);
});

// ─── 6. Doctor is refused by requireRole (403, ROLE_INSUFFICIENT) ────────────

Deno.test("p72http: doctor is refused (403, ROLE_INSUFFICIENT)", async () => {
  const f = fx();
  const res = await callPolicy(f.doctorA.token, f.hospitalA, null, {
    mode: "read",
  });
  assertEquals(res.status, 403, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "ROLE_INSUFFICIENT");
});

// ─── 7. Unauthenticated is refused (401) ─────────────────────────────────────

Deno.test("p72http: unauthenticated request is refused with 401", async () => {
  const f = fx();
  const res = await callPolicy(null, f.hospitalA, null, { mode: "read" });
  assert(
    res.status === 401 || res.status === 403,
    `unauthenticated must be 401/403, got ${res.status}`,
  );
});

// ─── 8. Stale expected_version maps SQLSTATE P0001 → 409 ────────────────────

Deno.test("p72http: stale expectedVersion is 409 DB_CONCURRENCY_ERROR", async () => {
  const f = fx();
  const current = (await policyRow(f.hospitalA))!.version as number;
  const res = await callPolicy(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      mode: "update",
      // Deliberately stale: an earlier version than the row now holds.
      expectedVersion: Math.max(1, current - 1),
      patch: { full_refund_within_minutes: 60 },
    },
  );
  assertEquals(res.status, 409, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "DB_CONCURRENCY_ERROR");
  // Server state untouched.
  const row = await policyRow(f.hospitalA);
  assertEquals(row!.version, current);
  assertEquals(row!.full_refund_within_minutes, 45);
});

// ─── 9. Out-of-range value → 422 (Edge Zod) ─────────────────────────────────

Deno.test("p72http: out-of-range percentage is 422 and leaves state untouched", async () => {
  const f = fx();
  const before = await policyRow(f.hospitalA);
  const res = await callPolicy(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      mode: "update",
      expectedVersion: before!.version as number,
      patch: { same_day_refund_percentage: 150 },
    },
  );
  assertEquals(res.status, 422, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "VALIDATION_ERROR");
  const after = await policyRow(f.hospitalA);
  assertEquals(after!.version, before!.version);
  assertEquals(
    Number(after!.same_day_refund_percentage),
    Number(before!.same_day_refund_percentage),
  );
});

Deno.test("p72http: unknown field in patch is 422 (Edge strict Zod schema)", async () => {
  const f = fx();
  const before = await policyRow(f.hospitalA);
  const res = await callPolicy(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      mode: "update",
      expectedVersion: before!.version as number,
      // Not in the allowlist.
      patch: { hospital_id: f.hospitalB },
    },
  );
  assertEquals(res.status, 422, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "VALIDATION_ERROR");
  assertEquals(
    (await policyRow(f.hospitalA))!.version,
    before!.version,
  );
});

// ─── 10. Missing X-Hospital-ID → client error (Edge-level header gate) ──────

Deno.test("p72http: missing X-Hospital-ID is refused", async () => {
  const f = fx();
  const res = await callPolicy(f.adminA.token, null, null, { mode: "read" });
  assert(
    res.status === 400 || res.status === 401 || res.status === 403 ||
      res.status === 422,
    `missing header must be a client-error (not 200), got ${res.status}`,
  );
});

// ─── 11. Empty patch is an honest noop over HTTP ────────────────────────────

Deno.test("p72http: empty patch returns updated=false without a version bump", async () => {
  const f = fx();
  const before = await policyRow(f.hospitalA);
  const res = await callPolicy(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      mode: "update",
      expectedVersion: before!.version as number,
      patch: {},
    },
  );
  assertEquals(res.status, 200, `body: ${JSON.stringify(res.json)}`);
  const data = res.json!.data as Record<string, unknown>;
  assertEquals(data.updated, false, "noop must be reported honestly");
  assertEquals(data.version, before!.version);
  const after = await policyRow(f.hospitalA);
  assertEquals(after!.version, before!.version);
});

// ─── 12. global_admin may update any tenant policy over HTTP ────────────────

Deno.test("p72http: global_admin updates tenant B policy (200)", async () => {
  const f = fx();
  const res = await callPolicy(
    f.globalAdmin.token,
    f.hospitalB,
    crypto.randomUUID(),
    {
      mode: "update",
      expectedVersion: 1,
      patch: { partial_refund_percentage: 70 },
    },
  );
  assertEquals(res.status, 200, `body: ${JSON.stringify(res.json)}`);
  const data = res.json!.data as Record<string, unknown>;
  assertEquals(data.version, 2);
  assertEquals(data.updated, true);
  const row = await policyRow(f.hospitalB);
  assertEquals(Number(row!.partial_refund_percentage), 70);
  assertEquals(await auditCountFor(f.hospitalB), 1);
});
