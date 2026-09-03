/**
 * tests/integration/usage_retention.test.ts
 *
 * Phase 0.5 / P0.3 + P0.4 — subscription usage accounting and
 * retention cleanup against the REAL local stack.
 *
 * Verifies:
 *   - counter increments are atomic under concurrent execution
 *   - extended counters (WhatsApp/API/queue) live in metadata.usage
 *   - calendar-month rollover resets counters
 *   - sync recomputes doctor/receptionist gauges from source of truth
 *   - nightly retention run preserves immutable tables, deletes expired
 *     operational rows, and records a cleanup_run_log entry
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

const RUN = crypto.randomUUID().slice(0, 8);

type SubscriptionRow = {
  current_month_bookings: number;
  current_doctor_count: number;
  current_receptionist_count: number;
  metadata: Record<string, unknown> | null;
};

async function getSubscription(): Promise<SubscriptionRow> {
  const client = await db();
  const { data, error } = await client
    .from("hospital_subscriptions")
    .select(
      "current_month_bookings, current_doctor_count, current_receptionist_count, metadata",
    )
    .eq("hospital_id", SEED.HOSPITAL_ID)
    .single();
  assertEquals(error, null);
  assertExists(data);
  return data as unknown as SubscriptionRow;
}

async function record(metric: string, increment?: number) {
  const client = await db();
  return await client.rpc("record_subscription_usage", {
    p_hospital_id: SEED.HOSPITAL_ID,
    p_metric: metric,
    ...(increment !== undefined ? { p_increment: increment } : {}),
  });
}

// ─── 1. Normalize period, then atomic concurrent increments ─────────────────

Deno.test("usage: concurrent booking increments are atomic", async () => {
  const client = await db();

  // Normalize usage_period to the current month first
  const { error: syncErr } = await client.rpc("sync_subscription_usage", {
    p_hospital_id: SEED.HOSPITAL_ID,
  });
  assertEquals(syncErr, null);

  const baseline = await getSubscription();

  const results = await Promise.all([
    record("booking"),
    record("booking"),
    record("booking"),
    record("booking"),
    record("booking"),
  ]);
  for (const r of results) {
    assertEquals(r.error, null);
  }

  const after = await getSubscription();
  assertEquals(
    after.current_month_bookings,
    baseline.current_month_bookings + 5,
    "5 concurrent increments must add exactly 5",
  );
});

// ─── 2. Extended counters in metadata.usage ─────────────────────────────────

Deno.test("usage: whatsapp/api/queue counters accumulate in metadata.usage", async () => {
  const before = await getSubscription();
  const usageBefore = (before.metadata?.usage ?? {}) as Record<
    string,
    number
  >;

  const r1 = await record("whatsapp_message");
  assertEquals(r1.error, null);
  const r2 = await record("whatsapp_message");
  assertEquals(r2.error, null);
  const r3 = await record("api_call");
  assertEquals(r3.error, null);
  const r4 = await record("queue_operation");
  assertEquals(r4.error, null);

  const after = await getSubscription();
  const usage = (after.metadata?.usage ?? {}) as Record<string, number>;

  assertEquals(
    usage.whatsapp_messages ?? 0,
    (usageBefore.whatsapp_messages ?? 0) + 2,
  );
  assertEquals(usage.api_calls ?? 0, (usageBefore.api_calls ?? 0) + 1);
  assertEquals(
    usage.queue_operations ?? 0,
    (usageBefore.queue_operations ?? 0) + 1,
  );
});

// ─── 3. Calendar-month rollover resets counters ─────────────────────────────

Deno.test("usage: month rollover resets extended counters", async () => {
  const client = await db();

  // Force an old usage period with stale counters
  const { error: forceErr } = await client
    .from("hospital_subscriptions")
    .update({
      metadata: {
        usage_period: "2000-01",
        usage: { api_calls: 500, whatsapp_messages: 300 },
      },
    })
    .eq("hospital_id", SEED.HOSPITAL_ID);
  assertEquals(forceErr, null);

  const { data, error } = await record("api_call");
  assertEquals(error, null);

  const result = data as { period: string; usage: Record<string, number> };
  assertNotEqualsPeriod2000(result.period);
  assertEquals(
    result.usage.api_calls,
    1,
    "stale counters must reset on rollover",
  );
  assertEquals(result.usage.whatsapp_messages ?? 0, 0);

  function assertNotEqualsPeriod2000(period: string) {
    if (period === "2000-01") {
      throw new Error("usage_period was not rolled over");
    }
  }
});

// ─── 4. Invalid metric rejected ─────────────────────────────────────────────

Deno.test("usage: unknown metric is rejected", async () => {
  const { error } = await record("not_a_metric");
  assertExists(error, "unknown metric must return an RPC error");
});

// ─── 5. Sync recomputes gauges from source of truth ─────────────────────────

Deno.test("usage: sync recomputes doctor/receptionist gauges", async () => {
  const client = await db();

  // Corrupt the gauges, then let sync repair them
  const { error: corruptErr } = await client
    .from("hospital_subscriptions")
    .update({ current_doctor_count: 99, current_receptionist_count: 99 })
    .eq("hospital_id", SEED.HOSPITAL_ID);
  assertEquals(corruptErr, null);

  const { data, error } = await client.rpc("sync_subscription_usage", {
    p_hospital_id: SEED.HOSPITAL_ID,
  });
  assertEquals(error, null);

  const result = data as {
    current_doctor_count: number;
    current_receptionist_count: number;
    storage_rows: number;
  };
  // The deterministic seed provisions exactly 1 doctor + 1 receptionist
  assertEquals(result.current_doctor_count, 1);
  assertEquals(result.current_receptionist_count, 1);
  assertGreater(result.storage_rows, 0);

  const row = await getSubscription();
  assertEquals(row.current_doctor_count, 1);
  assertEquals(row.current_receptionist_count, 1);
});

// ─── 6. Usage snapshot read ─────────────────────────────────────────────────

Deno.test("usage: get_subscription_usage exposes limits and counters", async () => {
  const client = await db();
  const { data, error } = await client.rpc("get_subscription_usage", {
    p_hospital_id: SEED.HOSPITAL_ID,
  });
  assertEquals(error, null);

  const snapshot = data as {
    plan_name: string;
    limits: { max_doctors: number; max_bookings_per_month: number | null };
    counters: Record<string, number>;
  };
  assertExists(snapshot.plan_name);
  assertEquals(snapshot.limits.max_doctors, 1);
  assertExists(snapshot.counters.current_month_bookings);
});

// ─── 7. Retention: expired operational rows cleaned, immutable preserved ────

Deno.test("retention: cleanup deletes expired jobs, preserves ledger/audit", async () => {
  const client = await db();

  // Fixture: a completed job older than the 30-day job_queue policy
  const staleIso = new Date(Date.now() - 40 * 86400000).toISOString();
  const { data: staleJob, error: jobErr } = await client
    .from("job_queue")
    .insert({
      job_type: "p05_retention_probe",
      payload: { run: RUN },
      status: "completed",
      idempotency_key: `p05_retention_${RUN}`,
      created_at: staleIso,
      processing_completed_at: staleIso,
    })
    .select("id")
    .single();
  assertEquals(jobErr, null);
  assertExists(staleJob);
  const staleJobId = (staleJob as { id: string }).id;

  // Immutable baselines
  const { count: ledgerBefore } = await client
    .from("financial_ledger")
    .select("id", { count: "exact", head: true });
  const { count: auditBefore } = await client
    .from("audit_logs")
    .select("id", { count: "exact", head: true });
  const { count: cleanupLogsBefore } = await client
    .from("cleanup_run_log")
    .select("id", { count: "exact", head: true });

  const { data, error } = await client.rpc("run_retention_cleanup");
  assertEquals(error, null);

  const summary = data as {
    status: string;
    total_deleted: number;
    tables_cleaned: Record<string, number>;
    operational_cleanup: Record<string, unknown>;
    archival: Record<string, unknown>;
  };
  assertEquals(summary.status, "completed");
  assertExists(summary.operational_cleanup);
  assertExists(summary.archival);

  // The stale completed job must be gone
  const { data: gone } = await client
    .from("job_queue")
    .select("id")
    .eq("id", staleJobId)
    .maybeSingle();
  assertEquals(gone, null, "expired completed job must be hard-deleted");

  // Immutable tables untouched
  const { count: ledgerAfter } = await client
    .from("financial_ledger")
    .select("id", { count: "exact", head: true });
  const { count: auditAfter } = await client
    .from("audit_logs")
    .select("id", { count: "exact", head: true });
  assertEquals(ledgerAfter, ledgerBefore, "financial ledger must be preserved");
  assertEquals(auditAfter, auditBefore, "audit logs must be preserved");

  // Run recorded in cleanup_run_log
  const { count: cleanupLogsAfter } = await client
    .from("cleanup_run_log")
    .select("id", { count: "exact", head: true });
  assertEquals(
    cleanupLogsAfter,
    (cleanupLogsBefore ?? 0) + 1,
    "cleanup run must be logged",
  );
});

// ─── 8. Retention policies expose the preservation rules ────────────────────

Deno.test("retention: immutable tables have no hard-delete policy", async () => {
  const client = await db();
  const { data, error } = await client.rpc("get_retention_report");
  assertEquals(error, null);

  const rows = (data ?? []) as Array<{
    table_name: string;
    hard_delete_after_days: number | null;
  }>;
  assertGreater(rows.length, 10);

  const protectedTables = [
    "financial_ledger",
    "audit_logs",
    "hospital_settlements",
    "payment_orders",
    "payment_refunds",
    "whatsapp_messages",
    "bookings",
  ];

  for (const t of protectedTables) {
    const policy = rows.find((r) => r.table_name === t);
    assertExists(policy, `retention policy for ${t} must exist`);
    assertEquals(
      policy.hard_delete_after_days,
      null,
      `${t} must never be hard-deleted`,
    );
  }
});
