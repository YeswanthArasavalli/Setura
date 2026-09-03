/**
 * run-cron-minute/index.ts
 * Every-minute periodic tasks.
 * Runs <10s.
 */
import { handleCors } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { successResponse } from "../_shared/response.ts";
import { Env } from "../_shared/env.ts";
import {
  evaluateQueueHealth,
  notifyAdminsOfQueueAlerts,
} from "../_shared/queue/queue_runtime.ts";

const ENDPOINT = "run-cron-minute";

function constantTimeEquals(
  provided: string,
  expected: string,
): boolean {
  if (
    provided.length !== expected.length
  ) {
    return false;
  }

  let diff = 0;

  for (
    let i = 0;
    i < provided.length;
    i++
  ) {
    diff |= provided.charCodeAt(i) ^
      expected.charCodeAt(i);
  }

  return diff === 0;
}

Deno.serve(
  async (
    req: Request,
  ): Promise<Response> => {
    const cors = handleCors(req);

    if (cors) {
      return cors;
    }

    if (
      req.method !== "POST"
    ) {
      return new Response(
        "Method Not Allowed",
        {
          status: 405,
        },
      );
    }

    // --------------------------------------------------
    // Cron authentication
    // --------------------------------------------------

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
        {
          status: 403,
        },
      );
    }

    if (
      !constantTimeEquals(
        cronSecret,
        expectedSecret,
      )
    ) {
      return new Response(
        "Forbidden",
        {
          status: 403,
        },
      );
    }

    const trace = createTraceContext(req);

    const logger = createRequestLogger(
      req,
      ENDPOINT,
    ).child({
      correlationId: trace.correlationId,
    });

    const metrics = createMetrics(
      ENDPOINT,
      trace.correlationId,
    );

    const db = getServiceClient();

    const results: Record<
      string,
      unknown
    > = {};

    const errors: Record<
      string,
      string
    > = {};

    try {
      if (
        !Env.SUPABASE_URL
      ) {
        throw new Error(
          "SUPABASE_URL missing",
        );
      }

      // --------------------------------------------------
      // 1. Master SQL scheduler
      // --------------------------------------------------

      try {
        const {
          data,
          error,
        } = await db.rpc(
          "run_scheduled_tasks",
        );

        if (error) {
          throw new Error(
            error.message,
          );
        }

        results.run_scheduled_tasks = data;
      } catch (e) {
        errors.run_scheduled_tasks = e instanceof Error ? e.message : String(e);
      }

      // --------------------------------------------------
      // 1b. WhatsApp crash recovery:
      // reclaim messages stuck in processing
      // --------------------------------------------------

      try {
        const {
          data,
          error,
        } = await db.rpc(
          "reclaim_stale_whatsapp_processing",
          {
            p_stale_minutes: 15,
          },
        );

        if (error) {
          throw new Error(
            error.message,
          );
        }

        if (Number(data ?? 0) > 0) {
          metrics.increment(
            "whatsapp.stale_reclaimed",
          );
        }

        results.whatsapp_stale_recovery = data;
      } catch (e) {
        errors.whatsapp_stale_recovery = e instanceof Error
          ? e.message
          : String(e);
      }

      // --------------------------------------------------
      // 1c. WhatsApp retry sweep:
      // re-enqueue due retrying/queued messages
      // --------------------------------------------------

      try {
        const {
          data: dueMessages,
          error: fetchError,
        } = await db.rpc(
          "fetch_pending_whatsapp_messages",
          {
            p_limit: 25,
          },
        );

        if (fetchError) {
          throw new Error(
            fetchError.message,
          );
        }

        const rows = (dueMessages ?? []) as Array<{
          id: string;
          conversation_id: string;
          hospital_id: string | null;
          related_booking_id: string | null;
          template_name: string | null;
          retry_count: number;
        }>;

        let enqueued = 0;

        if (rows.length > 0) {
          const conversationIds = [
            ...new Set(rows.map((r) => r.conversation_id)),
          ];

          const { data: conversations } = await db
            .from("whatsapp_conversations")
            .select("id, phone_number")
            .in("id", conversationIds);

          const phoneById = new Map(
            ((conversations ?? []) as Array<{
              id: string;
              phone_number: string;
            }>).map((c) => [c.id, c.phone_number]),
          );

          for (const row of rows) {
            const phone = phoneById.get(row.conversation_id);

            if (!phone || !row.template_name) {
              continue;
            }

            const { error: enqueueError } = await db.rpc("enqueue_job", {
              p_job_type: "send_whatsapp_message",
              p_payload: {
                wa_message_id: row.id,
                template_name: row.template_name,
                phone,
                booking_id: row.related_booking_id,
              },
              p_priority: "normal",
              p_scheduled_at: new Date().toISOString(),
              p_idempotency_key: `wa_retry_${row.id}_${row.retry_count}`,
              p_hospital_id: row.hospital_id ?? undefined,
              p_booking_id: row.related_booking_id ?? undefined,
            });

            if (!enqueueError) {
              enqueued++;
            }
          }
        }

        results.whatsapp_retry_sweep = enqueued;
      } catch (e) {
        errors.whatsapp_retry_sweep = e instanceof Error
          ? e.message
          : String(e);
      }

      // --------------------------------------------------
      // 1d. Conversation state expiry (Phase 1.1):
      // sweep stale WhatsApp flow states back to idle
      // --------------------------------------------------

      try {
        const {
          data,
          error,
        } = await db.rpc(
          "expire_conversation_states",
        );

        if (error) {
          throw new Error(
            error.message,
          );
        }

        if (Number(data ?? 0) > 0) {
          metrics.increment(
            "wa.state.expired",
          );
        }

        results.conversation_state_expiry = data;
      } catch (e) {
        errors.conversation_state_expiry = e instanceof Error
          ? e.message
          : String(e);
      }

      // --------------------------------------------------
      // 1e. Queue health evaluation (Phase 1.3):
      // congestion, stall, pause, throughput and SLA
      // breach detection; admin WhatsApp notifications
      // for newly fired alerts
      // --------------------------------------------------

      try {
        const summary = await evaluateQueueHealth(db);

        const notified = await notifyAdminsOfQueueAlerts(
          db,
          summary.new_alerts ?? [],
          logger,
        );

        if (summary.new_alerts.length > 0) {
          metrics.increment("queue.health.alerts");
          metrics.record("queue.health.new_alerts", summary.new_alerts.length);
        }

        results.queue_health = {
          sessions_evaluated: summary.sessions_evaluated,
          new_alerts: summary.new_alerts.length,
          admin_notifications: notified,
        };
      } catch (e) {
        errors.queue_health = e instanceof Error ? e.message : String(e);
      }

      // --------------------------------------------------
      // 2. Reminder queue generation
      // --------------------------------------------------

      try {
        const resp = await fetch(
          `${Env.SUPABASE_URL}/functions/v1/send-reminders`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Cron-Secret": Env.CRON_SECRET,
            },
            body: JSON.stringify(
              {},
            ),
            signal: AbortSignal.timeout(
              8_000,
            ),
          },
        );

        if (!resp.ok) {
          throw new Error(
            `Reminder trigger failed (${resp.status})`,
          );
        }

        results.reminders = "ok";
      } catch (e) {
        errors.reminders = e instanceof Error ? e.message : String(e);
      }

      // --------------------------------------------------
      // 3. Worker wakeup
      // Optional:
      // only enable if worker is not
      // already scheduled elsewhere
      // --------------------------------------------------

      if (
        Env.ENABLE_WORKER_TRIGGER ===
          "true"
      ) {
        try {
          const resp = await fetch(
            `${Env.SUPABASE_URL}/functions/v1/run-background-worker`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Cron-Secret": Env.CRON_SECRET,
              },
              body: JSON.stringify(
                {},
              ),
              signal: AbortSignal.timeout(
                10_000,
              ),
            },
          );

          if (
            !resp.ok
          ) {
            throw new Error(
              `Worker trigger failed (${resp.status})`,
            );
          }

          results.worker = "ok";
        } catch (e) {
          errors.worker = e instanceof Error ? e.message : String(e);
        }
      }

      // --------------------------------------------------
      // 4. Health snapshot
      // Run last so health reflects
      // latest queue state
      // --------------------------------------------------

      try {
        const {
          data,
          error,
        } = await db.rpc(
          "run_health_check",
        );

        if (error) {
          throw new Error(
            error.message,
          );
        }

        results.health_check = data;
      } catch (e) {
        errors.health_check = e instanceof Error ? e.message : String(e);
      }

      const successCount = Object.keys(
        results,
      ).length;

      const errorCount = Object.keys(
        errors,
      ).length;

      if (
        errorCount === 0
      ) {
        metrics.increment(
          "cron.minute.success",
        );
      } else {
        metrics.increment(
          "cron.minute.partial_failure",
        );
      }

      logger.info(
        "Cron-minute completed",
        {
          successCount,
          errorCount,
          durationMs: elapsedMs(
            trace,
          ),
        },
      );

      metrics.record(
        "cron.minute.errors",
        errorCount,
      );

      metrics.timing(
        "cron.minute.duration",
        elapsedMs(trace),
      );

      metrics.flush(
        logger,
      );

      return successResponse(
        {
          results,
          errors,
          successCount,
          failureCount: errorCount,
          durationMs: elapsedMs(
            trace,
          ),
        },
        trace.correlationId,
        req,
      );
    } catch (err) {
      logger.error(
        "run-cron-minute failed",
        err,
        {
          durationMs: elapsedMs(trace),
        },
      );

      metrics.increment(
        "cron.minute.error",
      );

      metrics.flush(
        logger,
      );

      return successResponse(
        {
          results,
          errors: {
            fatal: err instanceof Error ? err.message : String(err),
          },
          successCount: 0,
          failureCount: 1,
          durationMs: elapsedMs(trace),
        },
        trace.correlationId,
        req,
      );
    }
  },
);
