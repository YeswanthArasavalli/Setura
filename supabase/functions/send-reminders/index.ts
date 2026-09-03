/**
 * send-reminders/index.ts
 * Queues due appointment reminders.
 * Called by run-cron-minute.
 */
import { handleCors } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { handleErrorResponse, successResponse } from "../_shared/response.ts";
import { Env } from "../_shared/env.ts";
import { formatE164 } from "../_shared/phone.ts";

const ENDPOINT = "send-reminders";

function constantTimeEquals(
  provided: string,
  expected: string,
): boolean {
  if (
    provided.length !== expected.length
  ) {
    return false;
  }

  let diff = 0;

  for (
    let i = 0;
    i < provided.length;
    i++
  ) {
    diff |= provided.charCodeAt(i) ^
      expected.charCodeAt(i);
  }

  return diff === 0;
}

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

    // ------------------------------------------------------------------
    // Cron authentication
    // ------------------------------------------------------------------

    const cronSecret = req.headers.get(
      "X-Cron-Secret",
    );

    const expectedSecret = Env.CRON_SECRET;

    if (
      !cronSecret ||
      !expectedSecret
    ) {
      return new Response(
        "Forbidden",
        {
          status: 403,
        },
      );
    }

    if (
      !constantTimeEquals(
        cronSecret,
        expectedSecret,
      )
    ) {
      return new Response(
        "Forbidden",
        {
          status: 403,
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
      const db = getServiceClient();

      const now = new Date();

      const today = now
        .toISOString()
        .split("T")[0];

      const weekday = now.getDay();

      let totalQueued = 0;

      // --------------------------------------------------------------
      // Load hospitals with reminders enabled
      // --------------------------------------------------------------

      const {
        data: hospitals,
        error: hospitalsError,
      } = await db
        .from(
          "hospital_settings",
        )
        .select(`
          hospital_id,
          send_whatsapp_reminder,
          reminder_before_minutes
        `)
        .eq(
          "send_whatsapp_reminder",
          true,
        );

      if (
        hospitalsError
      ) {
        throw new Error(
          `Failed loading hospital settings: ${hospitalsError.message}`,
        );
      }

      for (
        const hs of hospitals ?? []
      ) {
        const hospitalId = (
          hs as {
            hospital_id: string;
          }
        ).hospital_id;

        // ------------------------------------------------------------
        // Working hours
        // ------------------------------------------------------------

        const {
          data: hours,
          error: hoursError,
        } = await db
          .from(
            "hospital_working_hours",
          )
          .select(`
            open_time,
            is_open
          `)
          .eq(
            "hospital_id",
            hospitalId,
          )
          .eq(
            "weekday",
            weekday,
          )
          .maybeSingle();

        if (
          hoursError
        ) {
          logger.warn(
            "Working hours lookup failed",
            {
              hospitalId,
              error: hoursError.message,
            },
          );

          continue;
        }

        if (
          !hours ||
          !(
            hours as {
              is_open: boolean;
            }
          ).is_open ||
          !(
            hours as {
              open_time: string;
            }
          ).open_time
        ) {
          continue;
        }

        const reminderBefore = (
          hs as {
            reminder_before_minutes: number;
          }
        )
          .reminder_before_minutes;

        const openTime = (
          hours as {
            open_time: string;
          }
        ).open_time;

        const [
          openHour,
          openMinute,
        ] = openTime
          .split(":")
          .map(Number);

        const openMs = (
          openHour * 60 +
          openMinute
        ) * 60_000;

        const reminderMs = openMs -
          reminderBefore *
            60_000;

        const currentMs = (
          now.getHours() *
            60 +
          now.getMinutes()
        ) * 60_000;

        // ------------------------------------------------------------
        // One-minute execution window
        // Prevents duplicate reminder runs
        // ------------------------------------------------------------

        const reminderWindowEnd = reminderMs + 60_000;

        if (
          currentMs <
            reminderMs ||
          currentMs >
            reminderWindowEnd
        ) {
          continue;
        }

        // ------------------------------------------------------------
        // Find bookings requiring reminders
        // ------------------------------------------------------------

        const {
          data: bookings,
          error: bookingsError,
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
            today,
          )
          .in(
            "status",
            [
              "booked",
              "checked_in",
            ],
          )
          .eq(
            "whatsapp_reminder_sent",
            false,
          )
          .eq(
            "is_deleted",
            false,
          )
          .limit(100);

        if (
          bookingsError
        ) {
          logger.warn(
            "Booking lookup failed",
            {
              hospitalId,
              error: bookingsError.message,
            },
          );

          continue;
        }

        for (
          const b of bookings ?? []
        ) {
          const booking = b as {
            id: string;
            patient_name: string;
            patient_phone:
              | string
              | null;
            token_number: number;
          };

          if (
            !booking.patient_phone
          ) {
            continue;
          }

          const {
            error: enqueueError,
          } = await db.rpc(
            "enqueue_job",
            {
              p_job_type: "send_whatsapp_message",

              p_payload: {
                template_name: "appointment_reminder",

                booking_id: booking.id,

                phone: await formatE164(
                  db,
                  booking.patient_phone,
                  hospitalId,
                ),

                patient_name: booking.patient_name,

                token_number: booking.token_number,

                appointment_date: today,
              },

              p_priority: "high",

              p_scheduled_at: new Date().toISOString(),

              p_idempotency_key: `reminder_${booking.id}`,

              p_hospital_id: hospitalId,

              p_booking_id: booking.id,
            },
          );

          if (
            enqueueError
          ) {
            logger.warn(
              "Reminder enqueue failed",
              {
                bookingId: booking.id,
                error: enqueueError.message,
              },
            );

            continue;
          }

          totalQueued++;
        }
      }

      logger.info(
        "Reminders queued",
        {
          totalQueued,
          date: today,
        },
      );

      metrics.record(
        "reminders.queued",
        totalQueued,
      );

      metrics.increment(
        "reminders.run.success",
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
          remindersQueued: totalQueued,
        },
        trace.correlationId,
        req,
      );
    } catch (err) {
      metrics.increment(
        "reminders.run.error",
      );

      logger.error(
        "send-reminders failed",
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
