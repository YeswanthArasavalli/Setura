/**
 * enterprise-reports/index.ts
 *
 * Phase 1.5 — Executive Reporting Engine + Governance & Compliance.
 *
 * Actions:
 *   generate                  executive report (8 types) in json,
 *                             csv, or pdf_ready format
 *   audit_search              executive audit search with filters and
 *                             correlation tracing
 *   audit_integrity           audit referential integrity check
 *   settlement_integrity      settlement vs items reconciliation
 *   queue_integrity           queue session invariant check
 *   doctor_ops_integrity      doctor-day timestamp consistency
 *   integration_matrix        booking -> collection -> ledger chain
 *
 * Report payloads are produced by generate_executive_report (SQL);
 * the edge layer only renders csv/pdf_ready via reporting.ts.
 * Generation is audited as executive_report; compliance checks as
 * compliance_check. Every audit entry carries the correlation id so
 * executive correlation tracing works end to end.
 */

import { handleCors } from "../_shared/cors.ts";
import { requireRole, resolveAuth } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { logAuditEvent } from "../_shared/audit.ts";
import { handleErrorResponse, successResponse } from "../_shared/response.ts";
import { InternalError, ValidationError } from "../_shared/errors.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { parseBody } from "../_shared/validation.ts";
import { reportToCsv, reportToPdfReady } from "../_shared/reporting.ts";

const ENDPOINT = "enterprise-reports";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const REPORT_TYPES = [
  "daily_hospital",
  "weekly_operations",
  "monthly_executive",
  "doctor_performance",
  "financial",
  "settlement",
  "sla",
  "audit",
] as const;

const REPORT_ACTIONS = [
  "generate",
  "audit_search",
  "audit_integrity",
  "settlement_integrity",
  "queue_integrity",
  "doctor_ops_integrity",
  "integration_matrix",
] as const;

type ReportAction = typeof REPORT_ACTIONS[number];

const Schema = z.object({
  action: z.enum(REPORT_ACTIONS),

  // generate
  reportType: z.enum(REPORT_TYPES).optional(),
  format: z.enum(["json", "csv", "pdf_ready"]).optional(),
  fromDate: z.string().regex(DATE_RE).optional(),
  toDate: z.string().regex(DATE_RE).optional(),

  // audit_search
  actorId: z.string().uuid().optional(),
  entityType: z.string().max(64).optional(),
  actionType: z.string().max(64).optional(),
  fromTs: z.string().datetime().optional(),
  toTs: z.string().datetime().optional(),
  correlationId: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(1000).optional(),

  // integrity targets
  queueSessionId: z.string().uuid().optional(),
  doctorId: z.string().uuid().optional(),
  date: z.string().regex(DATE_RE).optional(),
}).refine(
  (v) => v.action !== "generate" || typeof v.reportType === "string",
  {
    message: "reportType is required for generate",
    path: ["reportType"],
  },
).refine(
  (v) => v.action !== "queue_integrity" || typeof v.queueSessionId === "string",
  {
    message: "queueSessionId is required for queue_integrity",
    path: ["queueSessionId"],
  },
).refine(
  (v) => v.action !== "doctor_ops_integrity" || typeof v.doctorId === "string",
  {
    message: "doctorId is required for doctor_ops_integrity",
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

  let action: ReportAction | undefined;

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
     * Generate: dispatch to the SQL reporting engine, then render
     * the requested format. Audited as executive_report.
     */
    if (body.action === "generate") {
      const { data: report, error } = await db.rpc(
        "generate_executive_report",
        {
          p_report_type: body.reportType!,
          p_hospital_id: hospitalId,
          ...(body.fromDate ? { p_from_date: body.fromDate } : {}),
          ...(body.toDate ? { p_to_date: body.toDate } : {}),
        },
      );

      if (error) {
        throw new InternalError("Report generation failed", {
          error: error.message,
        });
      }

      const payload = (report ?? {}) as Record<string, unknown>;

      if (payload.ok === false) {
        throw new ValidationError("Report rejected", {
          reportType: [String(payload.reason ?? "unknown")],
        });
      }

      await logAuditEvent(
        {
          hospitalId,
          actorUserId: auth.userId,
          entityType: "executive_report",
          // No entityId: a report type is not a row identifier, and
          // audit_logs.entity_id is a UUID column. It is carried in
          // newData.reportType instead.
          actionType: "executive_report",
          severity: "low",
          oldData: null,
          newData: {
            reportType: body.reportType,
            format: body.format ?? "json",
            fromDate: body.fromDate ?? null,
            toDate: body.toDate ?? null,
          },
        },
        logger,
        metrics,
      );

      metrics.increment("enterprise_reports.generate");
      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      const format = body.format ?? "json";

      if (format === "csv") {
        return successResponse(
          { action: "generate", format, csv: reportToCsv(payload) },
          trace.correlationId,
          req,
          { contentType: "text/csv" },
        );
      }

      if (format === "pdf_ready") {
        return successResponse(
          { action: "generate", format, pdf: reportToPdfReady(payload) },
          trace.correlationId,
          req,
        );
      }

      return successResponse(
        { action: "generate", format, report: payload },
        trace.correlationId,
        req,
      );
    }

    /**
     * Audit search: executive search with correlation tracing. The
     * search itself is audited so audit access is accountable.
     */
    if (body.action === "audit_search") {
      const { data: results, error } = await db.rpc("search_audit_logs", {
        p_hospital_id: hospitalId,
        ...(body.actorId ? { p_actor_id: body.actorId } : {}),
        ...(body.entityType ? { p_entity_type: body.entityType } : {}),
        ...(body.actionType ? { p_action_type: body.actionType } : {}),
        ...(body.fromTs ? { p_from_ts: body.fromTs } : {}),
        ...(body.toTs ? { p_to_ts: body.toTs } : {}),
        ...(body.correlationId ? { p_correlation_id: body.correlationId } : {}),
        ...(body.limit ? { p_limit: body.limit } : {}),
      });

      if (error) {
        throw new InternalError("Audit search failed", {
          error: error.message,
        });
      }

      await logAuditEvent(
        {
          hospitalId,
          actorUserId: auth.userId,
          entityType: "audit_logs",
          actionType: "compliance_check",
          severity: "low",
          oldData: null,
          newData: {
            check: "audit_search",
            filters: {
              actorId: body.actorId ?? null,
              entityType: body.entityType ?? null,
              actionType: body.actionType ?? null,
              correlationId: body.correlationId ?? null,
            },
          },
        },
        logger,
      );

      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        { action: "audit_search", results },
        trace.correlationId,
        req,
      );
    }

    /**
     * Compliance checks: integrity verification RPCs. Each check is
     * audited as compliance_check with its outcome.
     */
    let checkResult: unknown;
    let checkName: string;

    if (body.action === "audit_integrity") {
      checkName = "audit_integrity";

      const { data, error } = await db.rpc("verify_audit_integrity", {
        p_hospital_id: hospitalId,
        ...(body.fromTs ? { p_from_ts: body.fromTs } : {}),
      });

      if (error) {
        throw new InternalError("Audit integrity check failed", {
          error: error.message,
        });
      }

      checkResult = data;
    } else if (body.action === "settlement_integrity") {
      checkName = "settlement_integrity";

      const { data, error } = await db.rpc("verify_settlement_integrity", {
        p_hospital_id: hospitalId,
      });

      if (error) {
        throw new InternalError("Settlement integrity check failed", {
          error: error.message,
        });
      }

      checkResult = data;
    } else if (body.action === "queue_integrity") {
      checkName = "queue_integrity";

      const { data, error } = await db.rpc("verify_queue_integrity", {
        p_queue_session_id: body.queueSessionId!,
      });

      if (error) {
        throw new InternalError("Queue integrity check failed", {
          error: error.message,
        });
      }

      checkResult = data;
    } else if (body.action === "doctor_ops_integrity") {
      checkName = "doctor_ops_integrity";

      const { data, error } = await db.rpc(
        "verify_doctor_operations_integrity",
        {
          p_doctor_id: body.doctorId!,
          ...(body.date ? { p_date: body.date } : {}),
        },
      );

      if (error) {
        throw new InternalError("Doctor operations integrity failed", {
          error: error.message,
        });
      }

      checkResult = data;
    } else {
      checkName = "integration_matrix";

      const { data, error } = await db.rpc("verify_integration_matrix", {
        p_hospital_id: hospitalId,
        ...(body.date ? { p_date: body.date } : {}),
      });

      if (error) {
        throw new InternalError("Integration matrix check failed", {
          error: error.message,
        });
      }

      checkResult = data;
    }

    await logAuditEvent(
      {
        hospitalId,
        actorUserId: auth.userId,
        entityType: "compliance_check",
        // No entityId: a check name is not a row identifier. It is
        // carried in newData.check instead.
        actionType: "compliance_check",
        severity: "low",
        oldData: null,
        newData: {
          check: checkName,
          result: checkResult,
          queueSessionId: body.queueSessionId ?? null,
          doctorId: body.doctorId ?? null,
        },
      },
      logger,
      metrics,
    );

    metrics.increment(`enterprise_reports.${checkName}`);
    metrics.timing("request.total", elapsedMs(trace));
    metrics.flush(logger);

    return successResponse(
      { action: body.action, check: checkName, result: checkResult },
      trace.correlationId,
      req,
    );
  } catch (err) {
    metrics.increment("enterprise_reports.error");

    logger.error("enterprise-reports failed", err, {
      action,
      durationMs: elapsedMs(trace),
    });

    return handleErrorResponse(err, trace.correlationId, req);
  }
});
