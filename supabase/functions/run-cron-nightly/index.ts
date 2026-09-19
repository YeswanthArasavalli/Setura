/**
 * run-cron-nightly/index.ts
 *
 * Runs once per night at 23:45 IST (18:15 UTC).
 * Orchestrates all nightly operations in strict dependency order:
 *
 *   1. Carry-forward pending tokens (all hospitals)
 *   2. Ordered MV refresh (daily_stats first, revenue_forecast last)
 *   3. Analytics rollups (weekly, monthly, quarterly, global)
 *   4. SLA tracking (per hospital, previous day)
 *   5. Retention/cleanup (operational data only)
 *   6. Subscription usage sync (gauges + storage, all hospitals)
 *   7. Schedule future partitions (if auto-enabled)
 *   8. Health check snapshot
 *
 * Nightly tasks are SYNCHRONOUS by frozen architecture constraint
 * (P2-09 / drift D-05: "verify run-cron-nightly does NOT wake the
 * worker"). A former Step 9 fetched run-background-worker with a
 * derived credential (P1-07: wrong secret, always 403). Removing the
 * prohibited call resolved the pair — see
 * docs/security/NIGHTLY_SYNCHRONOUS_CONSTRAINT.md.
 *
 * Each step is wrapped in independent try/catch.
 * Partial failure is logged but does not abort subsequent steps.
 * Total runtime budget: 90 seconds (well within 150s Deno Deploy limit).
 */

import { handleCors } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { successResponse } from "../_shared/response.ts";
import { logAuditEvent } from "../_shared/audit.ts";
import { verifyCronRequest } from "../_shared/cron_auth.ts";
import { Env } from "../_shared/env.ts";
import type { Logger } from "../_shared/logger.ts";

const ENDPOINT = "run-cron-nightly";

// ─── Utility: execute SQL function with timeout + error capture ───────────────

async function runStep(
  label: string,
  fn: () => Promise<unknown>,
  logger: Logger,
): Promise<
  {
    label: string;
    ok: boolean;
    result?: unknown;
    error?: string;
    durationMs: number;
  }
> {
  const start = performance.now();
  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - start);
    logger.info(`Nightly step completed: ${label}`, { durationMs });
    return { label, ok: true, result, durationMs };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const error = err instanceof Error ? err.message : String(err);
    logger.error(`Nightly step failed: ${label}`, err, { durationMs });
    return { label, ok: false, error, durationMs };
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Fail-closed cron auth (P0-C: extracted to _shared/cron_auth.ts,
  // unit-proven there). Missing header, unconfigured CRON_SECRET,
  // length mismatch or any byte mismatch are all 403.
  const forbidden = verifyCronRequest(req, Env.CRON_SECRET);
  if (forbidden) return forbidden;

  const trace = createTraceContext(req);
  const logger = createRequestLogger(req, ENDPOINT).child({
    correlationId: trace.correlationId,
  });
  const metrics = createMetrics(ENDPOINT, trace.correlationId);
  const db = getServiceClient();

  logger.info("Nightly cron started", { at: new Date().toISOString() });

  const stepResults: Array<
    ReturnType<typeof runStep> extends Promise<infer R> ? R : never
  > = [];

  // ── Step 1: Carry-forward (all hospitals) ─────────────────────────────────
  stepResults.push(
    await runStep("carry_forward_all_hospitals", async () => {
      const yesterday = new Date(
        Date.now() - 86400000,
      ).toISOString().split("T")[0];

      const today = new Date()
        .toISOString()
        .split("T")[0];

      // The RPC is per-hospital (advisory lock is hospital-scoped),
      // so iterate over all active hospitals.
      const { data: hospitals, error: hospitalsError } = await db
        .from("hospitals")
        .select("id")
        .eq("is_active", true);

      if (hospitalsError) {
        throw new Error(hospitalsError.message);
      }

      let totalCarried = 0;
      for (const hospital of hospitals ?? []) {
        const { data, error } = await db.rpc(
          "carry_forward_pending_tokens",
          {
            p_hospital_id: hospital.id,
            p_from_date: yesterday,
            p_to_date: today,
          },
        );

        if (error) {
          throw new Error(
            error.message,
          );
        }

        totalCarried += data ?? 0;
      }

      return totalCarried;
    }, logger),
  );

  // ── Step 2: Ordered MV refresh ────────────────────────────────────────────
  stepResults.push(
    await runStep("analytics_mv_refresh", async () => {
      const { data, error } = await db.rpc(
        "refresh_analytics_views_ordered",
      );
      if (error) throw new Error(error.message);
      return data;
    }, logger),
  );

  // ── Step 3: Analytics rollups ─────────────────────────────────────────────
  stepResults.push(
    await runStep("analytics_rollups", async () => {
      const yesterday =
        new Date(Date.now() - 86400000).toISOString().split("T")[0];
      const { data, error } = await db.rpc("run_analytics_rollups", {
        p_target_date: yesterday,
      });
      if (error) throw new Error(error.message);
      return data;
    }, logger),
  );

  // ── Step 4: SLA tracking (all hospitals, yesterday) ───────────────────────
  stepResults.push(
    await runStep("sla_tracking", async () => {
      const yesterday = new Date(
        Date.now() - 86400000,
      ).toISOString().split("T")[0];

      const {
        data: hospitals,
        error: hospitalsError,
      } = await db
        .from("hospitals")
        .select("id")
        .eq("is_active", true)
        .is("deleted_at", null);

      if (hospitalsError) {
        throw new Error(
          hospitalsError.message,
        );
      }

      const results = await Promise.allSettled(
        (hospitals ?? []).map(
          (h) =>
            db.rpc(
              "compute_sla_tracking",
              {
                p_hospital_id: h.id,
                p_date: yesterday,
              },
            ),
        ),
      );

      const successCount = results.filter(
        (r) => r.status === "fulfilled",
      ).length;

      return {
        hospitalsProcessed: successCount,
        totalHospitals: hospitals?.length ?? 0,
      };
    }, logger),
  );

  // ── Step 5: Retention cleanup ─────────────────────────────────────────────
  stepResults.push(
    await runStep("retention_cleanup", async () => {
      const { data, error } = await db.rpc(
        "run_retention_cleanup",
      );
      if (error) throw new Error(error.message);
      return data;
    }, logger),
  );

  // ── Step 6: Subscription usage sync (all hospitals) ───────────────────────
  stepResults.push(
    await runStep("subscription_usage_sync", async () => {
      const { data: hospitals, error: hospitalsError } = await db
        .from("hospitals")
        .select("id")
        .eq("is_active", true);

      if (hospitalsError) {
        throw new Error(hospitalsError.message);
      }

      const results = await Promise.allSettled(
        (hospitals ?? []).map((h) =>
          db.rpc("sync_subscription_usage", {
            p_hospital_id: (h as { id: string }).id,
          })
        ),
      );

      return {
        hospitalsSynced: results.filter((r) => r.status === "fulfilled").length,
        totalHospitals: hospitals?.length ?? 0,
      };
    }, logger),
  );

  // ── Step 7: Partition scheduling ──────────────────────────────────────────
  stepResults.push(
    await runStep("partition_scheduling", async () => {
      const { data, error } = await db.rpc(
        "schedule_partition_creation",
      );
      if (error) throw new Error(error.message);
      return data;
    }, logger),
  );

  // ── Step 8: Health check snapshot ────────────────────────────────────────
  stepResults.push(
    await runStep("health_check", async () => {
      const { data, error } = await db.rpc(
        "run_health_check",
      );
      if (error) throw new Error(error.message);
      return data;
    }, logger),
  );

  // ── P0-C (P1-07 + P2-09): the former Step 9 "trigger_worker" fetch
  // to run-background-worker was REMOVED, not repaired. Nightly tasks
  // are synchronous by frozen constraint (ROADMAP I-03, drift D-05);
  // the call was prohibited behavior whose only runtime effect was a
  // permanent 403 from the wrong derived secret (P1-07). Fixing the
  // secret alone would have activated the forbidden wake. Worker
  // wake-up belongs exclusively to the flag-gated minute cron path
  // (run-cron-minute, ENABLE_WORKER_TRIGGER) and the future scheduler
  // decision (NPD-05).

  // ── Audit the nightly run ─────────────────────────────────────────────────
  const failedSteps = stepResults.filter((r) => !r.ok);
  const successRate = (
    (
      stepResults.filter(
        (r) => r.ok,
      ).length /
      stepResults.length
    ) * 100
  ).toFixed(1);
  await logAuditEvent({
    hospitalId: null,
    actorUserId: "system",
    entityType: "cron",
    actionType: "admin_action",
    severity: failedSteps.length === 0
      ? "low"
      : failedSteps.length <= 2
      ? "medium"
      : "high",
    newData: {
      type: "nightly_cron",
      successRate,
      steps: stepResults.length,
      failed: failedSteps.length,
      durationMs: elapsedMs(trace),
      failedSteps: failedSteps.map((s) => s.label),
    },
  }, logger);

  const summary = {
    totalSteps: stepResults.length,
    successSteps: stepResults.filter((r) => r.ok).length,
    failedSteps: failedSteps.length,
    steps: stepResults,
    durationMs: elapsedMs(trace),
  };

  logger.info("Nightly cron completed", {
    success: failedSteps.length === 0,
    durationMs: elapsedMs(trace),
    failedSteps: failedSteps.map((s) => s.label),
  });

  metrics.record(
    "cron.nightly.failed_steps",
    failedSteps.length,
  );

  if (failedSteps.length === 0) {
    metrics.increment(
      "cron.nightly.success",
    );
  } else {
    metrics.increment(
      "cron.nightly.partial_failure",
    );
  }

  metrics.timing(
    "cron.nightly.duration",
    elapsedMs(trace),
  );

  metrics.flush(logger);

  return successResponse(summary, trace.correlationId, req);
});
