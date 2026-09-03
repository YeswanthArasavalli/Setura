/**
 * worker.ts — Worker lease management (integrates with Script 19)
 *
 * Design:
 * - Each Edge Function invocation that runs background jobs registers
 *   as a worker with a unique worker_id.
 * - Workers heartbeat every 10 seconds to renew their lease.
 * - If a worker crashes, its lease expires and jobs are reclaimed.
 * - claim_jobs_v2() registers a lease per job for crash recovery.
 *
 * Concurrency model:
 * - Multiple Edge Function instances can run simultaneously.
 * - FOR UPDATE SKIP LOCKED in claim_jobs_v2() prevents double-processing.
 * - Worker IDs are per-invocation UUIDs — never shared.
 */

import { getServiceClient } from "./db.ts";
import type { DbJobQueue } from "./types.ts";
import type { Logger } from "./logger.ts";

export interface WorkerConfig {
  workerId: string;
  workerType: string;
  instanceId: string;
  leaseDurationSecs?: number;
}

// ─── Worker registration ──────────────────────────────────────────────────────

export async function registerWorker(
  config: WorkerConfig,
  logger: Logger,
): Promise<void> {
  const db = getServiceClient();

  const { error } = await db.rpc("register_worker", {
    p_worker_id: config.workerId,
    p_worker_type: config.workerType,
    p_instance_id: config.instanceId,
    p_lease_duration: config.leaseDurationSecs ?? 30,
  });

  if (error) {
    logger.warn("Failed to register worker (non-fatal)", {
      error: error.message,
    });
  } else {
    logger.info("Worker registered", {
      workerId: config.workerId,
      workerType: config.workerType,
      instanceId: config.instanceId,
    });
  }
}

// ─── Worker heartbeat ─────────────────────────────────────────────────────────

export async function sendWorkerHeartbeat(
  workerId: string,
  jobsInFlight: number,
  logger: Logger,
): Promise<boolean> {
  const db = getServiceClient();

  const { data, error } = await db.rpc("worker_heartbeat", {
    p_worker_id: workerId,
    p_jobs_in_flight: jobsInFlight,
    p_metadata: {},
  });

  if (error) {
    logger.warn("Heartbeat failed", { workerId, error: error.message });
    return false;
  }

  return Boolean(data);
}

// ─── Stop worker ──────────────────────────────────────────────────────────────

export async function stopWorker(
  workerId: string,
  drain: boolean,
  logger: Logger,
): Promise<void> {
  const db = getServiceClient();

  await db.rpc("stop_worker", {
    p_worker_id: workerId,
    p_drain: drain,
  });

  logger.info("Worker stopped", { workerId, drain });
}

// ─── Claim jobs (FOR UPDATE SKIP LOCKED) ─────────────────────────────────────

export async function claimJobs(
  workerId: string,
  jobTypes: string[],
  batchSize: number,
  logger: Logger,
): Promise<DbJobQueue[]> {
  const db = getServiceClient();

  // Use claim_jobs_v2 which registers per-job leases for crash recovery
  const { data, error } = await db.rpc("claim_jobs_v2", {
    p_worker_id: workerId,
    p_job_types: jobTypes,
    p_batch_size: batchSize,
  });

  if (error) {
    logger.error("Failed to claim jobs", error, { workerId, jobTypes });
    return [];
  }

  const jobs = (data as DbJobQueue[]) ?? [];

  if (jobs.length > 0) {
    logger.info("Jobs claimed", {
      workerId,
      count: jobs.length,
      jobTypes: jobs.map((j) => j.job_type),
      jobIds: jobs.map((j) => j.id),
    });
  }

  return jobs;
}

// ─── Complete job ─────────────────────────────────────────────────────────────

export async function completeJob(
  jobId: string,
  workerId: string,
  logger: Logger,
): Promise<void> {
  const db = getServiceClient();

  const { error } = await db.rpc("complete_job_v2", {
    p_job_id: jobId,
    p_worker_id: workerId,
  });

  if (error) {
    logger.error("Failed to complete job", error, { jobId, workerId });
  } else {
    logger.debug("Job completed", { jobId, workerId });
  }
}

// ─── Fail job ─────────────────────────────────────────────────────────────────

export async function failJob(
  jobId: string,
  workerId: string,
  errorMessage: string,
  logger: Logger,
): Promise<void> {
  const db = getServiceClient();

  const { error } = await db.rpc("fail_job_v2", {
    p_job_id: jobId,
    p_worker_id: workerId,
    p_error: errorMessage,
  });

  if (error) {
    logger.error("Failed to fail job", error, {
      jobId,
      workerId,
      errorMessage,
    });
  } else {
    logger.warn("Job failed", { jobId, workerId, errorMessage });
  }
}

// ─── Heartbeat loop ───────────────────────────────────────────────────────────

/**
 * Starts a periodic heartbeat that runs every intervalMs milliseconds.
 * Returns a cleanup function — call it when the worker is done processing.
 *
 * Usage:
 *   const stopHeartbeat = startHeartbeatLoop(workerId, () => jobsInFlight, logger);
 *   // ... process jobs ...
 *   stopHeartbeat();
 */
export function startHeartbeatLoop(
  workerId: string,
  getJobsInFlight: () => number,
  logger: Logger,
  intervalMs = 10_000,
): () => void {
  let active = true;

  const loop = async () => {
    while (active) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (!active) break;
      await sendWorkerHeartbeat(workerId, getJobsInFlight(), logger);
    }
  };

  // Start the loop without awaiting
  loop().catch((err) => {
    logger.error("Heartbeat loop crashed", err, { workerId });
  });

  return () => {
    active = false;
  };
}

// ─── Process job with retry safety ───────────────────────────────────────────

export interface JobProcessor {
  process: (job: DbJobQueue, logger: Logger) => Promise<void>;
  shouldRetry?: (err: unknown) => boolean;
}

/**
 * Processes a single job with complete error handling:
 * - Calls process()
 * - On success: calls completeJob()
 * - On failure: calls failJob() (which handles backoff + dead-letter internally)
 */
export async function processJob(
  job: DbJobQueue,
  workerId: string,
  processor: JobProcessor,
  logger: Logger,
): Promise<"completed" | "failed"> {
  const jobLogger = logger.child({
    jobId: job.id,
    jobType: job.job_type,
    attempt: job.attempt_count,
    workerId,
  });

  const timer = jobLogger.timer(`job.${job.job_type}`);

  try {
    await processor.process(job, jobLogger);
    await completeJob(job.id, workerId, jobLogger);
    timer.end();
    return "completed";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jobLogger.error("Job processing failed", err);
    await failJob(job.id, workerId, message, jobLogger);
    return "failed";
  }
}
