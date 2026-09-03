/**
 * tests/integration/refund_sync.test.ts
 *
 * Phase 0.5 / P0.2 — refund synchronization against the REAL local
 * stack. Razorpay is never called; the flow is exercised through the
 * same DB primitives the endpoints use:
 *
 *   initiate_refund → confirm_refund_processed → replay guard
 *
 * Verifies:
 *   - booking status synchronized (cancelled on initiation)
 *   - payment order status synchronized (refunded)
 *   - immutable ledger receives exactly ONE refund_debit entry
 *   - settlement input synchronized (unsettled collection entry zeroed)
 *   - webhook replay is idempotent (second confirm returns false,
 *     no duplicate ledger row)
 *
 * Run with:  deno task test:integration   (requires `supabase start`)
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

// ─── Per-run fixtures ────────────────────────────────────────────────────────

const RUN = crypto.randomUUID().slice(0, 8);
const TOKEN = (Date.now() % 900_000) + 1000;
const AMOUNT_INR = 300;

let bookingId: string | null = null;
let orderId: string | null = null;
let refundId: string | null = null;

async function seedCapturedBooking(): Promise<void> {
  const client = await db();
  const today = new Date().toISOString().split("T")[0];

  const { data: booking, error: bErr } = await client
    .from("bookings")
    .insert({
      hospital_id: SEED.HOSPITAL_ID,
      patient_name: `P05 Refund ${RUN}`,
      patient_phone: `9000${RUN}${RUN.slice(0, 2)}`,
      token_number: TOKEN,
      booking_source: "walkin",
      appointment_date: today,
      status: "booked",
      platform_fee_snapshot: 20,
      receptionist_fee_snapshot: 10,
      hospital_fee_snapshot: 270,
      total_amount_snapshot: AMOUNT_INR,
    })
    .select("id")
    .single();
  assertEquals(bErr, null);
  assertExists(booking);
  bookingId = (booking as { id: string }).id;

  const { data: order, error: oErr } = await client
    .from("payment_orders")
    .insert({
      hospital_id: SEED.HOSPITAL_ID,
      booking_id: bookingId,
      amount_inr: AMOUNT_INR,
      payment_status: "captured",
      gateway_order_id: `order_p05_${RUN}`,
      gateway_payment_id: `pay_p05_${RUN}`,
      captured_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  assertEquals(oErr, null);
  assertExists(order);
  orderId = (order as { id: string }).id;
}

// ─── 1. Initiation synchronizes booking status ──────────────────────────────

Deno.test("refund: initiation cancels the booking and creates refund record", async () => {
  await seedCapturedBooking();
  const client = await db();

  const { data, error } = await client.rpc("initiate_refund", {
    p_booking_id: bookingId as string,
    p_refund_amount_inr: AMOUNT_INR,
    p_refund_reason: `P05 integration test ${RUN}`,
    p_initiated_by: SEED.HOSPITAL_ADMIN_ID,
  });
  assertEquals(error, null);
  assertExists(data);
  refundId = data as string;

  const { data: booking } = await client
    .from("bookings")
    .select("status, cancellation_reason")
    .eq("id", bookingId as string)
    .single();
  assertEquals((booking as { status: string }).status, "cancelled");
});

// ─── 2. Confirmation synchronizes payment + ledger + settlement ─────────────

Deno.test("refund: confirmation syncs payment status, ledger and settlement input", async () => {
  const client = await db();

  const { data: confirmed, error } = await client.rpc(
    "confirm_refund_processed",
    {
      p_refund_id: refundId as string,
      p_gateway_refund_id: `rfnd_p05_${RUN}`,
      p_gateway_response: { run: RUN },
    },
  );
  assertEquals(error, null);
  assertEquals(confirmed, true);

  // Payment order synchronized
  const { data: order } = await client
    .from("payment_orders")
    .select("payment_status")
    .eq("id", orderId as string)
    .single();
  assertEquals(
    (order as { payment_status: string }).payment_status,
    "refunded",
  );

  // Immutable ledger synchronized — exactly one debit entry
  const { data: ledger } = await client
    .from("financial_ledger")
    .select("entry_type, amount_inr, is_credit, refund_id")
    .eq("refund_id", refundId as string);
  assertEquals((ledger ?? []).length, 1);
  const entry = (ledger ?? [])[0] as {
    entry_type: string;
    amount_inr: number;
    is_credit: boolean;
  };
  assertEquals(entry.entry_type, "refund_debit");
  assertEquals(Number(entry.amount_inr), AMOUNT_INR);
  assertEquals(entry.is_credit, false);

  // Settlement input synchronized — unsettled collection entry zeroed
  const { data: collection } = await client
    .from("daily_collection_entries")
    .select("total_amount, platform_fee, metadata, is_settled")
    .eq("booking_id", bookingId as string)
    .maybeSingle();

  if (collection) {
    const c = collection as {
      total_amount: number;
      platform_fee: number;
      metadata: Record<string, unknown>;
      is_settled: boolean;
    };
    assertEquals(c.is_settled, false);
    assertEquals(Number(c.total_amount), 0);
    assertEquals(Number(c.platform_fee), 0);
    assertEquals(c.metadata?.refund_adjusted, true);
  }
});

// ─── 3. Webhook replay is idempotent ─────────────────────────────────────────

Deno.test("refund: replayed confirmation is a no-op (no duplicate ledger entry)", async () => {
  const client = await db();

  const { data: again, error } = await client.rpc("confirm_refund_processed", {
    p_refund_id: refundId as string,
    p_gateway_refund_id: `rfnd_p05_${RUN}`,
    p_gateway_response: { run: RUN, replay: true },
  });
  assertEquals(error, null);
  assertEquals(again, false, "already-processed refund must return false");

  const { data: ledger } = await client
    .from("financial_ledger")
    .select("id")
    .eq("refund_id", refundId as string);
  assertEquals(
    (ledger ?? []).length,
    1,
    "replay must not duplicate ledger entries",
  );
});

// ─── 4. Cross-scope guard: unknown refund ids are rejected ──────────────────

Deno.test("refund: confirmation of unknown refund id returns false", async () => {
  const client = await db();
  const { data, error } = await client.rpc("confirm_refund_processed", {
    p_refund_id: crypto.randomUUID(),
    p_gateway_refund_id: `rfnd_ghost_${RUN}`,
    p_gateway_response: {},
  });
  assertEquals(error, null);
  assertEquals(data, false);
});

// ─── Cleanup (ledger rows are immutable and remain, scoped by refund_id) ────

Deno.test("refund: cleanup fixtures", async () => {
  const client = await db();

  if (refundId) {
    await client.from("payment_refunds").delete().eq("id", refundId);
  }
  if (orderId) {
    await client.from("payment_orders").delete().eq("id", orderId);
  }
  if (bookingId) {
    await client.from("daily_collection_entries").delete().eq(
      "booking_id",
      bookingId,
    );
    await client.from("booking_events").delete().eq(
      "booking_id",
      bookingId,
    );
    await client.from("bookings").delete().eq("id", bookingId);
  }
});
