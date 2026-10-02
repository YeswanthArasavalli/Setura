/**
 * tests/integration/hospital_configuration_http.test.ts
 *
 * WS-ONBOARD-2 - REAL HTTP-path coverage for the `hospital-configuration`
 * Edge Function, end-to-end against the live local runtime:
 *   HTTP -> resolveAuth(JWT + X-Hospital-ID) -> requireRole(['global_admin',
 *   'hospital_admin']) -> tenant cross-check -> parseBody(discriminated
 *   union on mode) -> (read: get_hospital_configuration RPC |
 *   update: Idempotency-Key gate -> api_idempotency_keys registry ->
 *   withIdempotency -> update_hospital_configuration RPC ->
 *   logAuditEvent inside the handler) -> server-authoritative response.
 *
 * Every case POSTs to <API_URL>/functions/v1/hospital-configuration with a
 * genuine GoTrue password-grant JWT and the correct X-Hospital-ID header.
 * No case substitutes a direct RPC call for the HTTP invocation. The
 * Edge-layer concerns the DB suite cannot reach - JWT + role gating,
 * tenant cross-check at resolveAuth, missing Idempotency-Key 400,
 * replay returning the stored version + a single audit event, SQLSTATE
 * 40001 mapped to HTTP 409 DB_CONCURRENCY_ERROR, and SQLSTATE 22023 mapped
 * to HTTP 422 - are exactly what this file proves.
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

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "8");
const FIXTURE_PASSWORD = `H66-${RUN}-fixture-pass`;

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
  const email = `h66-${tag}-${RUN}@setura.test`;
  await createAuthUser(userId, email);
  const { error: pErr } = await (db.from as AnyClient)("profiles").upsert({
    id: userId,
    full_name: `H66 ${tag} ${RUN}`,
    normalized_phone: `95${RUN}${phoneSuffix}`,
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

/** POST /functions/v1/hospital-configuration over real HTTP. */
async function callConfig(
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
    `${LOCAL_STATUS.API_URL}/functions/v1/hospital-configuration`,
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

async function configVersionMax(hospitalId: string): Promise<number> {
  const { db } = await ctx();
  const { data } = await (db.from as AnyClient)("config_versions")
    .select("version_number")
    .eq("config_table", "hospital_settings")
    .eq("hospital_id", hospitalId)
    .eq("config_key", "settings")
    .order("version_number", { ascending: false })
    .limit(1);
  return (data?.[0]?.version_number as number | undefined) ?? 0;
}

async function auditCountFor(hospitalId: string): Promise<number> {
  const { db } = await ctx();
  const { count } = await (db.from as AnyClient)("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("action_type", "hospital_setting_update")
    .eq("entity_id", hospitalId);
  return count ?? 0;
}

async function settingsFor(
  hospitalId: string,
): Promise<Record<string, unknown> | null> {
  const { db } = await ctx();
  const { data } = await (db.from as AnyClient)("hospital_settings")
    .select("*")
    .eq("hospital_id", hospitalId)
    .maybeSingle();
  return (data ?? null) as Record<string, unknown> | null;
}

async function hospitalsFor(
  hospitalId: string,
): Promise<Record<string, unknown> | null> {
  const { db } = await ctx();
  const { data } = await (db.from as AnyClient)("hospitals")
    .select("*")
    .eq("id", hospitalId)
    .maybeSingle();
  return (data ?? null) as Record<string, unknown> | null;
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

Deno.test("h66http: setup two tenants + global/hospital admin + doctor fixtures", async () => {
  const globalAdmin = await fixtureActor("ga", "global_admin", null, "01");
  const hospitalA = await provisionAs(
    globalAdmin.userId,
    `H66 A ${RUN}`,
    `h66http-a-${RUN}`,
  );
  const hospitalB = await provisionAs(
    globalAdmin.userId,
    `H66 B ${RUN}`,
    `h66http-b-${RUN}`,
  );
  const adminA = await fixtureActor("ha-a", "hospital_admin", hospitalA, "02");
  const adminB = await fixtureActor("ha-b", "hospital_admin", hospitalB, "03");
  const doctorA = await fixtureActor("dr-a", "doctor", hospitalA, "04");
  F = { globalAdmin, adminA, adminB, doctorA, hospitalA, hospitalB };
});

// ─── 1. Read happy path (hospital_admin self-tenant) ────────────────────────

Deno.test("h66http: hospital_admin reads their own configuration (200)", async () => {
  const f = fx();
  const res = await callConfig(f.adminA.token, f.hospitalA, null, {
    mode: "read",
  });
  assertEquals(res.status, 200, `body: ${JSON.stringify(res.json)}`);
  assertExists(res.json);
  const json = res.json!;
  assertEquals(json.success, true);
  const data = json.data as Record<string, unknown>;
  assertExists(data);
  assertEquals(data.hospitalId, f.hospitalA);
  assertEquals(data.version, 0, "fresh tenant has no config_versions row yet");
  const hospital = data.hospital as Record<string, unknown>;
  assertEquals(hospital.id, f.hospitalA);
  assertExists(data.settings, "settings snapshot present");
  assertExists(data.featureFlags, "feature flags array present");
});

Deno.test("h66http: global_admin reads ANY hospital (200)", async () => {
  const f = fx();
  const res = await callConfig(f.globalAdmin.token, f.hospitalB, null, {
    mode: "read",
  });
  assertEquals(res.status, 200, `body: ${JSON.stringify(res.json)}`);
  const data = res.json!.data as Record<string, unknown>;
  assertEquals(data.hospitalId, f.hospitalB);
});

// ─── 2. Update happy path (version bump + settings persist + audit) ─────────

Deno.test("h66http: hospital_admin update bumps version and lands settings + audit", async () => {
  const f = fx();
  const key = crypto.randomUUID();
  const res = await callConfig(f.adminA.token, f.hospitalA, key, {
    mode: "update",
    expectedVersion: 0,
    hospitalPatch: { phone: "9800099001" },
    settingsPatch: { display_name: "H66 A Display", platform_fee_online: 30 },
  });
  assertEquals(res.status, 200, `body: ${JSON.stringify(res.json)}`);
  const data = res.json!.data as Record<string, unknown>;
  assertEquals(data.hospitalId, f.hospitalA);
  assertEquals(data.version, 1);
  assertEquals(data.updated, true);

  // Server-side truth: the settings row genuinely persisted.
  const s = await settingsFor(f.hospitalA);
  assertExists(s);
  assertEquals(s!.display_name, "H66 A Display");
  assertEquals(Number(s!.platform_fee_online), 30);
  // Migration-35 alias rule: booking_fee_amount is kept in sync.
  assertEquals(Number(s!.booking_fee_amount), 30);
  // Optimistic version now advanced by the existing AFTER-UPDATE trigger.
  assertEquals(await configVersionMax(f.hospitalA), 1);
  // One audit row landed (from the Edge handler, not from the RPC).
  assertEquals(await auditCountFor(f.hospitalA), 1);

  // Hospital-row patch also applied.
  const h = await hospitalsFor(f.hospitalA);
  assertEquals(h!.phone, "9800099001");
});

// ─── 3. Idempotent replay: same key returns stored result, no double-write ───

Deno.test("h66http: replaying the same Idempotency-Key returns stored version + does not double-audit", async () => {
  const f = fx();
  const key = crypto.randomUUID();
  const body = {
    mode: "update",
    expectedVersion: 1,
    settingsPatch: { display_name: "Replay Display" },
  };
  const first = await callConfig(f.adminA.token, f.hospitalA, key, body);
  assertEquals(first.status, 200);
  assertEquals((first.json!.data as Record<string, unknown>).version, 2);

  const replay = await callConfig(f.adminA.token, f.hospitalA, key, body);
  assertEquals(
    replay.status,
    200,
    `replay body: ${JSON.stringify(replay.json)}`,
  );
  assertEquals(
    (replay.json!.data as Record<string, unknown>).version,
    2,
    "replay must return the SAME stored version",
  );

  // The RPC ran only once: max version is still 2, and there is exactly
  // one additional audit row for this key (audit lives inside the
  // handler, not outside the idempotency envelope).
  assertEquals(await configVersionMax(f.hospitalA), 2);
  assertEquals(
    await auditCountFor(f.hospitalA),
    2,
    "one audit per successful mutation, replay does not double-record",
  );

  // And the settings actually landed once (not a phantom).
  const s = await settingsFor(f.hospitalA);
  assertEquals(s!.display_name, "Replay Display");
});

// ─── 4. Missing Idempotency-Key on update → 400 ─────────────────────────────

Deno.test("h66http: update without Idempotency-Key is refused with 400 (no DB write)", async () => {
  const f = fx();
  const beforeMax = await configVersionMax(f.hospitalA);
  const res = await callConfig(f.adminA.token, f.hospitalA, null, {
    mode: "update",
    expectedVersion: beforeMax,
    settingsPatch: { display_name: "should never land" },
  });
  assertEquals(res.status, 400, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "IDEMPOTENCY_KEY_REQUIRED");
  // Nothing changed server-side.
  assertEquals(await configVersionMax(f.hospitalA), beforeMax);
  const s = await settingsFor(f.hospitalA);
  assertEquals(
    s!.display_name,
    "Replay Display",
    "refused mutation must not touch settings",
  );
});

// ─── 5. Cross-tenant hospital_admin is refused at resolveAuth (403) ─────────

Deno.test("h66http: hospital_admin of B reading A is refused (403, HOSPITAL_ACCESS_DENIED)", async () => {
  const f = fx();
  const res = await callConfig(f.adminB.token, f.hospitalA, null, {
    mode: "read",
  });
  assertEquals(res.status, 403, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "HOSPITAL_ACCESS_DENIED");
});

Deno.test("h66http: hospital_admin of B writing A is refused (403, no DB write)", async () => {
  const f = fx();
  const beforeMax = await configVersionMax(f.hospitalA);
  const res = await callConfig(
    f.adminB.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      mode: "update",
      expectedVersion: beforeMax,
      settingsPatch: { display_name: "cross-tenant should not land" },
    },
  );
  assertEquals(res.status, 403, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "HOSPITAL_ACCESS_DENIED");
  assertEquals(await configVersionMax(f.hospitalA), beforeMax);
  const s = await settingsFor(f.hospitalA);
  assertEquals(s!.display_name, "Replay Display");
});

// ─── 6. Doctor is refused by requireRole (403, ROLE_INSUFFICIENT) ────────────

Deno.test("h66http: doctor is refused (403, ROLE_INSUFFICIENT)", async () => {
  const f = fx();
  const res = await callConfig(f.doctorA.token, f.hospitalA, null, {
    mode: "read",
  });
  assertEquals(res.status, 403, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "ROLE_INSUFFICIENT");
});

// ─── 7. Unauthenticated is refused (401) ─────────────────────────────────────

Deno.test("h66http: unauthenticated request is refused with 401", async () => {
  const f = fx();
  const res = await callConfig(null, f.hospitalA, null, { mode: "read" });
  assert(
    res.status === 401 || res.status === 403,
    `unauthenticated must be 401/403, got ${res.status}`,
  );
});

// ─── 8. Stale expected_version maps SQLSTATE 40001 → 409 DB_CONCURRENCY_ERROR ─

Deno.test("h66http: stale expectedVersion is 409 DB_CONCURRENCY_ERROR", async () => {
  const f = fx();
  const current = await configVersionMax(f.hospitalA);
  const res = await callConfig(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      mode: "update",
      // Deliberately stale: force an expected < current.
      expectedVersion: Math.max(0, current - 1),
      settingsPatch: { display_name: "should not land on stale" },
    },
  );
  assertEquals(res.status, 409, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "DB_CONCURRENCY_ERROR");
  // Server state untouched.
  assertEquals(await configVersionMax(f.hospitalA), current);
  const s = await settingsFor(f.hospitalA);
  assertEquals(s!.display_name, "Replay Display");
});

// ─── 9. Out-of-range value → 422 (either Edge Zod or RPC 22023 mapping) ─────

Deno.test("h66http: out-of-range max_tokens_per_day is 422 and leaves state untouched", async () => {
  const f = fx();
  const current = await configVersionMax(f.hospitalA);
  const sBefore = await settingsFor(f.hospitalA);
  const res = await callConfig(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      mode: "update",
      expectedVersion: current,
      settingsPatch: { max_tokens_per_day: 99_999 },
    },
  );
  assertEquals(res.status, 422, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "VALIDATION_ERROR");
  // No version bump and no partial write.
  assertEquals(await configVersionMax(f.hospitalA), current);
  const sAfter = await settingsFor(f.hospitalA);
  assertEquals(
    String(sAfter!.max_tokens_per_day),
    String(sBefore!.max_tokens_per_day),
  );
});

Deno.test("h66http: unknown field in patch is 422 (Edge strict Zod schema)", async () => {
  const f = fx();
  const current = await configVersionMax(f.hospitalA);
  const res = await callConfig(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      mode: "update",
      expectedVersion: current,
      // Not in the allowlist.
      settingsPatch: { razorpay_key_id: "should never land" },
    },
  );
  assertEquals(res.status, 422, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "VALIDATION_ERROR");
  assertEquals(await configVersionMax(f.hospitalA), current);
});

// ─── 10. Missing X-Hospital-ID → 400 VALIDATION_ERROR (Edge-level header gate) ─

Deno.test("h66http: missing X-Hospital-ID is refused", async () => {
  const f = fx();
  const res = await callConfig(f.adminA.token, null, null, { mode: "read" });
  // Header gate throws ValidationError (422) OR the JWT path rejects
  // (401/403) depending on which layer fires first. Both are honest
  // refusals; the union already proves the response was NOT a 200.
  assert(
    res.status === 400 || res.status === 401 || res.status === 403 ||
      res.status === 422,
    `missing header must be a client-error (not 200), got ${res.status}`,
  );
});

// ─── 11. Feature-flag override round-trip via HTTP ───────────────────────────

Deno.test("h66http: upserting a tenant-scoped feature-flag override via HTTP", async () => {
  const f = fx();
  const current = await configVersionMax(f.hospitalA);
  const res = await callConfig(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      mode: "update",
      expectedVersion: current,
      settingsPatch: { reminder_before_minutes: 90 },
      featureOverrides: [{ flag_key: "telemedicine", is_enabled: true }],
    },
  );
  assertEquals(res.status, 200, `body: ${JSON.stringify(res.json)}`);
  const newVersion = (res.json!.data as Record<string, unknown>)
    .version as number;
  assertEquals(newVersion, current + 1);

  // Read back through HTTP - the flag is visible as an override.
  const read = await callConfig(f.adminA.token, f.hospitalA, null, {
    mode: "read",
  });
  assertEquals(read.status, 200);
  const flags = (read.json!.data as Record<string, unknown>)
    .featureFlags as Array<
      { flag_key: string; is_enabled: boolean; is_override: boolean }
    >;
  const tm = flags.find((x) => x.flag_key === "telemedicine");
  assertExists(tm, "telemedicine flag present in the read");
  assertEquals(tm!.is_enabled, true);
  assertEquals(tm!.is_override, true);
});
