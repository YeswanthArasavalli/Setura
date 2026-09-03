/**
 * executive-analytics/index.ts
 *
 * Phase 1.5 — Executive Dashboard APIs.
 *
 * Actions:
 *   daily_operations    daily operations dashboard (hourly trend,
 *                       rates, doctor throughput, SLA)
 *   weekly_operations   weekly rollup + incidents + productivity
 *   monthly_executive   monthly rollup + SLA trend + settlements
 *   doctor_performance  individual doctor metrics over a range
 *   doctor_rankings     comparative rankings + utilization heatmap
 *   portfolio           all-hospitals portfolio dashboard
 *   benchmarks          cross-hospital benchmarks
 *
 * Every action is a pass-through to the SQL analytics layer —
 * nothing is recomputed at the edge. `portfolio` and `benchmarks`
 * expose cross-tenant data and are restricted to global admins.
 * Read-only: no audit entries (consistent with the doctor
 * dashboard precedent).
 */

import { handleCors } from "../_shared/cors.ts";
import { requireRole, resolveAuth } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { handleErrorResponse, successResponse } from "../_shared/response.ts";
import {
  ForbiddenError,
  InternalError,
  ValidationError,
} from "../_shared/errors.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { parseBody } from "../_shared/validation.ts";

const ENDPOINT = "executive-analytics";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ANALYTICS_ACTIONS = [
  "daily_operations",
  "weekly_operations",
  "monthly_executive",
  "doctor_performance",
  "doctor_rankings",
  "portfolio",
  "benchmarks",
] as const;

type AnalyticsAction = typeof ANALYTICS_ACTIONS[number];

/** Cross-tenant actions: global admins only. */
const GLOBAL_ACTIONS = new Set<AnalyticsAction>(["portfolio", "benchmarks"]);

const Schema = z.object({
  action: z.enum(ANALYTICS_ACTIONS),

  date: z.string().regex(DATE_RE).optional(),

  weekStart: z.string().regex(DATE_RE).optional(),

  monthStart: z.string().regex(DATE_RE).optional(),

  fromDate: z.string().regex(DATE_RE).optional(),

  toDate: z.string().regex(DATE_RE).optional(),

  doctorId: z.string().uuid().optional(),
}).refine(
  (v) => v.action !== "doctor_performance" || typeof v.doctorId === "string",
  {
    message: "doctorId is required for doctor_performance",
    path: ["doctorId"],
  },
);

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const trace = createTraceContext(req);

  const logger = createRequestLogger(req, ENDPOINT).child({
    correlationId: trace.correlationId,
  });

  const metrics = createMetrics(ENDPOINT, trace.correlationId);

  let action: AnalyticsAction | undefined;

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

    action = body.action;

    if (GLOBAL_ACTIONS.has(body.action) && auth.role !== "global_admin") {
      throw new ForbiddenError(
        "Portfolio analytics require global admin access",
      );
    }

    const db = getServiceClient();

    /**
     * Daily operations dashboard.
     */
    if (body.action === "daily_operations") {
      const { data: dashboard, error } = await db.rpc(
        "get_daily_operations_dashboard",
        {
          p_hospital_id: hospitalId,
          ...(body.date ? { p_date: body.date } : {}),
        },
      );

      if (error) {
        throw new InternalError("Daily dashboard failed", {
          error: error.message,
        });
      }

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "daily_operations", dashboard },
        trace.correlationId,
        req,
      );
    }

    /**
     * Weekly operations dashboard.
     */
    if (body.action === "weekly_operations") {
      const { data: dashboard, error } = await db.rpc(
        "get_weekly_dashboard",
        {
          p_hospital_id: hospitalId,
          ...(body.weekStart ? { p_week_start: body.weekStart } : {}),
        },
      );

      if (error) {
        throw new InternalError("Weekly dashboard failed", {
          error: error.message,
        });
      }

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "weekly_operations", dashboard },
        trace.correlationId,
        req,
      );
    }

    /**
     * Monthly executive dashboard.
     */
    if (body.action === "monthly_executive") {
      const { data: dashboard, error } = await db.rpc(
        "get_monthly_dashboard",
        {
          p_hospital_id: hospitalId,
          ...(body.monthStart ? { p_month_start: body.monthStart } : {}),
        },
      );

      if (error) {
        throw new InternalError("Monthly dashboard failed", {
          error: error.message,
        });
      }

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "monthly_executive", dashboard },
        trace.correlationId,
        req,
      );
    }

    /**
     * Individual doctor performance intelligence.
     */
    if (body.action === "doctor_performance") {
      const { data: performance, error } = await db.rpc(
        "get_doctor_performance",
        {
          p_doctor_id: body.doctorId!,
          p_hospital_id: hospitalId,
          ...(body.fromDate ? { p_from_date: body.fromDate } : {}),
          ...(body.toDate ? { p_to_date: body.toDate } : {}),
        },
      );

      if (error) {
        throw new InternalError("Doctor performance failed", {
          error: error.message,
        });
      }

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "doctor_performance", performance },
        trace.correlationId,
        req,
      );
    }

    /**
     * Comparative doctor rankings and utilization heatmap.
     */
    if (body.action === "doctor_rankings") {
      const { data: rankings, error } = await db.rpc(
        "get_doctor_rankings",
        {
          p_hospital_id: hospitalId,
          ...(body.fromDate ? { p_from_date: body.fromDate } : {}),
          ...(body.toDate ? { p_to_date: body.toDate } : {}),
        },
      );

      if (error) {
        throw new InternalError("Doctor rankings failed", {
          error: error.message,
        });
      }

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "doctor_rankings", rankings },
        trace.correlationId,
        req,
      );
    }

    /**
     * Multi-hospital portfolio dashboard (global admins only).
     */
    if (body.action === "portfolio") {
      const { data: portfolio, error } = await db.rpc(
        "get_portfolio_dashboard",
        {
          ...(body.date ? { p_date: body.date } : {}),
        },
      );

      if (error) {
        throw new InternalError("Portfolio dashboard failed", {
          error: error.message,
        });
      }

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "portfolio", portfolio },
        trace.correlationId,
        req,
      );
    }

    /**
     * Cross-hospital benchmarks (global admins only).
     */
    const { data: benchmarks, error } = await db.rpc(
      "get_cross_hospital_benchmarks",
      {
        ...(body.fromDate ? { p_from_date: body.fromDate } : {}),
        ...(body.toDate ? { p_to_date: body.toDate } : {}),
      },
    );

    if (error) {
      throw new InternalError("Benchmarks failed", {
        error: error.message,
      });
    }

    metrics.timing("request.total", elapsedMs(trace));
    metrics.flush(logger);

    return successResponse(
      { action: "benchmarks", benchmarks },
      trace.correlationId,
      req,
    );
  } catch (err) {
    metrics.increment("executive_analytics.error");

    logger.error("executive-analytics failed", err, {
      action,
      durationMs: elapsedMs(trace),
    });

    return handleErrorResponse(err, trace.correlationId, req);
  }
});
