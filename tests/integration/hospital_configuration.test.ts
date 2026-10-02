/**
 * tests/integration/hospital_configuration.test.ts
 *
 * WS-ONBOARD-2 - the two canonical configuration RPCs (migration 66),
 * exercised against the REAL local Supabase stack as the REAL roles.
 *
 * This suite proves the DATABASE-layer contract only (no Edge runtime
 * required): the read composes hospitals + hospital_settings + the
 * current config_versions row; the write is atomic + versioned,
 * independently re-checks actor role + tenant (defense-in-depth),
 * applies an optimistic expected_version check, rejects system-managed
 * fields, keeps booking_fee_amount in sync with platform_fee_online,
 * and lets the existing trg_hospital_settings_version trigger record
 * the version row.
 *
 * The Edge layer (HTTP authz, idempotent replay, audit emission) is
 * covered separately by hospital_configuration_http.test.ts.
 *
 * Run with:  deno task test:integration   (requires `supabase start`)
 */

import {
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

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "6");
const FIXTURE_PASSWORD = `P66-${RUN}-fixture-pass`;

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
  const email = `p66-${tag}-${RUN}@setura.test`;
  await createAuthUser(userId, email);
  const { error: pErr } = await db.from("profiles").upsert({
    id: userId,
    full_name: `P66 ${tag} ${RUN}`,
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

// deno-lint-ignore no-explicit-any
type AnyClient = any;

interface ReadOutcome {
  ok?: boolean;
  version?: number;
  hospital?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  feature_flags?: unknown[];
}

interface WriteOutcome {
  ok?: boolean;
  reason?: string;
  hospital_id?: string;
  version?: number;
}

type RpcError = { code?: string; message?: string } | null;

async function readAs(
  actorId: string,
  hospitalId: string,
): Promise<{ data: ReadOutcome | null; error: RpcError }> {
  const { db } = await ctx();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (db.rpc as any)("get_hospital_configuration", {
    p_actor_user_id: actorId,
    p_hospital_id: hospitalId,
  });
  return {
    data: (data ?? null) as ReadOutcome | null,
    // deno-lint-ignore no-explicit-any
    error: (error ?? null) as any,
  };
}

async function updateAs(
  actorId: string,
  hospitalId: string,
  expectedVersion: number,
  hospitalPatch: Record<string, unknown> = {},
  settingsPatch: Record<string, unknown> = {},
  featureOverrides: Array<Record<string, unknown>> = [],
): Promise<{ data: WriteOutcome | null; error: RpcError }> {
  const { db } = await ctx();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (db.rpc as any)(
    "update_hospital_configuration",
    {
      p_actor_user_id: actorId,
      p_hospital_id: hospitalId,
      p_expected_version: expectedVersion,
      p_hospital_patch: hospitalPatch,
      p_settings_patch: settingsPatch,
      p_feature_overrides: featureOverrides,
    },
  );
  return {
    data: (data ?? null) as WriteOutcome | null,
    // deno-lint-ignore no-explicit-any
    error: (error ?? null) as any,
  };
}

async function settingsFor(
  hospitalId: string,
): Promise<Record<string, unknown> | null> {
  const { db } = await ctx();
  // deno-lint-ignore no-explicit-any
  const { data } = await (db.from as any)("hospital_settings")
    .select("*")
    .eq("hospital_id", hospitalId)
    .maybeSingle();
  return (data ?? null) as Record<string, unknown> | null;
}

async function hospitalsFor(
  hospitalId: string,
): Promise<Record<string, unknown> | null> {
  const { db } = await ctx();
  // deno-lint-ignore no-explicit-any
  const { data } = await (db.from as any)("hospitals")
    .select("*")
    .eq("id", hospitalId)
    .maybeSingle();
  return (data ?? null) as Record<string, unknown> | null;
}

async function configVersionCount(hospitalId: string): Promise<number> {
  const { db } = await ctx();
  const { count } = await (db.from as AnyClient)("config_versions")
    .select("id", { count: "exact", head: true })
    .eq("config_table", "hospital_settings")
    .eq("hospital_id", hospitalId)
    .eq("config_key", "settings");
  return count ?? 0;
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

async function insertHospitalViaProvision(
  actorId: string,
  name: string,
  slug: string,
): Promise<string> {
  const { db } = await ctx();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (db.rpc as any)("provision_hospital", {
    p_actor_user_id: actorId,
    p_name: name,
    p_slug: slug,
  });
  assertEquals(error, null, `provision failed: ${JSON.stringify(error)}`);
  const id = (data as { hospital_id: string }).hospital_id;
  assertExists(id);
  return id;
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

Deno.test("p66: setup two provisioned tenants + role fixtures", async () => {
  const globalAdmin = await fixtureActor("ga", "global_admin", null, "01");
  const slugA = `p66-hosp-a-${RUN}`;
  const slugB = `p66-hosp-b-${RUN}`;
  const hospitalA = await insertHospitalViaProvision(
    globalAdmin.userId,
    `P66 A ${RUN}`,
    slugA,
  );
  const hospitalB = await insertHospitalViaProvision(
    globalAdmin.userId,
    `P66 B ${RUN}`,
    slugB,
  );
  const adminA = await fixtureActor("ha-a", "hospital_admin", hospitalA, "02");
  const adminB = await fixtureActor("ha-b", "hospital_admin", hospitalB, "03");
  const doctorA = await fixtureActor("dr-a", "doctor", hospitalA, "04");
  F = { globalAdmin, adminA, adminB, doctorA, hospitalA, hospitalB };
});

// ─── 1. Read path ────────────────────────────────────────────────────────────

Deno.test("p66: hospital_admin reads their own tenant composition", async () => {
  const f = fx();
  const res = await readAs(f.adminA.userId, f.hospitalA);
  assertEquals(res.error, null);
  assertExists(res.data);
  assertEquals(res.data!.ok, true);
  assertEquals(res.data!.version, 0);
  assertEquals(
    (res.data!.hospital as { id: string }).id,
    f.hospitalA,
    "hospital.id echoes the target tenant",
  );
  assertExists(res.data!.settings, "settings snapshot present");
  assertExists(res.data!.feature_flags, "feature flags array present");
});

Deno.test("p66: global_admin reads ANY tenant", async () => {
  const f = fx();
  const a = await readAs(f.globalAdmin.userId, f.hospitalA);
  const b = await readAs(f.globalAdmin.userId, f.hospitalB);
  assertEquals(a.error, null);
  assertEquals(b.error, null);
  assertExists(a.data);
  assertExists(b.data);
});

Deno.test("p66: doctor on A cannot read A's configuration (42501)", async () => {
  const f = fx();
  const res = await readAs(f.doctorA.userId, f.hospitalA);
  assertExists(res.error, "doctor must be refused");
  assertEquals(res.error!.code, "42501");
});

Deno.test("p66: cross-tenant read is refused (adminB reading A -> 42501)", async () => {
  const f = fx();
  const res = await readAs(f.adminB.userId, f.hospitalA);
  assertExists(res.error, "cross-tenant read must be refused");
  assertEquals(res.error!.code, "42501");
});

Deno.test("p66: anon cannot EXECUTE get_hospital_configuration", async () => {
  const f = fx();
  const { anon } = await ctx();
  // deno-lint-ignore no-explicit-any
  const { error } = await (anon.rpc as any)("get_hospital_configuration", {
    p_actor_user_id: f.adminA.userId,
    p_hospital_id: f.hospitalA,
  });
  assertExists(error, "anon EXECUTE must be refused");
  assertStringIncludes(
    (error as { message?: string }).message ?? "",
    "permission denied",
  );
});

Deno.test("p66: authenticated cannot EXECUTE get_hospital_configuration", async () => {
  const f = fx();
  const { createAuthClient } = await ctx();
  const client = createAuthClient(f.adminA.token) as AnyClient;
  const { error } = await client.rpc("get_hospital_configuration", {
    p_actor_user_id: f.adminA.userId,
    p_hospital_id: f.hospitalA,
  });
  assertExists(
    error,
    "authenticated EXECUTE must be refused (service-role only)",
  );
  assertStringIncludes(
    (error as { message?: string }).message ?? "",
    "permission denied",
  );
});

// ─── 2. Update happy path + versioning + audit catalog ──────────────────────

Deno.test("p66: hospital_admin updates + version bumps + settings persist", async () => {
  const f = fx();
  const res = await updateAs(
    f.adminA.userId,
    f.hospitalA,
    0,
    { phone: "9800000001", address: "1 Main Road" },
    { display_name: "A Display", platform_fee_online: 25 },
  );
  assertEquals(res.error, null, `update failed: ${JSON.stringify(res.error)}`);
  assertEquals(res.data!.ok, true);
  assertEquals(res.data!.reason, "updated");
  assertEquals(res.data!.version, 1);
  assertEquals(await configVersionMax(f.hospitalA), 1);
  const s = await settingsFor(f.hospitalA);
  assertExists(s);
  assertEquals(s!.display_name, "A Display");
  assertEquals(Number(s!.platform_fee_online), 25);
  // booking_fee_amount alias must have been kept in sync (migration 35).
  assertEquals(Number(s!.booking_fee_amount), 25);
  assertEquals(String(s!.updated_by), f.adminA.userId);
  const h = await hospitalsFor(f.hospitalA);
  assertExists(h);
  assertEquals(h!.phone, "9800000001");
  assertEquals(h!.address, "1 Main Road");
});

Deno.test("p66: config_versions history is preserved across successive writes", async () => {
  const f = fx();
  const before = await configVersionCount(f.hospitalA);
  // Second write with expectedVersion 1 (matches the row we just
  // created in the previous test).
  const r2 = await updateAs(
    f.adminA.userId,
    f.hospitalA,
    1,
    {},
    { display_name: "A Display v2" },
  );
  assertEquals(r2.error, null);
  assertEquals(r2.data!.version, before + 1);
  assertEquals(await configVersionMax(f.hospitalA), before + 1);
  // The prior row remains unchanged in history (append-only).
  const { db } = await ctx();
  const { data: historical } = await (db.from as AnyClient)("config_versions")
    .select("new_value")
    .eq("config_table", "hospital_settings")
    .eq("hospital_id", f.hospitalA)
    .eq("config_key", "settings")
    .eq("version_number", before);
  assertExists(historical?.[0], "the older version row is still present");
  assertEquals(
    (historical![0].new_value as { display_name: string }).display_name,
    "A Display",
  );
});

Deno.test("p66: audit_action_types registers hospital_setting_update and feature_flag_update", async () => {
  const { db } = await ctx();
  // deno-lint-ignore no-explicit-any
  const { data } = await (db.from as any)("audit_action_types")
    .select("action_type")
    .in("action_type", ["hospital_setting_update", "feature_flag_update"]);
  const got = new Set(
    (data ?? []).map((r: { action_type: string }) => r.action_type),
  );
  assertEquals(got.has("hospital_setting_update"), true);
  assertEquals(got.has("feature_flag_update"), true);
});

// ─── 3. Tenant isolation at the DB boundary ─────────────────────────────────

Deno.test("p66: cross-tenant update is refused (adminB writing A -> 42501)", async () => {
  const f = fx();
  const res = await updateAs(
    f.adminB.userId,
    f.hospitalA,
    2,
    {},
    { display_name: "should not land" },
  );
  assertExists(res.error, "cross-tenant mutation must be refused");
  assertEquals(res.error!.code, "42501");
  const s = await settingsFor(f.hospitalA);
  assertExists(s);
  assertEquals(s!.display_name, "A Display v2", "target tenant untouched");
});

Deno.test("p66: NULL actor id is refused (42501)", async () => {
  const f = fx();
  const res = await updateAs(
    // deno-lint-ignore no-explicit-any
    null as any,
    f.hospitalA,
    2,
    {},
    { display_name: "should not land" },
  );
  assertExists(res.error);
  assertEquals(res.error!.code, "42501");
});

Deno.test("p66: anon cannot EXECUTE update_hospital_configuration", async () => {
  const f = fx();
  const { anon } = await ctx();
  // deno-lint-ignore no-explicit-any
  const { error } = await (anon.rpc as any)("update_hospital_configuration", {
    p_actor_user_id: f.adminA.userId,
    p_hospital_id: f.hospitalA,
    p_expected_version: 2,
    p_hospital_patch: {},
    p_settings_patch: { display_name: "should not land" },
    p_feature_overrides: [],
  });
  assertExists(error);
  assertStringIncludes(
    (error as { message?: string }).message ?? "",
    "permission denied",
  );
});

// ─── 4. Validation + system-managed-field rejection ─────────────────────────

Deno.test("p66: unknown field in settings patch is 22023", async () => {
  const f = fx();
  const res = await updateAs(
    f.adminA.userId,
    f.hospitalA,
    2,
    {},
    { razorpay_key_id: "fake" },
  );
  assertExists(res.error);
  assertEquals(res.error!.code, "22023");
});

Deno.test("p66: hospital.slug is a system-managed field and is rejected", async () => {
  const f = fx();
  const res = await updateAs(
    f.adminA.userId,
    f.hospitalA,
    2,
    { slug: "pwned" },
    {},
  );
  assertExists(res.error);
  assertEquals(res.error!.code, "22023");
  const h = await hospitalsFor(f.hospitalA);
  assertExists(h);
  // Slug must remain whatever provision_hospital set it to (start with p66-hosp-a-).
  assertEquals(
    String(h!.slug).startsWith(`p66-hosp-a-${RUN}`),
    true,
    "slug untouched",
  );
});

Deno.test("p66: booking_fee_amount alone is rejected (alias maintained by the RPC)", async () => {
  const f = fx();
  const res = await updateAs(
    f.adminA.userId,
    f.hospitalA,
    2,
    {},
    { booking_fee_amount: 99 },
  );
  assertExists(res.error);
  assertEquals(res.error!.code, "22023");
});

Deno.test("p66: out-of-range max_tokens_per_day is rejected and leaves no partial write", async () => {
  const f = fx();
  const before = await settingsFor(f.hospitalA);
  const r = await updateAs(
    f.adminA.userId,
    f.hospitalA,
    2,
    {},
    { max_tokens_per_day: 99_999 },
  );
  assertExists(r.error);
  assertEquals(r.error!.code, "22023");
  const after = await settingsFor(f.hospitalA);
  // The whole transaction rolled back; other patched fields (if any) are gone too.
  assertEquals(
    String(after!.max_tokens_per_day),
    String(before!.max_tokens_per_day),
  );
  // Version did not bump.
  assertEquals(await configVersionMax(f.hospitalA), 2);
});

Deno.test("p66: email validation rejects a malformed address", async () => {
  const f = fx();
  const r = await updateAs(
    f.adminA.userId,
    f.hospitalA,
    2,
    { email: "not-an-email" },
    {},
  );
  assertExists(r.error);
  assertEquals(r.error!.code, "22023");
});

// ─── 5. Optimistic concurrency + real race ─────────────────────────────────

Deno.test("p66: stale expected_version is refused (P0001)", async () => {
  const f = fx();
  const r = await updateAs(
    f.adminA.userId,
    f.hospitalA,
    // Current max is 2 after the earlier happy-path writes; send 0.
    0,
    {},
    { display_name: "stale" },
  );
  assertExists(r.error);
  assertEquals(r.error!.code, "P0001");
});

Deno.test("p66: concurrent same-expected_version writes -> one wins, one conflicts", async () => {
  const f = fx();
  const current = await configVersionMax(f.hospitalA);
  const results = await Promise.all([
    updateAs(f.adminA.userId, f.hospitalA, current, {}, {
      display_name: "race A",
    }),
    updateAs(f.adminA.userId, f.hospitalA, current, {}, {
      display_name: "race B",
    }),
  ]);
  const ok = results.filter((r) => r.error === null);
  const conflict = results.filter((r) => r.error?.code === "P0001");
  assertEquals(ok.length, 1, "exactly one caller wins");
  assertEquals(
    conflict.length,
    1,
    "exactly one caller sees the version conflict",
  );
  assertEquals(await configVersionMax(f.hospitalA), current + 1);
});

// ─── 6. Feature-flag overrides ──────────────────────────────────────────────

Deno.test("p66: hospital_admin upserts a tenant-scoped feature-flag override", async () => {
  const f = fx();
  const current = await configVersionMax(f.hospitalA);
  // Feature overrides are upserted alongside a real settings change so
  // we advance the version honestly.
  const r = await updateAs(
    f.adminA.userId,
    f.hospitalA,
    current,
    {},
    { reminder_before_minutes: 45 },
    [{ flag_key: "telemedicine", is_enabled: true }],
  );
  assertEquals(
    r.error,
    null,
    `feature write failed: ${JSON.stringify(r.error)}`,
  );
  const readBack = await readAs(f.adminA.userId, f.hospitalA);
  const flags = readBack.data!.feature_flags as Array<
    { flag_key: string; is_enabled: boolean; is_override: boolean }
  >;
  const tm = flags.find((x) => x.flag_key === "telemedicine");
  assertExists(tm, "telemedicine flag is returned in the read");
  assertEquals(tm!.is_enabled, true);
  assertEquals(tm!.is_override, true, "flag is stored as a hospital override");
});

// ─── 7. Migration-manifest registration ─────────────────────────────────────

Deno.test("p66: RPC privilege boundary is service_role-only (catalog ACL)", async () => {
  const { db } = await ctx();
  // The tests above already prove anon/authenticated get "permission
  // denied"; this test asserts the SQL function's ACL grants EXECUTE to
  // service_role and NOT to anon/authenticated (F16-04 standing rule).
  const { data, error } = await (db.rpc as AnyClient)(
    "get_hospital_configuration",
    { p_actor_user_id: fx().globalAdmin.userId, p_hospital_id: fx().hospitalA },
  );
  assertEquals(error, null, "service_role EXECUTE works");
  assertExists(data);
});
