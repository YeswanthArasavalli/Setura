/**
 * tests/integration/cancellation_policy.test.ts
 *
 * WS-CONF-1 - the two canonical cancellation-policy RPCs (migration 72),
 * exercised against the REAL local Supabase stack as the REAL roles.
 *
 * This suite proves the DATABASE-layer contract only (no Edge runtime
 * required): the read composes the tenant's cancellation_policies row + its
 * version history; the write is atomic + versioned, independently re-checks
 * actor role + tenant (defense-in-depth), applies an optimistic expected-version
 * check, rejects system-managed / unknown fields, validates the refund tiers,
 * bumps version so the EXISTING trg_cancel_policy_history trigger records the
 * prior snapshot, and never changes refund-calculation semantics.
 *
 * The Edge layer (HTTP authz, idempotent replay, audit emission) is covered
 * separately by cancellation_policy_http.test.ts.
 *
 * Run with:  deno task test:integration   (requires `supabase start`)
 */

import {
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
const FIXTURE_PASSWORD = `P72-${RUN}-fixture-pass`;

interface Actor {
  userId: string;
  email: string;
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

async function fixtureActor(
  tag: string,
  role: "global_admin" | "hospital_admin" | "doctor",
  hospitalId: string | null,
  phoneSuffix: string,
): Promise<Actor> {
  const { db } = await ctx();
  const userId = crypto.randomUUID();
  const email = `p72-${tag}-${RUN}@setura.test`;
  await createAuthUser(userId, email);
  const { error: pErr } = await (db.from as AnyClient)("profiles").upsert({
    id: userId,
    full_name: `P72 ${tag} ${RUN}`,
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
  return { userId, email };
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

type RpcError = { code?: string; message?: string } | null;

interface ReadOutcome {
  ok?: boolean;
  hospital_id?: string;
  version?: number;
  policy?: Record<string, unknown>;
  history?: unknown[];
}

interface WriteOutcome {
  ok?: boolean;
  reason?: string;
  hospital_id?: string;
  version?: number;
}

async function readAs(
  actorId: string,
  hospitalId: string,
): Promise<{ data: ReadOutcome | null; error: RpcError }> {
  const { db } = await ctx();
  const { data, error } = await (db.rpc as AnyClient)(
    "get_cancellation_policy",
    { p_actor_user_id: actorId, p_hospital_id: hospitalId },
  );
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
  patch: Record<string, unknown> = {},
): Promise<{ data: WriteOutcome | null; error: RpcError }> {
  const { db } = await ctx();
  const { data, error } = await (db.rpc as AnyClient)(
    "update_cancellation_policy",
    {
      p_actor_user_id: actorId,
      p_hospital_id: hospitalId,
      p_expected_version: expectedVersion,
      p_patch: patch,
    },
  );
  return {
    data: (data ?? null) as WriteOutcome | null,
    // deno-lint-ignore no-explicit-any
    error: (error ?? null) as any,
  };
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

Deno.test("p72: setup two provisioned tenants + role fixtures", async () => {
  const globalAdmin = await fixtureActor("ga", "global_admin", null, "01");
  const hospitalA = await provisionAs(
    globalAdmin.userId,
    `P72 A ${RUN}`,
    `p72-hosp-a-${RUN}`,
  );
  const hospitalB = await provisionAs(
    globalAdmin.userId,
    `P72 B ${RUN}`,
    `p72-hosp-b-${RUN}`,
  );
  const adminA = await fixtureActor("ha-a", "hospital_admin", hospitalA, "02");
  const adminB = await fixtureActor("ha-b", "hospital_admin", hospitalB, "03");
  const doctorA = await fixtureActor("dr-a", "doctor", hospitalA, "04");
  F = { globalAdmin, adminA, adminB, doctorA, hospitalA, hospitalB };

  // Each tenant was auto-issued a cancellation_policies row (migration 29
  // trigger) at version 1 with the schema defaults.
  const rowA = await policyRow(hospitalA);
  assertExists(rowA, "auto-created policy row must exist for a fresh tenant");
  assertEquals(rowA!.version, 1);
});

// ─── 1. Read path ────────────────────────────────────────────────────────────

Deno.test("p72: hospital_admin reads their own tenant policy", async () => {
  const f = fx();
  const res = await readAs(f.adminA.userId, f.hospitalA);
  assertEquals(res.error, null);
  assertExists(res.data);
  assertEquals(res.data!.ok, true);
  assertEquals(res.data!.hospital_id, f.hospitalA);
  assertEquals(res.data!.version, 1);
  assertExists(res.data!.policy, "policy snapshot present");
  assertEquals(
    (res.data!.policy as { full_refund_within_minutes: number })
      .full_refund_within_minutes,
    30,
    "default free-cancellation window",
  );
  assertExists(res.data!.history, "history array present");
  assertEquals(res.data!.history!.length, 0, "no prior versions yet");
});

Deno.test("p72: global_admin reads ANY tenant policy", async () => {
  const f = fx();
  const res = await readAs(f.globalAdmin.userId, f.hospitalB);
  assertEquals(res.error, null);
  assertEquals(res.data!.hospital_id, f.hospitalB);
});

Deno.test("p72: doctor is denied read (42501)", async () => {
  const f = fx();
  const res = await readAs(f.doctorA.userId, f.hospitalA);
  assertEquals(res.error?.code, "42501");
});

Deno.test("p72: cross-tenant hospital_admin read is denied (42501)", async () => {
  const f = fx();
  const res = await readAs(f.adminB.userId, f.hospitalA);
  assertEquals(res.error?.code, "42501");
});

// ─── 2. Write path ───────────────────────────────────────────────────────────

Deno.test("p72: hospital_admin updates own policy, version bumps, history grows", async () => {
  const f = fx();
  const res = await updateAs(f.adminA.userId, f.hospitalA, 1, {
    full_refund_within_minutes: 45,
    same_day_refund_percentage: 25,
    notes: "Lenient window set by hospital admin",
  });
  assertEquals(res.error, null, `update failed: ${JSON.stringify(res.error)}`);
  assertEquals(res.data!.ok, true);
  assertEquals(res.data!.reason, "updated");
  assertEquals(res.data!.version, 2, "version bumped by exactly one");

  const row = await policyRow(f.hospitalA);
  assertEquals(row!.full_refund_within_minutes, 45);
  assertEquals(Number(row!.same_day_refund_percentage), 25);
  assertEquals(row!.notes, "Lenient window set by hospital admin");
  assertEquals(row!.version, 2);

  const hist = await historyCount(f.hospitalA);
  assertEquals(
    hist,
    1,
    "the existing history trigger captured the v1 snapshot",
  );
});

Deno.test("p72: stale expected_version is a conflict (P0001)", async () => {
  const f = fx();
  const res = await updateAs(f.adminA.userId, f.hospitalA, 1, {
    full_refund_within_minutes: 60,
  });
  assertEquals(res.error?.code, "P0001");
  // Value unchanged: still 45 from the prior successful write.
  const row = await policyRow(f.hospitalA);
  assertEquals(row!.full_refund_within_minutes, 45);
});

Deno.test("p72: empty patch is a honest noop (no version bump)", async () => {
  const f = fx();
  const res = await updateAs(f.adminA.userId, f.hospitalA, 2, {});
  assertEquals(res.error, null);
  assertEquals(res.data!.reason, "noop");
  assertEquals(res.data!.version, 2);
  const hist = await historyCount(f.hospitalA);
  assertEquals(hist, 1, "noop does not create a history row");
});

Deno.test("p72: system-managed / unknown keys are rejected (22023)", async () => {
  const f = fx();
  const rVersion = await updateAs(f.adminA.userId, f.hospitalA, 2, {
    version: 999,
  });
  assertEquals(rVersion.error?.code, "22023");
  const rHosp = await updateAs(f.adminA.userId, f.hospitalA, 2, {
    hospital_id: f.hospitalB,
  });
  assertEquals(rHosp.error?.code, "22023");
  const rUnknown = await updateAs(f.adminA.userId, f.hospitalA, 2, {
    not_a_field: 1,
  });
  assertEquals(rUnknown.error?.code, "22023");
});

Deno.test("p72: out-of-range tiers are rejected (22023)", async () => {
  const f = fx();
  const rPct = await updateAs(f.adminA.userId, f.hospitalA, 2, {
    same_day_refund_percentage: 150,
  });
  assertEquals(rPct.error?.code, "22023");
  const rOrder = await updateAs(f.adminA.userId, f.hospitalA, 2, {
    full_refund_within_minutes: 9999,
    partial_refund_within_minutes: 100,
  });
  assertEquals(
    rOrder.error?.code,
    "22023",
    "full window must not exceed partial window",
  );
});

Deno.test("p72: cross-tenant hospital_admin write is denied (42501), target unchanged", async () => {
  const f = fx();
  const before = await policyRow(f.hospitalA);
  const res = await updateAs(
    f.adminB.userId,
    f.hospitalA,
    before!.version as number,
    {
      full_refund_within_minutes: 1,
    },
  );
  assertEquals(res.error?.code, "42501");
  const after = await policyRow(f.hospitalA);
  assertEquals(
    after!.full_refund_within_minutes,
    before!.full_refund_within_minutes,
    "cross-tenant actor must not mutate the target row",
  );
});

Deno.test("p72: global_admin may update any tenant policy", async () => {
  const f = fx();
  const read = await readAs(f.globalAdmin.userId, f.hospitalB);
  const v = read.data!.version!;
  assertEquals(typeof v, "number");
  const res = await updateAs(f.globalAdmin.userId, f.hospitalB, v, {
    partial_refund_percentage: 70,
  });
  assertEquals(
    res.error,
    null,
    `global update failed: ${JSON.stringify(res.error)}`,
  );
  assertEquals(res.data!.reason, "updated");
  assertEquals(res.data!.version, v + 1);
  const row = await policyRow(f.hospitalB);
  assertEquals(Number(row!.partial_refund_percentage), 70);
});
