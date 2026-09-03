/**
 * tests/integration/whatsapp_lifecycle.test.ts
 *
 * Phase 0.5 / P0.1 — outbound WhatsApp lifecycle against the REAL
 * local stack (no mocks; Meta is never called).
 *
 * Covers:
 *   - idempotent message queueing (duplicate sends blocked)
 *   - atomic pending-claim (concurrent execution)
 *   - retry scheduling, backoff, exhaustion (retry path)
 *   - delivery-status reconciliation sent→delivered→read
 *   - webhook replay dedupe (register_webhook_event_v2)
 *   - worker crash recovery (stale processing reclaim)
 *   - cross-hospital isolation
 *   - worker-secret auth guard on send-whatsapp-message
 *
 * Run with:  deno task test:integration   (requires `supabase start`)
 */

import {
  assertEquals,
  assertExists,
  assertGreater,
  assertNotEquals,
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
let _status: LocalStatus | null = null;

async function createClient() {
  _status = await getLocalStatus();
  if (!_status) {
    throw new Error(
      "Local Supabase stack is not running. Run `supabase start` first.",
    );
  }
  Deno.env.set("APP_ENV", "test");
  Deno.env.set("SUPABASE_URL", _status.API_URL);
  Deno.env.set("SUPABASE_ANON_KEY", _status.ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", _status.SERVICE_ROLE_KEY);

  const { getServiceClient } = await import(
    "../../supabase/functions/_shared/db.ts"
  );
  return getServiceClient();
}

async function db() {
  if (!_db) _db = await createClient();
  return _db;
}

// ─── Per-run fixture isolation ───────────────────────────────────────────────

const RUN = crypto.randomUUID().slice(0, 8);
const PHONE_A = `9198${RUN}${RUN.slice(0, 3)}`; // 13-digit-ish, unique per run
const PHONE_B = `9197${RUN}${RUN.slice(0, 3)}`;

const createdMessageIds: string[] = [];
let secondHospitalId: string | null = null;

type WaMessage = {
  id: string;
  message_status: string;
  whatsapp_message_id: string | null;
  retry_count: number;
  max_retries: number;
  next_retry_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  hospital_id: string;
  conversation_id: string;
};

async function queueMsg(
  phone: string,
  idemKey: string,
  hospitalId: string = SEED.HOSPITAL_ID,
): Promise<string> {
  const client = await db();
  const { data, error } = await client.rpc("queue_whatsapp_message", {
    p_hospital_id: hospitalId,
    // Generated RPC types declare UUID params as string; SQL accepts NULL
    p_patient_id: null as unknown as string,
    p_booking_id: null as unknown as string,
    p_phone: phone,
    p_template_name: "booking_confirmation",
    p_message_text: "",
    p_idempotency_key: idemKey,
  });
  assertEquals(error, null);
  assertExists(data);
  createdMessageIds.push(data as string);
  return data as string;
}

async function getMsg(id: string): Promise<WaMessage> {
  const client = await db();
  const { data, error } = await client
    .from("whatsapp_messages")
    .select(
      "id, message_status, whatsapp_message_id, retry_count, max_retries, next_retry_at, delivered_at, read_at, hospital_id, conversation_id",
    )
    .eq("id", id)
    .single();
  assertEquals(error, null);
  assertExists(data);
  return data as unknown as WaMessage;
}

// ─── 1. Idempotent queueing: duplicate sends blocked ─────────────────────────

Deno.test("whatsapp: queue_whatsapp_message is idempotent on its key", async () => {
  const key = `p05_dup_${RUN}`;
  const first = await queueMsg(PHONE_A, key);
  const second = await queueMsg(PHONE_A, key);
  assertEquals(second, first, "same idempotency key must return same row");

  const row = await getMsg(first);
  assertEquals(row.message_status, "queued");
  assertEquals(row.hospital_id, SEED.HOSPITAL_ID);
});

// ─── 2. Atomic claim: concurrent fetch cannot double-process ─────────────────

Deno.test("whatsapp: fetch_pending claims atomically (no double claim)", async () => {
  const client = await db();
  const msgId = await queueMsg(PHONE_A, `p05_claim_${RUN}`);

  const { data: batch1, error: e1 } = await client.rpc(
    "fetch_pending_whatsapp_messages",
    { p_limit: 50 },
  );
  assertEquals(e1, null);

  const claimed = (batch1 ?? []) as Array<{ id: string }>;
  const ours = claimed.find((m) => m.id === msgId);
  assertExists(ours, "queued message must be claimed");

  const after = await getMsg(msgId);
  assertEquals(after.message_status, "processing");

  // A concurrent/second fetch must not claim the same row again
  const { data: batch2, error: e2 } = await client.rpc(
    "fetch_pending_whatsapp_messages",
    { p_limit: 50 },
  );
  assertEquals(e2, null);
  const again = ((batch2 ?? []) as Array<{ id: string }>).find((m) =>
    m.id === msgId
  );
  assertEquals(again, undefined, "already-processing row must not re-claim");

  // Leave it queued for later tests/cleanup
  await client.from("whatsapp_messages")
    .update({ message_status: "queued", processing_started_at: null })
    .eq("id", msgId);
});

// ─── 3. Retry path: backoff scheduling and exhaustion ────────────────────────

Deno.test("whatsapp: schedule_whatsapp_retry backs off then exhausts", async () => {
  const client = await db();
  const msgId = await queueMsg(PHONE_A, `p05_retry_${RUN}`);

  // Tighten max_retries so exhaustion is observable
  const { error: capErr } = await client.from("whatsapp_messages")
    .update({ max_retries: 2 })
    .eq("id", msgId);
  assertEquals(capErr, null);

  const { data: r1, error: e1 } = await client.rpc("schedule_whatsapp_retry", {
    p_message_id: msgId,
    p_error: "simulated transient failure",
  });
  assertEquals(e1, null);
  assertEquals(r1, true);

  let row = await getMsg(msgId);
  assertEquals(row.message_status, "retrying");
  assertEquals(row.retry_count, 1);
  assertExists(row.next_retry_at, "backoff must schedule next_retry_at");

  const { data: r2 } = await client.rpc("schedule_whatsapp_retry", {
    p_message_id: msgId,
    p_error: "simulated transient failure 2",
  });
  assertEquals(r2, true);

  // Third attempt exceeds max_retries=2 → permanently failed, no retry
  const { data: r3 } = await client.rpc("schedule_whatsapp_retry", {
    p_message_id: msgId,
    p_error: "simulated transient failure 3",
  });
  assertEquals(r3, false);

  row = await getMsg(msgId);
  assertEquals(row.message_status, "permanently_failed");
});

// ─── 4. Reconciliation: sent → delivered → read, terminal protected ─────────

Deno.test("whatsapp: delivery webhook reconciliation reaches read, terminal protected", async () => {
  const client = await db();
  const msgId = await queueMsg(PHONE_A, `p05_recon_${RUN}`);
  const metaId = `wamid.p05.${RUN}`;

  // Simulate a successful Meta send (bookkeeping the endpoint performs)
  const { error: sentErr } = await client.from("whatsapp_messages")
    .update({
      message_status: "sent",
      whatsapp_message_id: metaId,
      sent_at: new Date().toISOString(),
    })
    .eq("id", msgId);
  assertEquals(sentErr, null);

  const { data: delivered, error: de } = await client.rpc(
    "handle_whatsapp_delivery_status",
    { p_meta_message_id: metaId, p_status: "delivered", p_payload: {} },
  );
  assertEquals(de, null);
  assertEquals(delivered, true);
  let row = await getMsg(msgId);
  assertEquals(row.message_status, "delivered");
  assertExists(row.delivered_at);

  const { data: read, error: re } = await client.rpc(
    "handle_whatsapp_delivery_status",
    { p_meta_message_id: metaId, p_status: "read", p_payload: {} },
  );
  assertEquals(re, null);
  assertEquals(read, true);
  row = await getMsg(msgId);
  assertEquals(row.message_status, "read");
  assertExists(row.read_at);

  // Replay of an older status must not downgrade the terminal state
  await client.rpc("handle_whatsapp_delivery_status", {
    p_meta_message_id: metaId,
    p_status: "delivered",
    p_payload: {},
  });
  row = await getMsg(msgId);
  assertEquals(row.message_status, "read", "terminal read state is protected");
});

// ─── 5. Webhook replay dedupe ────────────────────────────────────────────────

Deno.test("whatsapp: webhook replay is deduplicated via register_webhook_event_v2", async () => {
  const client = await db();
  const providerEventId = `p05_replay_${RUN}`;

  const { data: first, error: e1 } = await client.rpc(
    "register_webhook_event_v2",
    {
      p_provider: "razorpay",
      p_provider_event_id: providerEventId,
      p_event_type: "refund.processed",
      p_payload_hash: `hash-a-${RUN}`,
      p_raw_payload: { run: RUN },
    },
  );
  assertEquals(e1, null);
  const firstRow = (first as Array<{ is_new: boolean }>)?.[0];
  assertEquals(firstRow?.is_new, true);

  const { data: second, error: e2 } = await client.rpc(
    "register_webhook_event_v2",
    {
      p_provider: "razorpay",
      p_provider_event_id: providerEventId,
      p_event_type: "refund.processed",
      p_payload_hash: `hash-a-${RUN}`,
      p_raw_payload: { run: RUN },
    },
  );
  assertEquals(e2, null);
  const secondRow = (second as Array<{ is_new: boolean }>)?.[0];
  assertEquals(secondRow?.is_new, false, "replayed webhook must be deduped");
});

// ─── 6. Worker crash recovery ────────────────────────────────────────────────

Deno.test("whatsapp: stale processing rows are reclaimed after worker crash", async () => {
  const client = await db();
  const msgId = await queueMsg(PHONE_A, `p05_crash_${RUN}`);

  const staleStart = new Date(Date.now() - 30 * 60_000).toISOString();
  const { error: simErr } = await client.from("whatsapp_messages")
    .update({
      message_status: "processing",
      processing_started_at: staleStart,
    })
    .eq("id", msgId);
  assertEquals(simErr, null);

  const { data: reclaimed, error: rcErr } = await client.rpc(
    "reclaim_stale_whatsapp_processing",
    { p_stale_minutes: 15 },
  );
  assertEquals(rcErr, null);
  assertGreater(
    Number(reclaimed ?? 0),
    0,
    "stale processing message must be reclaimed",
  );

  const row = await getMsg(msgId);
  assertNotEquals(
    row.message_status,
    "processing",
    "reclaimed message must leave processing state",
  );
  assertEquals(row.message_status, "retrying");
});

// ─── 7. Cross-hospital isolation ─────────────────────────────────────────────

Deno.test("whatsapp: conversations and messages are hospital-scoped", async () => {
  const client = await db();

  // Second tenant
  const { data: hospitalB, error: hErr } = await client
    .from("hospitals")
    .insert({
      name: `P05 Isolation Hospital ${RUN}`,
      slug: `p05-isolation-${RUN}`,
    })
    .select("id")
    .single();
  assertEquals(hErr, null);
  assertExists(hospitalB);
  secondHospitalId = (hospitalB as { id: string }).id;

  // Same phone number in two hospitals → distinct conversations
  const msgA = await queueMsg(PHONE_B, `p05_iso_a_${RUN}`, SEED.HOSPITAL_ID);
  const msgB = await queueMsg(PHONE_B, `p05_iso_b_${RUN}`, secondHospitalId!);

  const rowA = await getMsg(msgA);
  const rowB = await getMsg(msgB);

  assertEquals(rowA.hospital_id, SEED.HOSPITAL_ID);
  assertEquals(rowB.hospital_id, secondHospitalId);
  assertNotEquals(
    rowA.conversation_id,
    rowB.conversation_id,
    "same phone in different hospitals must not share a conversation",
  );

  // Tenant B can never see tenant A's message rows in a scoped query
  const { data: scoped } = await client
    .from("whatsapp_messages")
    .select("id")
    .eq("hospital_id", secondHospitalId!)
    .eq("id", msgA);
  assertEquals((scoped ?? []).length, 0);
});

// ─── 8. Endpoint auth guard (no Meta involved) ───────────────────────────────

Deno.test("whatsapp: send-whatsapp-message rejects missing worker secret", async () => {
  if (!_status) await db();
  const resp = await fetch(
    `${_status!.API_URL}/functions/v1/send-whatsapp-message`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${_status!.ANON_KEY}`,
      },
      body: JSON.stringify({
        phone: PHONE_A,
        template_name: "booking_confirmation",
      }),
    },
  );
  assertEquals(resp.status, 403);
  await resp.body?.cancel();
});

// ─── Cleanup ─────────────────────────────────────────────────────────────────

Deno.test("whatsapp: cleanup fixtures", async () => {
  const client = await db();

  if (createdMessageIds.length > 0) {
    await client.from("whatsapp_delivery_logs").delete().in(
      "message_id",
      createdMessageIds,
    );
    await client.from("whatsapp_messages").delete().in(
      "id",
      createdMessageIds,
    );
  }

  // Conversations created for this run's phones
  await client.from("whatsapp_conversations").delete().like(
    "phone_number",
    `%${RUN}%`,
  );

  // Second hospital cascades its conversations/messages if any remain
  if (secondHospitalId) {
    await client.from("hospitals").delete().eq("id", secondHospitalId);
  }
});
