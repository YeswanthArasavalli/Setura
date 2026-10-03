/**
 * tests/integration/hospital_activation_http.test.ts
 *
 * WS-ONBOARD-5 — REAL HTTP-path coverage for the `hospital-activation` Edge
 * Function against the live local runtime:
 *   HTTP → Edge → resolveAuth(JWT) → requireRole(global_admin)
 *     → validate: validate_hospital_configuration RPC (read, no key)
 *     → activate: Idempotency-Key gate → api_idempotency_keys registry →
 *                  set_hospital_activation RPC → audit → response.
 *
 * This is REAL, not mocked: every case POSTs to
 * `<API_URL>/functions/v1/hospital-activation` with a genuine GoTrue
 * password-grant JWT. The Edge-only concerns the DB suite cannot reach — role
 * gating over HTTP, the missing-key 400, idempotent replay returning the stored
 * result without a second audit, the readiness refusal as 422, and the
 * activation audit event — are exactly what this file proves.
 *
 * Run with: deno task test:integration (requires `supabase start` AND the Edge
 * Runtime actually SERVING the new function; verify the runtime before
 * trusting a result — F16-01).
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

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "6");
const FIXTURE_PASSWORD = `H71-${RUN}-fixture-pass`;

// deno-lint-ignore no-explicit-any
type AnyClient = any;

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
  const email = `h71-${tag}-${RUN}@setura.test`;
  await createAuthUser(userId, email);
  const { error: pErr } = await (db.from as AnyClient)("profiles").upsert({
    id: userId,
    full_name: `H71 ${tag} ${RUN}`,
    normalized_phone: `95${RUN}${phoneSuffix}`,
    is_active: true,
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

async function newHospital(label: string): Promise<string> {
  const { db } = await ctx();
  const slug = `h71-${label}-${RUN}`.toLowerCase();
  const { data, error } = await (db.from as AnyClient)("hospitals")
    .insert({ name: `H71 ${label} ${RUN}`, slug })
    .select("id")
    .single();
  assertEquals(error, null);
  assertExists(data);
  return data.id as string;
}

async function seedReady(hospitalId: string): Promise<void> {
  const { db } = await ctx();
  await (db.from as AnyClient)("departments").insert({
    hospital_id: hospitalId,
    name: `Neuro ${RUN}`,
    code: `NEU-${RUN}`,
  });
  const doc = await fixtureActor(`doc-${RUN}`, "doctor", hospitalId, "09");
  await (db.from as AnyClient)("doctor_schedules").insert({
    doctor_id: doc.userId,
    hospital_id: hospitalId,
    weekday: 2,
    start_time: "10:00:00",
    end_time: "14:00:00",
  });
  // Start inactive so the HTTP activation flip is observable.
  await (db.from as AnyClient)("hospitals").update({ is_active: false }).eq(
    "id",
    hospitalId,
  );
}

interface HttpResult {
  status: number;
  json: Record<string, unknown> | null;
}

async function callActivation(
  token: string | null,
  idempotencyKey: string | null,
  body: Record<string, unknown>,
): Promise<HttpResult> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // A bounded acting-hospital id purely to satisfy the transport header; the
    // endpoint ignores it for authorization (the target is in the body).
    "X-Hospital-ID": "00000000-0000-0000-0000-000000000000",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/functions/v1/hospital-activation`,
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

async function hospitalState(
  id: string,
): Promise<{ is_active: boolean; activated_at: string | null }> {
  const { db } = await ctx();
  const { data } = await (db.from as AnyClient)("hospitals")
    .select("is_active,activated_at")
    .eq("id", id)
    .maybeSingle();
  return {
    is_active: (data?.is_active ?? null) as boolean,
    activated_at: (data?.activated_at ?? null) as string | null,
  };
}

async function auditCountFor(
  hospitalId: string,
  action: string,
): Promise<number> {
  const { db } = await ctx();
  const { count } = await (db.from as AnyClient)("audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("action_type", action)
    .eq("entity_id", hospitalId);
  return count ?? 0;
}

interface FixtureState {
  globalAdmin: Actor;
  hospitalAdmin: Actor;
  empty: string;
  ready: string;
}

let F: FixtureState | null = null;
function fx(): FixtureState {
  if (!F) throw new Error("setup test not run");
  return F;
}

// ─── 0. Setup ────────────────────────────────────────────────────────────────

Deno.test("h71http: setup actors + empty and ready tenants", async () => {
  const anchor = await newHospital("anchor");
  const globalAdmin = await fixtureActor("ga", "global_admin", null, "01");
  const hospitalAdmin = await fixtureActor(
    "ha",
    "hospital_admin",
    anchor,
    "02",
  );
  const empty = await newHospital("empty");
  const ready = await newHospital("ready");
  await seedReady(ready);
  F = { globalAdmin, hospitalAdmin, empty, ready };
});

// ─── 1. validate is a READ (200, checklist, no key required) ─────────────────

Deno.test("h71http: validate returns the readiness checklist for a ready tenant (200)", async () => {
  const f = fx();
  const res = await callActivation(f.globalAdmin.token, null, {
    mode: "validate",
    hospitalId: f.ready,
  });
  assertEquals(res.status, 200, `body: ${JSON.stringify(res.json)}`);
  assertExists(res.json);
  assertEquals(res.json!.success, true);
  const data = res.json!.data as Record<string, unknown>;
  assertEquals(data.mode, "validate");
  const result = data.result as Record<string, unknown>;
  assertEquals(result.ready, true);
});

Deno.test("h71http: validate reports not-ready for an empty tenant", async () => {
  const f = fx();
  const res = await callActivation(f.globalAdmin.token, null, {
    mode: "validate",
    hospitalId: f.empty,
  });
  assertEquals(res.status, 200);
  const result = ((res.json!.data as Record<string, unknown>).result) as Record<
    string,
    unknown
  >;
  assertEquals(result.ready, false);
});

// ─── 2. activate a ready tenant over HTTP (200 + real write + audit) ─────────

Deno.test("h71http: global_admin activates a ready tenant (200), is_active + audit land", async () => {
  const f = fx();
  const key = crypto.randomUUID();
  const res = await callActivation(f.globalAdmin.token, key, {
    mode: "activate",
    hospitalId: f.ready,
  });
  assertEquals(res.status, 200, `body: ${JSON.stringify(res.json)}`);
  const data = res.json!.data as Record<string, unknown>;
  assertEquals(data.isActive, true);
  assertExists(data.activatedAt, "activation must return activated_at");

  const state = await hospitalState(f.ready);
  assertEquals(state.is_active, true, "server must have flipped is_active");
  assertExists(state.activated_at);

  // The activation audit event landed exactly once.
  assertEquals(await auditCountFor(f.ready, "hospital_activation"), 1);
});

// ─── 3. Idempotent replay: same key returns stored result, no double audit ───

Deno.test("h71http: replaying the same Idempotency-Key does not re-run or double-audit", async () => {
  const f = fx();
  const key = crypto.randomUUID();
  const body = { mode: "deactivate", hospitalId: f.ready };
  const first = await callActivation(f.globalAdmin.token, key, body);
  assertEquals(first.status, 200);
  assertEquals((first.json!.data as Record<string, unknown>).isActive, false);

  const replay = await callActivation(f.globalAdmin.token, key, body);
  assertEquals(replay.status, 200, `replay: ${JSON.stringify(replay.json)}`);
  assertEquals(
    (replay.json!.data as Record<string, unknown>).hospitalId,
    (first.json!.data as Record<string, unknown>).hospitalId,
    "replay must return the SAME result",
  );

  // De-activation audit for the ready tenant stays at exactly ONE (first
  // activation + this de-activation are DIFFERENT keys; the replay must not
  // add a third). Count only reflects that the replay did not re-run the RPC.
  const audits = await auditCountFor(f.ready, "hospital_activation");
  assertEquals(
    audits,
    2,
    "one activation + one de-activation, replay adds none",
  );
});

// ─── 4. Missing Idempotency-Key on a mutation → 400 ──────────────────────────

Deno.test("h71http: activate without an Idempotency-Key is refused with 400", async () => {
  const f = fx();
  const res = await callActivation(f.globalAdmin.token, null, {
    mode: "activate",
    hospitalId: f.ready,
  });
  assertEquals(res.status, 400, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "IDEMPOTENCY_KEY_REQUIRED");
});

// ─── 5. Readiness refusal → 422 (empty tenant) ───────────────────────────────

Deno.test("h71http: activating an incomplete tenant is refused with 422", async () => {
  const f = fx();
  const res = await callActivation(f.globalAdmin.token, crypto.randomUUID(), {
    mode: "activate",
    hospitalId: f.empty,
  });
  assertEquals(res.status, 422, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "VALIDATION_ERROR");
  assertEquals((await hospitalState(f.empty)).activated_at, null);
});

// ─── 6. Non-admin authenticated → 403 (edge role gate before any RPC) ────────

Deno.test("h71http: hospital_admin (wrong role) is refused with 403", async () => {
  const f = fx();
  const res = await callActivation(
    f.hospitalAdmin.token,
    crypto.randomUUID(),
    { mode: "activate", hospitalId: f.ready },
  );
  assertEquals(res.status, 403, `body: ${JSON.stringify(res.json)}`);
  assertEquals(errCode(res.json), "ROLE_INSUFFICIENT");
});

Deno.test("h71http: hospital_admin validate is refused with 403 (read is also gated)", async () => {
  const f = fx();
  const res = await callActivation(f.hospitalAdmin.token, null, {
    mode: "validate",
    hospitalId: f.ready,
  });
  assertEquals(res.status, 403);
});

// ─── 7. Unauthenticated → 401/403 ────────────────────────────────────────────

Deno.test("h71http: unauthenticated request is refused with 401/403", async () => {
  const f = fx();
  const res = await callActivation(null, crypto.randomUUID(), {
    mode: "validate",
    hospitalId: f.ready,
  });
  assert(
    res.status === 401 || res.status === 403,
    `unauthenticated must be 401/403, got ${res.status}`,
  );
});
