/**
 * tests/integration/worker_job_failure.test.ts
 *
 * P0-A regression — fail_job_v2 dead-letter path against the REAL
 * local stack (no mocks — see tests/utils/setup_env.ts).
 *
 * Migration 19's fail_job_v2 inserted into a non-existent job_id
 * column of dead_letter_jobs (migration 06 calls it original_job_id),
 * so every retry-exhausted job aborted its own failure handling and
 * was stranded in 'processing'. Migration 50 redefines the function.
 *
 * Proves:
 *   1. retryable failure   → status pending, future scheduled_at,
 *                            last_error recorded, NO dead-letter row,
 *                            lease outcome 'failed'
 *   2. terminal failure    → dead_letter_jobs row keyed by
 *                            original_job_id with hospital_id,
 *                            attempt_count, last_error; job 'dead'
 *   3. repeated failure    → still exactly one dead-letter row
 *                            (ON CONFLICT original_job_id)
 *   4. unknown job id      → returns FALSE, no error
 *   5. privilege boundary  → anon cannot execute fail_job_v2
 *                            (PostgREST error code 42501 — the
 *                            specific SQLSTATE, not a bare 401)
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
const WORKER_ID = `p0a-${RUN}-worker`;
const JOB_TYPE = "p0a_selftest";

type JobRow = {
  id: string;
  status: string;
  worker_id: string | null;
  processing_started_at: string | null;
  scheduled_at: string;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  hospital_id: string | null;
};

/** Enqueue one test job for the seeded hospital and return the row. */
async function enqueueJob(idempotencyKey: string): Promise<string> {
  const client = await db();
  const { data, error } = await client.rpc("enqueue_job", {
    p_job_type: JOB_TYPE,
    p_payload: { selftest: RUN },
    p_priority: "normal",
    p_scheduled_at: new Date().toISOString(),
    p_idempotency_key: idempotencyKey,
    p_hospital_id: SEED.HOSPITAL_ID,
    p_metadata: { p0a_test: RUN },
  });
  assertEquals(error, null);
  assertExists(data);
  return data as string;
}

/** Read one job_queue row. */
async function getJob(jobId: string): Promise<JobRow> {
  const client = await db();
  const { data, error } = await client
    .from("job_queue")
    .select(
      "id, status, worker_id, processing_started_at, scheduled_at, " +
        "attempt_count, max_attempts, last_error, hospital_id",
    )
    .eq("id", jobId)
    .single();
  assertEquals(error, null);
  assertExists(data);
  return data as unknown as JobRow;
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

type LeaseRow = {
  worker_id: string;
  job_queue_id: string;
  outcome: string | null;
  failed_at: string | null;
  error_message: string | null;
};

async function getLeases(jobId: string): Promise<LeaseRow[]> {
  const client = await db();
  const { data, error } = await client
    .from("worker_job_leases")
    .select(
      "worker_id, job_queue_id, outcome, failed_at, error_message",
    )
    .eq("job_queue_id", jobId)
    .order("leased_at");
  assertEquals(error, null);
  return (data ?? []) as unknown as LeaseRow[];
}

/** Register + claim so the failure path runs against a real lease. */
async function claimJob(jobId: string): Promise<void> {
  const client = await db();
  const { error } = await client.rpc("register_worker", {
    p_worker_id: WORKER_ID,
    p_worker_type: "test",
    p_instance_id: RUN,
    p_lease_duration: 60,
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

/** Remove every row this run created (best-effort, per test). */
async function cleanup(jobIds: string[]): Promise<void> {
  const client = await db();
  if (jobIds.length > 0) {
    await client.from("dead_letter_jobs").delete().in(
      "original_job_id",
      jobIds,
    );
    await client.from("job_queue").delete().in("id", jobIds);
  }
  await client.from("worker_registry").delete().eq(
    "worker_id",
    WORKER_ID,
  ); // cascades leases + heartbeats
}

// ─── 1. Retryable failure ────────────────────────────────────────────────────

Deno.test("p0a: retryable failure reschedules with backoff and never dead-letters", async () => {
  const client = await db();
  const jobId = await enqueueJob(`p0a-retry-${RUN}`);
  try {
    await claimJob(jobId);

    const claimed = await getJob(jobId);
    assertEquals(claimed.status, "processing");
    assertEquals(claimed.attempt_count, 1);
    assertEquals(claimed.worker_id, WORKER_ID);

    // attempt_count (1) < max_attempts (5) → retry branch.
    const { data, error } = await client.rpc("fail_job_v2", {
      p_job_id: jobId,
      p_worker_id: WORKER_ID,
      p_error: "transient failure",
    });
    assertEquals(error, null);
    assertEquals(data, true);

    const job = await getJob(jobId);
    assertEquals(job.status, "pending");
    assertEquals(job.worker_id, null);
    assertEquals(job.processing_started_at, null);
    assertEquals(job.last_error, "transient failure");
    assertEquals(
      new Date(job.scheduled_at).getTime() > Date.now(),
      true,
      "scheduled_at must be in the future (exponential backoff)",
    );

    // No dead-letter row for a retryable failure.
    assertEquals((await getDlqRow(jobId)).length, 0);

    // The active lease is closed as 'failed'.
    const leases = await getLeases(jobId);
    assertEquals(leases.length, 1);
    assertEquals(leases[0].outcome, "failed");
    assertEquals(leases[0].worker_id, WORKER_ID);
    assertExists(leases[0].failed_at);
    assertEquals(leases[0].error_message, "transient failure");
  } finally {
    await cleanup([jobId]);
  }
});

// ─── 2. Terminal failure ─────────────────────────────────────────────────────

Deno.test("p0a: terminal failure dead-letters into original_job_id with full context", async () => {
  const client = await db();
  const jobId = await enqueueJob(`p0a-terminal-${RUN}`);
  try {
    await claimJob(jobId);

    // Simulate retry exhaustion: the function's own branch condition
    // is attempt_count >= max_attempts. (Claiming five times is not
    // possible here — the first failure sets scheduled_at in the
    // future, so claim_jobs_v2 would skip the job.)
    const { error: bumpError } = await client
      .from("job_queue")
      .update({ attempt_count: 5 })
      .eq("id", jobId);
    assertEquals(bumpError, null);

    const { data, error } = await client.rpc("fail_job_v2", {
      p_job_id: jobId,
      p_worker_id: WORKER_ID,
      p_error: "fatal after retries",
    });
    assertEquals(error, null);
    assertEquals(data, true);

    // Job terminal state.
    const job = await getJob(jobId);
    assertEquals(job.status, "dead");
    assertEquals(job.last_error, "fatal after retries");

    // Dead-letter row: exactly the columns the old INSERT got wrong.
    const dlq = await getDlqRow(jobId);
    assertEquals(dlq.length, 1);
    const row = dlq[0];
    assertEquals(row.job_type, JOB_TYPE);
    assertEquals(row.hospital_id, SEED.HOSPITAL_ID);
    assertEquals(row.attempt_count, 5);
    assertEquals(row.last_error, "fatal after retries");
    assertExists(row.failed_at);
    assertEquals(
      (row.payload as Record<string, unknown>).selftest,
      RUN,
    );
  } finally {
    await cleanup([jobId]);
  }
});

// ─── 3. Idempotent terminal failure ──────────────────────────────────────────

Deno.test("p0a: repeated terminal failure keeps exactly one dead-letter row", async () => {
  const client = await db();
  const jobId = await enqueueJob(`p0a-idem-${RUN}`);
  try {
    await claimJob(jobId);

    const { error: bumpError } = await client
      .from("job_queue")
      .update({ attempt_count: 5 })
      .eq("id", jobId);
    assertEquals(bumpError, null);

    for (let i = 0; i < 2; i++) {
      const { data, error } = await client.rpc("fail_job_v2", {
        p_job_id: jobId,
        p_worker_id: WORKER_ID,
        p_error: `repeat ${i}`,
      });
      assertEquals(error, null);
      assertEquals(data, true);
    }

    const dlq = await getDlqRow(jobId);
    assertEquals(dlq.length, 1, "ON CONFLICT must deduplicate");
    assertEquals(dlq[0].last_error, "repeat 0");

    const job = await getJob(jobId);
    assertEquals(job.status, "dead");
  } finally {
    await cleanup([jobId]);
  }
});

// ─── 4. Unknown job ──────────────────────────────────────────────────────────

Deno.test("p0a: unknown job id returns FALSE without error", async () => {
  const client = await db();
  const { data, error } = await client.rpc("fail_job_v2", {
    p_job_id: crypto.randomUUID(),
    p_worker_id: WORKER_ID,
    p_error: "no such job",
  });
  assertEquals(error, null);
  assertEquals(data, false);
});

// ─── 5. Privilege boundary ───────────────────────────────────────────────────

Deno.test("p0a: anon cannot execute fail_job_v2 (SQLSTATE 42501)", async () => {
  const status = await getLocalStatus();
  assertExists(status, "local stack required for the privilege probe");

  const { createClient: supabaseCreateClient } = await import(
    "@supabase/supabase-js"
  );
  // Anon-key client: carries the anon JWT, so a rejection here is a
  // database EXECUTE denial, never a JWT-layer 401 (F16-05).
  const anon = supabaseCreateClient(status.API_URL, status.ANON_KEY);

  const { error } = await anon.rpc("fail_job_v2", {
    p_job_id: crypto.randomUUID(),
    p_worker_id: "anon-probe",
    p_error: "must be denied",
  });
  assertExists(error, "anon EXECUTE must fail");
  assertEquals(
    error.code,
    "42501",
    `expected SQLSTATE 42501 (permission denied for function), got ${error.code}: ${error.message}`,
  );
});
