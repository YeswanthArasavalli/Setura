/**
 * tests/integration/settlement_record_payment.test.ts
 *
 * P0-D behavioral proof against the REAL local Supabase stack.
 *
 * Defect: settlement-engine `record_payment` always returned HTTP 500
 * because it called the migration-33 no-op RPC (RETURN FALSE) and threw
 * InternalError on that FALSE.
 *
 * This proves the fix end to end over HTTP:
 *   - an authenticated hospital_admin gets a deterministic 501
 *     (NOT_IMPLEMENTED), never 500;
 *   - the rejection happens with NO Idempotency-Key present, confirming it
 *     short-circuits before the idempotency claim / RPC / any financial
 *     mutation;
 *   - an unauthenticated caller is still rejected at the auth boundary
 *     (defense in depth preserved — the 501 does not weaken auth).
 *
 * A self-contained fixture hospital_admin is created via the Admin API
 * (service role) rather than relying on seed data, matching the pattern in
 * doctor_operations.test.ts / multi_role_auth.test.ts.
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

type DbClient = ReturnType<
  typeof import("../../supabase/functions/_shared/db.ts").getServiceClient
>;
let _db: DbClient | null = null;

async function db(): Promise<DbClient> {
  if (!_db) {
    const s = await status();
    Deno.env.set("APP_ENV", "test");
    Deno.env.set("SUPABASE_URL", s.API_URL);
    Deno.env.set("SUPABASE_ANON_KEY", s.ANON_KEY);
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", s.SERVICE_ROLE_KEY);
    const { getServiceClient } = await import(
      "../../supabase/functions/_shared/db.ts"
    );
    _db = getServiceClient();
  }
  return _db;
}

async function status(): Promise<LocalStatus> {
  if (!LOCAL_STATUS) {
    const s = await getLocalStatus();
    if (!s) {
      throw new Error(
        "Local Supabase stack is not running. Run `supabase start` first.",
      );
    }
    LOCAL_STATUS = s;
  }
  return LOCAL_STATUS;
}

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "7");
const FIXTURE_PASSWORD = `P0D-${RUN}-fixture-pass`;

async function createAdminToken(): Promise<
  { token: string; hospitalId: string }
> {
  const s = await status();
  const client = await db();

  // Fixture hospital.
  const { data: hospital, error: hErr } = await client
    .from("hospitals")
    .insert({ name: `P0D ${RUN} Hosp`, slug: `p0d-${RUN}` })
    .select("id")
    .single();
  assertEquals(hErr, null);
  assertExists(hospital);
  const hospitalId = hospital.id as string;

  const userId = crypto.randomUUID();
  const email = `p0d-admin-${RUN}@setura.test`;

  // Auth user with a known password, via the service-role Admin API.
  const create = await fetch(`${s.API_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${s.SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: userId,
      email,
      email_confirm: true,
      password: FIXTURE_PASSWORD,
    }),
  });
  assertEquals(
    create.status < 300,
    true,
    `admin create failed: ${create.status}`,
  );

  // Active profile + primary hospital_admin role (what resolveAuth reads).
  const { error: pErr } = await client.from("profiles").upsert({
    id: userId,
    full_name: `P0D Admin ${RUN}`,
    normalized_phone: `96${RUN}`,
    is_active: true,
  });
  assertEquals(pErr, null);

  const { error: rErr } = await client.from("user_roles").insert({
    user_id: userId,
    hospital_id: hospital.id as string,
    role: "hospital_admin",
    is_primary: true,
  });
  assertEquals(rErr, null);

  // Password grant → a real access token.
  const grant = await fetch(
    `${s.API_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        "apikey": s.ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password: FIXTURE_PASSWORD }),
    },
  );
  assertEquals(
    grant.status < 300,
    true,
    `password grant failed: ${grant.status}`,
  );
  const json = await grant.json() as { access_token?: string };
  assertExists(json.access_token);
  return { token: json.access_token as string, hospitalId };
}

async function callSettlement(
  token: string | null,
  hospitalId: string | null,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const s = await status();
  const headers: Record<string, string> = {
    "apikey": s.ANON_KEY,
    "Content-Type": "application/json",
  };
  if (hospitalId) headers["X-Hospital-ID"] = hospitalId;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(
    `${s.API_URL}/functions/v1/settlement-engine`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
  let json: Record<string, unknown> | null = null;
  try {
    json = await resp.json();
  } catch {
    json = null;
  }
  return { status: resp.status, json };
}

// Cached fixture so the three tests share one hospital admin.
let _admin: { token: string; hospitalId: string } | null = null;
async function admin(): Promise<{ token: string; hospitalId: string }> {
  if (!_admin) _admin = await createAdminToken();
  return _admin;
}

// ─── 1. Headline fix: authenticated record_payment -> 501, never 500 ──────────

Deno.test("settlement: authenticated record_payment returns 501, not 500", async () => {
  const { token, hospitalId } = await admin();

  // NOTE: no Idempotency-Key sent — the short-circuit answers before the
  // idempotency layer would otherwise demand one.
  const { status: code, json } = await callSettlement(token, hospitalId, {
    action: "record_payment",
    settlementId: crypto.randomUUID(),
    paidAmountInr: 100,
  });

  assertEquals(
    code === 500,
    false,
    "record_payment regressed to the always-500 path",
  );
  assertEquals(code, 501, `expected 501, got ${code}: ${JSON.stringify(json)}`);

  assertExists(json, "501 must carry a JSON envelope");
  const err = json.error as Record<string, unknown>;
  assertExists(err, "501 must carry an error block");
  assertEquals(err.code, "NOT_IMPLEMENTED");
  assertEquals(err.retryable, false);
});

// ─── 2. Settlement id is irrelevant: the action is refused before lookup ──────

Deno.test("settlement: record_payment is refused regardless of settlement existence", async () => {
  const { token, hospitalId } = await admin();

  const { status: code } = await callSettlement(token, hospitalId, {
    action: "record_payment",
    settlementId: "00000000-0000-4000-8000-0000deadbeef",
    paidAmountInr: 1,
  });

  assertEquals(code, 501);
});

// ─── 3. Defense in depth: the 501 does not bypass authentication ──────────────

Deno.test("settlement: unauthenticated record_payment is still denied (not 501)", async () => {
  const { hospitalId } = await admin();

  const { status: code } = await callSettlement(null, hospitalId, {
    action: "record_payment",
    settlementId: crypto.randomUUID(),
    paidAmountInr: 100,
  });

  // Fails at the auth boundary (401), never reaching the action.
  assertEquals(code, 401, `expected 401 for missing token, got ${code}`);
});
