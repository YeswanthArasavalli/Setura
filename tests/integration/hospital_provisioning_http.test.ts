/**
 * tests/integration/hospital_provisioning_http.test.ts
 *
 * WS-ONBOARD-1 — REAL HTTP-path coverage for the `provision-hospital` Edge
 * Function, end-to-end against the live local runtime:
 *   HTTP → Edge Function → resolveAuth(JWT) → requireRole(global_admin)
 *     → Idempotency-Key gate → api_idempotency_keys registry →
 *     provision_hospital RPC → audit → server-authoritative response.
 *
 * This is REAL, not mocked: every case POSTs to
 * `<API_URL>/functions/v1/provision-hospital` with a genuine GoTrue
 * password-grant JWT. No case substitutes a direct RPC call for the HTTP
 * invocation. The Edge-layer concerns the DB suite cannot reach — role
 * gating over HTTP, the missing-key 400, idempotent replay returning the
 * stored result without a second tenant, and the provisioning audit event —
 * are exactly what this file proves.
 *
 * Run with:  deno task test:integration
 * (requires `supabase start` AND the Edge Runtime actually serving; verify
 *  the runtime is up before trusting a result — F16-01).
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

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "5");
const FIXTURE_PASSWORD = `H65-${RUN}-fixture-pass`;

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
  role: "global_admin" | "hospital_admin",
  hospitalId: string | null,
  phoneSuffix: string,
): Promise<Actor> {
  const { db } = await ctx();
  const userId = crypto.randomUUID();
  const email = `h65-${tag}-${RUN}@setura.test`;
  await createAuthUser(userId, email);
  const { error: pErr } = await (db.from as AnyClient)("profiles").upsert({
    id: userId,
    full_name: `H65 ${tag} ${RUN}`,
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

// deno-lint-ignore no-explicit-any
type AnyClient = any;

interface HttpResult {
  status: number;
  json: Record<string, unknown> | null;
}

/** POST /functions/v1/provision-hospital over real HTTP with JWT auth. */
async function callProvision(
  token: string | null,
  idempotencyKey: string | null,
  body: Record<string, unknown>,
): Promise<HttpResult> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/functions/v1/provision-hospital`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
  const text = await resp.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Non-JSON body (gateway refusal) — status is still checked.
  }
  return { status: resp.status, json };
}

function errCode(json: Record<string, unknown> | null): string | undefined {
  if (!json) return undefined;
  const err = json.error as { code?: string } | undefined;
  return err?.code;
}

async function hospitalRowBySlug(
  slug: string,
): Promise<{ id: string; name: string } | null> {
  const { db } = await ctx();
  const { data } = await (db.from as AnyClient)("hospitals")
    .select("id,name")
    .eq("slug", slug)
    .maybeSingle();
  return (data ?? null) as { id: string; name: string } | null;
}

async function settingsCountFor(hospitalId: string): Promise<number> {
  const { db } = await ctx();
  const { count } = await (db.from as AnyClient)("hospital_settings")
    .select("id", { count: "exact", head: true })
    .eq("hospital_id", hospitalId);
  return count ?? 0;
}

async function auditCountFor(hospitalId: string): Promise<number> {
  const { db } = await ctx();
  const { count } = await (db.from as AnyClient)("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("action_type", "hospital_provision")
    .eq("entity_id", hospitalId);
  return count ?? 0;
}

interface FixtureState {
  globalAdmin: Actor;
  hospitalAdmin: Actor;
}

let F: FixtureState | null = null;

function fx(): FixtureState {
  if (!F) throw new Error("setup test not run");
  return F;
}

// ─── 0. Setup ────────────────────────────────────────────────────────────────

Deno.test("p65http: setup global_admin + hospital_admin fixtures", async () => {
  const { db } = await ctx();
  const anchor = `p65http-anchor-${RUN}`;
  const { data: h, error: hErr } = await (db.from as AnyClient)("hospitals")
    .insert({ name: `P65 HTTP Anchor ${RUN}`, slug: anchor })
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
  F = { globalAdmin, hospitalAdmin };
});

// ─── 1. Happy path over HTTP: 201 + real tenant + settings + audit ───────────

Deno.test("p65http: global_admin provisions a tenant (201), settings + audit land", async () => {
  const f = fx();
  const slug = `p65http-hosp-${RUN}`;
  const key = crypto.randomUUID();
  const res = await callProvision(f.globalAdmin.token, key, {
    name: `HTTP Provisioned ${RUN}`,
    slug,
    email: `http-${RUN}@setura.test`,
  });
  assertEquals(res.status, 201, `body: ${JSON.stringify(res.json)}`);
  assertExists(res.json);
  assertEquals(res.json.success, true);
  const data = res.json.data as Record<string, unknown>;
  assertExists(data);
  assertEquals(data.created, true);
  assertEquals(data.slug, slug);
  const hospitalId = data.hospitalId as string;
  assertExists(hospitalId);

  // The tenant genuinely exists (server-owned, not an optimistic client echo).
  const row = await hospitalRowBySlug(slug);
  assertExists(row, "hospital row must exist after 201");
  assertEquals(row!.id, hospitalId);
  assertEquals(await settingsCountFor(hospitalId), 1);

  // The provisioning audit event landed exactly once.
  assertEquals(await auditCountFor(hospitalId), 1);
});

// ─── 2. Idempotent replay: same key returns the stored result, no duplicate ──

Deno.test("p65http: replaying the same Idempotency-Key returns the stored tenant (no duplicate)", async () => {
  const f = fx();
  const slug = `p65http-replay-${RUN}`;
  const key = crypto.randomUUID();
  const body = { name: `Replay Hospital ${RUN}`, slug };

  const first = await callProvision(f.globalAdmin.token, key, body);
  assertEquals(first.status, 201);
  const firstId = (first.json!.data as Record<string, unknown>)
    .hospitalId as string;

  const replay = await callProvision(f.globalAdmin.token, key, body);
  assertEquals(
    replay.status,
    201,
    `replay body: ${JSON.stringify(replay.json)}`,
  );
  const replayId = (replay.json!.data as Record<string, unknown>)
    .hospitalId as string;

  assertEquals(replayId, firstId, "replay must return the SAME tenant id");

  // Exactly one hospital with that slug — the replay created no second row.
  const { db } = await ctx();
  const { count } = await (db.from as AnyClient)("hospitals")
    .select("id", { count: "exact", head: true })
    .eq("slug", slug);
  assertEquals(
    count,
    1,
    "idempotent replay must not create a duplicate tenant",
  );

  // And the audit was not double-recorded (it lives inside the handler).
  assertEquals(await auditCountFor(firstId), 1);
});

// ─── 3. Missing Idempotency-Key → 400 ────────────────────────────────────────

Deno.test("p65http: missing Idempotency-Key is refused with 400", async () => {
  const f = fx();
  const slug = `p65http-nokey-${RUN}`;
  const res = await callProvision(f.globalAdmin.token, null, {
    name: `No Key ${RUN}`,
    slug,
  });
  assertEquals(res.status, 400, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "IDEMPOTENCY_KEY_REQUIRED");
  assertEquals(await hospitalRowBySlug(slug), null);
});

// ─── 4. Non-admin authenticated → 403 (edge role gate, before any RPC) ───────

Deno.test("p65http: hospital_admin (authenticated, wrong role) is refused with 403", async () => {
  const f = fx();
  const slug = `p65http-nonadmin-${RUN}`;
  const res = await callProvision(
    f.hospitalAdmin.token,
    crypto.randomUUID(),
    { name: `Non Admin ${RUN}`, slug },
  );
  assertEquals(res.status, 403, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "ROLE_INSUFFICIENT");
  assertEquals(await hospitalRowBySlug(slug), null);
});

// ─── 5. Unauthenticated → 401 ────────────────────────────────────────────────

Deno.test("p65http: unauthenticated request is refused with 401", async () => {
  const slug = `p65http-anon-${RUN}`;
  const res = await callProvision(null, crypto.randomUUID(), {
    name: `Anon ${RUN}`,
    slug,
  });
  assert(
    res.status === 401 || res.status === 403,
    `unauthenticated must be 401/403, got ${res.status}`,
  );
  assertEquals(await hospitalRowBySlug(slug), null);
});

// ─── 6. Duplicate slug on a DISTINCT key → 409 ───────────────────────────────

Deno.test("p65http: a distinct request reusing an existing slug is a 409 collision", async () => {
  const f = fx();
  const slug = `p65http-dupe-${RUN}`;
  const ok = await callProvision(f.globalAdmin.token, crypto.randomUUID(), {
    name: `Dupe Original ${RUN}`,
    slug,
  });
  assertEquals(ok.status, 201);

  const clash = await callProvision(f.globalAdmin.token, crypto.randomUUID(), {
    name: `Dupe Clash ${RUN}`,
    slug,
  });
  assertEquals(clash.status, 409, `body: ${JSON.stringify(clash.json)}`);
  assertEquals(errCode(clash.json), "DB_CONSTRAINT_VIOLATION");
});

// ─── 7. Body validation → 422 (rejects before reaching the RPC) ──────────────

Deno.test("p65http: an invalid slug is rejected with 422 and no tenant", async () => {
  const f = fx();
  const res = await callProvision(f.globalAdmin.token, crypto.randomUUID(), {
    name: `Bad ${RUN}`,
    slug: "Bad Slug!!",
  });
  assertEquals(res.status, 422, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "VALIDATION_ERROR");
});
