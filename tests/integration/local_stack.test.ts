/**
 * tests/integration/local_stack.test.ts
 *
 * Certification-grade smoke test against the REAL local Supabase
 * stack (no mocks — see tests/utils/setup_env.ts for strategy).
 *
 * Verifies:
 *   1. The local stack is up (supabase status).
 *   2. All migrations are applied (migration_registry).
 *   3. The deterministic seed created a complete working hospital:
 *      hospital, users/profiles, roles, settings, working hours,
 *      doctor schedules, fee policy, queue config, feature flags.
 *   4. Exact row counts — proves seed idempotency (no duplicates).
 *
 * Run with:  deno task test:integration   (requires `supabase start`)
 */

import {
  assertEquals,
  assertExists,
  assertGreater,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { SEED } from "../utils/seed_constants.ts";

interface LocalStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

/** Reads local stack endpoints/keys straight from the Supabase CLI. */
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
    return null; // supabase CLI not on PATH
  }
}

// ─── One-time bootstrap: env → dynamic import of the real db client ─────────

let _db: Awaited<ReturnType<typeof createClient>> | null = null;

async function createClient() {
  const status = await getLocalStatus();
  if (!status) {
    throw new Error(
      "Local Supabase stack is not running. Run `supabase start` first.",
    );
  }
  // Set env BEFORE importing env.ts-dependent modules (eager validation).
  Deno.env.set("APP_ENV", "test");
  Deno.env.set("SUPABASE_URL", status.API_URL);
  Deno.env.set("SUPABASE_ANON_KEY", status.ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", status.SERVICE_ROLE_KEY);

  const { getServiceClient } = await import(
    "../../supabase/functions/_shared/db.ts"
  );
  return getServiceClient();
}

async function db() {
  if (!_db) _db = await createClient();
  return _db;
}

// ─── 1. Migrations ───────────────────────────────────────────────────────────

Deno.test("migrations: registry records applied migrations incl. 39", async () => {
  const client = await db();
  const { data, error } = await client
    .from("migration_registry")
    .select("migration_id, script_filename, status");
  assertEquals(error, null);
  assertExists(data);
  // The registry is opt-in self-registration; assert it is non-empty
  // and every registered row is in the applied state.
  assertGreater(data.length, 0, "migration_registry must not be empty");
  for (const row of data) {
    assertEquals(row.status, "applied");
  }

  const latest = data.find((m) => m.script_filename.startsWith("39_"));
  assertExists(latest, "migration 39 must be registered");
  assertEquals(latest.status, "applied");
});

// ─── 2. Hospital ─────────────────────────────────────────────────────────────

Deno.test("seed: hospital exists with expected attributes", async () => {
  const client = await db();
  const { data, error } = await client
    .from("hospitals")
    .select(
      "id, name, slug, is_active, online_booking_enabled, max_advance_booking_days",
    )
    .eq("id", SEED.HOSPITAL_ID)
    .single();
  assertEquals(error, null);
  assertExists(data);
  assertEquals(data.name, SEED.HOSPITAL_NAME);
  assertEquals(data.slug, SEED.HOSPITAL_SLUG);
  assertEquals(data.is_active, true);
  assertEquals(data.online_booking_enabled, true);
  assertEquals(data.max_advance_booking_days, 7);
});

// ─── 3. Users / profiles / roles ─────────────────────────────────────────────

// Seeded user ids: assertions scope to these because other suites may
// leave inert fixture profiles/roles on the shared local stack (e.g.
// audit-anchored doctor fixtures), which must not mask seed drift.
const SEED_USER_IDS = [
  SEED.GLOBAL_ADMIN_ID,
  SEED.HOSPITAL_ADMIN_ID,
  SEED.DOCTOR_ID,
  SEED.RECEPTIONIST_ID,
];

Deno.test("seed: exactly 4 profiles (idempotent, no duplicates)", async () => {
  const client = await db();
  const { data, error } = await client
    .from("profiles")
    .select("id")
    .in("id", SEED_USER_IDS);
  assertEquals(error, null);
  assertExists(data);
  assertEquals(data.length, SEED.EXPECTED.PROFILES);
  assertEquals(
    new Set(data.map((r) => r.id)),
    new Set(SEED_USER_IDS),
  );
});

Deno.test("seed: role assignment matches the seeded users", async () => {
  const client = await db();
  const { data, error } = await client
    .from("user_roles")
    .select("user_id, role, hospital_id, is_primary")
    .in("user_id", SEED_USER_IDS);
  assertEquals(error, null);
  assertExists(data);
  assertEquals(data.length, SEED.EXPECTED.USER_ROLES);

  const byUser = new Map(data.map((r) => [r.user_id, r]));
  assertEquals(byUser.get(SEED.GLOBAL_ADMIN_ID)?.role, "global_admin");
  assertEquals(byUser.get(SEED.GLOBAL_ADMIN_ID)?.hospital_id, null);
  assertEquals(byUser.get(SEED.HOSPITAL_ADMIN_ID)?.role, "hospital_admin");
  assertEquals(byUser.get(SEED.DOCTOR_ID)?.role, "doctor");
  assertEquals(byUser.get(SEED.RECEPTIONIST_ID)?.role, "receptionist");
  for (const r of data) {
    assertEquals(r.is_primary, true);
  }
});

// ─── 4. Doctor setup ─────────────────────────────────────────────────────────

Deno.test("seed: doctor specialization with 300 INR fee", async () => {
  const client = await db();
  const { data, error } = await client
    .from("doctor_specializations")
    .select("doctor_id, specialization_name, consultation_fee")
    .eq("hospital_id", SEED.HOSPITAL_ID);
  assertEquals(error, null);
  assertExists(data);
  assertEquals(data.length, SEED.EXPECTED.DOCTOR_SPECIALIZATIONS);
  assertEquals(data[0].doctor_id, SEED.DOCTOR_ID);
  assertEquals(Number(data[0].consultation_fee), 300);
});

Deno.test("seed: 12 doctor schedule slots (6 days × 2 shifts)", async () => {
  const client = await db();
  const { count, error } = await client
    .from("doctor_schedules")
    .select("id", { count: "exact", head: true })
    .eq("doctor_id", SEED.DOCTOR_ID);
  assertEquals(error, null);
  assertEquals(count, SEED.EXPECTED.DOCTOR_SCHEDULES);
});

// ─── 5. Working hours ────────────────────────────────────────────────────────

Deno.test("seed: 7 working-hours rows, Sunday closed", async () => {
  const client = await db();
  const { data, error } = await client
    .from("hospital_working_hours")
    .select("weekday, open_time, close_time, is_open")
    .eq("hospital_id", SEED.HOSPITAL_ID)
    .order("weekday");
  assertEquals(error, null);
  assertExists(data);
  assertEquals(data.length, SEED.EXPECTED.WORKING_HOURS_ROWS);

  const sunday = data.find((d) => d.weekday === 0);
  assertExists(sunday);
  assertEquals(sunday.is_open, false);

  const monday = data.find((d) => d.weekday === 1);
  assertExists(monday);
  assertEquals(monday.is_open, true);
  assertEquals(monday.open_time.startsWith("09:00"), true);
});

// ─── 6. Hospital settings ────────────────────────────────────────────────────

Deno.test("seed: hospital settings converged to seed values", async () => {
  const client = await db();
  const { data, error } = await client
    .from("hospital_settings")
    .select(
      "max_tokens_per_day, reminder_before_minutes, payment_enabled, allow_online_booking, send_whatsapp_reminder",
    )
    .eq("hospital_id", SEED.HOSPITAL_ID)
    .single();
  assertEquals(error, null);
  assertExists(data);
  assertEquals(data.max_tokens_per_day, 100);
  assertEquals(data.reminder_before_minutes, 30);
  assertEquals(data.payment_enabled, false);
  assertEquals(data.allow_online_booking, true);
  assertEquals(data.send_whatsapp_reminder, true);
});

// ─── 7. Fee policy ───────────────────────────────────────────────────────────

Deno.test("seed: booking fee policy matches seed values", async () => {
  const client = await db();
  const { data, error } = await client
    .from("booking_fee_policies")
    .select(
      "booking_fee_online, booking_fee_whatsapp, booking_fee_enabled, default_consultation_fee_inr",
    )
    .eq("hospital_id", SEED.HOSPITAL_ID)
    .single();
  assertEquals(error, null);
  assertExists(data);
  assertEquals(Number(data.booking_fee_online), 20);
  assertEquals(Number(data.booking_fee_whatsapp), 10);
  assertEquals(data.booking_fee_enabled, true);
  assertEquals(Number(data.default_consultation_fee_inr), 300);
});

// ─── 8. Queue configuration ──────────────────────────────────────────────────

Deno.test("seed: queue configuration keys present", async () => {
  const client = await db();
  const { data, error } = await client
    .from("queue_configs")
    .select("config_key")
    .eq("hospital_id", SEED.HOSPITAL_ID);
  assertEquals(error, null);
  assertExists(data);
  assertEquals(data.length, SEED.EXPECTED.QUEUE_CONFIGS);
  const keys = data.map((d) => d.config_key).sort();
  assertEquals(keys, ["call_window_minutes", "queue_display", "token_prefix"]);
});

// ─── 9. Feature flags ────────────────────────────────────────────────────────

Deno.test("seed: hospital feature flags enabled", async () => {
  const client = await db();
  const { data, error } = await client
    .from("feature_flags")
    .select("flag_key, is_enabled")
    .eq("hospital_id", SEED.HOSPITAL_ID);
  assertEquals(error, null);
  assertExists(data);
  assertEquals(data.length, SEED.EXPECTED.FEATURE_FLAGS);
  for (const flag of data) {
    assertEquals(flag.is_enabled, true);
  }
});
