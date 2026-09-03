/**
 * compute-sla/index.ts
 *
 * Computes SLA metrics for a specific hospital and date range.
 * Returns current SLA data and flags any breaches.
 */

import { handleCors } from "../_shared/cors.ts";
import { requireRole, resolveAuth } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { handleErrorResponse, successResponse } from "../_shared/response.ts";
import { ValidationError } from "../_shared/errors.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { DateSchema, parseBody } from "../_shared/validation.ts";

const ENDPOINT = "compute-sla";

const Schema = z.object({
  fromDate: DateSchema.optional(),
  toDate: DateSchema.optional(),
  recompute: z.boolean().default(false),
});

Deno.serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const trace = createTraceContext(req);
  const logger = createRequestLogger(req, ENDPOINT).child({
    correlationId: trace.correlationId,
  });
  const metrics = createMetrics(ENDPOINT, trace.correlationId);

  try {
    const hospitalId = req.headers.get("X-Hospital-ID");
    if (!hospitalId) {
      throw new ValidationError("Missing X-Hospital-ID header", {
        header: ["Required"],
      });
    }

    const auth = await resolveAuth(req, hospitalId, logger);
    requireRole(auth, ["hospital_admin", "global_admin"]);

    const body = await parseBody(req, Schema);
    const db = getServiceClient();
    const today = new Date().toISOString().split("T")[0];
    const fromDate = body.fromDate ??
      new Date(Date.now() - 7 * 86400000)
        .toISOString()
        .split("T")[0];

    const toDate = body.toDate ??
      today;

    const fromDateObj = new Date(fromDate);
    const toDateObj = new Date(toDate);

    if (fromDateObj > toDateObj) {
      throw new ValidationError(
        "Invalid date range",
        {
          fromDate: [
            "Must be before or equal to toDate",
          ],
        },
      );
    }

    const daysDiff = Math.ceil(
      (
        toDateObj.getTime() -
        fromDateObj.getTime()
      ) / 86400000,
    );

    if (daysDiff > 90) {
      throw new ValidationError(
        "Date range too large",
        {
          fromDate: [
            "Maximum SLA window is 90 days",
          ],
        },
      );
    }

    // Recompute if requested
    if (body.recompute) {
      let d = new Date(fromDate);
      const end = new Date(toDate);
      while (d <= end) {
        const ds = d.toISOString().split("T")[0];
        const {
          error: recomputeError,
        } = await db.rpc(
          "compute_sla_tracking",
          {
            p_hospital_id: hospitalId,
            p_date: ds,
          },
        );

        if (recomputeError) {
          throw new ValidationError(
            "SLA recompute failed",
            {
              date: [ds],
              database: [
                recomputeError.message,
              ],
            },
          );
        }
        d = new Date(d.getTime() + 86400000);
      }
    }

    // Load SLA data
    const {
      data: slaData,
      error: slaError,
    } = await db
      .from("sla_daily_tracking")
      .select("*")
      .eq("hospital_id", hospitalId)
      .gte("tracking_date", fromDate)
      .lte("tracking_date", toDate)
      .order("tracking_date", { ascending: false });

    if (slaError) {
      throw new ValidationError(
        "Failed to load SLA data",
        {
          database: [slaError.message],
        },
      );
    }

    const breachedDays = (slaData ?? []).filter(
      (d) => d.sla_wait_breached || d.sla_completion_breached,
    );

    const avgWait = (slaData ?? []).reduce(
      (acc, d) =>
        acc +
        Number(
          d.avg_wait_minutes ?? 0,
        ),
      0,
    ) /
      Math.max(
        (slaData ?? []).length,
        1,
      );

    const avgCompletion = (slaData ?? []).reduce(
      (acc, d) =>
        acc +
        Number(
          d.completion_rate_pct ?? 0,
        ),
      0,
    ) /
      Math.max(
        (slaData ?? []).length,
        1,
      );

    metrics.timing("request.total", elapsedMs(trace));
    metrics.increment(
      breachedDays.length > 0 ? "sla.breached" : "sla.healthy",
    );
    metrics.flush(logger);

    return successResponse(
      {
        hospitalId,
        fromDate,
        toDate,
        summary: {
          totalDays: slaData?.length ?? 0,
          breachedDays: breachedDays.length,
          avgWaitMinutes: Math.round(avgWait * 10) / 10,
          avgCompletionPct: Math.round(avgCompletion * 10) / 10,
          slaHealthy: breachedDays.length === 0,
        },
        dailyData: slaData ?? [],
      },
      trace.correlationId,
      req,
    );
  } catch (err) {
    logger.error("compute-sla failed", err);
    return handleErrorResponse(err, trace.correlationId, req);
  }
});
