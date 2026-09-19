/**
 * tests/integration/booking_fee_refund.test.ts
 *
 * Phase 3 / P0-04 (roadmap B2) regression test.
 *
 * Root cause proven by source: `bookings.booking_fee_inr` is the
 * refund basis read by calculate_refund_amount (migration 29:201),
 * the cancel-booking Edge Function and whatsapp_cancel_flow, but the
 * ONLY writer before migration 54 was migration 28's one-time
 * backfill. `create_booking` never persisted it, so every booking
 * created at runtime stored the column DEFAULT 0 and refunds computed
 * ₹0 regardless of what the patient paid.
 *
 * This test exercises the REAL stack through the same primitive every
 * fee-paying path funnels through — the `create_booking` RPC — and
 * proves:
 *
 *   1. create_booking now persists booking_fee_inr = platform fee
 *      (the money SETURA actually collects), matching
 *      platform_fee_snapshot.
 *   2. calculate_refund_amount therefore returns a NON-ZERO refund on
 *      the full-refund tier (was always ₹0 before the fix).
 *
 * Razorpay is never called. Test data only, with deterministic
 * cleanup. Run with: deno task test:integration (requires `supabase start`).
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

let _db: Awaited<ReturnType<typeof createClient>> | null = null;

async function createClient() {
  const status = await getLocalStatus();
  if (!status) {
    throw new Error(
      "Local Supabase stack is not running. Run `supabase start` first.",
    );
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

async function db() {
  if (!_db) _db = await createClient();
  return _db;
}

// ─── Per-run fixture ──────────────────────────────────────────────────────────

const RUN = crypto.randomUUID().slice(0, 8);

const PLATFORM_FEE = 25;
const RECEPTIONIST_FEE = 10;
const HOSPITAL_FEE = 270;

// A far-future appointment date so calculate_refund_amount can be
// invoked with a cancellation_time 15 minutes ahead of it: that lands
// squarely in the Tier-1 full-refund window (<= full_refund_within_
// minutes default 30) and, because the cancellation DATE differs from
// the appointment DATE, it does NOT fall into the same-day branch
// (whose default percentage is 0). The result is therefore
// deterministically the full platform fee.
const APPOINTMENT_DATE = "2030-06-01";
const CANCELLATION_TIME = "2030-05-31T23:45:00+00:00";

let bookingId: string | null = null;

async function createBookingViaRpc(): Promise<void> {
  const client = await db();

  const { data, error } = await client.rpc("create_booking", {
    p_hospital_id: SEED.HOSPITAL_ID,
    p_patient_name: `P3 BookingFee ${RUN}`,
    p_patient_phone: `9111${RUN}${RUN.slice(0, 2)}`,
    p_patient_age: 41,
    p_patient_gender: "male",
    p_booking_source: "walkin",
    p_appointment_date: APPOINTMENT_DATE,
    p_platform_fee: PLATFORM_FEE,
    p_receptionist_fee: RECEPTIONIST_FEE,
    p_hospital_fee: HOSPITAL_FEE,
    p_idempotency_key: `p0-04-${RUN}`,
  });

  assertEquals(error, null);
  assertExists(data);
  const row = (Array.isArray(data) ? data[0] : data) as {
    booking_id: string;
    token_number: number;
  };
  assertExists(row.booking_id);
  bookingId = row.booking_id;

  // Simulate a captured payment (calculate_refund_amount refuses when
  // payment_completed is false). Fixture status flag only, no money is
  // hand-edited.
  const { error: payErr } = await client
    .from("bookings")
    .update({ payment_completed: true })
    .eq("id", bookingId);
  assertEquals(payErr, null);
}

// ─── 1. create_booking persists booking_fee_inr = platform fee ────────────────

Deno.test("P0-04: create_booking writes booking_fee_inr from the platform fee", async () => {
  await createBookingViaRpc();
  const client = await db();

  const { data: booking, error } = await client
    .from("bookings")
    .select(
      "booking_fee_inr, platform_fee_snapshot, total_amount_snapshot",
    )
    .eq("id", bookingId as string)
    .single();
  assertEquals(error, null);

  const b = booking as {
    booking_fee_inr: number;
    platform_fee_snapshot: number;
    total_amount_snapshot: number;
  };

  // The refund basis is the platform fee, NOT 0 and NOT the total.
  assertEquals(
    Number(b.booking_fee_inr),
    PLATFORM_FEE,
    "booking_fee_inr must equal the platform fee (was 0 before migration 54)",
  );
  assertEquals(
    Number(b.booking_fee_inr),
    Number(b.platform_fee_snapshot),
    "booking_fee_inr must match platform_fee_snapshot (migration 28 semantics)",
  );
  assertEquals(
    Number(b.total_amount_snapshot),
    PLATFORM_FEE + RECEPTIONIST_FEE + HOSPITAL_FEE,
    "total snapshot unchanged",
  );
});

// ─── 2. calculate_refund_amount returns a non-zero refund ─────────────────────

Deno.test("P0-04: calculate_refund_amount refunds the platform fee (non-zero)", async () => {
  const client = await db();

  const { data, error } = await client.rpc("calculate_refund_amount", {
    p_booking_id: bookingId as string,
    p_cancellation_time: CANCELLATION_TIME,
  });
  assertEquals(error, null);
  assertExists(data);

  const row = (Array.isArray(data) ? data[0] : data) as {
    refund_amount: number;
    refund_percentage: number;
    is_eligible: boolean;
  };

  assertEquals(
    row.is_eligible,
    true,
    "cancellation inside the full-refund window must be eligible",
  );
  assertEquals(
    Number(row.refund_amount),
    PLATFORM_FEE,
    "refund must equal the persisted booking_fee_inr, not ₹0",
  );
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────

Deno.test("P0-04: cleanup fixtures", async () => {
  const client = await db();
  if (bookingId) {
    await client.from("daily_collection_entries").delete().eq(
      "booking_id",
      bookingId,
    );
    await client.from("booking_events").delete().eq("booking_id", bookingId);
    await client.from("bookings").delete().eq("id", bookingId);
  }
});
