/**
 * carry-forward-tokens/index.ts
 * Idempotent carry-forward via SQL function.
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
import { DateSchema, parseBody } from "../_shared/validation.ts";
import { formatE164 } from "../_shared/phone.ts";

const ENDPOINT = "carry-forward-tokens";

const Schema = z
  .object({
    fromDate: DateSchema,
    toDate: DateSchema,
  })
  .refine(
    (d) => d.toDate > d.fromDate,
    {
      message: "toDate must be after fromDate",
      path: ["toDate"],
    },
  );

Deno.serve(
  async (
    req: Request,
  ): Promise<Response> => {
    const cors = handleCors(req);

    if (cors) {
      return cors;
    }

    if (req.method !== "POST") {
      return new Response(
        "Method Not Allowed",
        {
          status: 405,
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

    try {
      const hospitalId = req.headers.get(
        "X-Hospital-ID",
      );

      if (!hospitalId) {
        throw new ValidationError(
          "Missing X-Hospital-ID header",
          {
            header: [
              "Required",
            ],
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

      // Optional hospital-scope protection
      if (
        auth.role ===
          "hospital_admin" &&
        (
          auth as {
            hospitalId?: string;
          }
        ).hospitalId &&
        (
            auth as {
              hospitalId?: string;
            }
          ).hospitalId !==
          hospitalId
      ) {
        throw new ValidationError(
          "Hospital scope mismatch",
          {
            hospitalId: [
              "Cannot operate on another hospital",
            ],
          },
        );
      }

      const body = await parseBody(
        req,
        Schema,
      );

      const diffDays = Math.floor(
        (
          new Date(
            body.toDate,
          ).getTime() -
          new Date(
            body.fromDate,
          ).getTime()
        ) /
          86400000,
      );

      if (diffDays > 7) {
        throw new ValidationError(
          "Max 7 days gap",
          {
            toDate: [
              "Maximum gap is 7 days",
            ],
          },
        );
      }

      const db = getServiceClient();

      const {
        data: count,
        error: carryForwardError,
      } = await db.rpc(
        "carry_forward_pending_tokens",
        {
          p_hospital_id: hospitalId,
          p_from_date: body.fromDate,
          p_to_date: body.toDate,
        },
      );

      if (
        carryForwardError
      ) {
        logger.error(
          "Carry-forward RPC failed",
          {
            hospitalId,
            fromDate: body.fromDate,
            toDate: body.toDate,
            error: carryForwardError.message,
          },
        );

        throw new InternalError(
          "Carry-forward failed",
          {
            error: carryForwardError.message,
          },
        );
      }

      const carriedCount = Number(
        count ?? 0,
      );

      if (
        Number.isNaN(
          carriedCount,
        )
      ) {
        throw new InternalError(
          "Invalid carry-forward result",
        );
      }

      logger.info(
        "Carry-forward completed",
        {
          hospitalId,
          carriedCount,
          fromDate: body.fromDate,
          toDate: body.toDate,
        },
      );

      if (
        carriedCount > 0
      ) {
        const {
          data: carried,
          error: carriedError,
        } = await db
          .from("bookings")
          .select(`
            id,
            patient_name,
            patient_phone,
            token_number
          `)
          .eq(
            "hospital_id",
            hospitalId,
          )
          .eq(
            "appointment_date",
            body.toDate,
          )
          .eq(
            "is_carry_forward",
            true,
          )
          .eq(
            "whatsapp_confirmation_sent",
            false,
          )
          .limit(200);

        if (
          carriedError
        ) {
          logger.warn(
            "Failed loading carried bookings",
            {
              error: carriedError.message,
            },
          );
        }

        for (
          const b of carried ?? []
        ) {
          const phone = (
            b as {
              patient_phone: string | null;
            }
          )
            .patient_phone;

          if (!phone) {
            continue;
          }

          const {
            error: enqueueError,
          } = await db.rpc(
            "enqueue_job",
            {
              p_job_type: "send_whatsapp_message",

              p_payload: {
                template_name: "carry_forward_notice",

                booking_id: (
                  b as {
                    id: string;
                  }
                ).id,

                phone: await formatE164(
                  db,
                  phone,
                  hospitalId,
                ),

                patient_name: (
                  b as {
                    patient_name: string;
                  }
                )
                  .patient_name,

                token_number: (
                  b as {
                    token_number: number;
                  }
                )
                  .token_number,

                new_date: body.toDate,
              },

              p_priority: "high",

              p_scheduled_at: new Date()
                .toISOString(),

              p_idempotency_key: `wa_cf_${
                (
                  b as {
                    id: string;
                  }
                ).id
              }`,

              p_hospital_id: hospitalId,

              p_booking_id: (
                b as {
                  id: string;
                }
              ).id,
            },
          );

          if (
            enqueueError
          ) {
            logger.warn(
              "Carry-forward WhatsApp enqueue failed",
              {
                bookingId: (
                  b as {
                    id: string;
                  }
                ).id,
                error: enqueueError.message,
              },
            );

            continue;
          }

          await db
            .from(
              "bookings",
            )
            .update({
              whatsapp_confirmation_sent: true,
            })
            .eq(
              "id",
              (
                b as {
                  id: string;
                }
              ).id,
            );
        }
      }

      await logAuditEvent(
        {
          hospitalId,
          actorUserId: auth.userId,

          entityType: "queue",

          actionType: "carry_forward",

          severity: "medium",

          newData: {
            fromDate: body.fromDate,
            toDate: body.toDate,
            count: carriedCount,
          },
        },
        logger,
      );

      metrics.record(
        "carry_forward.count",
        carriedCount,
      );

      metrics.increment(
        "carry_forward.success",
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
          carriedCount,
          fromDate: body.fromDate,
          toDate: body.toDate,
        },
        trace.correlationId,
        req,
      );
    } catch (err) {
      metrics.increment(
        "carry_forward.error",
      );

      logger.error(
        "carry-forward-tokens failed",
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
  },
);
