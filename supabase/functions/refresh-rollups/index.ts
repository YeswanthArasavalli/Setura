/**
 * refresh-rollups/index.ts
 *
 * Manually triggers analytics rollup computation for a hospital or globally.
 * Normally called by run-cron-nightly, but can be triggered on-demand by admin.
 *
 * Flow:
 *   1. Auth + role validation
 *   2. Hospital ownership validation
 *   3. Target date validation
 *   4. Refresh materialized views (optional)
 *   5. Run analytics rollups
 *   6. Run SLA computation
 *   7. Return execution summary
 */

import { handleCors } from "../_shared/cors.ts";
import { requireRole, resolveAuth } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { handleErrorResponse, successResponse } from "../_shared/response.ts";
import { InternalError, ValidationError } from "../_shared/errors.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { DateSchema, parseBody } from "../_shared/validation.ts";

const ENDPOINT = "refresh-rollups";

const Schema = z.object({
  targetDate: DateSchema.optional(),
  hospitalId: z.string().uuid().optional(),
  refreshMvs: z.boolean().default(true),
});

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response(
      "Method Not Allowed",
      { status: 405 },
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

  try {
    const hospitalId = req.headers.get(
      "X-Hospital-ID",
    );

    const auth = await resolveAuth(
      req,
      hospitalId ?? undefined,
      logger,
    );

    requireRole(auth, [
      "hospital_admin",
      "global_admin",
    ]);

    const body = await parseBody(
      req,
      Schema,
    );

    // --------------------------------------------------
    // Hospital isolation
    // --------------------------------------------------

    if (
      auth.role ===
        "hospital_admin"
    ) {
      const targetHospitalId = body.hospitalId ??
        hospitalId;

      if (
        !targetHospitalId ||
        targetHospitalId !==
          hospitalId
      ) {
        throw new ValidationError(
          "Hospital admins may only refresh their own hospital",
          {
            hospitalId: [
              "Cross-hospital refresh denied",
            ],
          },
        );
      }
    }

    const db = getServiceClient();

    const targetDate = body.targetDate ??
      new Date(
        Date.now() -
          86400000,
      )
        .toISOString()
        .split("T")[0];

    const targetDateObj = new Date(
      targetDate,
    );

    const today = new Date();

    const diffDays = Math.abs(
      (
        today.getTime() -
        targetDateObj.getTime()
      ) / 86400000,
    );

    if (
      diffDays > 365
    ) {
      throw new ValidationError(
        "Target date too old",
        {
          targetDate: [
            "Maximum rollup window is 365 days",
          ],
        },
      );
    }

    const results: Record<
      string,
      unknown
    > = {};

    // --------------------------------------------------
    // Refresh MVs
    // --------------------------------------------------

    if (
      body.refreshMvs
    ) {
      const mvTimer = metrics.startTimer(
        "mv.refresh",
      );

      const {
        data: mvResult,
        error: mvErr,
      } = await db.rpc(
        "refresh_analytics_views_ordered",
      );

      mvTimer.stop();

      if (mvErr) {
        logger.warn(
          "MV refresh failed (non-fatal)",
          {
            error: mvErr.message,
          },
        );

        results.mvRefresh = {
          ok: false,
          error: mvErr.message,
        };
      } else {
        results.mvRefresh = {
          ok: true,
          result: mvResult,
        };
      }
    }

    // --------------------------------------------------
    // Analytics Rollups
    // --------------------------------------------------

    const rollupTimer = metrics.startTimer(
      "rollups.compute",
    );

    const {
      data: rollupResult,
      error: rollupErr,
    } = await db.rpc(
      "run_analytics_rollups",
      {
        p_target_date: targetDate,
      },
    );

    rollupTimer.stop();

    if (
      rollupErr
    ) {
      logger.error(
        "Rollup computation failed",
        {
          targetDate,
          error: rollupErr.message,
        },
      );

      throw new InternalError(
        "Rollup computation failed",
        {
          error: rollupErr.message,
        },
      );
    }

    results.rollups = rollupResult;

    // --------------------------------------------------
    // SLA Recompute
    // --------------------------------------------------

    if (
      body.hospitalId ||
      hospitalId
    ) {
      const hid = body.hospitalId ??
        hospitalId!;

      const {
        error: slaErr,
      } = await db.rpc(
        "compute_sla_tracking",
        {
          p_hospital_id: hid,
          p_date: targetDate,
        },
      );

      results.sla = slaErr
        ? {
          ok: false,
          error: slaErr.message,
        }
        : {
          ok: true,
        };
    }

    logger.info(
      "Rollups refreshed",
      {
        targetDate,
        results,
      },
    );

    metrics.increment(
      "rollups.refresh.success",
    );

    metrics.timing(
      "request.total",
      elapsedMs(trace),
    );

    metrics.flush(
      logger,
    );

    return successResponse(
      {
        targetDate,
        results,
      },
      trace.correlationId,
      req,
    );
  } catch (err) {
    metrics.increment(
      "rollups.refresh.error",
    );

    logger.error(
      "refresh-rollups failed",
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
