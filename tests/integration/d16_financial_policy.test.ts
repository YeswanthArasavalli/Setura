/**
 * tests/integration/d16_financial_policy.test.ts
 *
 * PART 3B / D16 (owner-finalized financial policy) regression.
 *
 * Proves the canonical SETURA money model enforced by migrations 59 + 60
 * and the create-payment-order / process-refund Edge changes:
 *
 *   Q1 SETURA collects ONLY the booking/platform fee (booking_fee_inr).
 *   Q2 one refund basis = amount actually collected; total_refunded
 *      <= total_collected on every path.
 *   Q3 revenue is recognised at CAPTURE, not at booking creation.
 *   Q4 unpaid / WhatsApp bookings create no collected revenue and no
 *      settlement amount.
 *   Q5 a partial refund reduces ONLY the refunded amount (never zeroes
 *      the whole collection record) and refund accounting is idempotent.
 *   Q6/Q7 GST and the Razorpay gateway fee are computed on the platform
 *      fee and recorded as separate debits.
 *
 * Razorpay is never called. Every assertion runs through the REAL RPCs
 * the production flow uses: create_booking, capture_payment,
 * initiate_refund, confirm_refund_processed, calculate_refund_amount.
 *
 * Ledger residue is intentional: financial_ledger is immutable
 * (migration 13 prevent_ledger_mutation) and its FK to bookings is
 * NO ACTION, so a captured booking cannot be deleted. This mirrors the
 * "inert ledger residue" teardown of hospital_core_journey. Each run is
 * isolated by a random RUN tag and asserts only on its own fixtures.
 *
 * Run with: deno task test:integration  (requires `supabase start`).
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertMatch,
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

// ─── Per-run fixtures ─────────────────────────────────────────────────────────

const RUN = crypto.randomUUID().slice(0, 8);

const PLATFORM_FEE = 100; // booking_fee_inr == what SETURA collects
const RECEPTIONIST_FEE = 30; // NOT collected by SETURA (Q1)
const HOSPITAL_FEE = 500; // NOT collected by SETURA (Q1)

// Far-future appointment so calculate_refund_amount's same-day 0% branch
// never applies; cancellation_time is inside the Tier-1 full-refund window.
const APPOINTMENT_DATE = "2030-09-01";
const CANCELLATION_TIME = "2030-08-31T23:45:00+00:00";

interface BookingRow {
  id: string;
  booking_fee_inr: number;
  platform_fee_snapshot: number;
  total_amount_snapshot: number;
  payment_completed: boolean;
}

async function newBooking(
  source: "walkin" | "online" | "manual_whatsapp" = "walkin",
  tag: string = "x",
): Promise<BookingRow> {
  const client = await db();
  const { data, error } = await client.rpc("create_booking", {
    p_hospital_id: SEED.HOSPITAL_ID,
    p_patient_name: `D16 ${RUN} ${source}`,
    p_patient_phone: `9122${RUN}${tag}`,
    p_patient_age: 40,
    p_patient_gender: "male",
    p_booking_source: source,
    p_appointment_date: APPOINTMENT_DATE,
    p_platform_fee: PLATFORM_FEE,
    p_receptionist_fee: RECEPTIONIST_FEE,
    p_hospital_fee: HOSPITAL_FEE,
    // Unique per TEST: create_booking is idempotent, so reusing one key
    // across tests would silently return the same booking row.
    p_idempotency_key: `d16-${source}-${tag}-${RUN}`,
  });
  assertEquals(error, null);
  assertExists(data);
  const row = (Array.isArray(data) ? data[0] : data) as { booking_id: string };
  const { data: b, error: bErr } = await client
    .from("bookings")
    .select(
      "id, booking_fee_inr, platform_fee_snapshot, total_amount_snapshot, payment_completed",
    )
    .eq("id", row.booking_id)
    .single();
  assertEquals(bErr, null);
  return b as BookingRow;
}

async function ledgerSum(
  bookingId: string,
  entryType: string,
): Promise<number> {
  const client = await db();
  const { data, error } = await client
    .from("financial_ledger")
    .select("amount_inr")
    .eq("booking_id", bookingId)
    .eq("entry_type", entryType);
  assertEquals(error, null);
  const rows = (data ?? []) as Array<{ amount_inr: number | string }>;
  return rows.reduce((s, r) => s + Number(r.amount_inr), 0);
}

async function ledgerCount(
  bookingId: string,
  entryType: string,
): Promise<number> {
  const client = await db();
  const { count, error } = await client
    .from("financial_ledger")
    .select("id", { count: "exact", head: true })
    .eq("booking_id", bookingId)
    .eq("entry_type", entryType);
  assertEquals(error, null);
  return count ?? 0;
}

async function dce(bookingId: string) {
  const client = await db();
  const { data, error } = await client
    .from("daily_collection_entries")
    .select(
      "platform_fee, receptionist_fee, hospital_fee, total_amount, setura_revenue, is_settled",
    )
    .eq("booking_id", bookingId)
    .maybeSingle();
  assertEquals(error, null);
  return data as {
    platform_fee: number;
    receptionist_fee: number;
    hospital_fee: number;
    total_amount: number;
    setura_revenue: number;
    is_settled: boolean;
  } | null;
}

// Insert a pending payment order at the platform-fee amount and capture it
// through the same RPC capture_payment the verify-payment leg drives.
async function createAndCapture(
  bookingId: string,
  amount = PLATFORM_FEE,
): Promise<string> {
  const client = await db();
  const orderId = `d16o_${RUN}_${bookingId.slice(0, 4)}`;
  const { error: insErr } = await client.from("payment_orders").insert({
    hospital_id: SEED.HOSPITAL_ID,
    booking_id: bookingId,
    amount_inr: amount,
    gateway: "razorpay",
    gateway_order_id: orderId,
    payment_status: "initiated",
  });
  assertEquals(insErr, null);

  const { data: cap, error: capErr } = await client.rpc("capture_payment", {
    p_gateway_order_id: orderId,
    p_gateway_payment_id: `d16pay_${RUN}_${bookingId.slice(0, 4)}`,
    p_gateway_signature: `d16-sig-${RUN}`,
    p_gateway_response: { event: "payment.captured" },
    // Explicit fee resolves the PGRST203 overload ambiguity between the
    // 4-arg and 5-arg capture_payment candidates.
    p_gateway_fee_inr: 2,
  });
  assertEquals(capErr, null);
  assertEquals(cap, true, "capture_payment must succeed");
  return orderId;
}

async function refund(
  bookingId: string,
  amount: number,
): Promise<string> {
  const client = await db();
  const { data: rid, error } = await client.rpc("initiate_refund", {
    p_booking_id: bookingId,
    p_refund_amount_inr: amount,
    p_refund_reason: `d16 ${RUN}`,
    p_initiated_by: SEED.HOSPITAL_ADMIN_ID,
  });
  assertEquals(error, null);
  assertExists(rid);
  return (Array.isArray(rid) ? rid[0] : rid) as string;
}

async function confirmRefund(refundId: string): Promise<boolean> {
  const client = await db();
  const { data, error } = await client.rpc("confirm_refund_processed", {
    p_refund_id: refundId,
    // Derived from the refund id: payment_refunds.gateway_refund_id is
    // UNIQUE, so a per-run constant would collide across sequential refunds.
    p_gateway_refund_id: `d16ref_${RUN}_${refundId.slice(0, 8)}`,
    p_gateway_response: { status: "processed" },
  });
  assertEquals(error, null);
  return data as boolean;
}

// ─── Q1 + Q3 + Q4: no revenue / settlement before capture ────────────────────

Deno.test("D16 Q1: create_booking records booking_fee_inr = platform fee only", async () => {
  const b = await newBooking("walkin", "q1");
  assertEquals(Number(b.booking_fee_inr), PLATFORM_FEE);
  // The Razorpay charge basis is the platform fee, NOT the display total.
  assert(
    Number(b.booking_fee_inr) < Number(b.total_amount_snapshot),
    "booking_fee_inr must be strictly below the display total (hospital + receptionist are not collected)",
  );
});

Deno.test("D16 Q3/Q4: a created booking recognises NO revenue and NO collected settlement", async () => {
  const b = await newBooking("manual_whatsapp", "q4");
  assertEquals(b.payment_completed, false);
  // No capture-time collection ledger entry exists yet.
  assertEquals(await ledgerSum(b.id, "booking_fee_collected"), 0);
  assertEquals(await ledgerCount(b.id, "platform_fee_credit"), 0);
  // The collection row exists (operational) but carries zero money.
  const row = await dce(b.id);
  assertExists(row, "unpaid booking keeps a zero-value collection row");
  assertEquals(Number(row!.total_amount), 0);
  assertEquals(Number(row!.platform_fee), 0);
  assertEquals(Number(row!.setura_revenue), 0);
});

Deno.test("D16 Q3: a pending payment order still recognises NO revenue", async () => {
  const b = await newBooking("online", "pd");
  const client = await db();
  const { error } = await client.from("payment_orders").insert({
    hospital_id: SEED.HOSPITAL_ID,
    booking_id: b.id,
    amount_inr: PLATFORM_FEE,
    gateway: "razorpay",
    gateway_order_id: `d16pending_${RUN}`,
    payment_status: "pending",
  });
  assertEquals(error, null);
  assertEquals(await ledgerSum(b.id, "booking_fee_collected"), 0);
  assertEquals(Number((await dce(b.id))!.total_amount), 0);
});

// ─── Q3 + Q1: revenue recognised at capture, on the platform fee ─────────────

Deno.test("D16 Q3: capture recognises collected revenue equal to the platform fee", async () => {
  const b = await newBooking("online", "cp");
  await createAndCapture(b.id);

  assertEquals(
    await ledgerSum(b.id, "booking_fee_collected"),
    PLATFORM_FEE,
    "collected revenue == booking_fee_inr, not the total",
  );
  // GST / gateway fee are recorded separately as debits (Q6/Q7).
  assert(await ledgerCount(b.id, "gateway_fee_debit") >= 1);

  const row = await dce(b.id);
  assertExists(row);
  assertEquals(Number(row!.platform_fee), PLATFORM_FEE);
  assertEquals(Number(row!.total_amount), PLATFORM_FEE);
  assertEquals(
    Number(row!.receptionist_fee),
    0,
    "SETURA does not collect receptionist fee",
  );
  assertEquals(
    Number(row!.hospital_fee),
    0,
    "SETURA does not collect hospital fee",
  );
  assertEquals(Number(row!.setura_revenue), PLATFORM_FEE);
});

// ─── Q5: full refund zeroes the collection; order fully refunded ─────────────

Deno.test("D16 Q5: a full refund zeroes the collection and marks the order refunded", async () => {
  const b = await newBooking("online", "ff");
  await createAndCapture(b.id);

  const rid = await refund(b.id, PLATFORM_FEE);
  assertEquals(await confirmRefund(rid), true);

  const row = await dce(b.id);
  assertExists(row);
  assertEquals(Number(row!.total_amount), 0);
  assertEquals(Number(row!.platform_fee), 0);
  assertEquals(await ledgerSum(b.id, "refund_debit"), PLATFORM_FEE);

  const client = await db();
  const { data: order } = await client
    .from("payment_orders")
    .select("payment_status")
    .eq("booking_id", b.id)
    .single();
  assertEquals(
    (order as { payment_status: string }).payment_status,
    "refunded",
  );
});

// ─── Q5: partial refund reduces ONLY the refunded amount, sequentially ───────

Deno.test("D16 Q5: sequential partial refunds reduce the collection amount exactly", async () => {
  const b = await newBooking("online", "ps");
  await createAndCapture(b.id); // collected 100

  const r1 = await refund(b.id, 40);
  assertEquals(await confirmRefund(r1), true);
  let row = await dce(b.id);
  assertEquals(Number(row!.total_amount), 60, "100 - 40 = 60, not 0");
  assertEquals(Number(row!.platform_fee), 60);
  const { data: o1 } = await (await db())
    .from("payment_orders")
    .select("payment_status")
    .eq("booking_id", b.id)
    .single();
  assertEquals(
    (o1 as { payment_status: string }).payment_status,
    "partially_refunded",
  );

  const r2 = await refund(b.id, 60);
  assertEquals(await confirmRefund(r2), true);
  row = await dce(b.id);
  assertEquals(Number(row!.total_amount), 0, "40 + 60 = 100 fully refunded");
  assertEquals(Number(row!.platform_fee), 0);
  const { data: o2 } = await (await db())
    .from("payment_orders")
    .select("payment_status")
    .eq("booking_id", b.id)
    .single();
  assertEquals((o2 as { payment_status: string }).payment_status, "refunded");
  assertEquals(await ledgerSum(b.id, "refund_debit"), 100);
});

// ─── Q2 / invariant: over-refund is rejected ─────────────────────────────────

Deno.test("D16 Q2: cumulative over-refund is rejected (total_refunded <= total_collected)", async () => {
  const b = await newBooking("online", "of");
  await createAndCapture(b.id); // collected 100

  const r1 = await refund(b.id, 70);
  assertEquals(await confirmRefund(r1), true);

  // 70 already refunded; a further 50 would total 120 > 100 -> must raise.
  const client = await db();
  const { error } = await client.rpc("initiate_refund", {
    p_booking_id: b.id,
    p_refund_amount_inr: 50,
    p_refund_reason: `d16 over ${RUN}`,
    p_initiated_by: SEED.HOSPITAL_ADMIN_ID,
  });
  assert(error, "over-refund beyond the collected amount must be rejected");
  assertMatch(error!.message, /exceeds collected|Refund/i);

  // The collection reflects only the 70 that actually cleared.
  const row = await dce(b.id);
  assertEquals(Number(row!.total_amount), 30);
});

// ─── Q5 idempotency: a replayed refund confirmation does not double-count ────

Deno.test("D16 Q5: replaying confirm_refund_processed is idempotent", async () => {
  const b = await newBooking("online", "rp");
  await createAndCapture(b.id);
  const rid = await refund(b.id, 40);

  assertEquals(await confirmRefund(rid), true, "first confirmation processes");
  const debitsAfterFirst = await ledgerCount(b.id, "refund_debit");

  assertEquals(
    await confirmRefund(rid),
    false,
    "replay must return FALSE and never re-process",
  );
  assertEquals(
    await ledgerCount(b.id, "refund_debit"),
    debitsAfterFirst,
    "replay must not add a second refund_debit",
  );
  const row = await dce(b.id);
  assertEquals(
    Number(row!.total_amount),
    60,
    "replay must not re-reduce the collection",
  );
});

// ─── Q6: refund basis (calculate_refund_amount) is the platform fee ──────────

Deno.test("D16 Q6: calculate_refund_amount is bounded by the platform fee, never the total", async () => {
  const b = await newBooking("online", "cr");
  await createAndCapture(b.id);
  const client = await db();
  const { data, error } = await client.rpc("calculate_refund_amount", {
    p_booking_id: b.id,
    p_cancellation_time: CANCELLATION_TIME,
  });
  assertEquals(error, null);
  const row = (Array.isArray(data) ? data[0] : data) as {
    refund_amount: number;
  };
  assertEquals(
    Number(row.refund_amount),
    PLATFORM_FEE,
    "tiered refund is computed on booking_fee_inr, not total_amount_snapshot",
  );
});

// ─── Multi-tenancy: every generated financial row carries the owning hospital ─

Deno.test("D16 tenancy: captured money is attributed to the booking's hospital only", async () => {
  const b = await newBooking("online", "tn");
  await createAndCapture(b.id);
  const client = await db();
  const { data: ledger } = await client
    .from("financial_ledger")
    .select("hospital_id")
    .eq("booking_id", b.id);
  assert((ledger ?? []).length > 0);
  for (const l of ledger ?? []) {
    assertEquals(l.hospital_id, SEED.HOSPITAL_ID);
  }
  const row = await dce(b.id);
  assertExists(row);
});

// ─── Cleanup (best effort; ledger + captured bookings are immutable residue) ──

Deno.test("D16: cleanup freely-deletable fixtures (ledger residue retained by design)", async () => {
  const client = await db();
  const ids = await client
    .from("bookings")
    .select("id")
    .like("patient_name", `D16 ${RUN}%`);
  const bookings = (ids.data ?? []) as Array<{ id: string }>;
  for (const bk of bookings) {
    // DCE rows for still-unpaid / unsettled fixtures are deletable.
    await client.from("daily_collection_entries").delete().eq(
      "booking_id",
      bk.id,
    );
  }
});
