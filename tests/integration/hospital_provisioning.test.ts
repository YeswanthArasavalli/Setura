/**
 * tests/integration/hospital_provisioning.test.ts
 *
 * WS-ONBOARD-1 — the canonical `provision_hospital` RPC (migration 65),
 * exercised against the REAL local Supabase stack as the REAL roles.
 *
 * This suite proves the DATABASE-layer contract only (no Edge runtime
 * required): the tenant is created atomically with its settings defaults,
 * the privilege boundary is fail-closed (F16-04 explicit REVOKE), the DB
 * independently refuses a non-global_admin actor, a duplicate slug is a
 * collision (not a silent success), invalid identity is rejected, and a
 * failed provision leaves no partial row.
 *
 * The Edge layer (HTTP authz, idempotent replay, audit emission) is covered
 * separately by hospital_provisioning_http.test.ts.
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

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "7");
const FIXTURE_PASSWORD = `P65-${RUN}-fixture-pass`;

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

/**
 * Create a real auth user + profile + role row and return the actor. The RPC
 * re-checks the actor against `user_roles`, so the fixture must actually hold
 * the role (no fake shortcut).
 */
async function fixtureActor(
  tag: string,
  role: "global_admin" | "hospital_admin",
  hospitalId: string | null,
  phoneSuffix: string,
): Promise<Actor> {
  const { db } = await ctx();
  const userId = crypto.randomUUID();
  const email = `p65-${tag}-${RUN}@setura.test`;
  await createAuthUser(userId, email);
  const { error: pErr } = await db.from("profiles").upsert({
    id: userId,
    full_name: `P65 ${tag} ${RUN}`,
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

// deno-lint-ignore no-explicit-any
type AnyClient = any;

interface ProvisionOutcome {
  ok?: boolean;
  reason?: string;
  hospital_id?: string;
  name?: string;
  slug?: string;
}

type RpcError = { code?: string; message?: string } | null;

async function provisionAs(
  actorId: string,
  name: string,
  slug: string,
  extra: Record<string, string> = {},
): Promise<{ data: ProvisionOutcome | null; error: RpcError }> {
  const { db } = await ctx();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (db.rpc as any)("provision_hospital", {
    p_actor_user_id: actorId,
    p_name: name,
    p_slug: slug,
    ...extra,
  });
  return {
    data: (data ?? null) as ProvisionOutcome | null,
    // deno-lint-ignore no-explicit-any
    error: (error ?? null) as any,
  };
}

async function hospitalBySlug(
  slug: string,
): Promise<
  { id: string; name: string; country: string; timezone: string } | null
> {
  const { db } = await ctx();
  // deno-lint-ignore no-explicit-any
  const { data } = await (db.from as any)("hospitals")
    .select("id,name,country,timezone")
    .eq("slug", slug)
    .maybeSingle();
  return (data ?? null) as
    | { id: string; name: string; country: string; timezone: string }
    | null;
}

async function settingsCountFor(hospitalId: string): Promise<number> {
  const { db } = await ctx();
  // deno-lint-ignore no-explicit-any
  const { count } = await (db.from as any)("hospital_settings")
    .select("id", { count: "exact", head: true })
    .eq("hospital_id", hospitalId);
  return count ?? 0;
}

interface FixtureState {
  globalAdmin: Actor;
  hospitalAdmin: Actor;
  anchorHospital: string;
  slugA: string;
}

let F: FixtureState | null = null;

function fx(): FixtureState {
  if (!F) throw new Error("setup test not run");
  return F;
}

// ─── 0. Setup ────────────────────────────────────────────────────────────────

Deno.test("p65: setup fixture actors (global_admin + hospital_admin)", async () => {
  const { db } = await ctx();

  // A pre-existing hospital so the non-global fixture role has a valid tenant.
  const anchor = `p65-anchor-${RUN}`;
  const { data: h, error: hErr } = await (db.from as AnyClient)("hospitals")
    .insert({ name: `P65 Anchor ${RUN}`, slug: anchor })
    .select("id")
    .single();
  assertEquals(hErr, null);
  assertExists(h);

  const globalAdmin = await fixtureActor("ga", "global_admin", null, "01");
  const hospitalAdmin = await fixtureActor(
    "ha",
    "hospital_admin",
    h.id as string,
    "02",
  );

  F = {
    globalAdmin,
    hospitalAdmin,
    anchorHospital: h.id as string,
    slugA: `p65-hosp-${RUN}`,
  };
});

// ─── 1. Happy path: tenant created atomically with settings defaults ────────

Deno.test("p65: provision creates hospital row + auto hospital_settings", async () => {
  const f = fx();
  const res = await provisionAs(
    f.globalAdmin.userId,
    `Provisioned Hospital ${RUN}`,
    f.slugA,
    { p_email: `ops-${RUN}@setura.test`, p_district: `dist-${RUN}` },
  );
  assertEquals(
    res.error,
    null,
    `provision failed: ${JSON.stringify(res.error)}`,
  );
  assertEquals(res.data?.ok, true);
  assertEquals(res.data?.reason, "created");
  assertExists(res.data?.hospital_id);
  assertEquals(res.data?.slug, f.slugA);

  const row = await hospitalBySlug(f.slugA);
  assertExists(row, "hospital row must exist after provision");
  assertEquals(row!.name, `Provisioned Hospital ${RUN}`);
  // Unspecified NOT-NULL fields fall back to the platform defaults the RPC sets.
  assertEquals(row!.country, "India");
  assertEquals(row!.timezone, "Asia/Kolkata");

  // The EXISTING AFTER-INSERT trigger must have created the settings defaults.
  const settings = await settingsCountFor(row!.id);
  assertEquals(settings, 1, "auto_create_hospital_settings trigger must fire");
});

// ─── 2. Privilege boundary (F16-04 explicit REVOKE) ──────────────────────────

Deno.test("p65: anon cannot EXECUTE provision_hospital (permission denied)", async () => {
  const { anon } = await ctx();
  const f = fx();
  const { error } = await (anon.rpc as AnyClient)("provision_hospital", {
    p_actor_user_id: f.globalAdmin.userId,
    p_name: `Anon Attempt ${RUN}`,
    p_slug: `p65-anon-${RUN}`,
  });
  assertExists(error, "anon EXECUTE must be refused at the privilege layer");
  assertStringIncludes(
    (error as { message?: string }).message ?? "",
    "permission denied",
  );
  // No tenant was created by the refused attempt.
  assertEquals(await hospitalBySlug(`p65-anon-${RUN}`), null);
});

Deno.test("p65: authenticated (even hospital_admin) cannot EXECUTE provision_hospital", async () => {
  const { createAuthClient } = await ctx();
  const f = fx();
  const client = createAuthClient(f.hospitalAdmin.token) as AnyClient;
  const { error } = await client.rpc("provision_hospital", {
    p_actor_user_id: f.hospitalAdmin.userId,
    p_name: `Auth Attempt ${RUN}`,
    p_slug: `p65-auth-${RUN}`,
  });
  assertExists(
    error,
    "authenticated EXECUTE must be refused (service_role-only function)",
  );
  assertStringIncludes(
    (error as { message?: string }).message ?? "",
    "permission denied",
  );
  assertEquals(await hospitalBySlug(`p65-auth-${RUN}`), null);
});

// ─── 3. DB-layer authorization: non-global_admin actor refused (42501) ───────

Deno.test("p65: RPC refuses a non-global_admin actor with 42501", async () => {
  const f = fx();
  // service_role can EXECUTE, so this isolates the RPC's own role re-check.
  const res = await provisionAs(
    f.hospitalAdmin.userId,
    `Non Admin ${RUN}`,
    `p65-nonadmin-${RUN}`,
  );
  assertExists(res.error, "non-global_admin actor must be refused");
  assertEquals(res.error!.code, "42501");
  assertStringIncludes(res.error!.message ?? "", "global_admin");
  assertEquals(await hospitalBySlug(`p65-nonadmin-${RUN}`), null);
});

Deno.test("p65: RPC refuses a NULL actor with 42501", async () => {
  const { db } = await ctx();
  const slug = `p65-null-${RUN}`;
  // Pass a genuine SQL NULL (not an empty string, which fails UUID coercion at
  // binding with 22P02 before the body runs) so the RPC's own IS NULL guard is
  // the thing under test.
  // deno-lint-ignore no-explicit-any
  const { error } = await (db.rpc as any)("provision_hospital", {
    p_actor_user_id: null,
    p_name: `Null Actor ${RUN}`,
    p_slug: slug,
  });
  assertExists(error, "NULL actor must be refused");
  assertEquals((error as { code?: string }).code, "42501");
  assertEquals(await hospitalBySlug(slug), null);
});

// ─── 4. Duplicate slug is a collision (23505), never a silent success ────────

Deno.test("p65: duplicate slug returns 23505 and does not create a second row", async () => {
  const f = fx();
  // slugA was created in test 1.
  const dupe = await provisionAs(
    f.globalAdmin.userId,
    `Second ${RUN}`,
    f.slugA,
  );
  assertExists(dupe.error, "duplicate slug must be refused");
  assertEquals(dupe.error!.code, "23505");

  const row = await hospitalBySlug(f.slugA);
  assertExists(row);
  // Still exactly one hospital with that slug (the original), and the RPC is
  // not callable in a way that could have produced a second — assert count via
  // settings for the original is unchanged (single settings row for single tenant).
  assertEquals(await settingsCountFor(row!.id), 1);
});

// ─── 4b. Concurrency: parallel same-slug cannot create two tenants ───────────

Deno.test("p65: concurrent same-slug provisioning yields exactly one tenant", async () => {
  const { db } = await ctx();
  const f = fx();
  const slug = `p65-concurrent-${RUN}`;
  // Two genuinely parallel transactions for the SAME slug (distinct logical
  // requests). The UNIQUE constraint + the RPC's unique_violation handler must
  // let exactly one win and force the other to a 23505 collision — never two
  // hospitals.
  const results = await Promise.all([
    provisionAs(f.globalAdmin.userId, `Concurrent A ${RUN}`, slug),
    provisionAs(f.globalAdmin.userId, `Concurrent B ${RUN}`, slug),
  ]);
  const created = results.filter((r) => r.error === null).length;
  const collided = results.filter((r) => r.error?.code === "23505").length;
  assertEquals(created, 1, "exactly one concurrent call may create the tenant");
  assertEquals(
    collided,
    1,
    "the other must collide on the unique slug (23505)",
  );

  const { count } = await (db.from as AnyClient)("hospitals")
    .select("id", { count: "exact", head: true })
    .eq("slug", slug);
  assertEquals(count, 1, "concurrent provisioning must not leave two rows");
});

// ─── 5. Invalid identity is rejected (22023) with no partial row ─────────────

Deno.test("p65: malformed slug is rejected 22023 (rollback: no partial row)", async () => {
  const f = fx();
  const badSlug = `Bad Slug ${RUN}!`;
  const res = await provisionAs(f.globalAdmin.userId, `Bad ${RUN}`, badSlug);
  assertExists(res.error, "invalid slug must be rejected");
  assertEquals(res.error!.code, "22023");
  assertEquals(
    await hospitalBySlug(badSlug.toLowerCase()),
    null,
    "a rejected provision must leave no hospital row",
  );
});

Deno.test("p65: empty name is rejected 22023 (rollback: no partial row)", async () => {
  const f = fx();
  const slug = `p65-emptyname-${RUN}`;
  const res = await provisionAs(f.globalAdmin.userId, "   ", slug);
  assertExists(res.error, "blank name must be rejected");
  assertEquals(res.error!.code, "22023");
  assertEquals(await hospitalBySlug(slug), null);
});

// ─── 6. Audit action type registered for the provisioning event ──────────────

Deno.test("p65: audit_action_types registers 'hospital_provision'", async () => {
  const { db } = await ctx();
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (db.from as any)("audit_action_types")
    .select("action_type,category,default_severity")
    .eq("action_type", "hospital_provision")
    .maybeSingle();
  assertEquals(error, null);
  assertExists(data, "the provisioning audit action type must be registered");
  assertEquals(data.category, "system");
  assertEquals(data.default_severity, "high");
});
