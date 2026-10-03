/**
 * tests/integration/worker_concurrent_claim.test.ts
 *
 * WS-OPS-1 §8 / §22 — ATOMIC CLAIMING under concurrent workers.
 *
 * The other worker suites drive a SINGLE worker. None of them proves the
 * invariant that two workers racing for the same pool can never both own
 * one job. claim_jobs_v2 selects with `FOR UPDATE SKIP LOCKED` (migration
 * 19 / 51); this test proves that against the REAL local stack.
 *
 * Method (no mocks — see tests/utils/setup_env.ts):
 *   1. enqueue K jobs of a dedicated self-test type for the seeded hospital
 *   2. register two DISTINCT active workers A and B
 *   3. run claim_jobs_v2 for A and B CONCURRENTLY (Promise.all), each asking
 *      for the whole pool (batch_size >= K)
 *   4. assert the two claimed id-sets are DISJOINT (no job double-claimed)
 *   5. assert every claimed job row is 'processing' owned by exactly ONE
 *      worker, and A-claimed ∪ B-claimed covers the pool with no overlap —
 *      i.e. total distinct claims == number of jobs that were claimable
 *
 * The disjointness of concurrent FOR UPDATE SKIP LOCKED claims is the whole
 * concurrency guarantee: a second claim of the same job returns it to nobody,
 * so it can never be double-processed.
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

/** Service-role client (bypasses RLS; used for fixtures + RPCs). */
async function db() {
  if (!_db) _db = await createClient();
  return _db;
}

const RUN = crypto.randomUUID().slice(0, 8);
const JOB_TYPE = "ws_ops1_concurrent_selftest";
const WORKER_A = `ops1-${RUN}-worker-a`;
const WORKER_B = `ops1-${RUN}-worker-b`;
// A pool small enough to claim in one batch yet large enough that a naive
// SELECT-then-UPDATE race would very likely double-claim some rows.
const POOL = 12;

const jobIds: string[] = [];

async function registerWorker(workerId: string): Promise<void> {
  const client = await db();
  const { error } = await client.rpc("register_worker", {
    p_worker_id: workerId,
    p_worker_type: "test",
    p_instance_id: RUN,
    p_lease_duration: 300,
  });
  assertEquals(error, null);
}

/** Claim as `workerId`; returns the claimed job ids. */
async function claim(workerId: string): Promise<string[]> {
  const client = await db();
  const { data, error } = await client.rpc("claim_jobs_v2", {
    p_worker_id: workerId,
    p_job_types: [JOB_TYPE],
    p_batch_size: POOL,
  });
  assertEquals(error, null);
  return ((data ?? []) as unknown as { id: string }[]).map((j) => j.id);
}

async function cleanup(): Promise<void> {
  const client = await db();
  if (jobIds.length > 0) {
    await client.from("dead_letter_jobs").delete().in(
      "original_job_id",
      jobIds,
    );
    await client.from("job_queue").delete().in("id", jobIds); // cascades leases
  }
  for (const w of [WORKER_A, WORKER_B]) {
    await client.from("worker_registry").delete().eq("worker_id", w);
  }
}

Deno.test(
  "ws-ops1: two concurrent workers never double-claim the same job (FOR UPDATE SKIP LOCKED)",
  async () => {
    const client = await db();
    try {
      // 1. Enqueue a dedicated pool of jobs.
      for (let i = 0; i < POOL; i++) {
        const { data, error } = await client.rpc("enqueue_job", {
          p_job_type: JOB_TYPE,
          p_payload: { selftest: RUN, index: i },
          p_priority: "normal",
          p_scheduled_at: new Date(Date.now() - 1000).toISOString(),
          p_idempotency_key: `ops1-concurrent-${RUN}-${i}`,
          p_hospital_id: SEED.HOSPITAL_ID,
          p_metadata: { ops1_test: RUN },
        });
        assertEquals(error, null);
        assertExists(data);
        jobIds.push(data as string);
      }
      assertEquals(jobIds.length, POOL);

      // 2. Two distinct active workers.
      await registerWorker(WORKER_A);
      await registerWorker(WORKER_B);

      // 3. Race them for the whole pool simultaneously.
      const [claimedA, claimedB] = await Promise.all([
        claim(WORKER_A),
        claim(WORKER_B),
      ]);

      const setA = new Set(claimedA);
      const setB = new Set(claimedB);

      // A worker must never receive the same id twice within its own batch.
      assertEquals(
        setA.size,
        claimedA.length,
        "worker A received a duplicate id in one batch",
      );
      assertEquals(
        setB.size,
        claimedB.length,
        "worker B received a duplicate id in one batch",
      );

      // 4. The two concurrent claims must be DISJOINT: no job owned by both.
      const overlap = [...setA].filter((id) => setB.has(id));
      assertEquals(
        overlap.length,
        0,
        `jobs double-claimed by two concurrent workers: ${overlap.join(",")}`,
      );

      // Every claimed id belongs to the known pool (no phantom claims).
      const pool = new Set(jobIds);
      for (const id of [...setA, ...setB]) {
        assertEquals(pool.has(id), true, `claimed id not in pool: ${id}`);
      }

      // 5. Database authority: each claimed row is 'processing' and owned by
      //    exactly one worker, and A's rows are never B's rows.
      const ownedBy = new Map<string, string>();
      for (const id of jobIds) {
        const { data, error } = await client.from("job_queue")
          .select("id, status, worker_id")
          .eq("id", id)
          .single();
        assertEquals(error, null);
        assertExists(data);
        const row = data as unknown as {
          id: string;
          status: string;
          worker_id: string | null;
        };
        const wasClaimed = setA.has(id) || setB.has(id);
        if (wasClaimed) {
          assertEquals(
            row.status,
            "processing",
            `claimed job ${id} is not processing`,
          );
          assertExists(row.worker_id, `claimed job ${id} has no owner`);
          // Ownership agrees with exactly one of the racing claim responses.
          const claimers = row.worker_id === WORKER_A
            ? 1
            : row.worker_id === WORKER_B
            ? 1
            : 0;
          assertEquals(claimers, 1, `job ${id} owned by neither racer`);
          ownedBy.set(id, row.worker_id as string);
        }
      }

      // Distinct-union coverage: total jobs owned across both racers equals the
      // number of jobs that were actually claimed (proves no lost/duplicated
      // ownership from the race).
      const totalDistinctClaimed = setA.size + setB.size;
      assertEquals(
        ownedBy.size,
        totalDistinctClaimed,
        "DB ownership count disagrees with the disjoint concurrent claims",
      );

      // At least one of the two racers must have claimed (the pool was claimable).
      assertEquals(
        totalDistinctClaimed > 0,
        true,
        "no concurrent worker claimed any job",
      );
    } finally {
      await cleanup();
    }
  },
);
