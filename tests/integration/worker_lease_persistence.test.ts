/**
 * tests/integration/worker_lease_persistence.test.ts
 *
 * P0-E regression — claim_jobs_v2 lease persistence against the REAL
 * local stack (no mocks — see tests/utils/setup_env.ts).
 *
 * Migration 19's claim_jobs_v2 recorded the per-job lease only in
 * worker_job_leases and never set job_queue.lease_expires_at (the v1
 * claim_jobs in migration 06 did), so a v2-claimed job stranded in
 * 'processing' by a dead worker had a NULL lease that
 * reclaim_stale_jobs (`status='processing' AND lease_expires_at <
 * now()`) could never match. Migration 51 makes the claim UPDATE write
 * the same transaction-stable now() + 2 minutes as the lease row.
 *
 * Proves:
 *   1. a pending job can be claimed by an active worker
 *   2. job_queue.lease_expires_at is NOT NULL after the claim
 *   3. it equals worker_job_leases.lease_expires_at (one coherent lease)
 *   4. anon cannot execute claim_jobs_v2 (SQLSTATE 42501 — the specific
 *      database EXECUTE denial, not a JWT-layer 401; see F16-05)
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

// ─── Shared fixture state ────────────────────────────────────────────────────

const RUN = crypto.randomUUID().slice(0, 8);
const WORKER_ID = `p0e-${RUN}-worker`;
const JOB_TYPE = "p0e_selftest";

/** Enqueue one test job for the seeded hospital and return its id. */
async function enqueueJob(idempotencyKey: string): Promise<string> {
  const client = await db();
  const { data, error } = await client.rpc("enqueue_job", {
    p_job_type: JOB_TYPE,
    p_payload: { selftest: RUN },
    p_priority: "normal",
    p_scheduled_at: new Date().toISOString(),
    p_idempotency_key: idempotencyKey,
    p_hospital_id: SEED.HOSPITAL_ID,
    p_metadata: { p0e_test: RUN },
  });
  assertEquals(error, null);
  assertExists(data);
  return data as string;
}

/** Read job_queue.lease_expires_at (and status) for one job. */
async function getJobLease(
  jobId: string,
): Promise<{ status: string; lease_expires_at: string | null }> {
  const client = await db();
  const { data, error } = await client
    .from("job_queue")
    .select("status, lease_expires_at")
    .eq("id", jobId)
    .single();
  assertEquals(error, null);
  assertExists(data);
  return data as unknown as {
    status: string;
    lease_expires_at: string | null;
  };
}

/** Read worker_job_leases.lease_expires_at for one job. */
async function getLeaseRow(
  jobId: string,
): Promise<string | null> {
  const client = await db();
  const { data, error } = await client
    .from("worker_job_leases")
    .select("lease_expires_at")
    .eq("job_queue_id", jobId)
    .eq("worker_id", WORKER_ID)
    .order("leased_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  assertEquals(error, null);
  return (data?.lease_expires_at as string) ?? null;
}

/** Register + claim so the lease is written by the real v2 path. */
async function claimJob(jobId: string): Promise<void> {
  const client = await db();
  const { error } = await client.rpc("register_worker", {
    p_worker_id: WORKER_ID,
    p_worker_type: "test",
    p_instance_id: RUN,
    p_lease_duration: 300,
  });
  assertEquals(error, null);

  const { data, error: claimError } = await client.rpc("claim_jobs_v2", {
    p_worker_id: WORKER_ID,
    p_job_types: [JOB_TYPE],
    p_batch_size: 10,
  });
  assertEquals(claimError, null);
  const claimed = (data ?? []) as unknown as { id: string }[];
  assertEquals(
    claimed.some((j) => j.id === jobId),
    true,
    "job was not claimed by the test worker",
  );
}

/** Remove every row this run created (best-effort). */
async function cleanup(jobIds: string[]): Promise<void> {
  const client = await db();
  if (jobIds.length > 0) {
    await client.from("job_queue").delete().in("id", jobIds); // cascades leases
  }
  await client.from("worker_registry").delete().eq("worker_id", WORKER_ID);
}

// ─── 1-3. Claim persists a coherent lease ────────────────────────────────────

Deno.test("p0e: claim_jobs_v2 persists job_queue.lease_expires_at consistent with worker_job_leases", async () => {
  const jobId = await enqueueJob(`p0e-lease-${RUN}`);
  try {
    // Before the claim the job is pending with no lease.
    const before = await getJobLease(jobId);
    assertEquals(before.status, "pending");
    assertEquals(
      before.lease_expires_at,
      null,
      "a freshly enqueued job must not carry a lease yet",
    );

    await claimJob(jobId);

    // (1) claimed → processing.
    const after = await getJobLease(jobId);
    assertEquals(after.status, "processing");

    // (2) the P0-E defect: this used to stay NULL in the v2 path.
    assertExists(
      after.lease_expires_at,
      "job_queue.lease_expires_at must be set by claim_jobs_v2 " +
        "(reclaim_stale_jobs cannot see a NULL lease)",
    );

    // (3) one coherent lease across both tables.
    const wjl = await getLeaseRow(jobId);
    assertExists(wjl, "worker_job_leases row must exist for the claimed job");
    assertEquals(
      after.lease_expires_at,
      wjl,
      "job_queue.lease_expires_at must equal worker_job_leases.lease_expires_at",
    );

    // The lease is in the future (not already reclaimable).
    assertEquals(
      new Date(after.lease_expires_at as string).getTime() > Date.now(),
      true,
      "lease_expires_at must be in the future",
    );
  } finally {
    await cleanup([jobId]);
  }
});

// ─── 4. Privilege boundary ───────────────────────────────────────────────────

Deno.test("p0e: anon cannot execute claim_jobs_v2 (SQLSTATE 42501)", async () => {
  const status = await getLocalStatus();
  assertExists(status, "local stack required for the privilege probe");

  const { createClient: supabaseCreateClient } = await import(
    "@supabase/supabase-js"
  );
  // Anon-key client: carries the anon JWT, so a rejection here is a
  // database EXECUTE denial, never a JWT-layer 401 (F16-05).
  const anon = supabaseCreateClient(status.API_URL, status.ANON_KEY);

  const { error } = await anon.rpc("claim_jobs_v2", {
    p_worker_id: "anon-probe",
    p_job_types: [JOB_TYPE],
    p_batch_size: 1,
  });
  assertExists(error, "anon EXECUTE must fail");
  assertEquals(
    error.code,
    "42501",
    `expected SQLSTATE 42501 (permission denied for function), got ${error.code}: ${error.message}`,
  );
});
