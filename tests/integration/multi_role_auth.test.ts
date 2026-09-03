/**
 * tests/integration/multi_role_auth.test.ts
 *
 * Product decision D-1 — multi-role authorization — against the REAL
 * local Supabase stack. No mocked authorization: every token is a real
 * GoTrue access token obtained by password grant, `resolveAuth()` is the
 * real Edge-layer function, and `current_user_role()` is called through
 * PostgREST as the authenticated user so the database's own answer is
 * observed rather than assumed.
 *
 * The rule under test:
 *
 *   1. The `is_primary` role for the SELECTED hospital is authoritative.
 *   2. Several roles per (user, hospital) remain legal. Holding more
 *      roles must never grant more privilege.
 *   3. A role set with no primary is inconsistent, so access is denied
 *      (fail closed) rather than guessed at.
 *   4. `global_admin` stays explicit: it is a hospital_id IS NULL grant
 *      and is only consulted when the user has no grant at the hospital.
 *
 * Both halves of the fix are covered, because both used to be wrong in
 * the same way:
 *   - `supabase/functions/_shared/auth.ts` (`resolveAuth`/`selectRole`),
 *     which used `.single()` and therefore ERRORED on a legitimate
 *     multi-role user instead of returning a row.
 *   - `public.current_user_role(UUID)` (migration 49), which used a bare
 *     `LIMIT 1` with no `ORDER BY` and therefore returned an arbitrary
 *     role to every RLS policy that calls it.
 *
 * Residue policy: nothing here writes audit_logs, so every fixture row
 * is fully removed by the teardown test.
 *
 * Run with:  deno task test:integration
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
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

// ─── One-time bootstrap: env → dynamic import of the real modules ────────────

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

  const { createAuthClient, getServiceClient } = await import(
    "../../supabase/functions/_shared/db.ts"
  );
  const auth = await import("../../supabase/functions/_shared/auth.ts");
  const { rootLogger } = await import(
    "../../supabase/functions/_shared/logger.ts"
  );

  return {
    db: getServiceClient(),
    createAuthClient,
    resolveAuth: auth.resolveAuth,
    requireRole: auth.requireRole,
    ROLE_HIERARCHY: auth.ROLE_HIERARCHY,
    logger: rootLogger,
  };
}

async function ctx(): Promise<Shared> {
  if (!_ctx) _ctx = await bootstrap();
  return _ctx;
}

// ─── Per-run fixture isolation ───────────────────────────────────────────────

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "7");
const FIXTURE_PASSWORD = `D1-${RUN}-fixture-pass`;

type RoleName = "global_admin" | "hospital_admin" | "doctor" | "receptionist";

interface Actor {
  userId: string;
  email: string;
  token: string;
}

interface FixtureState {
  hospitalA: string;
  hospitalB: string;
  /** One role, primary. The baseline case. */
  single: Actor;
  /** receptionist (primary) + hospital_admin (secondary) at A. */
  multi: Actor;
  /** doctor (primary) + receptionist (secondary) at A. */
  docPrimary: Actor;
  /** hospital_admin (primary) + doctor (secondary) at A. */
  adminPlus: Actor;
  /** Primary at BOTH hospitals: admin at A, doctor at B. */
  dual: Actor;
  /** Two roles at A, NEITHER primary. Inconsistent legacy state. */
  legacy: Actor;
  /** global_admin only (hospital_id IS NULL). */
  gadmin: Actor;
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

/** A bare request carrying only the Bearer token, as the edge sees it. */
function authorizedRequest(token: string): Request {
  return new Request("http://localhost/d1-multi-role", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}` },
  });
}

/**
 * The DATABASE's own answer, obtained as the authenticated user through
 * PostgREST. This is deliberately not the service client: the point is
 * that `auth.uid()` inside `current_user_role()` is the fixture user.
 */
async function dbRoleFor(
  actor: Actor,
  hospitalId: string,
): Promise<string | null> {
  const { createAuthClient } = await ctx();
  const client = createAuthClient(actor.token);
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (client.rpc as any)("current_user_role", {
    p_hospital_id: hospitalId,
  });
  assertEquals(error, null);
  return (data ?? null) as string | null;
}

// ─── 0. Setup ────────────────────────────────────────────────────────────────

Deno.test("d1: setup hospitals and multi-role actors", async () => {
  const { db } = await ctx();

  const { data: hA, error: hAErr } = await db
    .from("hospitals")
    .insert({ name: `D1 Role ${RUN} A`, slug: `d1-role-${RUN}-a` })
    .select("id")
    .single();
  assertEquals(hAErr, null);
  const { data: hB, error: hBErr } = await db
    .from("hospitals")
    .insert({ name: `D1 Role ${RUN} B`, slug: `d1-role-${RUN}-b` })
    .select("id")
    .single();
  assertEquals(hBErr, null);
  assertExists(hA);
  assertExists(hB);
  const hospitalA = hA.id as string;
  const hospitalB = hB.id as string;

  /**
   * Creates one fixture actor and grants exactly the listed roles.
   *
   * `grants` is written out per actor rather than derived, because the
   * is_primary layout IS the thing under test. UNIQUE(user_id,
   * hospital_id, role) and the partial unique index idx_primary_role
   * are both left to enforce themselves — a grant list that violated
   * either would fail here, which is the correct outcome.
   */
  async function actor(
    tag: string,
    phoneSuffix: string,
    grants: Array<{
      hospitalId: string | null;
      role: RoleName;
      isPrimary: boolean;
    }>,
  ): Promise<Actor> {
    const userId = crypto.randomUUID();
    const email = `d1-${tag}-${RUN}@setura.test`;
    await createAuthUser(userId, email);

    const { error: pErr } = await db.from("profiles").upsert({
      id: userId,
      full_name: `D1 ${tag} ${RUN}`,
      normalized_phone: `95${RUN}${phoneSuffix}`,
    });
    assertEquals(pErr, null);

    for (const g of grants) {
      const { error } = await db.from("user_roles").insert({
        user_id: userId,
        hospital_id: g.hospitalId,
        role: g.role,
        is_primary: g.isPrimary,
      });
      assertEquals(error, null, `grant ${g.role} for ${tag}`);
    }

    return { userId, email, token: await tokenFor(email) };
  }

  const single = await actor("single", "11", [
    { hospitalId: hospitalA, role: "receptionist", isPrimary: true },
  ]);

  // The no-escalation case: the secondary role outranks the primary.
  const multi = await actor("multi", "12", [
    { hospitalId: hospitalA, role: "receptionist", isPrimary: true },
    { hospitalId: hospitalA, role: "hospital_admin", isPrimary: false },
  ]);

  const docPrimary = await actor("docprim", "13", [
    { hospitalId: hospitalA, role: "doctor", isPrimary: true },
    { hospitalId: hospitalA, role: "receptionist", isPrimary: false },
  ]);

  const adminPlus = await actor("adminplus", "14", [
    { hospitalId: hospitalA, role: "hospital_admin", isPrimary: true },
    { hospitalId: hospitalA, role: "doctor", isPrimary: false },
  ]);

  // idx_primary_role is UNIQUE per (user, hospital), so two primaries
  // ACROSS hospitals are legal and were exactly what `.single()` broke.
  const dual = await actor("dual", "15", [
    { hospitalId: hospitalA, role: "hospital_admin", isPrimary: true },
    { hospitalId: hospitalB, role: "doctor", isPrimary: true },
  ]);

  const legacy = await actor("legacy", "16", [
    { hospitalId: hospitalA, role: "doctor", isPrimary: false },
    { hospitalId: hospitalA, role: "receptionist", isPrimary: false },
  ]);

  // role_hospital_consistency forces hospital_id IS NULL for this role.
  const gadmin = await actor("gadmin", "17", [
    { hospitalId: null, role: "global_admin", isPrimary: true },
  ]);

  F = {
    hospitalA,
    hospitalB,
    single,
    multi,
    docPrimary,
    adminPlus,
    dual,
    legacy,
    gadmin,
  };
});

// ─── 1. Single role (baseline) ───────────────────────────────────────────────

Deno.test("d1: a single primary role resolves to that role", async () => {
  const { resolveAuth, logger } = await ctx();
  const f = fx();

  const auth = await resolveAuth(
    authorizedRequest(f.single.token),
    f.hospitalA,
    logger,
  );

  assertEquals(auth.userId, f.single.userId);
  assertEquals(auth.hospitalId, f.hospitalA);
  assertEquals(auth.role, "receptionist");

  // The database agrees. Both sides apply the same rule.
  assertEquals(await dbRoleFor(f.single, f.hospitalA), "receptionist");
});

// ─── 2. Multiple roles at one hospital: primary wins, never the highest ──────

Deno.test("d1: multiple roles at one hospital resolve to the primary", async () => {
  const { resolveAuth, requireRole, logger } = await ctx();
  const f = fx();

  // receptionist is primary; hospital_admin is held as a secondary role.
  const auth = await resolveAuth(
    authorizedRequest(f.multi.token),
    f.hospitalA,
    logger,
  );

  // Before the fix this threw: `.single()` errors on two rows, so a
  // legitimate multi-role user was locked out of their own hospital.
  assertEquals(auth.role, "receptionist");

  // "Never escalate privileges because multiple roles exist" (D-1).
  // Holding hospital_admin as a secondary role must not confer it.
  requireRole(auth, ["receptionist"]);
  assertThrows(
    () => requireRole(auth, ["hospital_admin"]),
    Error,
    "Role insufficient",
  );

  assertEquals(await dbRoleFor(f.multi, f.hospitalA), "receptionist");
});

// ─── 3. Primary doctor + receptionist ───────────────────────────────────────

Deno.test("d1: primary doctor with a receptionist role resolves to doctor", async () => {
  const { resolveAuth, logger } = await ctx();
  const f = fx();

  const auth = await resolveAuth(
    authorizedRequest(f.docPrimary.token),
    f.hospitalA,
    logger,
  );

  // The primary is authoritative in BOTH directions: here it is the
  // HIGHER-privileged of the two roles, so the rule cannot be mistaken
  // for "always pick the least privileged role".
  assertEquals(auth.role, "doctor");
  assertEquals(await dbRoleFor(f.docPrimary, f.hospitalA), "doctor");
});

// ─── 4. Primary admin + secondary role ──────────────────────────────────────

Deno.test("d1: primary hospital_admin with a secondary role resolves to hospital_admin", async () => {
  const { resolveAuth, requireRole, logger } = await ctx();
  const f = fx();

  const auth = await resolveAuth(
    authorizedRequest(f.adminPlus.token),
    f.hospitalA,
    logger,
  );

  assertEquals(auth.role, "hospital_admin");
  requireRole(auth, ["hospital_admin"]);
  assertEquals(await dbRoleFor(f.adminPlus, f.hospitalA), "hospital_admin");
});

// ─── 5. Primary at several hospitals ────────────────────────────────────────

Deno.test("d1: multi-hospital primary roles resolve per selected hospital", async () => {
  const { resolveAuth, ROLE_HIERARCHY, logger } = await ctx();
  const f = fx();

  // idx_primary_role is per (user, hospital), so this user has TWO
  // is_primary rows. `.single()` used to fail and leave role null.
  const atA = await resolveAuth(
    authorizedRequest(f.dual.token),
    f.hospitalA,
    logger,
  );
  assertEquals(atA.role, "hospital_admin");

  const atB = await resolveAuth(
    authorizedRequest(f.dual.token),
    f.hospitalB,
    logger,
  );
  assertEquals(atB.role, "doctor");

  assertEquals(await dbRoleFor(f.dual, f.hospitalA), "hospital_admin");
  assertEquals(await dbRoleFor(f.dual, f.hospitalB), "doctor");

  // With no hospital context there is no single authoritative scope, so
  // the tie between two primaries breaks toward LEAST privilege.
  assert(
    ROLE_HIERARCHY.doctor < ROLE_HIERARCHY.hospital_admin,
    "role levels must rank doctor below hospital_admin",
  );
  const unscoped = await resolveAuth(
    authorizedRequest(f.dual.token),
    null,
    logger,
  );
  assertEquals(unscoped.hospitalId, null);
  assertEquals(unscoped.role, "doctor");
});

// ─── 6. Inconsistent legacy state ───────────────────────────────────────────

Deno.test("d1: a role set with no primary fails closed", async () => {
  const { resolveAuth, logger } = await ctx();
  const f = fx();

  // Two roles, neither primary. The effective role is unknowable, and
  // guessing would either escalate or pick arbitrarily, so this denies.
  await assertRejects(
    () => resolveAuth(authorizedRequest(f.legacy.token), f.hospitalA, logger),
    Error,
    `Access denied to hospital ${f.hospitalA}`,
  );

  // The database is deterministic rather than fail-closed here: RLS
  // policies need an answer, and with no primary the ORDER BY falls
  // through to the LEAST privileged role. It cannot escalate.
  assertEquals(await dbRoleFor(f.legacy, f.hospitalA), "receptionist");

  // Repairing the state repairs access, without changing the role set.
  const { db } = await ctx();
  const { error: upErr } = await db
    .from("user_roles")
    .update({ is_primary: true })
    .eq("user_id", f.legacy.userId)
    .eq("hospital_id", f.hospitalA)
    .eq("role", "doctor");
  assertEquals(upErr, null);

  const repaired = await resolveAuth(
    authorizedRequest(f.legacy.token),
    f.hospitalA,
    logger,
  );
  assertEquals(repaired.role, "doctor");
  assertEquals(await dbRoleFor(f.legacy, f.hospitalA), "doctor");
});

// ─── 7. Cross-hospital access ───────────────────────────────────────────────

Deno.test("d1: a role at one hospital grants nothing at another", async () => {
  const { resolveAuth, logger } = await ctx();
  const f = fx();

  await assertRejects(
    () =>
      resolveAuth(authorizedRequest(f.docPrimary.token), f.hospitalB, logger),
    Error,
    `Access denied to hospital ${f.hospitalB}`,
  );

  // Same for the multi-role user: extra roles at A are still only at A.
  await assertRejects(
    () => resolveAuth(authorizedRequest(f.multi.token), f.hospitalB, logger),
    Error,
    `Access denied to hospital ${f.hospitalB}`,
  );

  // And the database refuses to name a role out of scope.
  assertEquals(await dbRoleFor(f.docPrimary, f.hospitalB), null);
});

// ─── 8. global_admin stays explicit ─────────────────────────────────────────

Deno.test("d1: global_admin resolves at any hospital without a grant there", async () => {
  const { resolveAuth, requireRole, logger } = await ctx();
  const f = fx();

  for (const hospitalId of [f.hospitalA, f.hospitalB]) {
    const auth = await resolveAuth(
      authorizedRequest(f.gadmin.token),
      hospitalId,
      logger,
    );
    assertEquals(auth.role, "global_admin");
    requireRole(auth, ["receptionist"]); // global_admin always passes
  }

  // The grant itself is hospital-scoped to NULL by
  // role_hospital_consistency, so a hospital-scoped lookup finds
  // nothing and the global fallback is what answers.
  assertEquals(await dbRoleFor(f.gadmin, f.hospitalA), null);
});

// ─── 9. Inactive and unauthenticated callers ────────────────────────────────

Deno.test("d1: an inactive profile is denied regardless of role set", async () => {
  const { db, resolveAuth, logger } = await ctx();
  const f = fx();

  const { error: offErr } = await db
    .from("profiles")
    .update({ is_active: false })
    .eq("id", f.adminPlus.userId);
  assertEquals(offErr, null);

  await assertRejects(
    () =>
      resolveAuth(authorizedRequest(f.adminPlus.token), f.hospitalA, logger),
    Error,
    "User account is inactive",
  );

  const { error: onErr } = await db
    .from("profiles")
    .update({ is_active: true })
    .eq("id", f.adminPlus.userId);
  assertEquals(onErr, null);
});

Deno.test("d1: no token and a garbage token are both rejected", async () => {
  const { resolveAuth, logger } = await ctx();
  const f = fx();

  await assertRejects(
    () =>
      resolveAuth(
        new Request("http://localhost/d1-multi-role", { method: "POST" }),
        f.hospitalA,
        logger,
      ),
    Error,
    "Missing Bearer token",
  );

  await assertRejects(
    () =>
      resolveAuth(
        authorizedRequest("not.a.jwt"),
        f.hospitalA,
        logger,
      ),
    Error,
    "Invalid or expired token",
  );
});

// ─── 10. Teardown ───────────────────────────────────────────────────────────

Deno.test("d1: teardown removes every fixture row", async () => {
  const { db } = await ctx();
  const f = fx();

  const actors = [
    f.single,
    f.multi,
    f.docPrimary,
    f.adminPlus,
    f.dual,
    f.legacy,
    f.gadmin,
  ];

  for (const a of actors) {
    const { error } = await db.from("user_roles").delete().eq(
      "user_id",
      a.userId,
    );
    assertEquals(error, null);
  }

  for (const a of actors) {
    const { error } = await db.from("profiles").delete().eq("id", a.userId);
    assertEquals(error, null);
    await deleteAuthUser(a.userId);
  }

  for (const hid of [f.hospitalA, f.hospitalB]) {
    const { error } = await db.from("hospitals").delete().eq("id", hid);
    assertEquals(error, null);
  }
});
