/**
 * reschedule-booking/index.ts
 * Marks original booking as rescheduled and creates a new booking.
 * Fully idempotent.
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
  ConcurrencyError,
  DoctorUnavailableError,
  ForbiddenError,
  HospitalClosedError,
  InternalError,
  ValidationError,
} from "../_shared/errors.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import {
  DateSchema,
  getWeekday,
  isValidAdvanceBookingDate,
  parseBody,
} from "../_shared/validation.ts";
import type { BookingStatus } from "../_shared/types.ts";
import { formatE164 } from "../_shared/phone.ts";

const ENDPOINT = "reschedule-booking";

const RESCHEDULABLE: BookingStatus[] = [
  "booked",
  "checked_in",
  "waiting",
];

const Schema = z.object({
  bookingId: z.string().uuid(),
  newDate: DateSchema,
  newDoctorId: z.string().uuid().optional(),
  reason: z.string().max(500).optional(),
});

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

      const idempotencyKey = extractIdempotencyKey(
        req,
        true,
      )!;

      const auth = await resolveAuth(
        req,
        hospitalId,
        logger,
      );

      requireRole(
        auth,
        [
          "receptionist",
          "hospital_admin",
          "global_admin",
        ],
      );

      const body = await parseBody(
        req,
        Schema,
      );

      const db = getServiceClient();

      const result = await withIdempotency(
        idempotencyKey,
        ENDPOINT,
        auth.userId,
        hospitalId,
        body,
        crypto.randomUUID(),
        logger,
        async () => {
          const {
            data: orig,
            error: origErr,
          } = await db
            .from("bookings")
            .select(`
                id,
                hospital_id,
                patient_id,
                patient_name,
                patient_phone,
                patient_age,
                patient_gender,
                village,
                blood_group,
                has_diabetes,
                has_bp,
                booking_source,
                assigned_doctor_id,
                appointment_date,
                status,
                platform_fee_snapshot,
                receptionist_fee_snapshot,
                hospital_fee_snapshot,
                queue_session_id
              `)
            .eq(
              "id",
              body.bookingId,
            )
            .eq(
              "is_deleted",
              false,
            )
            .single();

          if (
            origErr ||
            !orig
          ) {
            throw new ValidationError(
              "Booking not found",
              {
                bookingId: [
                  "Not found",
                ],
              },
            );
          }

          if (
            orig.hospital_id !==
              hospitalId
          ) {
            throw new ForbiddenError(
              "Booking belongs to different hospital",
            );
          }

          if (
            body.newDate ===
              orig.appointment_date
          ) {
            throw new ValidationError(
              "New date must be different",
              {
                newDate: [
                  "Already booked on this date",
                ],
              },
            );
          }

          const today = new Date()
            .toISOString()
            .split("T")[0];

          if (
            body.newDate <
              today
          ) {
            throw new ValidationError(
              "Cannot reschedule to past date",
              {
                newDate: [
                  "Date must be today or future",
                ],
              },
            );
          }

          const current = orig.status as BookingStatus;

          if (
            !RESCHEDULABLE.includes(
              current,
            )
          ) {
            throw new ValidationError(
              `Cannot reschedule booking in '${current}' state`,
              {
                status: [
                  `Only: ${RESCHEDULABLE.join(", ")}`,
                ],
              },
            );
          }

          const {
            data: hs,
          } = await db
            .from(
              "hospital_settings",
            )
            .select(
              "max_tokens_per_day",
            )
            .eq(
              "hospital_id",
              hospitalId,
            )
            .single();

          if (
            !isValidAdvanceBookingDate(
              body.newDate,
              hs?.max_tokens_per_day ??
                7,
            )
          ) {
            throw new ValidationError(
              "New date outside booking window",
              {
                newDate: [
                  "Too far in advance",
                ],
              },
            );
          }

          const {
            data: holiday,
          } = await db
            .from(
              "hospital_holidays",
            )
            .select("id")
            .eq(
              "hospital_id",
              hospitalId,
            )
            .eq(
              "holiday_date",
              body.newDate,
            )
            .single();

          if (holiday) {
            throw new HospitalClosedError(
              hospitalId,
              "Holiday on new date",
            );
          }

          const weekday = getWeekday(
            body.newDate,
          );

          const {
            data: hours,
          } = await db
            .from(
              "hospital_working_hours",
            )
            .select(
              "is_open",
            )
            .eq(
              "hospital_id",
              hospitalId,
            )
            .eq(
              "weekday",
              weekday,
            )
            .single();

          if (
            hours &&
            !hours.is_open
          ) {
            throw new HospitalClosedError(
              hospitalId,
              "Hospital closed on new date",
            );
          }

          const doctorId = body.newDoctorId ??
            orig.assigned_doctor_id;

          if (doctorId) {
            const {
              data: avail,
              error: availError,
            } = await db.rpc(
              "is_doctor_available",
              {
                p_doctor_id: doctorId,
                p_hospital_id: hospitalId,
                p_date: body.newDate,
              },
            );

            if (
              availError
            ) {
              throw new InternalError(
                "Doctor availability check failed",
                {
                  error: availError.message,
                },
              );
            }

            if (!avail) {
              throw new DoctorUnavailableError(
                doctorId,
                body.newDate,
                "Not available on new date",
              );
            }
          }

          const {
            data: marked,
            error: markErr,
          } = await db
            .from("bookings")
            .update({
              status: "rescheduled",
              updated_at: new Date().toISOString(),
            })
            .eq(
              "id",
              body.bookingId,
            )
            .eq(
              "status",
              current,
            )
            .select("id");

          if (markErr) {
            throw new InternalError(
              "Failed to mark original booking as rescheduled",
              {
                error: markErr.message,
              },
            );
          }

          if (
            !marked ||
            marked.length === 0
          ) {
            throw new ConcurrencyError(
              "Booking was modified concurrently",
              {
                bookingId: body.bookingId,
              },
            );
          }

          const {
            data: newBk,
            error: newErr,
          } = await db.rpc(
            "create_booking",
            {
              p_hospital_id: hospitalId,
              p_queue_session_id: undefined,
              p_patient_id: orig.patient_id ?? undefined,
              p_patient_name: orig.patient_name,
              p_patient_phone: orig.patient_phone,
              p_patient_age: orig.patient_age ?? undefined,
              p_patient_gender: orig.patient_gender ?? undefined,
              p_village: orig.village ?? undefined,
              p_blood_group: orig.blood_group ?? undefined,
              p_has_diabetes: orig.has_diabetes,
              p_has_bp: orig.has_bp,
              p_booking_source: orig.booking_source,
              p_doctor_id: doctorId ?? undefined,
              p_booked_by: auth.userId,
              p_appointment_date: body.newDate,
              p_platform_fee: Number(
                orig.platform_fee_snapshot,
              ),
              p_receptionist_fee: Number(
                orig.receptionist_fee_snapshot,
              ),
              p_hospital_fee: Number(
                orig.hospital_fee_snapshot,
              ),
              p_idempotency_key: idempotencyKey,
            },
          );

          if (newErr) {
            throw new InternalError(
              "Failed to create rescheduled booking",
              {
                error: newErr.message,
              },
            );
          }

          const bookingRows = newBk as Array<{
            booking_id: string;
            token_number: number;
          }>;

          if (
            !bookingRows ||
            bookingRows.length === 0
          ) {
            throw new InternalError(
              "Booking creation returned no result",
            );
          }

          const nb = bookingRows[0];

          const {
            error: carryForwardError,
          } = await db
            .from("bookings")
            .update({
              carry_forwarded_from: body.bookingId,
            })
            .eq(
              "id",
              nb.booking_id,
            );

          if (
            carryForwardError
          ) {
            logger.warn(
              "Failed to update carry-forward link",
              {
                bookingId: nb.booking_id,
                error: carryForwardError.message,
              },
            );
          }

          if (
            orig.patient_phone
          ) {
            const {
              error: enqueueError,
            } = await db.rpc(
              "enqueue_job",
              {
                p_job_type: "send_whatsapp_message",
                p_payload: {
                  template_name: "booking_rescheduled",
                  booking_id: nb.booking_id,
                  phone: await formatE164(
                    db,
                    orig.patient_phone,
                    hospitalId,
                  ),
                  patient_name: orig.patient_name,
                  token_number: nb.token_number,
                  new_date: body.newDate,
                },
                p_priority: "high",
                p_scheduled_at: new Date().toISOString(),
                p_idempotency_key: `wa_reschedule_${nb.booking_id}`,
                p_hospital_id: hospitalId,
                p_booking_id: nb.booking_id,
              },
            );

            if (
              enqueueError
            ) {
              logger.warn(
                "Reschedule WhatsApp enqueue failed",
                {
                  bookingId: nb.booking_id,
                  error: enqueueError.message,
                },
              );
            }
          }

          await logAuditEvent(
            {
              hospitalId,
              actorUserId: auth.userId,
              entityType: "booking",
              entityId: body.bookingId,
              actionType: "booking_status_change",
              severity: "medium",
              oldData: {
                status: current,
                date: orig.appointment_date,
                oldBookingId: body.bookingId,
                oldDoctorId: orig.assigned_doctor_id,
              },
              newData: {
                status: "rescheduled",
                newDate: body.newDate,
                newBookingId: nb.booking_id,
                newDoctorId: doctorId,
                reason: body.reason,
              },
            },
            logger,
          );

          return {
            statusCode: 200,
            body: {
              originalBookingId: body.bookingId,
              newBookingId: nb.booking_id,
              newTokenNumber: nb.token_number,
              newDate: body.newDate,
            },
          };
        },
      );

      metrics.increment(
        "booking.rescheduled",
      );

      metrics.increment(
        "booking.reschedule.success",
      );

      metrics.timing(
        "request.total",
        elapsedMs(trace),
      );

      metrics.flush(logger);

      return successResponse(
        result.body,
        trace.correlationId,
        req,
      );
    } catch (err) {
      metrics.increment(
        "booking.reschedule.error",
      );

      logger.error(
        "reschedule-booking failed",
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
