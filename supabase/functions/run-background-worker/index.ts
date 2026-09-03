/**
 * run-background-worker/index.ts
 * Multi-type job processor with worker leases, heartbeat, crash recovery.
 * Runs for MAX_RUNTIME_MS then exits cleanly.
 */
import { handleCors } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import {
  claimJobs,
  processJob,
  registerWorker,
  startHeartbeatLoop,
  stopWorker,
} from "../_shared/worker.ts";
import { successResponse } from "../_shared/response.ts";
import { Env } from "../_shared/env.ts";
import type { DbJobQueue } from "../_shared/types.ts";
import type { Logger } from "../_shared/logger.ts";
import { processInboundMessage } from "../_shared/whatsapp/whatsapp_conversation_engine.ts";

const ENDPOINT = "run-background-worker";
const MAX_RUNTIME = 115_000;
const BATCH_SIZE = 5;
const POLL_INTERVAL = 2_000;
const JOB_TYPES = [
  "send_whatsapp_message",
  "process_incoming_whatsapp",
  "send_notification",
  "refresh_analytics",
  "compute_sla",
  "create_partition",
];

async function processSendWhatsapp(
  job: DbJobQueue,
  _logger: Logger,
): Promise<void> {
  const resp = await fetch(
    `${Env.SUPABASE_URL}/functions/v1/send-whatsapp-message`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Worker-Secret": Env.WORKER_SECRET,
      },
      body: JSON.stringify({ ...job.payload, hospital_id: job.hospital_id }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`WhatsApp send failed (${resp.status}): ${text}`);
  }
}

/**
 * Phase 1.1 — routes one inbound WhatsApp message through the
 * conversational engine (intent routing, state machine, flows).
 * Replies are enqueued as send_whatsapp_message jobs; Meta is
 * never called inline here.
 */
async function processIncomingWhatsapp(
  job: DbJobQueue,
  logger: Logger,
): Promise<void> {
  const db = getServiceClient();

  const payload = job.payload as {
    message?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    from?: Record<string, unknown>;
  };

  const msg = payload.message;

  // The webhook enqueues the WABA metadata under `from`; accept
  // `metadata` as well for forward compatibility.
  const waMetadata = payload.metadata ?? payload.from ?? {};

  if (!msg) {
    logger.warn("No message in incoming WA job payload");
    return;
  }

  const metaMessageId = String(msg.id ?? "");
  const from = String(msg.from ?? "");
  const msgType = String(msg.type ?? "text");
  const text = String(
    (msg.text as { body?: string } | undefined)?.body ?? "",
  ).trim();

  if (!from || !metaMessageId) {
    logger.warn("Malformed incoming WA message", { job_id: job.id });
    return;
  }

  if (msgType !== "text" || !text) {
    // Pilot scope: deterministic text handling only.
    logger.info("Skipping non-text incoming WA message", {
      type: msgType,
      metaMessageId,
    });
    return;
  }

  const phone = from.replace(/\D/g, "").slice(-10);

  // Resolve the hospital from the receiving WhatsApp number.
  const phoneNumberId = String(waMetadata.phone_number_id ?? "");
  let hospitalId: string | null = null;

  if (phoneNumberId) {
    const { data } = await db
      .from("hospital_settings")
      .select("hospital_id")
      .eq("meta_phone_number_id", phoneNumberId)
      .maybeSingle();

    hospitalId = (data as { hospital_id: string } | null)?.hospital_id ??
      null;
  }

  if (!hospitalId) {
    // Fallback for pilot deployments with a single active hospital.
    const { data: hospitals } = await db
      .from("hospitals")
      .select("id")
      .eq("is_active", true)
      .limit(2);

    const rows = (hospitals ?? []) as Array<{ id: string }>;
    if (rows.length === 1) hospitalId = rows[0].id;
  }

  if (!hospitalId) {
    logger.warn("Could not resolve hospital for incoming WA message", {
      phoneNumberId,
      metaMessageId,
    });
    return;
  }

  const metrics = createMetrics("process_incoming_whatsapp", job.id);

  const result = await processInboundMessage(
    db,
    { hospitalId, phone, text, metaMessageId },
    logger,
    metrics,
  );

  metrics.flush(logger);

  logger.info("Incoming WA message processed", {
    hospitalId,
    phoneSuffix: phone.slice(-4),
    intent: result.intent,
    state: result.state,
    duplicate: result.duplicate,
    repliesEnqueued: result.repliesEnqueued,
  });
}

async function processRefreshAnalytics(
  _job: DbJobQueue,
  logger: Logger,
): Promise<void> {
  const { error } = await getServiceClient().rpc(
    "refresh_analytics_views_ordered",
  );
  if (error) throw new Error(`Analytics refresh failed: ${error.message}`);
  logger.info("Analytics views refreshed");
}

async function processSendNotification(
  job: DbJobQueue,
  logger: Logger,
): Promise<void> {
  const db = getServiceClient();
  const nId = (job.payload as { notification_id?: string }).notification_id;
  if (!nId) return;
  const { data: notif } = await db.from("notification_queue").select(
    "*",
  ).eq("id", nId).single();
  if (!notif) {
    logger.warn("Notification not found", { id: nId });
    return;
  }
  if ((notif as { channel: string }).channel === "whatsapp") {
    await db.rpc("enqueue_job", {
      p_job_type: "send_whatsapp_message",
      p_payload: {
        phone: (notif as { recipient: string }).recipient,
        template_name:
          (notif as { template_key: string | null }).template_key ??
            "generic_notification",
        ...(notif as { metadata: Record<string, unknown> }).metadata,
      },
      p_priority: "normal",
      p_scheduled_at: new Date().toISOString(),
      p_idempotency_key: `notif_wa_${nId}`,
    });
  }
  await db.from("notification_queue").update({
    status: "sent",
    sent_at: new Date().toISOString(),
  }).eq("id", nId);
}

async function processComputeSla(
  job: DbJobQueue,
  logger: Logger,
): Promise<void> {
  const db = getServiceClient();

  const p = job.payload as {
    hospital_id?: string;
    date?: string;
  };

  const dt = p.date ??
    new Date(
      Date.now() - 86400000,
    )
      .toISOString()
      .split("T")[0];

  if (p.hospital_id) {
    const {
      error,
    } = await db.rpc(
      "compute_sla_tracking",
      {
        p_hospital_id: p.hospital_id,
        p_date: dt,
      },
    );

    if (error) {
      throw new Error(
        error.message,
      );
    }
  } else {
    const {
      data: hospitals,
      error: hospitalError,
    } = await db
      .from("hospitals")
      .select("id")
      .eq(
        "is_active",
        true,
      );

    if (hospitalError) {
      throw new Error(
        hospitalError.message,
      );
    }

    await Promise.allSettled(
      (hospitals ?? []).map(
        (h) =>
          db.rpc(
            "compute_sla_tracking",
            {
              p_hospital_id: (
                h as {
                  id: string;
                }
              ).id,
              p_date: dt,
            },
          ),
      ),
    );
  }

  logger.info(
    "SLA computed",
    {
      date: dt,
    },
  );
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const cronSecret = req.headers.get(
    "X-Cron-Secret",
  );

  const expectedSecret = Env.CRON_SECRET;

  if (
    !cronSecret ||
    !expectedSecret
  ) {
    return new Response(
      "Forbidden",
      { status: 403 },
    );
  }

  if (
    cronSecret.length !==
      expectedSecret.length
  ) {
    return new Response(
      "Forbidden",
      { status: 403 },
    );
  }

  let diff = 0;

  for (
    let i = 0;
    i < cronSecret.length;
    i++
  ) {
    diff |= cronSecret.charCodeAt(i) ^
      expectedSecret.charCodeAt(i);
  }

  if (diff !== 0) {
    return new Response(
      "Forbidden",
      { status: 403 },
    );
  }

  const trace = createTraceContext(req);
  const logger = createRequestLogger(req, ENDPOINT).child({
    correlationId: trace.correlationId,
  });
  const metrics = createMetrics(ENDPOINT, trace.correlationId);
  const workerId = crypto.randomUUID();
  const instanceId = crypto.randomUUID();
  let inFlight = 0;
  let totalOk = 0;
  let totalFail = 0;
  let crashed = false;

  try {
    await registerWorker(
      {
        workerId,
        workerType: "general",
        instanceId,
      },
      logger,
    );
  } catch (err) {
    logger.error(
      "Worker registration failed",
      err,
    );

    throw err;
  }
  const stopHB = startHeartbeatLoop(workerId, () => inFlight, logger);

  try {
    const startMs = performance.now();
    while (performance.now() - startMs < MAX_RUNTIME) {
      let jobs: DbJobQueue[] = [];

      try {
        jobs = await claimJobs(
          workerId,
          JOB_TYPES,
          BATCH_SIZE,
          logger,
        );
      } catch (err) {
        logger.error(
          "Job claim failed",
          err,
        );

        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              POLL_INTERVAL,
            ),
        );

        continue;
      }

      if (jobs.length === 0) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        continue;
      }
      inFlight = jobs.length;

      const results = await Promise.allSettled(
        jobs.map((job) =>
          processJob(job, workerId, {
            process: async (j, jl) => {
              switch (j.job_type) {
                case "send_whatsapp_message":
                  await processSendWhatsapp(j, jl);
                  break;
                case "process_incoming_whatsapp":
                  await processIncomingWhatsapp(j, jl);
                  break;
                case "refresh_analytics":
                  await processRefreshAnalytics(j, jl);
                  break;
                case "send_notification":
                  await processSendNotification(j, jl);
                  break;
                case "compute_sla":
                  await processComputeSla(j, jl);
                  break;
                default:
                  throw new Error(
                    `Unsupported job type: ${j.job_type}`,
                  );
              }
            },
          }, logger)
        ),
      );

      for (const r of results) {
        if (r.status === "fulfilled") {
          r.value === "completed" ? totalOk++ : totalFail++;
        } else totalFail++;
      }
      metrics.record(
        "worker.batch.size",
        jobs.length,
      );

      metrics.record(
        "worker.batch.success",
        results.filter(
          (r) =>
            r.status ===
              "fulfilled",
        ).length,
      );

      metrics.record(
        "worker.batch.failed",
        results.filter(
          (r) =>
            r.status ===
              "rejected",
        ).length,
      );
      inFlight = 0;
    }
    logger.info("Worker run complete", { totalOk, totalFail, workerId });
  } catch (err) {
    crashed = true;

    metrics.increment(
      "worker.run.error",
    );

    logger.error(
      "Worker crashed",
      err,
    );

    throw err;
  } finally {
    stopHB();
    await stopWorker(workerId, crashed, logger);
  }

  metrics.increment(
    "worker.run.success",
  );
  metrics.record("worker.completed", totalOk);
  metrics.record("worker.failed", totalFail);
  metrics.timing("worker.runtime", elapsedMs(trace));
  metrics.flush(logger);
  return successResponse(
    { workerId, totalCompleted: totalOk, totalFailed: totalFail },
    trace.correlationId,
    req,
  );
});
