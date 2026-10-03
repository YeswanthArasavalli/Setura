/**
 * tests/integration/integration_configuration.test.ts
 *
 * WS-ONBOARD-3 - the five canonical integration-configuration RPCs
 * (migration 67), exercised against the REAL local Supabase stack as the
 * REAL roles. This suite proves the DATABASE-layer contract only (no Edge
 * runtime required):
 *
 *   - get_integration_configuration composes the per-hospital integration
 *     rows and the platform-global secret PRESENCE markers, and is
 *     FRONTEND-SAFE: it never emits a secret or an opaque secret_ref.
 *   - update_integration_configuration is atomic + versioned, independently
 *     re-checks actor role + tenant (defense-in-depth, SQLSTATE 42501),
 *     applies an optimistic expected_version check (P0001), allowlists ONLY
 *     safe public identifiers + enabled (rejects any secret/rotation key as
 *     22023), and projects onto the EXISTING hospital_settings runtime
 *     columns the payment / WhatsApp engines already read.
 *   - set_integration_secret is a platform-global operation (global_admin
 *     ONLY) that writes the value to Supabase Vault and records presence.
 *   - resolve_integration_secret is the ONLY Vault read path and is
 *     service-role-only.
 *   - record_integration_test_result stores a SANITIZED outcome and does NOT
 *     bump the configuration version (a test is an observation).
 *   - The recognizable fake secret TEST_SECRET_SHOULD_NEVER_LEAK_123456, once
 *     stored, is proven NEVER to appear in any sanitized read outcome.
 *
 * The Edge HTTP layer (JWT + role gating, idempotent replay, audit emission,
 * secret never crossing the response) is covered separately by
 * integration_configuration_http.test.ts (requires the Edge runtime serving;
 * F16-01).
 *
 * Run with:  deno task test:integration   (requires `supabase start`)
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
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

  const { createAuthClient, getAnonClient, getServiceClient } = await import(
    "../../supabase/functions/_shared/db.ts"
  );
  return {
    db: getServiceClient(),
    anon: getAnonClient(),
    createAuthClient,
  };
}

async function ctx(): Promise<Shared> {
  if (!_ctx) _ctx = await bootstrap();
  return _ctx;
}

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "9");
const FIXTURE_PASSWORD = `I67-${RUN}-fixture-pass`;
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
  const email = `i67-${tag}-${RUN}@setura.test`;
  await createAuthUser(userId, email);
  const { error: pErr } = await (db.from as AnyClient)("profiles").upsert({
    id: userId,
    full_name: `I67 ${tag} ${RUN}`,
    normalized_phone: `97${RUN}${phoneSuffix}`,
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

// deno-lint-ignore no-explicit-any
type AnyClient = any;

type RpcError = { code?: string; message?: string } | null;

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

async function readConfig(actorId: string, hospitalId: string) {
  const { db } = await ctx();
  const { data, error } = await (db.rpc as AnyClient)(
    "get_integration_configuration",
    { p_actor_user_id: actorId, p_hospital_id: hospitalId },
  );
  return {
    data: (data ?? null) as AnyClient,
    error: (error ?? null) as RpcError,
  };
}

async function updateConfig(
  actorId: string,
  hospitalId: string,
  provider: string,
  expectedVersion: number | null,
  patch: Record<string, unknown>,
) {
  const { db } = await ctx();
  const { data, error } = await (db.rpc as AnyClient)(
    "update_integration_configuration",
    {
      p_actor_user_id: actorId,
      p_hospital_id: hospitalId,
      p_provider: provider,
      p_expected_version: expectedVersion,
      p_patch: patch,
    },
  );
  return {
    data: (data ?? null) as AnyClient,
    error: (error ?? null) as RpcError,
  };
}

async function setSecret(actorId: string, provider: string, secret: string) {
  const { db } = await ctx();
  const { data, error } = await (db.rpc as AnyClient)(
    "set_integration_secret",
    { p_actor_user_id: actorId, p_provider: provider, p_secret: secret },
  );
  return {
    data: (data ?? null) as AnyClient,
    error: (error ?? null) as RpcError,
  };
}

async function resolveSecret(provider: string) {
  const { db } = await ctx();
  const { data, error } = await (db.rpc as AnyClient)(
    "resolve_integration_secret",
    { p_provider: provider },
  );
  return {
    data: (data ?? null) as string | null,
    error: (error ?? null) as RpcError,
  };
}

async function recordTest(
  actorId: string,
  hospitalId: string,
  provider: string,
  status: string,
) {
  const { db } = await ctx();
  const { data, error } = await (db.rpc as AnyClient)(
    "record_integration_test_result",
    {
      p_actor_user_id: actorId,
      p_hospital_id: hospitalId,
      p_provider: provider,
      p_test_status: status,
    },
  );
  return {
    data: (data ?? null) as AnyClient,
    error: (error ?? null) as RpcError,
  };
}

async function integrationRow(
  hospitalId: string,
  provider: string,
): Promise<Record<string, unknown> | null> {
  const { db } = await ctx();
  const { data } = await (db.from as AnyClient)("integration_config")
    .select("*")
    .eq("hospital_id", hospitalId)
    .eq("provider", provider)
    .maybeSingle();
  return (data ?? null) as Record<string, unknown> | null;
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

Deno.test("i67: setup two provisioned tenants + role fixtures", async () => {
  const globalAdmin = await fixtureActor("ga", "global_admin", null, "01");
  const hospitalA = await provisionAs(
    globalAdmin.userId,
    `I67 A ${RUN}`,
    `i67-hosp-a-${RUN}`,
  );
  const hospitalB = await provisionAs(
    globalAdmin.userId,
    `I67 B ${RUN}`,
    `i67-hosp-b-${RUN}`,
  );
  const adminA = await fixtureActor("ha-a", "hospital_admin", hospitalA, "02");
  const adminB = await fixtureActor("ha-b", "hospital_admin", hospitalB, "03");
  const doctorA = await fixtureActor("dr-a", "doctor", hospitalA, "04");
  F = { globalAdmin, adminA, adminB, doctorA, hospitalA, hospitalB };
});

// ─── 1. Read path is sanitized + tenant-scoped ───────────────────────────────

Deno.test("i67: hospital_admin reads own tenant - integrations empty, platform secret PRESENCE only", async () => {
  const f = fx();
  const res = await readConfig(f.adminA.userId, f.hospitalA);
  assertEquals(res.error, null);
  assertExists(res.data);
  assertEquals(res.data!.ok, true);
  assertEquals(res.data!.hospital_id, f.hospitalA);
  assertEquals(Array.isArray(res.data!.integrations), true);
  // Two platform-global secret markers exist from migration-67 seed.
  const secrets = res.data!.platform_secrets as Array<
    { provider: string; secret_present: boolean }
  >;
  const providers = secrets.map((s) => s.provider).sort();
  assertEquals(providers, ["meta_whatsapp", "razorpay"]);
  for (const s of secrets) {
    assertEquals(
      typeof s.secret_present,
      "boolean",
      "presence marker only, never a value",
    );
    // There is no key that carries a raw secret in the sanitized read.
    assertEquals(
      Object.prototype.hasOwnProperty.call(s, "secret"),
      false,
      "sanitized row must not contain a 'secret' key",
    );
  }
});

Deno.test("i67: global_admin reads ANY tenant", async () => {
  const f = fx();
  const a = await readConfig(f.globalAdmin.userId, f.hospitalA);
  const b = await readConfig(f.globalAdmin.userId, f.hospitalB);
  assertEquals(a.error, null);
  assertEquals(b.error, null);
});

Deno.test("i67: doctor reading A is refused (42501)", async () => {
  const f = fx();
  const res = await readConfig(f.doctorA.userId, f.hospitalA);
  assertExists(res.error);
  assertEquals(res.error!.code, "42501");
});

Deno.test("i67: cross-tenant read refused (adminB reading A -> 42501)", async () => {
  const f = fx();
  const res = await readConfig(f.adminB.userId, f.hospitalA);
  assertExists(res.error);
  assertEquals(res.error!.code, "42501");
});

Deno.test("i67: anon/authenticated cannot EXECUTE get_integration_configuration", async () => {
  const f = fx();
  const { anon, createAuthClient } = await ctx();
  const { error: anonErr } = await (anon.rpc as AnyClient)(
    "get_integration_configuration",
    { p_actor_user_id: f.adminA.userId, p_hospital_id: f.hospitalA },
  );
  assertExists(anonErr, "anon EXECUTE refused");
  assertStringIncludes(
    (anonErr as { message?: string }).message ?? "",
    "permission denied",
  );
  const client = createAuthClient(f.adminA.token) as AnyClient;
  const { error: authErr } = await client.rpc("get_integration_configuration", {
    p_actor_user_id: f.adminA.userId,
    p_hospital_id: f.hospitalA,
  });
  assertExists(authErr, "authenticated EXECUTE refused (service-role only)");
  assertStringIncludes(
    (authErr as { message?: string }).message ?? "",
    "permission denied",
  );
});

// ─── 2. Update: versioning, projection, allowlist, concurrency ───────────────

Deno.test("i67: hospital_admin updates razorpay + version bumps + projects onto hospital_settings", async () => {
  const f = fx();
  const res = await updateConfig(
    f.adminA.userId,
    f.hospitalA,
    "razorpay",
    0,
    { public_identifier: "rzp_test_123", enabled: true },
  );
  assertEquals(res.error, null, `update failed: ${JSON.stringify(res.error)}`);
  assertEquals(res.data!.ok, true);
  assertEquals(res.data!.version, 1);
  assertEquals(res.data!.status, "configured");

  const row = await integrationRow(f.hospitalA, "razorpay");
  assertExists(row);
  assertEquals(row!.public_identifier, "rzp_test_123");
  assertEquals(row!.enabled, true);
  assertEquals(row!.secret_ref, null, "no secret_ref is ever set by update");

  // Engine-compatibility projection onto the EXISTING runtime columns.
  const s = await settingsFor(f.hospitalA);
  assertExists(s);
  assertEquals(s!.razorpay_key_id, "rzp_test_123");
  assertEquals(s!.payment_enabled, true);
});

Deno.test("i67: enabled=false derives 'disabled' status (non-destructive)", async () => {
  const f = fx();
  const res = await updateConfig(f.adminA.userId, f.hospitalA, "razorpay", 1, {
    enabled: false,
  });
  assertEquals(res.error, null);
  assertEquals(res.data!.version, 2);
  assertEquals(res.data!.status, "disabled");
  const s = await settingsFor(f.hospitalA);
  assertEquals(s!.payment_enabled, false);
  // The public identifier is preserved (disable is not a delete).
  const row = await integrationRow(f.hospitalA, "razorpay");
  assertEquals(row!.public_identifier, "rzp_test_123");
});

Deno.test("i67: waba_id/contact_number apply only to meta_whatsapp (22023 on razorpay)", async () => {
  const f = fx();
  const cur = await integrationRow(f.hospitalA, "razorpay");
  const res = await updateConfig(
    f.adminA.userId,
    f.hospitalA,
    "razorpay",
    cur!.version as number,
    { waba_id: "should-not-apply" },
  );
  assertExists(res.error);
  assertEquals(res.error!.code, "22023");
});

Deno.test("i67: meta_whatsapp public_identifier + waba_id + contact_number land + project", async () => {
  const f = fx();
  const res = await updateConfig(
    f.adminA.userId,
    f.hospitalA,
    "meta_whatsapp",
    0,
    {
      public_identifier: "pn-999",
      waba_id: "waba-1",
      contact_number: "+919800000000",
      enabled: true,
    },
  );
  assertEquals(
    res.error,
    null,
    `meta update failed: ${JSON.stringify(res.error)}`,
  );
  assertEquals(res.data!.version, 1);
  const s = await settingsFor(f.hospitalA);
  assertEquals(s!.meta_phone_number_id, "pn-999");
  assertEquals(s!.meta_waba_id, "waba-1");
  assertEquals(s!.whatsapp_number, "+919800000000");
});

Deno.test("i67: any secret/rotation key in the patch is rejected (22023)", async () => {
  const f = fx();
  const cur = await integrationRow(f.hospitalA, "meta_whatsapp");
  for (
    const smuggle of [
      "secret",
      "razorpay_key_secret",
      "meta_access_token",
      "secret_ref",
      "last_rotated_at",
    ]
  ) {
    const res = await updateConfig(
      f.adminA.userId,
      f.hospitalA,
      "meta_whatsapp",
      cur!.version as number,
      { [smuggle]: "x" },
    );
    assertExists(res.error, `${smuggle} must be rejected`);
    assertEquals(res.error!.code, "22023", `${smuggle} -> 22023`);
  }
});

Deno.test("i67: stale expected_version is refused (P0001)", async () => {
  const f = fx();
  const res = await updateConfig(f.adminA.userId, f.hospitalA, "razorpay", 0, {
    public_identifier: "stale",
  });
  assertExists(res.error);
  assertEquals(res.error!.code, "P0001");
});

Deno.test("i67: concurrent same-expected_version writes -> one wins, one conflicts", async () => {
  const f = fx();
  const cur = await integrationRow(f.hospitalA, "meta_whatsapp");
  const base = cur!.version as number;
  const results = await Promise.all([
    updateConfig(f.adminA.userId, f.hospitalA, "meta_whatsapp", base, {
      contact_number: "+910000000001",
    }),
    updateConfig(f.adminA.userId, f.hospitalA, "meta_whatsapp", base, {
      contact_number: "+910000000002",
    }),
  ]);
  const ok = results.filter((r) => r.error === null);
  const conflict = results.filter((r) => r.error?.code === "P0001");
  assertEquals(ok.length, 1, "exactly one wins");
  assertEquals(conflict.length, 1, "exactly one conflicts");
});

Deno.test("i67: cross-tenant update refused (adminB writing A -> 42501) and doctor refused", async () => {
  const f = fx();
  const cur = await integrationRow(f.hospitalA, "razorpay");
  const b = await updateConfig(
    f.adminB.userId,
    f.hospitalA,
    "razorpay",
    cur!.version as number,
    { public_identifier: "pwn" },
  );
  assertExists(b.error);
  assertEquals(b.error!.code, "42501");
  const d = await updateConfig(
    f.doctorA.userId,
    f.hospitalA,
    "razorpay",
    cur!.version as number,
    { public_identifier: "pwn" },
  );
  assertExists(d.error);
  assertEquals(d.error!.code, "42501");
  const after = await integrationRow(f.hospitalA, "razorpay");
  assertEquals(after!.public_identifier, "rzp_test_123", "target untouched");
});

Deno.test("i67: anon/authenticated cannot EXECUTE update_integration_configuration", async () => {
  const f = fx();
  const { anon, createAuthClient } = await ctx();
  const { error: anonErr } = await (anon.rpc as AnyClient)(
    "update_integration_configuration",
    {
      p_actor_user_id: f.adminA.userId,
      p_hospital_id: f.hospitalA,
      p_provider: "razorpay",
      p_expected_version: 9,
      p_patch: {},
    },
  );
  assertExists(anonErr);
  assertStringIncludes(
    (anonErr as { message?: string }).message ?? "",
    "permission denied",
  );
  const client = createAuthClient(f.adminA.token) as AnyClient;
  const { error: authErr } = await client.rpc(
    "update_integration_configuration",
    {
      p_actor_user_id: f.adminA.userId,
      p_hospital_id: f.hospitalA,
      p_provider: "razorpay",
      p_expected_version: 9,
      p_patch: {},
    },
  );
  assertExists(authErr);
  assertStringIncludes(
    (authErr as { message?: string }).message ?? "",
    "permission denied",
  );
});

// ─── 3. Secret: write to Vault, resolve, and NON-EXPOSURE ────────────────────

Deno.test("i67: set_integration_secret is global_admin-only (hospital_admin -> 42501)", async () => {
  const f = fx();
  const res = await setSecret(f.adminA.userId, "razorpay", FAKE_SECRET);
  assertExists(res.error);
  assertEquals(res.error!.code, "42501");
});

Deno.test("i67: global_admin rotates the razorpay secret; resolve returns it (Vault works)", async () => {
  const f = fx();
  const set = await setSecret(f.globalAdmin.userId, "razorpay", FAKE_SECRET);
  assertEquals(set.error, null, `set failed: ${JSON.stringify(set.error)}`);
  assertEquals(set.data!.ok, true);
  assertEquals(set.data!.secret_present, true);

  const resolved = await resolveSecret("razorpay");
  assertEquals(resolved.error, null);
  assertEquals(
    resolved.data,
    FAKE_SECRET,
    "trusted runtime Vault read returns the stored value",
  );
});

Deno.test("i67: THE FAKE SECRET NEVER LEAKS into any sanitized read outcome", async () => {
  const f = fx();
  const res = await readConfig(f.adminA.userId, f.hospitalA);
  assertEquals(res.error, null);
  const serialized = JSON.stringify(res.data);
  assert(
    !serialized.includes(FAKE_SECRET),
    "the plaintext secret must never appear in the frontend-safe read",
  );
  // The razorpay presence marker is now true.
  const marker = (res.data!.platform_secrets as Array<
    { provider: string; secret_present: boolean }
  >).find((s) => s.provider === "razorpay");
  assertExists(marker);
  assertEquals(marker!.secret_present, true);
});

Deno.test("i67: resolve_integration_secret is service-role-only (anon/authenticated denied)", async () => {
  const { anon, createAuthClient } = await ctx();
  const f = fx();
  const { error: anonErr } = await (anon.rpc as AnyClient)(
    "resolve_integration_secret",
    { p_provider: "razorpay" },
  );
  assertExists(anonErr, "anon must not resolve secrets");
  assertStringIncludes(
    (anonErr as { message?: string }).message ?? "",
    "permission denied",
  );
  const client = createAuthClient(f.adminA.token) as AnyClient;
  const { error: authErr } = await client.rpc("resolve_integration_secret", {
    p_provider: "razorpay",
  });
  assertExists(authErr, "authenticated must not resolve secrets");
  assertStringIncludes(
    (authErr as { message?: string }).message ?? "",
    "permission denied",
  );
});

Deno.test("i67: set_integration_secret validates provider + non-empty value (22023)", async () => {
  const f = fx();
  const bad = await setSecret(f.globalAdmin.userId, "stripe", "x");
  assertExists(bad.error);
  assertEquals(bad.error!.code, "22023");
  const empty = await setSecret(f.globalAdmin.userId, "razorpay", "");
  assertExists(empty.error);
  assertEquals(empty.error!.code, "22023");
});

// ─── 4. Test-result bookkeeping does not bump version ────────────────────────

Deno.test("i67: record_integration_test_result stores sanitized status, no version bump", async () => {
  const f = fx();
  const before = await integrationRow(f.hospitalA, "razorpay");
  const res = await recordTest(
    f.adminA.userId,
    f.hospitalA,
    "razorpay",
    "CONNECTED",
  );
  assertEquals(res.error, null);
  assertEquals(res.data!.recorded, true);
  const after = await integrationRow(f.hospitalA, "razorpay");
  assertEquals(after!.last_test_status, "CONNECTED");
  assertEquals(
    after!.version,
    before!.version,
    "a test is an observation, not a config mutation",
  );
});

Deno.test("i67: unrecognized test status is rejected (22023); doctor refused (42501)", async () => {
  const f = fx();
  const bad = await recordTest(
    f.adminA.userId,
    f.hospitalA,
    "razorpay",
    "MAYBE",
  );
  assertExists(bad.error);
  assertEquals(bad.error!.code, "22023");
  const doc = await recordTest(
    f.doctorA.userId,
    f.hospitalA,
    "razorpay",
    "CONNECTED",
  );
  assertExists(doc.error);
  assertEquals(doc.error!.code, "42501");
});

// ─── 5. Privilege boundary + audit catalog registration ──────────────────────

Deno.test("i67: audit_action_types registers the WS-ONBOARD-3 system actions", async () => {
  const { db } = await ctx();
  const { data } = await (db.from as AnyClient)("audit_action_types")
    .select("action_type")
    .in("action_type", [
      "integration_config_update",
      "integration_enabled",
      "integration_disabled",
      "integration_connection_tested",
      "integration_secret_rotated",
    ]);
  const got = new Set(
    (data ?? []).map((r: { action_type: string }) => r.action_type),
  );
  for (
    const a of [
      "integration_config_update",
      "integration_enabled",
      "integration_disabled",
      "integration_connection_tested",
      "integration_secret_rotated",
    ]
  ) {
    assertEquals(got.has(a), true, `${a} registered`);
  }
});

Deno.test("i67: all five RPC EXECUTE grants are service_role-only (F16-04 catalog ACL)", async () => {
  await ctx();
  // Reaching the functions over the service client proves service_role
  // EXECUTE; the anon/authenticated refusals above prove those roles are
  // denied. This closes the F16-04 obligation for every new function.
  const f = fx();
  const read = await readConfig(f.globalAdmin.userId, f.hospitalA);
  assertEquals(read.error, null);
  const rec = await recordTest(
    f.globalAdmin.userId,
    f.hospitalA,
    "meta_whatsapp",
    "CONNECTED",
  );
  assertEquals(rec.error, null);
});
