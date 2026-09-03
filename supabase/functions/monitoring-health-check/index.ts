/**
 * monitoring-health-check/index.ts
 *
 * Returns a full system health report: queue depth, worker status,
 * DLQ counts, MV freshness, payment health, active alerts.
 * Called by admin dashboards and external monitoring (Uptime Robot, etc.)
 *
 * GET /monitoring-health-check  — returns health summary (no auth for uptime checks)
 * POST /monitoring-health-check — runs full health check + fires alerts (auth required)
 */

import { handleCors } from "../_shared/cors.ts";
import { requireRole, resolveAuth } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { handleErrorResponse, successResponse } from "../_shared/response.ts";

const ENDPOINT = "monitoring-health-check";

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const trace = createTraceContext(req);
  const logger = createRequestLogger(req, ENDPOINT).child({
    correlationId: trace.correlationId,
  });
  const metrics = createMetrics(ENDPOINT, trace.correlationId);
  const db = getServiceClient();

  // ── GET: lightweight uptime check (no auth) ───────────────────────────────
  if (req.method === "GET") {
    try {
      const {
        data: snap,
        error: snapError,
      } = await db
        .from("system_health_snapshots")
        .select(`
          health_score,
          snapshot_at,
          crashed_workers,
          job_queue_pending,
          dlq_unresolved
        `)
        .order("snapshot_at", {
          ascending: false,
        })
        .limit(1)
        .maybeSingle();

      if (snapError) {
        logger.warn(
          "Failed to load health snapshot",
          {
            error: snapError.message,
          },
        );
      }

      const score = (snap as { health_score: number } | null)?.health_score ??
        100;
      const status = score >= 80
        ? "healthy"
        : score >= 50
        ? "degraded"
        : "unhealthy";

      return new Response(
        JSON.stringify({
          status,
          score,
          snapshot_at: (snap as { snapshot_at: string } | null)?.snapshot_at,
          crashed_workers:
            (snap as { crashed_workers: number } | null)?.crashed_workers ?? 0,
          job_queue_pending:
            (snap as { job_queue_pending: number } | null)?.job_queue_pending ??
              0,
        }),
        {
          status: score >= 50 ? 200 : 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (err) {
      logger.error("Health GET failed", err);
      return new Response(
        JSON.stringify({ status: "unknown", error: "DB unavailable" }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // POST requires auth (global admin)
    const auth = await resolveAuth(req, undefined, logger);
    requireRole(auth, ["global_admin"]);

    // ── Run full health check ─────────────────────────────────────────────────
    const timer = metrics.startTimer(
      "health_check.run",
    );

    const {
      data: healthResult,
      error: healthErr,
    } = await db.rpc(
      "run_health_check",
    );

    timer.stop();

    if (healthErr) {
      throw new Error(
        `run_health_check failed: ${healthErr.message}`,
      );
    }

    // ── Load open alerts ──────────────────────────────────────────────────────
    const { data: openAlerts } = await db
      .from("alert_events")
      .select(
        "alert_key, severity, message, current_value, threshold_value, created_at",
      )
      .eq("is_resolved", false)
      .order("severity", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(20);

    // ── Load queue health ─────────────────────────────────────────────────────
    const { data: queueHealth } = await db.rpc(
      "get_queue_health",
    );

    // ── Load worker status ────────────────────────────────────────────────────
    const { data: workers } = await db
      .from("worker_registry")
      .select(
        "worker_id, worker_type, status, last_heartbeat_at, jobs_completed, jobs_failed",
      )
      .order("last_heartbeat_at", { ascending: false })
      .limit(10);

    // ── Load MV freshness ─────────────────────────────────────────────────────
    const { data: mvHealth } = await db.rpc(
      "get_mv_refresh_health",
    );

    // ── Load DLQ summary ──────────────────────────────────────────────────────
    const { data: dlqSummary } = await db.rpc(
      "get_dlq_summary",
    );

    // ── Load partition readiness ──────────────────────────────────────────────
    const { data: partitionStatus } = await db.rpc(
      "check_partition_readiness",
    );

    // ── Load outstanding balances ─────────────────────────────────────────────
    const {
      data: revenueBacklog,
    } = await db
      .from("outstanding_balances")
      .select(`
        hospital_id,
        total_outstanding,
        last_settlement_date
      `)
      .gt("total_outstanding", 0)
      .order(
        "total_outstanding",
        {
          ascending: false,
        },
      )
      .limit(10);

    const report = {
      health: healthResult,
      openAlerts: openAlerts ?? [],
      queueHealth: queueHealth ?? [],
      workers: workers ?? [],
      mvHealth: mvHealth ?? [],
      dlqSummary: dlqSummary ?? [],
      partitions: partitionStatus ?? [],
      revenueBacklog: revenueBacklog ?? [],
      generatedAt: new Date().toISOString(),
      durationMs: elapsedMs(trace),
    };

    logger.info("Health check completed", {
      healthScore: (healthResult as Record<string, unknown>)?.health_score,
      openAlerts: (openAlerts ?? []).length,
      durationMs: elapsedMs(trace),
    });

    metrics.timing("request.total", elapsedMs(trace));
    metrics.increment("health.check.success");
    metrics.flush(logger);

    return successResponse(report, trace.correlationId, req);
  } catch (err) {
    metrics.increment(
      "health.check.error",
    );

    logger.error(
      "monitoring-health-check failed",
      err,
      {
        durationMs: elapsedMs(trace),
      },
    );

    return handleErrorResponse(
      err,
      trace.correlationId,
      req,
    );
  }
});
