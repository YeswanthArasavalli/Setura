/**
 * settlement-engine/index.ts
 *
 * Creates a settlement for a hospital covering a date range.
 * Collects all unsettled daily_collection_entries and produces an
 * immutable settlement record.
 *
 * Idempotent: same (hospital, start_date, end_date) returns existing settlement.
 * The SQL create_hospital_settlement() function enforces this via UNIQUE constraint.
 */

import { handleCors } from "../_shared/cors.ts";
import { requireRole, resolveAuth } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { logAuditEvent } from "../_shared/audit.ts";
import {
  extractIdempotencyKey,
  withIdempotency,
} from "../_shared/idempotency.ts";
import { handleErrorResponse, successResponse } from "../_shared/response.ts";
import {
  ForbiddenError,
  InternalError,
  ValidationError,
} from "../_shared/errors.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { DateSchema, parseBody } from "../_shared/validation.ts";

const ENDPOINT = "settlement-engine";

const CreateSettlementSchema = z.object({
  action: z.enum(["create", "record_payment", "get_outstanding"]),
  startDate: DateSchema.optional(),
  endDate: DateSchema.optional(),
  // For record_payment
  settlementId: z.string().uuid().optional(),
  paidAmountInr: z.number().positive().optional(),
}).refine(
  (d) => d.action !== "create" || (d.startDate && d.endDate),
  {
    message: "startDate and endDate required for create action",
    path: ["startDate"],
  },
).refine(
  (d) => d.action !== "record_payment" || (d.settlementId && d.paidAmountInr),
  {
    message: "settlementId and paidAmountInr required for record_payment",
    path: ["settlementId"],
  },
);

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
      throw new ValidationError(
        "Missing X-Hospital-ID header",
        {
          header: ["Required"],
        },
      );
    }

    const auth = await resolveAuth(
      req,
      hospitalId,
      logger,
    );

    requireRole(
      auth,
      [
        "hospital_admin",
        "global_admin",
      ],
    );

    const body = await parseBody(
      req,
      CreateSettlementSchema,
    );

    const db = getServiceClient();

    let idempotencyKey:
      | string
      | undefined;

    if (
      body.action !==
        "get_outstanding"
    ) {
      idempotencyKey = extractIdempotencyKey(
        req,
        true,
      )!;
    }

    // ── GET_OUTSTANDING: no idempotency needed ──────────────────────────────
    if (
      body.action ===
        "get_outstanding"
    ) {
      const {
        data: balance,
        error: balanceErr,
      } = await db
        .from(
          "outstanding_balances",
        )
        .select(
          `
          total_outstanding,
          last_settlement_date,
          updated_at
          `,
        )
        .eq(
          "hospital_id",
          hospitalId,
        )
        .single();

      if (balanceErr) {
        throw new InternalError(
          "Failed to load balance",
          {
            error: balanceErr.message,
          },
        );
      }

      const {
        data: pendingEntries,
        error: pendingErr,
      } = await db
        .from(
          "daily_collection_entries",
        )
        .select(
          `
          collection_date,
          platform_fee,
          receptionist_fee,
          total_amount
          `,
        )
        .eq(
          "hospital_id",
          hospitalId,
        )
        .eq(
          "is_settled",
          false,
        )
        .order(
          "collection_date",
          {
            ascending: false,
          },
        );

      if (pendingErr) {
        throw new InternalError(
          "Failed to load pending entries",
          {
            error: pendingErr.message,
          },
        );
      }

      const unsettledTotal = (
        pendingEntries ??
          []
      ).reduce(
        (
          sum,
          entry,
        ) =>
          sum +
          Number(
            entry
              .total_amount ??
              0,
          ),
        0,
      );

      metrics.increment(
        "settlement.outstanding_view",
      );

      return successResponse(
        {
          outstandingBalance: balance
            ?.total_outstanding ??
            0,

          lastSettlementDate: balance
            ?.last_settlement_date,

          unsettledTotal,

          unsettledEntries: pendingEntries
            ?.length ?? 0,

          pendingEntries: pendingEntries
            ?.slice(0, 10),
        },
        trace.correlationId,
        req,
      );
    }

    const result = await withIdempotency<{
      settlement: unknown;
      alreadyExists: boolean;
    }>(
      idempotencyKey!,
      ENDPOINT,
      auth.userId,
      hospitalId,
      body,
      crypto.randomUUID(),
      logger,
      async () => {
        if (body.action === "create") {
          if (!body.startDate || !body.endDate) {
            throw new ValidationError(
              "Settlement date range is required",
              {
                startDate: ["Required for create"],
                endDate: ["Required for create"],
              },
            );
          }

          if (
            body.startDate >
              body.endDate
          ) {
            throw new ValidationError(
              "Invalid date range",
              {
                startDate: [
                  "Must be before endDate",
                ],
              },
            );
          }

          const days = Math.floor(
            (
              new Date(
                body.endDate,
              ).getTime() -
              new Date(
                body.startDate,
              ).getTime()
            ) /
              86400000,
          );

          if (days > 90) {
            throw new ValidationError(
              "Settlement window too large",
              {
                endDate: [
                  "Maximum 90 days",
                ],
              },
            );
          }
          // ── Create settlement (atomic SQL) ─────────────────────────────────
          const { data: settlementId, error: settlErr } = await db.rpc(
            "create_hospital_settlement",
            {
              p_hospital_id: hospitalId,
              p_start_date: body.startDate,
              p_end_date: body.endDate,
              p_collected_by: auth.userId,
            },
          );

          if (settlErr) {
            const errorMessage = (
              settlErr.message ??
                ""
            ).toLowerCase();

            const details = (
              settlErr.details ??
                ""
            ).toLowerCase();

            const isDuplicateSettlement = settlErr.code ===
                "23505" ||
              errorMessage.includes(
                "already exists",
              ) ||
              errorMessage.includes(
                "duplicate",
              ) ||
              details.includes(
                "duplicate",
              );

            if (isDuplicateSettlement) {
              const { data: existing, error: existingErr } = await db
                .from("hospital_settlements")
                .select("*")
                .eq("hospital_id", hospitalId)
                .eq("settlement_start_date", body.startDate)
                .eq("settlement_end_date", body.endDate)
                .single();

              if (existingErr || !existing) {
                throw new InternalError(
                  "Failed to fetch existing settlement",
                  {
                    error: existingErr?.message,
                  },
                );
              }

              return {
                statusCode: 200,
                body: {
                  settlement: existing,
                  alreadyExists: true,
                },
              };
            }

            throw new InternalError(
              "Settlement creation failed",
              {
                error: settlErr.message,
                code: settlErr.code,
              },
            );
          }

          const { data: settlement, error: settlementErr } = await db
            .from("hospital_settlements")
            .select("*")
            .eq("id", settlementId as string)
            .single();

          if (settlementErr || !settlement) {
            throw new InternalError(
              "Failed to fetch created settlement",
              { error: settlementErr?.message },
            );
          }

          await logAuditEvent({
            hospitalId,
            actorUserId: auth.userId,
            entityType: "hospital_settlement",
            entityId: settlementId as string,
            actionType: "settlement_create",
            severity: "high",
            newData: {
              startDate: body.startDate,
              endDate: body.endDate,
              totalAmount: (settlement as Record<string, unknown>)
                ?.total_platform_amount,
            },
          }, logger);

          metrics.increment("settlement.created");
          return {
            statusCode: 201,
            body: { settlement, alreadyExists: false },
          };
        }

        if (body.action === "record_payment") {
          // ── Record payment against settlement ──────────────────────────────
          const { data: existing, error: existingErr } = await db
            .from("hospital_settlements")
            .select("hospital_id, remaining_due, settlement_status")
            .eq("id", body.settlementId!)
            .single();

          if (existingErr || !existing) {
            throw new ValidationError(
              "Settlement not found",
              {
                settlementId: ["Not found"],
              },
            );
          }

          if (existing.hospital_id !== hospitalId) {
            throw new ForbiddenError(
              "Settlement belongs to different hospital",
            );
          }

          const { data: ok, error: payErr } = await db.rpc(
            "record_settlement_payment",
            {
              p_settlement_id: body.settlementId!,
              p_paid_amount: body.paidAmountInr!,
              p_performed_by: auth.userId,
            },
          );

          if (payErr) {
            throw new InternalError(
              "Payment recording failed",
              {
                error: payErr.message,
                code: payErr.code,
              },
            );
          }

          if (!ok) {
            throw new InternalError(
              "Settlement payment RPC returned false",
            );
          }

          const { data: updated, error: updatedErr } = await db
            .from("hospital_settlements")
            .select(
              "id, remaining_due, settlement_status, amount_paid_to_setura",
            )
            .eq("id", body.settlementId!)
            .single();

          if (updatedErr || !updated) {
            throw new InternalError(
              "Failed to fetch updated settlement",
              { error: updatedErr?.message },
            );
          }

          await logAuditEvent({
            hospitalId,
            actorUserId: auth.userId,
            entityType: "hospital_settlement",
            entityId: body.settlementId!,
            actionType: "settlement_paid",
            severity: "high",
            newData: {
              paidAmount: body.paidAmountInr,
              status: (updated as Record<string, unknown>)?.settlement_status,
            },
          }, logger);

          metrics.increment("settlement.payment_recorded");

          return {
            statusCode: 200,
            body: {
              settlement: updated,
              alreadyExists: false,
            },
          };
        }

        throw new InternalError("Unknown action");
      },
    );

    metrics.timing("request.total", elapsedMs(trace));
    try {
      metrics.flush(logger);
    } catch {
      // ignore metrics failures
    }

    return successResponse(
      result.body,
      trace.correlationId,
      req,
      undefined,
      result.statusCode,
    );
  } catch (err) {
    metrics.increment(
      "settlement.error",
    );

    logger.error(
      "settlement-engine failed",
      err,
      {
        correlationId: trace.correlationId,
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
