/**
 * tests/integration/compute_sla_null_wait.test.ts
 *
 * WS-OPS-1 regression — compute_sla NULL wait-breach (migration 73).
 *
 * Root cause reproduced against the REAL local Supabase stack: the
 * staging compute_sla jobs dead-lettered with
 *   null value in column "sla_wait_breached" ... violates not-null
 * because compute_sla_tracking derived the flag as
 *   v_avg_wait > v_wait_threshold
 * which is NULL (three-valued logic) whenever a (hospital, date) has no
 * qualifying wait samples, and the column is NOT NULL.
 *
 * These tests prove:
 *   1. A day with bookings but zero wait samples no longer errors and
 *      records sla_wait_breached = FALSE (nothing measured, nothing
 *      breached) — the exact staging failure shape.
 *   2. A day with no bookings at all likewise records FALSE, not NULL.
 *   3. Real breach detection is PRESERVED: a measured wait above the
 *      threshold still flags TRUE, and below it still flags FALSE.
 *
 * Run with: deno task test:integration  (requires `supabase start`).
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SEED } from "../utils/seed_constants.ts";

interface LocalStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

async function getLocalStatus(): Promise<LocalStatus | null> {
  try {
    const { code, stdout } = await new Deno.Command("supabase", {
      args: ["status", "-o", "json"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (code !== 0) return null;
    const text = new TextDecoder().decode(stdout);
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s === -1 || e === -1) return null;
    return JSON.parse(text.slice(s, e + 1)) as LocalStatus;
  } catch {
    return null;
  }
}

type Db = Awaited<ReturnType<typeof bootstrap>>;

async function bootstrap() {
  const status = await getLocalStatus();
  if (!status) {
    throw new Error("Local Supabase stack not running. Run `supabase start`.");
  }
  Deno.env.set("APP_ENV", "test");
  Deno.env.set("SUPABASE_URL", status.API_URL);
  Deno.env.set("SUPABASE_ANON_KEY", status.ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", status.SERVICE_ROLE_KEY);
  const { getServiceClient } = await import(
    "../../supabase/functions/_shared/db.ts"
  );
  return getServiceClient();
}

let _db: Db | null = null;
async function db(): Promise<Db> {
  if (!_db) _db = await bootstrap();
  return _db;
}

// Distinct sentinel dates so the per-run fixtures never collide with the
// seeded SLA rows or other tenants' tracking.
const D_NOWAIT = "2001-01-11"; // bookings, 0 wait samples
const D_EMPTY = "2001-01-12"; // no bookings
const D_BREACH = "2001-01-13"; // wait > default threshold (45 min)
const D_OK = "2001-01-14"; // wait < threshold

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 6).padEnd(6, "3");
const bookingIds: string[] = [];

async function insertBooking(
  date: string,
  token: number,
  extra: Record<string, unknown>,
): Promise<void> {
  const c = await db();
  const { data, error } = await c.from("bookings").insert({
    hospital_id: SEED.HOSPITAL_ID,
    patient_name: `SLAWait ${RUN} ${token}`,
    patient_phone: `91${RUN}${String(token).padStart(4, "0")}`,
    token_number: token,
    booking_source: "walkin",
    appointment_date: date,
    status: "completed",
    ...extra,
  }).select("id").single();
  assertEquals(error, null);
  assertExists(data);
  bookingIds.push((data as { id: string }).id);
}

async function readRow(date: string) {
  const c = await db();
  const { data, error } = await c.from("sla_daily_tracking")
    .select("avg_wait_minutes, sla_wait_breached, sla_completion_breached")
    .eq("hospital_id", SEED.HOSPITAL_ID)
    .eq("tracking_date", date)
    .maybeSingle();
  assertEquals(error, null);
  return data;
}

Deno.test("compute_sla: zero wait samples no longer dead-letters and flags false", async () => {
  const c = await db();
  // Checked in, but never called -> 0 qualifying wait samples -> v_avg_wait NULL.
  await insertBooking(D_NOWAIT, 1, {
    checked_in_at: "2001-01-11T09:00:00Z",
    called_at: null,
  });

  const { error } = await c.rpc("compute_sla_tracking", {
    p_hospital_id: SEED.HOSPITAL_ID,
    p_date: D_NOWAIT,
  });
  // Pre-fix this returned a NOT NULL violation on sla_wait_breached.
  assertEquals(error, null, `RPC must not fail: ${error?.message}`);

  const row = await readRow(D_NOWAIT);
  assertExists(row);
  assertEquals(row.avg_wait_minutes, null);
  assertEquals(row.sla_wait_breached, false);
});

Deno.test("compute_sla: empty day records false, not null", async () => {
  const c = await db();
  const { error } = await c.rpc("compute_sla_tracking", {
    p_hospital_id: SEED.HOSPITAL_ID,
    p_date: D_EMPTY,
  });
  assertEquals(error, null, `RPC must not fail: ${error?.message}`);

  const row = await readRow(D_EMPTY);
  assertExists(row);
  assertEquals(row.avg_wait_minutes, null);
  assertEquals(row.sla_wait_breached, false);
});

Deno.test("compute_sla: real breach detection is preserved (above/below threshold)", async () => {
  const c = await db();
  // 90-minute wait -> above the default 45-minute threshold -> breached.
  await insertBooking(D_BREACH, 1, {
    checked_in_at: "2001-01-13T09:00:00Z",
    called_at: "2001-01-13T10:30:00Z",
  });
  const { error: eBreach } = await c.rpc("compute_sla_tracking", {
    p_hospital_id: SEED.HOSPITAL_ID,
    p_date: D_BREACH,
  });
  assertEquals(eBreach, null);
  const breachRow = await readRow(D_BREACH);
  assertExists(breachRow);
  assertEquals(Number(breachRow.avg_wait_minutes), 90);
  assertEquals(breachRow.sla_wait_breached, true);

  // 10-minute wait -> below threshold -> not breached.
  await insertBooking(D_OK, 1, {
    checked_in_at: "2001-01-14T09:00:00Z",
    called_at: "2001-01-14T09:10:00Z",
  });
  const { error: eOk } = await c.rpc("compute_sla_tracking", {
    p_hospital_id: SEED.HOSPITAL_ID,
    p_date: D_OK,
  });
  assertEquals(eOk, null);
  const okRow = await readRow(D_OK);
  assertExists(okRow);
  assertEquals(Number(okRow.avg_wait_minutes), 10);
  assertEquals(okRow.sla_wait_breached, false);
});

Deno.test("compute_sla: fixture cleanup", async () => {
  const c = await db();
  for (const d of [D_NOWAIT, D_EMPTY, D_BREACH, D_OK]) {
    await c.from("sla_daily_tracking").delete()
      .eq("hospital_id", SEED.HOSPITAL_ID).eq("tracking_date", d);
  }
  if (bookingIds.length > 0) {
    await c.from("bookings").delete().in("id", bookingIds);
  }
});
