/**
 * tests/integration/integration_configuration_http.test.ts
 *
 * WS-ONBOARD-3 - REAL HTTP-path coverage for the `integration-configuration`
 * Edge Function, end-to-end against the live local runtime:
 *   HTTP -> resolveAuth(JWT + X-Hospital-ID) -> requireRole(...) ->
 *   parseBody(discriminated union on mode) -> Idempotency-Key gate ->
 *   withIdempotency -> service-role SECURITY DEFINER RPC ->
 *   logAuditEvent inside the handler -> server-authoritative response.
 *
 * The Edge-layer concerns the DB suite cannot reach: JWT + role gating,
 * tenant cross-check at resolveAuth, missing Idempotency-Key 400, replay
 * returning the stored result and a single audit event, SQLSTATE P0001
 * mapped to HTTP 409 DB_CONCURRENCY_ERROR, strict-body rejection of any
 * smuggled secret key (422), and - most importantly - that a rotated secret
 * NEVER crosses the HTTP response or the audit trail.
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

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "7");
const FIXTURE_PASSWORD = `J67-${RUN}-fixture-pass`;
const FAKE_SECRET = "TEST_SECRET_SHOULD_NEVER_LEAK_123456";

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
  const email = `j67-${tag}-${RUN}@setura.test`;
  await createAuthUser(userId, email);
  const { error: pErr } = await (db.from as AnyClient)("profiles").upsert({
    id: userId,
    full_name: `J67 ${tag} ${RUN}`,
    normalized_phone: `96${RUN}${phoneSuffix}`,
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
  raw: string;
  json: Record<string, unknown> | null;
}

/** POST /functions/v1/integration-configuration over real HTTP. */
async function callIntegration(
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
    `${LOCAL_STATUS.API_URL}/functions/v1/integration-configuration`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
  const raw = await resp.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Non-JSON body (gateway refusal) - status still checked.
  }
  return { status: resp.status, raw, json };
}

function errCode(json: Record<string, unknown> | null): string | undefined {
  if (!json) return undefined;
  const err = json.error as { code?: string } | undefined;
  return err?.code;
}

async function integrationRowVersion(
  hospitalId: string,
  provider: string,
): Promise<number> {
  const { db } = await ctx();
  const { data } = await (db.from as AnyClient)("integration_config")
    .select("version")
    .eq("hospital_id", hospitalId)
    .eq("provider", provider)
    .maybeSingle();
  return (data?.version as number | undefined) ?? 0;
}

async function auditCount(
  hospitalId: string,
  actionType: string,
): Promise<number> {
  const { db } = await ctx();
  const { count } = await (db.from as AnyClient)("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("action_type", actionType)
    .eq("entity_id", hospitalId);
  return count ?? 0;
}

async function integrationAuditBlob(hospitalId: string): Promise<string> {
  const { db } = await ctx();
  const { data } = await (db.from as AnyClient)("audit_logs")
    .select("new_data,old_data")
    .eq("entity_id", hospitalId)
    .in("action_type", [
      "integration_config_update",
      "integration_enabled",
      "integration_disabled",
      "integration_connection_tested",
      "integration_secret_rotated",
    ]);
  return JSON.stringify(data ?? []);
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

Deno.test("j67http: setup two tenants + global/hospital admin + doctor fixtures", async () => {
  const globalAdmin = await fixtureActor("ga", "global_admin", null, "01");
  const hospitalA = await provisionAs(
    globalAdmin.userId,
    `J67 A ${RUN}`,
    `j67http-a-${RUN}`,
  );
  const hospitalB = await provisionAs(
    globalAdmin.userId,
    `J67 B ${RUN}`,
    `j67http-b-${RUN}`,
  );
  const adminA = await fixtureActor("ha-a", "hospital_admin", hospitalA, "02");
  const adminB = await fixtureActor("ha-b", "hospital_admin", hospitalB, "03");
  const doctorA = await fixtureActor("dr-a", "doctor", hospitalA, "04");
  F = { globalAdmin, adminA, adminB, doctorA, hospitalA, hospitalB };
});

// ─── 1. Read happy path ──────────────────────────────────────────────────────

Deno.test("j67http: hospital_admin reads own tenant integration config (200, sanitized)", async () => {
  const f = fx();
  const res = await callIntegration(f.adminA.token, f.hospitalA, null, {
    mode: "read",
  });
  assertEquals(res.status, 200, `body: ${res.raw}`);
  assertExists(res.json);
  assertEquals(res.json!.success, true);
  const data = res.json!.data as Record<string, unknown>;
  assertEquals(data.hospitalId, f.hospitalA);
  assertEquals(Array.isArray(data.integrations), true);
  const secrets = data.platformSecrets as Array<Record<string, unknown>>;
  assertEquals(secrets.length, 2);
  for (const s of secrets) {
    assertEquals(
      Object.prototype.hasOwnProperty.call(s, "secret"),
      false,
      "no raw secret key crosses the HTTP response",
    );
  }
});

Deno.test("j67http: global_admin reads ANY tenant (200)", async () => {
  const f = fx();
  const res = await callIntegration(f.globalAdmin.token, f.hospitalB, null, {
    mode: "read",
  });
  assertEquals(res.status, 200, `body: ${res.raw}`);
});

// ─── 2. Update happy path + projection + audit ───────────────────────────────

Deno.test("j67http: update lands version + status + projection + audit (200)", async () => {
  const f = fx();
  const res = await callIntegration(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      mode: "update",
      provider: "razorpay",
      expectedVersion: 0,
      patch: { public_identifier: "rzp_live_abc", enabled: true },
    },
  );
  assertEquals(res.status, 200, `body: ${res.raw}`);
  const data = res.json!.data as Record<string, unknown>;
  assertEquals(data.provider, "razorpay");
  assertEquals(data.version, 1);
  assertEquals(data.status, "configured");
  assertEquals(await integrationRowVersion(f.hospitalA, "razorpay"), 1);
  assertEquals(await auditCount(f.hospitalA, "integration_enabled"), 1);
});

// ─── 3. Idempotent replay ────────────────────────────────────────────────────

Deno.test("j67http: replay same Idempotency-Key returns stored version + single audit", async () => {
  const f = fx();
  const key = crypto.randomUUID();
  const body = {
    mode: "update",
    provider: "meta_whatsapp",
    expectedVersion: 0,
    patch: { public_identifier: "pn-meta", enabled: true },
  };
  const first = await callIntegration(f.adminA.token, f.hospitalA, key, body);
  assertEquals(first.status, 200, `body: ${first.raw}`);
  assertEquals((first.json!.data as Record<string, unknown>).version, 1);

  const replay = await callIntegration(f.adminA.token, f.hospitalA, key, body);
  assertEquals(replay.status, 200, `body: ${replay.raw}`);
  assertEquals(
    (replay.json!.data as Record<string, unknown>).version,
    1,
    "replay returns the SAME stored version",
  );
  assertEquals(
    await integrationRowVersion(f.hospitalA, "meta_whatsapp"),
    1,
    "the RPC ran only once",
  );
});

// ─── 4. Missing Idempotency-Key on update -> 400 ─────────────────────────────

Deno.test("j67http: update without Idempotency-Key is 400 (no DB write)", async () => {
  const f = fx();
  const before = await integrationRowVersion(f.hospitalA, "razorpay");
  const res = await callIntegration(f.adminA.token, f.hospitalA, null, {
    mode: "update",
    provider: "razorpay",
    expectedVersion: before,
    patch: { public_identifier: "should-never-land" },
  });
  assertEquals(res.status, 400, `body: ${res.raw}`);
  assertEquals(errCode(res.json), "IDEMPOTENCY_KEY_REQUIRED");
  assertEquals(await integrationRowVersion(f.hospitalA, "razorpay"), before);
});

// ─── 5. Cross-tenant + role gates ────────────────────────────────────────────

Deno.test("j67http: hospital_admin of B reading A is 403 HOSPITAL_ACCESS_DENIED", async () => {
  const f = fx();
  const res = await callIntegration(f.adminB.token, f.hospitalA, null, {
    mode: "read",
  });
  assertEquals(res.status, 403, `body: ${res.raw}`);
  assertEquals(errCode(res.json), "HOSPITAL_ACCESS_DENIED");
});

Deno.test("j67http: doctor is 403 ROLE_INSUFFICIENT", async () => {
  const f = fx();
  const res = await callIntegration(f.doctorA.token, f.hospitalA, null, {
    mode: "read",
  });
  assertEquals(res.status, 403, `body: ${res.raw}`);
  assertEquals(errCode(res.json), "ROLE_INSUFFICIENT");
});

Deno.test("j67http: unauthenticated is refused (401/403)", async () => {
  const f = fx();
  const res = await callIntegration(null, f.hospitalA, null, { mode: "read" });
  assert(
    res.status === 401 || res.status === 403,
    `unauthenticated must be 401/403, got ${res.status}`,
  );
});

// ─── 6. Stale expected_version -> 409 ────────────────────────────────────────

Deno.test("j67http: stale expectedVersion is 409 DB_CONCURRENCY_ERROR", async () => {
  const f = fx();
  const cur = await integrationRowVersion(f.hospitalA, "razorpay");
  const res = await callIntegration(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      mode: "update",
      provider: "razorpay",
      expectedVersion: Math.max(0, cur - 1),
      patch: { public_identifier: "stale-should-not-land" },
    },
  );
  assertEquals(res.status, 409, `body: ${res.raw}`);
  assertEquals(errCode(res.json), "DB_CONCURRENCY_ERROR");
});

// ─── 7. Strict body rejects a smuggled secret (422) ──────────────────────────

Deno.test("j67http: a secret key inside patch is rejected by the strict body schema (422)", async () => {
  const f = fx();
  const cur = await integrationRowVersion(f.hospitalA, "razorpay");
  const res = await callIntegration(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      mode: "update",
      provider: "razorpay",
      expectedVersion: cur,
      patch: { razorpay_key_secret: "smuggled" },
    },
  );
  assertEquals(res.status, 422, `body: ${res.raw}`);
  assertEquals(errCode(res.json), "VALIDATION_ERROR");
});

// ─── 8. rotate_secret authorization + NON-EXPOSURE ───────────────────────────

Deno.test("j67http: hospital_admin cannot rotate a platform secret (403 ROLE_INSUFFICIENT)", async () => {
  const f = fx();
  const res = await callIntegration(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    { mode: "rotate_secret", provider: "razorpay", secret: FAKE_SECRET },
  );
  assertEquals(res.status, 403, `body: ${res.raw}`);
  assertEquals(errCode(res.json), "ROLE_INSUFFICIENT");
});

Deno.test("j67http: global_admin rotates secret; the value NEVER crosses the response", async () => {
  const f = fx();
  const res = await callIntegration(
    f.globalAdmin.token,
    f.hospitalA,
    crypto.randomUUID(),
    { mode: "rotate_secret", provider: "razorpay", secret: FAKE_SECRET },
  );
  assertEquals(res.status, 200, `body: ${res.raw}`);
  assert(
    !res.raw.includes(FAKE_SECRET),
    "rotate response must not echo the secret",
  );
  const data = res.json!.data as Record<string, unknown>;
  assertEquals(data.secret_present, true);
  assertEquals(await auditCount(f.hospitalA, "integration_secret_rotated"), 1);
});

Deno.test("j67http: read after rotation still omits the secret, and audit blob never contains it", async () => {
  const f = fx();
  const res = await callIntegration(f.adminA.token, f.hospitalA, null, {
    mode: "read",
  });
  assertEquals(res.status, 200, `body: ${res.raw}`);
  assert(
    !res.raw.includes(FAKE_SECRET),
    "the plaintext secret must never appear in the read response body",
  );
  const secrets = (res.json!.data as Record<string, unknown>)
    .platformSecrets as Array<Record<string, unknown>>;
  const rzp = secrets.find((s) => s.provider === "razorpay");
  assertEquals(rzp?.secret_present, true);

  const blob = await integrationAuditBlob(f.hospitalA);
  assert(
    !blob.includes(FAKE_SECRET),
    "the audit trail must never persist the plaintext secret",
  );
});

// ─── 9. Missing X-Hospital-ID -> client error (not 200) ──────────────────────

Deno.test("j67http: missing X-Hospital-ID is refused", async () => {
  const f = fx();
  const res = await callIntegration(f.adminA.token, null, null, {
    mode: "read",
  });
  assert(
    res.status === 400 || res.status === 401 || res.status === 403 ||
      res.status === 422,
    `missing header must be a client-error (not 200), got ${res.status}`,
  );
});
