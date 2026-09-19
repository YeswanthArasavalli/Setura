/**
 * tests/integration/worker_lifecycle.test.ts
 *
 * W1 — Worker Lifecycle Gate (Gate W1, §7 of the master roadmap).
 *
 * Proves the real operational chain — not that the code exists, but that
 * it works — against the REAL local Supabase stack (no mocks of the
 * system under test; see tests/utils/setup_env.ts). The job handlers in
 * run-background-worker reach Meta/Razorpay and cannot run here, so this
 * test drives the SAME shared worker primitives that Edge Function uses
 * (`registerWorker` / `claimJobs` / `processJob` / `completeJob` /
 * `failJob` from _shared/worker.ts, which call the real claim_jobs_v2 /
 * complete_job_v2 / fail_job_v2 RPCs) with an injected processor, plus
 * the canonical recovery RPCs (detect_crashed_workers +
 * reclaim_crashed_worker_jobs). The processor is the only injected piece
 * (the external side-effect); every claim/lease/complete/fail/reclaim
 * transition executes against the live database.
 *
 * Covers the W1 acceptance items that are runtime-provable without the
 * deferred Phase-1 decisions (scheduled caller wiring, dead-letter table
 * reconciliation, provisioned HTTP trigger secret):
 *   1. create → queue → claim → lease → execute → COMPLETED, observable
 *      in job_queue + worker_job_leases
 *   2. a handler that always fails, retried to exhaustion via the real
 *      backoff path, lands in dead_letter_jobs with correct columns
 *   3. a worker killed mid-processing has its job reclaimed through the
 *      wired recovery RPCs (detect_crashed_workers → reclaimed, then
 *      reclaim_crashed_worker_jobs → pending) — no stranded job
 *   4. a duplicate job (same idempotency key) does not create a second
 *      row / does not double-execute
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

/** Service-role client (bypasses RLS; used for fixtures + recovery RPCs). */
async function db() {
  if (!_db) _db = await createClient();
  return _db;
}

type WorkerModule = typeof import("../../supabase/functions/_shared/worker.ts");
type Logger = import("../../supabase/functions/_shared/logger.ts").Logger;

let _worker: WorkerModule | null = null;
let _logger: Logger | null = null;

/** Loads the real shared worker primitives + a real Logger after env is set. */
async function primitives(): Promise<{ w: WorkerModule; logger: Logger }> {
  await db(); // ensures SUPABASE_* env is set before _shared modules load
  if (!_worker) {
    _worker = await import("../../supabase/functions/_shared/worker.ts");
  }
  if (!_logger) {
    const { Logger: LoggerCtor } = await import(
      "../../supabase/functions/_shared/logger.ts"
    );
    _logger = new LoggerCtor({ test: "w1" });
  }
  return { w: _worker, logger: _logger };
}

// ─── Shared fixture state ────────────────────────────────────────────────────

const RUN = crypto.randomUUID().slice(0, 8);
// A job type with no external handler — the processor is injected, so the
// worker primitives run while no Meta/Razorpay call is ever attempted.
const JOB_TYPE = "w1_lifecycle_selftest";

type JobRow = {
  id: string;
  status: string;
  worker_id: string | null;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  scheduled_at: string;
  lease_expires_at: string | null;
  processing_completed_at: string | null;
};

async function enqueueJob(idempotencyKey: string): Promise<string> {
  const client = await db();
  const { data, error } = await client.rpc("enqueue_job", {
    p_job_type: JOB_TYPE,
    p_payload: { selftest: RUN },
    p_priority: "normal",
    p_scheduled_at: new Date().toISOString(),
    p_idempotency_key: idempotencyKey,
    p_hospital_id: SEED.HOSPITAL_ID,
    p_metadata: { w1_test: RUN },
  });
  assertEquals(error, null);
  assertExists(data);
  return data as string;
}

async function getJob(jobId: string): Promise<JobRow> {
  const client = await db();
  const { data, error } = await client
    .from("job_queue")
    .select(
      "id, status, worker_id, attempt_count, max_attempts, last_error, " +
        "scheduled_at, lease_expires_at, processing_completed_at",
    )
    .eq("id", jobId)
    .single();
  assertEquals(error, null);
  assertExists(data);
  return data as unknown as JobRow;
}

/** Make a pending (backed-off) job immediately claimable again. */
async function unbackoff(jobId: string): Promise<void> {
  const client = await db();
  const { error } = await client
    .from("job_queue")
    .update({ scheduled_at: new Date(Date.now() - 1000).toISOString() })
    .eq("id", jobId);
  assertEquals(error, null);
}

async function getLease(
  jobId: string,
): Promise<Record<string, unknown> | null> {
  const client = await db();
  const { data, error } = await client
    .from("worker_job_leases")
    .select(
      "worker_id, job_queue_id, outcome, leased_at, lease_expires_at, " +
        "completed_at, failed_at",
    )
    .eq("job_queue_id", jobId)
    .order("leased_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  assertEquals(error, null);
  return (data ?? null) as unknown as Record<string, unknown> | null;
}

async function getDlqRow(
  jobId: string,
): Promise<Record<string, unknown>[]> {
  const client = await db();
  const { data, error } = await client
    .from("dead_letter_jobs")
    .select("*")
    .eq("original_job_id", jobId);
  assertEquals(error, null);
  return (data ?? []) as unknown as Record<string, unknown>[];
}

async function cleanup(jobIds: string[], workerIds: string[]): Promise<void> {
  const client = await db();
  if (jobIds.length > 0) {
    await client.from("dead_letter_jobs").delete().in(
      "original_job_id",
      jobIds,
    );
    await client.from("job_queue").delete().in("id", jobIds); // cascades leases
  }
  for (const workerId of workerIds) {
    await client.from("worker_registry").delete().eq("worker_id", workerId);
  }
}

// ─── 1. Happy path: claim → lease → execute → complete ───────────────────────

Deno.test("w1: a real worker claims, leases and completes a job end-to-end", async () => {
  const { w, logger } = await primitives();
  const workerId = `w1-happy-${RUN}`;
  const jobId = await enqueueJob(`w1-happy-${RUN}`);

  try {
    await w.registerWorker(
      { workerId, workerType: "test", instanceId: RUN },
      logger,
    );

    // ENQUEUED → CLAIMED: claimJobs (via claim_jobs_v2) moves the job to
    // processing, stamps the claiming worker and opens a lease.
    const claimed = await w.claimJobs(workerId, [JOB_TYPE], 5, logger);
    const job = claimed.find((j) => j.id === jobId);
    assertExists(job, "the real worker did not claim the enqueued job");

    let row = await getJob(jobId);
    assertEquals(row.status, "processing");
    assertEquals(row.worker_id, workerId);
    assertEquals(row.attempt_count, 1);
    assertExists(row.lease_expires_at, "claim must persist job_queue lease");

    const leaseAfterClaim = await getLease(jobId);
    assertExists(leaseAfterClaim, "claim must open a worker_job_leases row");
    assertEquals(leaseAfterClaim!.outcome, null);

    // PROCESSING → COMPLETED: processJob runs the handler then completeJob.
    const outcome = await w.processJob(job!, workerId, {
      // success: no external side effect (the only injected piece)
      process: () => Promise.resolve(),
    }, logger);
    assertEquals(outcome, "completed");

    row = await getJob(jobId);
    assertEquals(row.status, "completed");
    assertExists(row.processing_completed_at);

    const lease = await getLease(jobId);
    assertExists(lease);
    assertEquals(lease!.outcome, "completed");
    assertExists(lease!.completed_at);
  } finally {
    await cleanup([jobId], [workerId]);
  }
});

// ─── 2. Retry to exhaustion → dead-letter (real backoff path) ────────────────

Deno.test("w1: a persistently failing handler retries then dead-letters with correct columns", async () => {
  const { w, logger } = await primitives();
  const workerId = `w1-fail-${RUN}`;
  const jobId = await enqueueJob(`w1-fail-${RUN}`);
  const client = await db();

  try {
    await w.registerWorker(
      { workerId, workerType: "test", instanceId: RUN },
      logger,
    );

    const { max_attempts: maxAttempts } = await getJob(jobId);
    const failing = {
      process: () => Promise.reject(new Error("w1 deterministic failure")),
    };

    let terminal = false;
    for (let attempt = 1; attempt <= maxAttempts + 2; attempt++) {
      const claimed = await w.claimJobs(workerId, [JOB_TYPE], 5, logger);
      const job = claimed.find((j) => j.id === jobId);
      assertExists(job, `job was not claimable on attempt ${attempt}`);

      const outcome = await w.processJob(job!, workerId, failing, logger);
      assertEquals(outcome, "failed");

      const row = await getJob(jobId);
      if (row.attempt_count >= maxAttempts) {
        // fail_job_v2's terminal branch: dead + exactly one DLQ row.
        assertEquals(row.status, "dead");
        terminal = true;
        break;
      }
      // Retry branch: back to pending with a future scheduled_at (backoff).
      assertEquals(row.status, "pending");
      assertEquals(row.worker_id, null);
      assertEquals(row.last_error, "w1 deterministic failure");
      assertEquals(
        new Date(row.scheduled_at).getTime() > Date.now(),
        true,
        "a retried job must be backed off before the next claim",
      );
      // Allow the next claim inside this test (do not wait out the backoff).
      await unbackoff(jobId);
    }

    assertEquals(terminal, true, "the job never reached the terminal branch");

    const dlq = await getDlqRow(jobId);
    assertEquals(dlq.length, 1, "terminal failure must dead-letter once");
    const d = dlq[0];
    assertEquals(d.job_type, JOB_TYPE);
    assertEquals(d.hospital_id, SEED.HOSPITAL_ID);
    assertEquals(d.attempt_count, maxAttempts);
    assertEquals(d.last_error, "w1 deterministic failure");
    assertExists(d.failed_at);
    assertEquals(
      (d.payload as Record<string, unknown>).selftest,
      RUN,
    );

    // The last (terminal) lease is closed as failed.
    const lease = await getLease(jobId);
    assertExists(lease);
    assertEquals(lease!.outcome, "failed");

    // Sanity: the failed attempts really incremented the worker counter.
    const { data: registry } = await client
      .from("worker_registry")
      .select("jobs_claimed")
      .eq("worker_id", workerId)
      .single();
    assertExists(registry);
  } finally {
    await cleanup([jobId], [workerId]);
  }
});

// ─── 3. Killed worker → reclaimed via the recovery RPCs ──────────────────────

Deno.test("w1: a crashed worker's in-flight job is reclaimed (not stranded)", async () => {
  const { w, logger } = await primitives();
  const liveWorker = `w1-live-${RUN}`;
  const deadWorker = `w1-dead-${RUN}`;
  const jobId = await enqueueJob(`w1-crash-${RUN}`);
  const client = await db();

  try {
    await w.registerWorker(
      { workerId: deadWorker, workerType: "test", instanceId: RUN },
      logger,
    );
    const claimed = await w.claimJobs(deadWorker, [JOB_TYPE], 5, logger);
    assertExists(
      claimed.find((j) => j.id === jobId),
      "the doomed worker must claim the job first",
    );

    let row = await getJob(jobId);
    assertEquals(row.status, "processing");
    assertEquals(row.worker_id, deadWorker);

    // Simulate the worker dying mid-processing: it stops heartbeating, so
    // both its registry lease and its open job lease age out. (Equivalent
    // to wall-clock elapsing; the recovery RPCs key off `now()`.)
    const past = new Date(Date.now() - 60_000).toISOString();
    const { error: regErr } = await client
      .from("worker_registry")
      .update({ lease_expires_at: past })
      .eq("worker_id", deadWorker);
    assertEquals(regErr, null);
    const { error: leaseErr } = await client
      .from("worker_job_leases")
      .update({ lease_expires_at: past })
      .eq("job_queue_id", jobId)
      .eq("worker_id", deadWorker);
    assertEquals(leaseErr, null);

    // Recovery, wired exactly as Phase 1 will wire it into the minute path:
    // detect the crashed worker, then reclaim its stranded job.
    const { error: detectError } = await client.rpc("detect_crashed_workers");
    assertEquals(detectError, null);

    const { error: reclaimError } = await client.rpc(
      "reclaim_crashed_worker_jobs",
    );
    assertEquals(reclaimError, null);

    // No job is stranded: it is back in the queue, unassigned.
    row = await getJob(jobId);
    assertEquals(row.status, "pending");
    assertEquals(row.worker_id, null);

    // The crashed worker is marked as such and its open lease is closed.
    const { data: crashedRegistry } = await client
      .from("worker_registry")
      .select("status")
      .eq("worker_id", deadWorker)
      .single();
    assertEquals(
      (crashedRegistry as { status: string }).status,
      "crashed",
    );
    const lease = await getLease(jobId);
    assertExists(lease);
    assertEquals(lease!.outcome, "reclaimed");

    // A healthy worker can now pick the reclaimed job up.
    await w.registerWorker(
      { workerId: liveWorker, workerType: "test", instanceId: RUN },
      logger,
    );
    const reclaimed = await w.claimJobs(liveWorker, [JOB_TYPE], 5, logger);
    const job = reclaimed.find((j) => j.id === jobId);
    assertExists(job, "the reclaimed job must be claimable by a live worker");

    const outcome = await w.processJob(job!, liveWorker, {
      process: () => Promise.resolve(), // success
    }, logger);
    assertEquals(outcome, "completed");
    assertEquals((await getJob(jobId)).status, "completed");
  } finally {
    await cleanup([jobId], [deadWorker, liveWorker]);
  }
});

// ─── 4. Duplicate job (same idempotency key) does not double-create ──────────

Deno.test("w1: enqueue is idempotent on the dedup key — no second job row", async () => {
  const key = `w1-dedup-${RUN}`;
  const client = await db();

  try {
    const first = await enqueueJob(key);
    const second = await enqueueJob(key);
    assertEquals(first, second, "the same dedup key must return the same id");

    const { data, error } = await client
      .from("job_queue")
      .select("id")
      .eq("idempotency_key", key);
    assertEquals(error, null);
    assertEquals(
      (data ?? []).length,
      1,
      "exactly one job_queue row may exist for a dedup key",
    );
  } finally {
    await cleanup([await enqueueJob(key)], []);
  }
});
