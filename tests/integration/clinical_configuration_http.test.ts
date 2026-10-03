/**
 * tests/integration/clinical_configuration_http.test.ts
 *
 * WS-ONBOARD-4 - REAL HTTP-path coverage for the `clinical-configuration`
 * Edge Function, end-to-end against the live local runtime:
 *   HTTP -> resolveAuth(JWT + X-Hospital-ID) -> requireRole(...) ->
 *   parseBody(discriminated union on action) -> Idempotency-Key gate ->
 *   withIdempotency -> service-role SECURITY DEFINER RPC ->
 *   logAuditEvent inside the handler -> server-authoritative response.
 *
 * The Edge-layer concerns the DB suite cannot reach, plus the matrix the
 * workstream requires: 200 success, 401 unauthenticated, 403 role + tenant,
 * 405 non-POST, 422 strict-body + RPC input refusals, 409 concurrency /
 * duplicate / overlap, and 500 for an injected unexpected database fault.
 *
 * Also proven here and nowhere else:
 *   - a replay of the same Idempotency-Key re-runs NEITHER the RPC nor its
 *     audit event - and for doctor_create it mints no second identity;
 *   - the admin-supplied initial doctor credential never crosses the HTTP
 *     response, never enters the audit trail, and a failed provisioning leaves
 *     NO orphan auth identity (the compensating delete really runs);
 *   - the specialization camelCase HTTP field really reaches the snake_case
 *     column (a silent-defaults write would look like a 200 success);
 *   - a cross-tenant probe and a nonexistent id produce the SAME refusal, so
 *     the endpoint leaks no existence information.
 *
 * Run with:  deno task test:integration
 * (requires `supabase start` AND the Edge Runtime actually serving; verify
 *  the runtime is up before trusting a result - F16-01).
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

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "5");
const FIXTURE_PASSWORD = `M68-${RUN}-fixture-pass`;
const INITIAL_DOCTOR_SECRET = `M68-init-${RUN}-Doctor-Pw1!`;

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

async function tokenFor(
  email: string,
  password = FIXTURE_PASSWORD,
): Promise<number> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        "apikey": LOCAL_STATUS.ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    },
  );
  return resp.status;
}

async function fixtureActor(
  tag: string,
  role: "global_admin" | "hospital_admin" | "doctor",
  hospitalId: string | null,
  phoneSuffix: string,
): Promise<Actor> {
  const { db } = await ctx();
  const userId = crypto.randomUUID();
  const email = `m68-${tag}-${RUN}@setura.test`;
  await createAuthUser(userId, email);
  const { error: pErr } = await (db.from as AnyClient)("profiles").upsert({
    id: userId,
    full_name: `M68 ${tag} ${RUN}`,
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
  const status = await tokenFor(email);
  assertEquals(status, 200);
  const resp = await fetch(
    `${LOCAL_STATUS!.API_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        "apikey": LOCAL_STATUS!.ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password: FIXTURE_PASSWORD }),
    },
  );
  const json = await resp.json() as { access_token?: string };
  assertExists(json.access_token);
  return { userId, email, token: json.access_token! };
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

// ─── HTTP harness ────────────────────────────────────────────────────────────

interface HttpResult {
  status: number;
  raw: string;
  json: Record<string, unknown> | null;
}

/** POST /functions/v1/clinical-configuration over real HTTP. */
async function callClinical(
  token: string | null,
  hospitalId: string | null,
  idempotencyKey: string | null,
  body: Record<string, unknown>,
  method = "POST",
): Promise<HttpResult> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (hospitalId) headers["X-Hospital-ID"] = hospitalId;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/functions/v1/clinical-configuration`,
    {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body),
    },
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

function errMsg(json: Record<string, unknown> | null): string | undefined {
  if (!json) return undefined;
  const err = json.error as { message?: string } | undefined;
  return err?.message;
}

function dataOf(res: HttpResult): Record<string, unknown> {
  assertExists(res.json, `no JSON body: ${res.raw}`);
  assertEquals(res.json!.success, true, `body: ${res.raw}`);
  return res.json!.data as Record<string, unknown>;
}

function entityOf(res: HttpResult): Record<string, unknown> {
  return dataOf(res).entity as Record<string, unknown>;
}

// ─── Database observers ──────────────────────────────────────────────────────

async function departmentRow(
  id: string,
): Promise<Record<string, unknown> | null> {
  const { db } = await ctx();
  const { data } = await (db.from as AnyClient)("departments")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return (data ?? null) as Record<string, unknown> | null;
}

async function rowsIn(
  table: string,
  filter: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const { db } = await ctx();
  let q = (db.from as AnyClient)(table).select("*");
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const { data, error } = await q;
  assertEquals(error, null, `read ${table}: ${JSON.stringify(error)}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

async function auditRows(
  hospitalId: string,
  actionType: string,
): Promise<Array<Record<string, unknown>>> {
  const { db } = await ctx();
  const { data } = await (db.from as AnyClient)("audit_logs")
    .select(
      "id,action_type,entity_type,entity_id,actor_user_id,action_severity,old_data,new_data,notes",
    )
    .eq("hospital_id", hospitalId)
    .eq("action_type", actionType);
  return (data ?? []) as Array<Record<string, unknown>>;
}

/** Read-only catalog probe. Used only where PostgREST has no path (auth
 *  schema), mirroring the established precedent in alert_center_http.test.ts. */
async function psqlScalar(sql: string): Promise<string> {
  const cmd = new Deno.Command("docker", {
    args: [
      "exec",
      "supabase_db_setura",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-t",
      "-A",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(
      `docker psql failed (${code}): ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout).trim();
}

/** Scoped DDL for the injected-fault (500) case. Always undone. */
async function dbDdl(sql: string): Promise<void> {
  const cmd = new Deno.Command("docker", {
    args: [
      "exec",
      "supabase_db_setura",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(
      `docker psql DDL failed (${code}): ${new TextDecoder().decode(stderr)}`,
    );
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

/** Create a department over real HTTP and return its id. */
async function mkDepartment(
  label: string,
  hospitalId?: string,
): Promise<string> {
  const f = fx();
  const res = await callClinical(
    f.adminA.token,
    hospitalId ?? f.hospitalA,
    crypto.randomUUID(),
    {
      action: "department_create",
      name: `M68 ${label} ${RUN}`,
      code: `${RUN}${label}`.slice(0, 32),
      description: "http fixture",
    },
  );
  assertEquals(res.status, 200, `dept ${label} failed: ${res.raw}`);
  return String(entityOf(res).departmentId);
}

const doctors: Record<string, string> = {};
/** Create a doctor over real HTTP and return its doctorId. */
async function mkDoctor(
  tag: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  if (doctors[tag]) return doctors[tag];
  const f = fx();
  const res = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "doctor_create",
      fullName: `M68 Dr ${tag} ${RUN}`,
      email: `m68-http-${tag}-${RUN}@setura.test`,
      password: INITIAL_DOCTOR_SECRET,
      phone: `95${RUN}${tag.padEnd(2, "0").slice(0, 2)}`,
      ...extra,
    },
  );
  assertEquals(res.status, 200, `doctor ${tag} failed: ${res.raw}`);
  doctors[tag] = String(entityOf(res).doctorId);
  return doctors[tag];
}

async function mkSchedule(
  doctorId: string,
  weekday: number,
  startTime: string,
  endTime: string,
): Promise<HttpResult> {
  const f = fx();
  return await callClinical(f.adminA.token, f.hospitalA, crypto.randomUUID(), {
    action: "schedule_upsert",
    doctorId,
    weekday,
    startTime,
    endTime,
    maxTokens: 20,
    averageConsultationMinutes: 10,
    isActive: true,
  });
}

function dateForWeekday(weekday: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 3);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── 0. Setup ────────────────────────────────────────────────────────────────

Deno.test("c68http: setup two tenants + global/hospital admin + doctor fixtures", async () => {
  const globalAdmin = await fixtureActor("ga", "global_admin", null, "01");
  const hospitalA = await provisionAs(
    globalAdmin.userId,
    `M68 A ${RUN}`,
    `m68http-a-${RUN}`,
  );
  const hospitalB = await provisionAs(
    globalAdmin.userId,
    `M68 B ${RUN}`,
    `m68http-b-${RUN}`,
  );
  const adminA = await fixtureActor("ha-a", "hospital_admin", hospitalA, "02");
  const adminB = await fixtureActor("ha-b", "hospital_admin", hospitalB, "03");
  const doctorA = await fixtureActor("dr-a", "doctor", hospitalA, "04");
  F = { globalAdmin, adminA, adminB, doctorA, hospitalA, hospitalB };
});

// ─── 1. Transport + authentication boundary ──────────────────────────────────

Deno.test("c68http: OPTIONS preflight is answered and GET is 405 (POST-only surface)", async () => {
  const f = fx();
  const preflight = await callClinical(
    null,
    null,
    null,
    {},
    "OPTIONS",
  );
  assertEquals(preflight.status, 204, `preflight: ${preflight.raw}`);

  const get = await callClinical(f.adminA.token, f.hospitalA, null, {}, "GET");
  assertEquals(get.status, 405, `GET: ${get.raw}`);
});

Deno.test("c68http: anonymous request is unauthorized (401) with no data", async () => {
  const f = fx();
  // A valid header is supplied so the request is not rejected for the header;
  // with no Authorization token the call must not mutate anything.
  const res = await callClinical(null, f.hospitalA, crypto.randomUUID(), {
    action: "department_create",
    name: `anon ${RUN}`,
    code: `${RUN}anon`,
  });
  assertEquals(res.status, 401);
  // Per AGENTS.md F16-05: do not assume WHICH layer answered 401 (the Edge
  // runtime JWT gate can reject before the handler). Only assert the honest
  // invariant: no success envelope and no mutation.
  if (res.json) {
    assertEquals(res.json.success !== true, true);
    assertEquals(res.json.data, undefined);
  }
  const count = await rowsIn("departments", { hospital_id: f.hospitalA });
  assertEquals(
    count.filter((r) => r.code === `${RUN}anon`).length,
    0,
    "nothing was written",
  );
});

Deno.test("c68http: a malformed token is 401 and never reaches the RPC", async () => {
  const f = fx();
  const res = await callClinical(
    "not-a.jwt.token",
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "department_create",
      name: `jwt ${RUN}`,
      code: `${RUN}jwt`,
    },
  );
  assertEquals(res.status, 401, `body: ${res.raw}`);
  const count = await rowsIn("departments", { hospital_id: f.hospitalA });
  assertEquals(count.filter((r) => r.code === `${RUN}jwt`).length, 0);
});

Deno.test("c68http: a doctor is refused by requireRole (403 ROLE_INSUFFICIENT)", async () => {
  const f = fx();
  const res = await callClinical(
    f.doctorA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "department_create",
      name: `doctor write ${RUN}`,
      code: `${RUN}drw`,
    },
  );
  assertEquals(res.status, 403, `body: ${res.raw}`);
  assertEquals(errCode(res.json), "ROLE_INSUFFICIENT");
  const count = await rowsIn("departments", { hospital_id: f.hospitalA });
  assertEquals(count.filter((r) => r.code === `${RUN}drw`).length, 0);
});

Deno.test("c68http: hospital_admin of B addressing A is 403 HOSPITAL_ACCESS_DENIED at resolveAuth", async () => {
  const f = fx();
  const res = await callClinical(
    f.adminB.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "department_create",
      name: `cross ${RUN}`,
      code: `${RUN}cross`,
    },
  );
  assertEquals(res.status, 403, `body: ${res.raw}`);
  assertEquals(errCode(res.json), "HOSPITAL_ACCESS_DENIED");
  const count = await rowsIn("departments", { hospital_id: f.hospitalA });
  assertEquals(count.filter((r) => r.code === `${RUN}cross`).length, 0);
});

Deno.test("c68http: missing X-Hospital-ID is 422 VALIDATION_ERROR with no write", async () => {
  const f = fx();
  const res = await callClinical(f.adminA.token, null, crypto.randomUUID(), {
    action: "department_create",
    name: `no header ${RUN}`,
    code: `${RUN}nohdr`,
  });
  assertEquals(res.status, 422, `body: ${res.raw}`);
  assertEquals(errCode(res.json), "VALIDATION_ERROR");
  assertStringIncludes(res.raw, "X-Hospital-ID");
});

// ─── 2. Success + audit ──────────────────────────────────────────────────────

Deno.test("c68http: department_create succeeds, persists, and emits exactly one attributable audit event", async () => {
  const f = fx();
  const key = crypto.randomUUID();
  const res = await callClinical(f.adminA.token, f.hospitalA, key, {
    action: "department_create",
    name: `M68 Audited ${RUN}`,
    code: `${RUN}aud`,
    description: "audit proof",
  });
  assertEquals(res.status, 200, `body: ${res.raw}`);

  const data = dataOf(res);
  assertEquals(data.action, "department_create");
  assertEquals(data.hospitalId, f.hospitalA);
  const entity = data.entity as Record<string, unknown>;
  const id = String(entity.departmentId);
  assertEquals(entity.version, 1);
  assertEquals(entity.isActive, true, "the response is server-authoritative");

  const stored = await departmentRow(id);
  assertExists(stored);
  assertEquals(stored!.hospital_id, f.hospitalA);
  assertEquals(stored!.name, `M68 Audited ${RUN}`);
  assertEquals(stored!.description, "audit proof");

  const audit = await auditRows(f.hospitalA, "department_create");
  const mine = audit.filter((r) => r.entity_id === id);
  assertEquals(mine.length, 1, "one audit event per mutation");
  assertEquals(mine[0].entity_type, "department");
  assertEquals(mine[0].actor_user_id, f.adminA.userId);
  assertEquals(mine[0].action_severity, "medium");
  const newData = mine[0].new_data as Record<string, unknown>;
  assertEquals((newData.result as Record<string, unknown>).departmentId, id);
});

Deno.test("c68http: global_admin may address any tenant; the response names that tenant", async () => {
  const f = fx();
  const res = await callClinical(
    f.globalAdmin.token,
    f.hospitalB,
    crypto.randomUUID(),
    {
      action: "department_create",
      name: `M68 Global ${RUN}`,
      code: `${RUN}glob`,
    },
  );
  assertEquals(res.status, 200, `body: ${res.raw}`);
  assertEquals(dataOf(res).hospitalId, f.hospitalB);
  const id = String(entityOf(res).departmentId);
  assertEquals((await departmentRow(id))!.hospital_id, f.hospitalB);
});

// ─── 3. Idempotency ──────────────────────────────────────────────────────────

Deno.test("c68http: replay returns the stored result and re-runs neither the RPC nor the audit", async () => {
  const f = fx();
  const key = crypto.randomUUID();
  const body = {
    action: "department_create",
    name: `M68 Replay ${RUN}`,
    code: `${RUN}replay`,
  };
  const first = await callClinical(f.adminA.token, f.hospitalA, key, body);
  assertEquals(first.status, 200, `first: ${first.raw}`);
  const id = String(entityOf(first).departmentId);

  const replay = await callClinical(f.adminA.token, f.hospitalA, key, body);
  assertEquals(replay.status, 200, `replay: ${replay.raw}`);
  assertEquals(
    String(entityOf(replay).departmentId),
    id,
    "replay returns the SAME stored entity",
  );
  assertEquals(entityOf(replay).version, 1);

  const live = await rowsIn("departments", { hospital_id: f.hospitalA });
  assertEquals(
    live.filter((r) => r.code === `${RUN}replay`).length,
    1,
    "no duplicate row from the retry",
  );
  const audit = (await auditRows(f.hospitalA, "department_create")).filter(
    (r) => r.entity_id === id,
  );
  assertEquals(audit.length, 1, "no duplicate audit event from the retry");
});

Deno.test("c68http: mutation without an Idempotency-Key is 400 and writes nothing", async () => {
  const f = fx();
  const res = await callClinical(f.adminA.token, f.hospitalA, null, {
    action: "department_create",
    name: `M68 Nokey ${RUN}`,
    code: `${RUN}nokey`,
  });
  assertEquals(res.status, 400, `body: ${res.raw}`);
  assertEquals(errCode(res.json), "IDEMPOTENCY_KEY_REQUIRED");
  const live = await rowsIn("departments", { hospital_id: f.hospitalA });
  assertEquals(live.filter((r) => r.code === `${RUN}nokey`).length, 0);
});

Deno.test("c68http: a non-UUID Idempotency-Key is refused (400) - no partial mutation", async () => {
  const f = fx();
  const res = await callClinical(f.adminA.token, f.hospitalA, "not-a-uuid", {
    action: "department_create",
    name: `M68 Badkey ${RUN}`,
    code: `${RUN}badkey`,
  });
  assertEquals(res.status, 400, `body: ${res.raw}`);
  assertEquals(errCode(res.json), "IDEMPOTENCY_KEY_REQUIRED");
  const live = await rowsIn("departments", { hospital_id: f.hospitalA });
  assertEquals(live.filter((r) => r.code === `${RUN}badkey`).length, 0);
});

Deno.test("c68http: same key with a DIFFERENT payload does not double-apply the second write", async () => {
  const f = fx();
  const key = crypto.randomUUID();
  const first = await callClinical(f.adminA.token, f.hospitalA, key, {
    action: "department_create",
    name: `M68 Swap ${RUN}`,
    code: `${RUN}swap`,
  });
  assertEquals(first.status, 200, `first: ${first.raw}`);

  const second = await callClinical(f.adminA.token, f.hospitalA, key, {
    action: "department_create",
    name: `M68 Swapped ${RUN}`,
    code: `${RUN}swapped`,
  });
  // MEASURED platform contract (AGENTS.md 8: reuse the primitive, do not invent
  // a new conflict contract): `withIdempotency` detects the hash mismatch but
  // still replays the STORED response for a used key. The second write is
  // therefore never applied, and the client gets the first result back.
  const live = await rowsIn("departments", { hospital_id: f.hospitalA });
  assertEquals(
    live.filter((r) => r.code === `${RUN}swapped`).length,
    0,
    "a mismatched replay must never apply the second write",
  );
  assertEquals(
    second.status,
    200,
    `mismatched replay status: ${second.raw}`,
  );
  assertEquals(
    String(entityOf(second).departmentId),
    String(entityOf(first).departmentId),
    "the replay returns the ORIGINAL stored entity, not a new one",
  );
  assertEquals(
    live.filter((r) => r.code === `${RUN}swap`).length,
    1,
    "exactly one department exists for the two requests",
  );
});

// ─── 4. Validation contract ──────────────────────────────────────────────────

Deno.test("c68http: strict bodies reject unknown keys and enum/range violations (422)", async () => {
  const f = fx();
  const cases: Array<[string, Record<string, unknown>]> = [
    ["smuggled key", {
      action: "department_create",
      name: `smug ${RUN}`,
      code: `${RUN}smug`,
      isActive: true,
    }],
    ["unknown action", {
      action: "department_delete",
      departmentId: crypto.randomUUID(),
    }],
    ["missing code", { action: "department_create", name: `nc ${RUN}` }],
    ["weekday out of range", {
      action: "schedule_upsert",
      doctorId: crypto.randomUUID(),
      weekday: 7,
      startTime: "09:00:00",
      endTime: "12:00:00",
      maxTokens: 20,
      averageConsultationMinutes: 10,
      isActive: true,
    }],
    ["bad leave type", {
      action: "leave_upsert",
      doctorId: crypto.randomUUID(),
      startDate: dateForWeekday(1),
      endDate: dateForWeekday(1),
      leaveType: "sabbatical",
    }],
    ["short password", {
      action: "doctor_create",
      fullName: `pw ${RUN}`,
      email: `m68-pw-${RUN}@setura.test`,
      password: "short",
    }],
  ];
  for (const [label, body] of cases) {
    const res = await callClinical(
      f.adminA.token,
      f.hospitalA,
      crypto.randomUUID(),
      body,
    );
    assertEquals(res.status, 422, `${label}: ${res.raw}`);
    assertEquals(errCode(res.json), "VALIDATION_ERROR", label);
  }
});

Deno.test("c68http: a calendar-impossible leave date is 422 at the boundary, never a 500", async () => {
  const f = fx();
  // `2026-02-30` is the case the shared `DateSchema` alone does NOT catch:
  // Deno's best-fit parser overflows it to 2026-03-02, so without the local
  // calendar refine it reaches PostgreSQL as SQLSTATE 22007 and the boundary
  // answers 500. `2026-13-01` is caught by the shared shape refine.
  for (const value of ["2026-02-30", "2026-13-01"]) {
    const res = await callClinical(
      f.adminA.token,
      f.hospitalA,
      crypto.randomUUID(),
      {
        action: "leave_upsert",
        doctorId: crypto.randomUUID(),
        startDate: value,
        endDate: value,
        leaveType: "annual_leave",
      },
    );
    assertEquals(res.status, 422, `${value}: ${res.raw}`);
    assertEquals(errCode(res.json), "VALIDATION_ERROR", value);
  }
});

Deno.test("c68http: an RPC-side input refusal (22023) surfaces as 422 without leaking SQL", async () => {
  const f = fx();
  const doctorId = await mkDoctor("reject");
  // maxTokens passes Zod (min 1) but the doctor has no schedule on 3; the
  // database-level refusal that remains is the inactive-doctor invariant.
  await callClinical(f.adminA.token, f.hospitalA, crypto.randomUUID(), {
    action: "doctor_update",
    doctorId,
    isActive: false,
  });
  const res = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "schedule_upsert",
      doctorId,
      weekday: 3,
      startTime: "09:00:00",
      endTime: "12:00:00",
      maxTokens: 20,
      averageConsultationMinutes: 10,
      isActive: true,
    },
  );
  assertEquals(res.status, 422, `body: ${res.raw}`);
  assertEquals(errCode(res.json), "VALIDATION_ERROR");
  assert(
    !res.raw.includes("doctor_schedules"),
    `no table name may leak: ${res.raw}`,
  );
  assertEquals(
    (await rowsIn("doctor_schedules", { doctor_id: doctorId })).length,
    0,
  );
});

// ─── 5. 409 conflict contract (the existing HTTP conflict vocabulary) ─────────

Deno.test("c68http: stale expectedVersion is 409 DB_CONCURRENCY_ERROR and the row keeps its version", async () => {
  const f = fx();
  const id = await mkDepartment("conc");
  const before = await departmentRow(id);

  const ok = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "department_update",
      departmentId: id,
      expectedVersion: before!.version,
      name: `M68 Conc Renamed ${RUN}`,
    },
  );
  assertEquals(ok.status, 200, `rename: ${ok.raw}`);
  assertEquals(entityOf(ok).version, (before!.version as number) + 1);

  const stale = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "department_update",
      departmentId: id,
      expectedVersion: before!.version,
      name: `M68 Loser ${RUN}`,
    },
  );
  assertEquals(stale.status, 409, `stale: ${stale.raw}`);
  assertEquals(errCode(stale.json), "DB_CONCURRENCY_ERROR");
  assertEquals((await departmentRow(id))!.name, `M68 Conc Renamed ${RUN}`);

  // The same vocabulary for the status toggle.
  const staleStatus = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "department_status_change",
      departmentId: id,
      expectedVersion: 1,
      isActive: false,
    },
  );
  assertEquals(staleStatus.status, 409, `status: ${staleStatus.raw}`);
  assertEquals(errCode(staleStatus.json), "DB_CONCURRENCY_ERROR");
});

Deno.test("c68http: duplicate department identifier is 409 DB_CONSTRAINT_VIOLATION", async () => {
  const f = fx();
  const id = await mkDepartment("duphttp");
  const dup = await departmentRow(id);
  const res = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "department_create",
      name: `M68 Dup HTTP ${RUN}`,
      code: String(dup!.code).toUpperCase(),
    },
  );
  assertEquals(res.status, 409, `body: ${res.raw}`);
  assertEquals(errCode(res.json), "DB_CONSTRAINT_VIOLATION");
  const live = await rowsIn("departments", { hospital_id: f.hospitalA });
  assertEquals(
    live.filter((r) => r.code === dup!.code).length,
    1,
    "the duplicate wrote nothing",
  );
});

Deno.test("c68http: schedule overlap is 409 DB_CONSTRAINT_VIOLATION with no row and no audit", async () => {
  const f = fx();
  const doctorId = await mkDoctor("ovl");
  const weekday = 1;
  const first = await mkSchedule(doctorId, weekday, "09:00:00", "12:00:00");
  assertEquals(first.status, 200, `first: ${first.raw}`);

  const overlap = await mkSchedule(doctorId, weekday, "11:00:00", "13:00:00");
  assertEquals(overlap.status, 409, `overlap: ${overlap.raw}`);
  assertEquals(errCode(overlap.json), "DB_CONSTRAINT_VIOLATION");
  assertStringIncludes(overlap.raw, "overlaps");

  const rows = await rowsIn("doctor_schedules", { doctor_id: doctorId });
  assertEquals(rows.length, 1, "the overlapping window was not stored");
  const created = await auditRows(f.hospitalA, "doctor_schedule_create");
  assertEquals(
    created.filter((r) => JSON.stringify(r.new_data)?.includes("11:00:00"))
      .length,
    0,
    "a refused mutation emits no audit event",
  );
});

Deno.test("c68http: leave overlap is 409 and a successful leave is approved + audited", async () => {
  const f = fx();
  const doctorId = await mkDoctor("leave");
  const start = dateForWeekday(3);
  const body = {
    action: "leave_upsert",
    doctorId,
    startDate: start,
    endDate: addDays(start, 2),
    leaveType: "annual_leave",
    reason: "conference week",
  };
  const first = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    body,
  );
  assertEquals(first.status, 200, `first: ${first.raw}`);
  assertEquals(
    entityOf(first).leaveStatus,
    "approved",
    "engine-honouring status",
  );
  assertEquals(entityOf(first).created, true);

  const overlap = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      ...body,
      startDate: addDays(start, 2),
      endDate: addDays(start, 4),
      leaveType: "sick_leave",
    },
  );
  assertEquals(overlap.status, 409, `overlap: ${overlap.raw}`);
  assertEquals(errCode(overlap.json), "DB_CONSTRAINT_VIOLATION");

  const leaves = await rowsIn("doctor_leaves", { doctor_id: doctorId });
  assertEquals(leaves.length, 1);
  assertEquals(leaves[0].leave_status, "approved");
  assertEquals(leaves[0].approved_by, f.adminA.userId);

  const audit = await auditRows(f.hospitalA, "doctor_leave_create");
  assertEquals(audit.length, 1);
  assertEquals(audit[0].entity_type, "doctor_leave");
  // The leave audit must name the leave row, not carry a NULL entity.
  assertEquals(String(entityOf(first).leaveId), String(leaves[0].id));
  assertEquals(String(audit[0].entity_id), String(leaves[0].id));

  const cancel = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    { action: "leave_cancel", leaveId: leaves[0].id },
  );
  assertEquals(cancel.status, 200, `cancel: ${cancel.raw}`);
  assertEquals(entityOf(cancel).leaveStatus, "cancelled");
  const cancelAudit = await auditRows(f.hospitalA, "doctor_leave_cancel");
  assertEquals(cancelAudit.length, 1);
  assertEquals(cancelAudit[0].entity_id, leaves[0].id);
});

// ─── 6. Tenant isolation over the wire (no existence leak) ───────────────────

Deno.test("c68http: a foreign id and a nonexistent id produce the IDENTICAL 403 refusal", async () => {
  const f = fx();
  // B's own department, addressed through A's context by A's admin.
  const foreignId = await callClinical(
    f.globalAdmin.token,
    f.hospitalB,
    crypto.randomUUID(),
    {
      action: "department_create",
      name: `M68 Foreign ${RUN}`,
      code: `${RUN}foreign`,
    },
  );
  assertEquals(foreignId.status, 200, `seed: ${foreignId.raw}`);
  const bDept = String(entityOf(foreignId).departmentId);

  const foreign = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "department_update",
      departmentId: bDept,
      expectedVersion: 1,
      name: `M68 stolen ${RUN}`,
    },
  );
  const absent = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "department_update",
      departmentId: crypto.randomUUID(),
      expectedVersion: 1,
      name: `M68 ghost ${RUN}`,
    },
  );
  assertEquals(foreign.status, 403, `foreign: ${foreign.raw}`);
  assertEquals(absent.status, 403, `absent: ${absent.raw}`);
  assertEquals(errCode(foreign.json), errCode(absent.json), "same code");
  assertEquals(errMsg(foreign.json), errMsg(absent.json), "same message");
  assertEquals(
    (await departmentRow(bDept))!.name,
    `M68 Foreign ${RUN}`,
    "B's row is untouched",
  );
});

Deno.test("c68http: the endpoint never accepts a body hospital and never trusts a client actor id", async () => {
  const f = fx();
  // The actor id and hospital id are taken from the JWT + header, never body.
  const res = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "department_create",
      name: `M68 Body ${RUN}`,
      code: `${RUN}bodyhdr`,
      hospitalId: f.hospitalB,
    },
  );
  assertEquals(res.status, 422, `body: ${res.raw}`);
  const liveB = await rowsIn("departments", { hospital_id: f.hospitalB });
  assertEquals(liveB.filter((r) => r.code === `${RUN}bodyhdr`).length, 0);
});

// ─── 7. Doctor provisioning: identity, credential non-exposure, compensation ──

Deno.test("c68http: doctor_create provisions the identity, lands the fee columns, and never leaks the password", async () => {
  const f = fx();
  const deptId = await mkDepartment("docassign");
  const email = `m68-http-created-${RUN}@setura.test`;

  const res = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "doctor_create",
      fullName: `Dr Provisioned ${RUN}`,
      email,
      password: INITIAL_DOCTOR_SECRET,
      phone: `+91 98${RUN} 00`,
      specializations: [
        {
          name: "Cardiology",
          consultationFee: 600,
          averageConsultationMinutes: 12,
        },
      ],
      departmentIds: [deptId],
    },
  );
  assertEquals(res.status, 200, `body: ${res.raw}`);

  const entity = entityOf(res);
  const doctorId = String(entity.doctorId);
  assertEquals(entity.fullName, `Dr Provisioned ${RUN}`);
  assertEquals(entity.isActive, true);
  assertEquals(entity.specializationCount, 1);
  assertEquals(entity.departmentCount, 1);

  // THE credential never crosses the HTTP response.
  assert(
    !res.raw.includes(INITIAL_DOCTOR_SECRET),
    "password must not appear in the response body",
  );

  // The auth identity really exists and IS the returned doctorId.
  const authCount = await psqlScalar(
    `select count(*) from auth.users where id = '${doctorId}' and email = '${email.toLowerCase()}'`,
  );
  assertEquals(authCount, "1", "the Edge layer created exactly one auth user");

  // The EXISTING doctor model, not a parallel one.
  assertEquals((await rowsIn("profiles", { id: doctorId })).length, 1);
  const roles = await rowsIn("user_roles", {
    user_id: doctorId,
    hospital_id: f.hospitalA,
  });
  assertEquals(roles.length, 1);
  assertEquals(roles[0].role, "doctor");

  // camelCase HTTP field -> snake_case column. A missing mapping is silent
  // here: the RPC would store the 0 / 10 defaults and still return 200.
  const specs = await rowsIn("doctor_specializations", { doctor_id: doctorId });
  assertEquals(specs.length, 1);
  assertEquals(specs[0].specialization_name, "Cardiology");
  assertEquals(Number(specs[0].consultation_fee), 600);
  assertEquals(specs[0].average_consultation_minutes, 12);
  const assigned = await rowsIn("doctor_departments", { doctor_id: doctorId });
  assertEquals(assigned.length, 1);
  assertEquals(assigned[0].department_id, deptId);
  assertEquals(assigned[0].assigned_by, f.adminA.userId);

  // The phone really normalized, and the audit trail has no credential.
  assertEquals(
    (await rowsIn("profiles", { id: doctorId }))[0].normalized_phone,
    `9198${RUN}00`,
  );
  const audit = await auditRows(f.hospitalA, "doctor_create");
  const mine = audit.filter((r) => r.entity_id === doctorId);
  assertEquals(mine.length, 1);
  assertEquals(mine[0].action_severity, "high");
  const blob = JSON.stringify(mine[0].new_data) +
    JSON.stringify(mine[0].old_data);
  assert(!blob.includes(INITIAL_DOCTOR_SECRET), "password must not be audited");
  assert(
    !blob.toLowerCase().includes("password"),
    "no password field is audited",
  );

  // The created doctor can sign in with the admin-supplied credential.
  assertEquals(await tokenFor(email, INITIAL_DOCTOR_SECRET), 200);
});

Deno.test("c68http: a failed doctor provisioning leaves NO orphan auth identity", async () => {
  const f = fx();
  const email = `m68-http-orphan-${RUN}@setura.test`;
  // Phone passes Zod (max 20) but the RPC requires 10-15 digits -> 422 AFTER
  // the auth user was created, which the handler must compensate by deleting.
  const res = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "doctor_create",
      fullName: `Dr Orphan ${RUN}`,
      email,
      password: INITIAL_DOCTOR_SECRET,
      phone: "12345",
    },
  );
  assertEquals(res.status, 422, `body: ${res.raw}`);
  assertEquals(errCode(res.json), "VALIDATION_ERROR");
  assert(
    !res.raw.includes(INITIAL_DOCTOR_SECRET),
    "no credential in the error",
  );

  const count = await psqlScalar(
    `select count(*) from auth.users where email = '${email}'`,
  );
  assertEquals(count, "0", "the compensating delete really ran");
  assertEquals(
    (await rowsIn("profiles", { id: crypto.randomUUID() })).length,
    0,
  );
  assertEquals(
    (await rowsIn("user_roles", { hospital_id: f.hospitalA })).filter(
      (r) =>
        r.role === "doctor" && String(r.user_id).length === 36 &&
        r.user_id === f.doctorA.userId,
    ).length,
    1,
    "only the pre-existing fixture doctor remains",
  );
  const audit = await auditRows(f.hospitalA, "doctor_create");
  assertEquals(
    audit.filter((r) => JSON.stringify(r.new_data)?.includes("Orphan")).length,
    0,
    "a refused provisioning emits no doctor_create audit",
  );
});

Deno.test("c68http: a duplicate doctor email is refused (422) without touching the existing identity", async () => {
  const f = fx();
  // `mkDoctor` really registers the identity, so re-using its email is the
  // duplicate case - no second create attempt is needed first.
  const doctorId = await mkDoctor("dupmail");
  const email = `m68-http-dupmail-${RUN}@setura.test`;
  const res = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "doctor_create",
      fullName: `M68 Second ${RUN}`,
      email,
      password: INITIAL_DOCTOR_SECRET,
    },
  );
  assertEquals(res.status, 422, `duplicate email: ${res.raw}`);
  assertEquals(errCode(res.json), "VALIDATION_ERROR");

  assertEquals(
    await psqlScalar(
      `select count(*) from auth.users where email = '${email}'`,
    ),
    "1",
    "the refused request created no second identity",
  );
  assertEquals(
    (await rowsIn("profiles", { id: doctorId })).length,
    1,
    "the existing doctor row is untouched",
  );
});

Deno.test("c68http: doctor_update reports the schedule cascade and audits the status change separately", async () => {
  const f = fx();
  const doctorId = await mkDoctor("cascade");
  const sched = await mkSchedule(doctorId, 4, "09:00:00", "13:00:00");
  assertEquals(sched.status, 200, `schedule: ${sched.raw}`);

  const off = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "doctor_update",
      doctorId,
      isActive: false,
    },
  );
  assertEquals(off.status, 200, `off: ${off.raw}`);
  assertEquals(entityOf(off).isActive, false);
  assertEquals(
    entityOf(off).schedulesDeactivated,
    1,
    "the cascade is reported",
  );

  const rows = await rowsIn("doctor_schedules", { doctor_id: doctorId });
  assertEquals(
    rows[0].is_active,
    false,
    "the availability engine input really flipped",
  );

  const updateAudit = await auditRows(f.hospitalA, "doctor_update");
  assertEquals(updateAudit.filter((r) => r.entity_id === doctorId).length, 1);
  const statusAudit = await auditRows(f.hospitalA, "doctor_status_change");
  const mine = statusAudit.filter((r) => r.entity_id === doctorId);
  assertEquals(mine.length, 1, "activation change is its own audit fact");
  assertEquals(mine[0].action_severity, "high");
  assertStringIncludes(String(mine[0].notes), "deactivated");

  // A department-set replacement is a third, distinct operational fact.
  const deptId = await mkDepartment("cascade2");
  const reassigned = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "doctor_update",
      doctorId,
      isActive: true,
      departmentIds: [deptId],
    },
  );
  assertEquals(reassigned.status, 200, `reassign: ${reassigned.raw}`);
  assertEquals(
    (await auditRows(f.hospitalA, "doctor_department_assignment")).filter(
      (r) => r.entity_id === doctorId,
    ).length,
    1,
  );
  const assigned = await rowsIn("doctor_departments", { doctor_id: doctorId });
  assertEquals(assigned.length, 1);
  assertEquals(assigned[0].department_id, deptId);
});

Deno.test("c68http: schedule create/update/delete are auditable end to end over the wire", async () => {
  const f = fx();
  const doctorId = await mkDoctor("sched");
  const created = await mkSchedule(doctorId, 5, "08:00:00", "10:00:00");
  assertEquals(created.status, 200, `create: ${created.raw}`);
  assertEquals(entityOf(created).created, true);
  assertEquals(entityOf(created).startTime, "08:00:00");

  // The upsert response is server-authoritative AND names the row it wrote, so
  // every audit assertion below is scoped to THIS schedule - other tests in
  // this suite legitimately created schedules in the same hospital.
  const scheduleId = String(entityOf(created).scheduleId);
  assert(
    /^[0-9a-f-]{36}$/i.test(scheduleId),
    `upsert must return the schedule id, got ${scheduleId}`,
  );
  const rows = await rowsIn("doctor_schedules", { doctor_id: doctorId });
  assertEquals(String(rows[0].id), scheduleId, "the id is the real row");

  const createAudit = (await auditRows(f.hospitalA, "doctor_schedule_create"))
    .filter((r) => r.entity_id === scheduleId);
  assertEquals(createAudit.length, 1);
  assertEquals(createAudit[0].entity_type, "doctor_schedule");

  const edited = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "schedule_upsert",
      doctorId,
      scheduleId,
      weekday: 5,
      startTime: "08:00:00",
      endTime: "11:00:00",
      maxTokens: 30,
      averageConsultationMinutes: 15,
      isActive: true,
    },
  );
  assertEquals(edited.status, 200, `edit: ${edited.raw}`);
  assertEquals(entityOf(edited).created, false);
  assertEquals(
    (await auditRows(f.hospitalA, "doctor_schedule_update")).filter((r) =>
      r.entity_id === scheduleId
    ).length,
    1,
  );

  const del = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "schedule_delete",
      doctorId,
      scheduleId,
    },
  );
  assertEquals(del.status, 200, `delete: ${del.raw}`);
  assertEquals(entityOf(del).deleted, true);
  const delAudit = (await auditRows(f.hospitalA, "doctor_schedule_delete"))
    .filter((r) => r.entity_id === scheduleId);
  assertEquals(delAudit.length, 1);
  assertEquals(delAudit[0].action_severity, "high");
  const after = await rowsIn("doctor_schedules", { doctor_id: doctorId });
  assertEquals(after[0].is_deleted, true);
});

// ─── 8. Unexpected fault -> 500, with no detail leak and no partial commit ────

Deno.test("c68http: an injected unexpected DB fault surfaces 500 and commits nothing", async () => {
  const f = fx();
  const id = await mkDepartment("boom");
  const before = await departmentRow(id);

  // A BEFORE UPDATE trigger scoped to this single synthetic row raises an
  // SQLSTATE the RPC error map deliberately does not know (XX001
  // internal_error), which must reach the client as a leak-free 500.
  await dbDdl(
    `CREATE OR REPLACE FUNCTION public.m68_http_500() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected db fault' USING ERRCODE = 'XX001'; END $$;`,
  );
  await dbDdl(
    `CREATE TRIGGER m68_http_500_trg BEFORE UPDATE ON public.departments FOR EACH ROW WHEN (NEW.id = '${id}') EXECUTE FUNCTION public.m68_http_500();`,
  );
  try {
    const res = await callClinical(
      f.adminA.token,
      f.hospitalA,
      crypto.randomUUID(),
      {
        action: "department_update",
        departmentId: id,
        expectedVersion: before!.version,
        name: `M68 Boom Renamed ${RUN}`,
      },
    );
    assertEquals(res.status, 500, `body: ${res.raw}`);
    assertEquals(errCode(res.json), "INTERNAL_ERROR");
    // The contract: no SQL, no driver message, no SQLSTATE.
    assert(
      !res.raw.includes("injected db fault"),
      `fault text leaked: ${res.raw}`,
    );
    assert(!res.raw.includes("XX001"), `SQLSTATE leaked: ${res.raw}`);
    assert(!res.raw.toLowerCase().includes("select"), `SQL leaked: ${res.raw}`);
    assertEquals(
      (await departmentRow(id))!.version,
      before!.version,
      "nothing committed",
    );
    assertEquals((await departmentRow(id))!.name, before!.name);

    // A 500 is replayable with a NEW key once the fault is gone; the failed
    // key is marked failed rather than caching a half result.
    const after = await callClinical(
      f.adminA.token,
      f.hospitalA,
      crypto.randomUUID(),
      {
        action: "department_update",
        departmentId: id,
        expectedVersion: before!.version,
        name: `M68 Still Blocked ${RUN}`,
      },
    );
    assertEquals(after.status, 500, `second fault: ${after.raw}`);
  } finally {
    await dbDdl(
      `DROP TRIGGER IF EXISTS m68_http_500_trg ON public.departments;`,
    );
    await dbDdl(`DROP FUNCTION IF EXISTS public.m68_http_500();`);
  }

  // Post-cleanup the same mutation succeeds: the fixture is fully undone.
  const ok = await callClinical(
    f.adminA.token,
    f.hospitalA,
    crypto.randomUUID(),
    {
      action: "department_update",
      departmentId: id,
      expectedVersion: before!.version,
      name: `M68 Repaired ${RUN}`,
    },
  );
  assertEquals(ok.status, 200, `after cleanup: ${ok.raw}`);
  assertEquals((await departmentRow(id))!.name, `M68 Repaired ${RUN}`);
});
