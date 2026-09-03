/**
 * financial-command-center/index.ts
 *
 * Phase 1.5 — Financial Command Center API.
 *
 * Actions:
 *   overview       daily collections (fee split, refunds, net,
 *                  payment method split), settlement intelligence
 *                  (aging buckets, velocity), reconciliation status
 *   forecast       deterministic revenue forecasting (prorated MTD)
 *   reconciliation collections -> ledger reconciliation summary
 *
 * All numbers come from the SQL financial layer (daily collection
 * entries, payment refunds, hospital settlements, outstanding
 * balances). Nothing is recomputed at the edge, and every figure
 * traces back to the immutable financial ledger. Read-only: no
 * audit entries.
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
import { parseBody } from "../_shared/validation.ts";

const ENDPOINT = "financial-command-center";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const FINANCE_ACTIONS = [
  "overview",
  "forecast",
  "reconciliation",
] as const;

type FinanceAction = typeof FINANCE_ACTIONS[number];

const Schema = z.object({
  action: z.enum(FINANCE_ACTIONS),

  date: z.string().regex(DATE_RE).optional(),

  fromDate: z.string().regex(DATE_RE).optional(),

  toDate: z.string().regex(DATE_RE).optional(),
});

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

  let action: FinanceAction | undefined;

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

    const db = getServiceClient();

    /**
     * Financial overview: daily collections + settlement
     * intelligence + reconciliation for the target date.
     */
    if (body.action === "overview") {
      const { data: financial, error } = await db.rpc(
        "get_financial_command_center",
        {
          p_hospital_id: hospitalId,
          ...(body.date ? { p_date: body.date } : {}),
        },
      );

      if (error) {
        throw new InternalError("Financial overview failed", {
          error: error.message,
        });
      }

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "overview", financial },
        trace.correlationId,
        req,
      );
    }

    /**
     * Revenue forecasting: deterministic proration of month-to-date
     * figures plus refund-rate and 7-day collection projections.
     */
    if (body.action === "forecast") {
      const { data: forecast, error } = await db.rpc(
        "get_revenue_forecast",
        {
          p_hospital_id: hospitalId,
          ...(body.date ? { p_date: body.date } : {}),
        },
      );

      if (error) {
        throw new InternalError("Revenue forecast failed", {
          error: error.message,
        });
      }

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "forecast", forecast },
        trace.correlationId,
        req,
      );
    }

    /**
     * Reconciliation: collections -> ledger traceability over a
     * range (defaults to the trailing 30 days).
     */
    const toDate = body.toDate ?? new Date().toISOString().slice(0, 10);

    const fromDate = body.fromDate ??
      new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);

    const { data: reconciliation, error } = await db.rpc(
      "get_reconciliation_summary",
      {
        p_hospital_id: hospitalId,
        p_from_date: fromDate,
        p_to_date: toDate,
      },
    );

    if (error) {
      throw new InternalError("Reconciliation summary failed", {
        error: error.message,
      });
    }

    metrics.timing("request.total", elapsedMs(trace));
    metrics.flush(logger);

    return successResponse(
      { action: "reconciliation", reconciliation },
      trace.correlationId,
      req,
    );
  } catch (err) {
    metrics.increment("financial_command_center.error");

    logger.error("financial-command-center failed", err, {
      action,
      durationMs: elapsedMs(trace),
    });

    return handleErrorResponse(err, trace.correlationId, req);
  }
});
