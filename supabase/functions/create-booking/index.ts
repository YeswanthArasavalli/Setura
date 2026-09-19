/**
 * create-booking/index.ts
 *
 * Production-grade booking creation Edge Function.
 *
 * Flow:
 *   1. CORS preflight
 *   2. Idempotency key extraction + claim
 *   3. JWT + role + hospital access validation
 *   4. Request body parse + Zod validation
 *   5. Rate limit check (phone + IP)
 *   6. Hospital open/holiday/advance-booking rules
 *   7. Doctor availability check (if assigned)
 *   8. Queue capacity check
 *   9. Phone block check
 *  10. Find-or-create patient (deduplicated by phone)
 *  11. Atomic booking creation (generate_next_token inside SQL)
 *  12. Enqueue WhatsApp confirmation job
 *  13. Enqueue notification job
 *  14. Write audit log
 *  15. Complete idempotency key (store response for replay)
 *  16. Return typed response
 *
 * Concurrency guarantees:
 *   - Token allocation: INSERT ... ON CONFLICT DO UPDATE RETURNING (atomic)
 *   - Duplicate booking: idempotency_key UNIQUE constraint on bookings table
 *   - Double-click: Idempotency-Key header + api_idempotency_keys table
 *   - Patient creation: UNIQUE (hospital_id, normalized_phone) + ON CONFLICT
 *
 * All DB mutations go through service-role client.
 * RLS is enforced at auth.ts level before any DB access.
 */

import { handleCors } from "../_shared/cors.ts";
import { requireRole, resolveAuth } from "../_shared/auth.ts";
import {
  CreateBookingSchema,
  isValidAdvanceBookingDate,
  parseBody,
} from "../_shared/validation.ts";
import { formatE164 } from "../_shared/phone.ts";
import {
  extractIdempotencyKey,
  withIdempotency,
} from "../_shared/idempotency.ts";
import { checkAndLogBookingAttempt, extractIp } from "../_shared/rate_limit.ts";
import { logAuditEvent } from "../_shared/audit.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { handleErrorResponse, successResponse } from "../_shared/response.ts";
import {
  DoctorUnavailableError,
  HospitalClosedError,
  InternalError,
  QueueFullError,
  ValidationError,
} from "../_shared/errors.ts";
import type {
  CreateBookingResponse,
  DbPatient,
  DbQueueSession,
} from "../_shared/types.ts";

const ENDPOINT = "create-booking";

Deno.serve(async (req: Request): Promise<Response> => {
  // ── CORS preflight ────────────────────────────────────────────────────────
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // ── Tracing + logging + metrics ───────────────────────────────────────────
  const trace = createTraceContext(req);
  const logger = createRequestLogger(req, ENDPOINT).child({
    correlationId: trace.correlationId,
    requestId: trace.requestId,
  });
  const metrics = createMetrics(ENDPOINT, trace.correlationId);
  const ip = extractIp(req);

  logger.info("Request received", { ip });

  // ── Idempotency key extraction ────────────────────────────────────────────
  let idempotencyKey: string;
  try {
    idempotencyKey = extractIdempotencyKey(req, true)!;
  } catch (err) {
    return handleErrorResponse(err, trace.correlationId, req);
  }

  try {
    // ── Auth: JWT + hospital membership ──────────────────────────────────────
    const authTimer = metrics.startTimer("auth.resolve");
    const hospitalId = req.headers.get("X-Hospital-ID");
    if (!hospitalId) {
      throw new ValidationError("Missing X-Hospital-ID header", {
        header: ["X-Hospital-ID is required"],
      });
    }

    const auth = await resolveAuth(req, hospitalId, logger);
    authTimer.stop();

    // Receptionists, doctors, and hospital admins can create bookings
    requireRole(auth, [
      "receptionist",
      "hospital_admin",
      "doctor",
      "global_admin",
    ]);
    logger.debug("Auth resolved", {
      userId: auth.userId,
      role: auth.role,
      hospitalId,
    });

    // ── Parse + validate body ─────────────────────────────────────────────────
    const parseTimer = metrics.startTimer("request.parse");
    const body = await parseBody(req, CreateBookingSchema);
    parseTimer.stop();

    // Ensure hospitalId in body matches header (prevent cross-hospital injection)
    if (body.hospitalId !== hospitalId) {
      throw new ValidationError(
        "hospitalId in body must match X-Hospital-ID header",
        {
          hospitalId: ["Must match the X-Hospital-ID header value"],
        },
      );
    }

    logger.debug("Body parsed", {
      patientPhone: body.patientPhone.slice(-4).padStart(10, "*"),
      appointmentDate: body.appointmentDate,
      bookingSource: body.bookingSource,
    });

    // ── Idempotency: check for duplicate request ──────────────────────────────
    const instanceId = crypto.randomUUID();

    const result = await withIdempotency<CreateBookingResponse>(
      idempotencyKey,
      ENDPOINT,
      auth.userId,
      hospitalId,
      body,
      instanceId,
      logger,
      async () => {
        // ── Everything inside here runs exactly once ──────────────────────────

        const db = getServiceClient();

        // ── Rate limit check ────────────────────────────────────────────────
        const rlTimer = metrics.startTimer("rate_limit.check");
        await checkAndLogBookingAttempt(
          body.patientPhone,
          ip,
          { hospitalId },
          logger,
        );
        rlTimer.stop();

        // ── Load hospital settings ───────────────────────────────────────────
        const settingsTimer = metrics.startTimer("db.hospital_settings");
        const { data: settings, error: settingsError } = await db
          .from("hospital_settings")
          .select("*")
          .eq("hospital_id", hospitalId)
          .single();

        if (settingsError || !settings) {
          throw new InternalError("Hospital settings not found", {
            hospitalId,
          });
        }
        const hs = settings;
        settingsTimer.stop();

        // ── Hospital rules ───────────────────────────────────────────────────

        // Online booking enabled?
        if (body.bookingSource === "online" && !hs.allow_online_booking) {
          throw new HospitalClosedError(
            hospitalId,
            "Online booking is disabled",
          );
        }

        // Advance booking window (lives on the hospitals table)
        const { data: hospitalRow } = await db
          .from("hospitals")
          .select("max_advance_booking_days")
          .eq("id", hospitalId)
          .single();

        const maxAdvanceBookingDays = hospitalRow?.max_advance_booking_days ??
          7;

        if (
          !isValidAdvanceBookingDate(
            body.appointmentDate,
            maxAdvanceBookingDays,
          )
        ) {
          throw new ValidationError(
            "Appointment date out of allowed booking window",
            {
              appointmentDate: [
                `Can only book up to ${maxAdvanceBookingDays} days in advance`,
              ],
            },
          );
        }

        // ── Holiday check ────────────────────────────────────────────────────
        const { data: holiday } = await db
          .from("hospital_holidays")
          .select("id, description")
          .eq("hospital_id", hospitalId)
          .eq("holiday_date", body.appointmentDate)
          .single();

        if (holiday) {
          throw new HospitalClosedError(
            hospitalId,
            `Holiday: ${holiday.description ?? "Closed"}`,
          );
        }

        // ── Working hours check ──────────────────────────────────────────────
        const weekday = new Date(body.appointmentDate).getDay();
        const { data: workingHours } = await db
          .from("hospital_working_hours")
          .select("is_open")
          .eq("hospital_id", hospitalId)
          .eq("weekday", weekday)
          .single();

        if (workingHours && !workingHours.is_open) {
          throw new HospitalClosedError(
            hospitalId,
            "Hospital is closed on this day",
          );
        }

        // ── Doctor availability ──────────────────────────────────────────────
        if (body.doctorId) {
          const { data: available } = await db.rpc(
            "is_doctor_available",
            {
              p_doctor_id: body.doctorId,
              p_hospital_id: hospitalId,
              p_date: body.appointmentDate,
            },
          );

          if (!available) {
            throw new DoctorUnavailableError(
              body.doctorId,
              body.appointmentDate,
              "Not available on this date",
            );
          }

          // Slot capacity
          const { data: remainingCapacity } = await db.rpc(
            "get_remaining_token_capacity",
            {
              p_doctor_id: body.doctorId,
              p_hospital_id: hospitalId,
              p_date: body.appointmentDate,
            },
          );

          if (typeof remainingCapacity === "number" && remainingCapacity <= 0) {
            throw new QueueFullError(hospitalId, body.queueSessionId ?? "", 0);
          }
        }

        // ── Resolve or create queue session ──────────────────────────────────
        let queueSessionId = body.queueSessionId ?? null;

        if (!queueSessionId && body.doctorId) {
          // Find today's active session for this doctor
          const { data: session } = await db
            .from("queue_sessions")
            .select("id, max_tokens, current_live_token")
            .eq("hospital_id", hospitalId)
            .eq("doctor_id", body.doctorId)
            .eq("session_date", body.appointmentDate)
            .eq("is_active", true)
            .single();

          if (session) {
            queueSessionId = (session as DbQueueSession).id;
          } else {
            // Auto-create session for today
            const { data: newSession, error: sessionError } = await db
              .from("queue_sessions")
              .insert({
                hospital_id: hospitalId,
                doctor_id: body.doctorId,
                session_date: body.appointmentDate,
                max_tokens: hs.max_tokens_per_day,
                is_active: true,
              })
              .select("id")
              .single();

            if (!sessionError && newSession) {
              queueSessionId = (newSession as { id: string }).id;
            }
          }
        }

        // ── Find or create patient (deduplicated by phone) ────────────────────
        const patientTimer = metrics.startTimer("db.find_or_create_patient");
        const normalizedPhone = await formatE164(
          db,
          body.patientPhone,
          hospitalId,
        );

        let patient: DbPatient;

        // Match BOTH the canonical E.164 form and the legacy raw form:
        // before this fix the INSERT below persisted the raw 10-digit
        // phone while the lookup filtered on E.164, so the canonical
        // patient was never found on rebooking (E1 defect). limit(1)
        // because the DB dedupe index includes the name, so several
        // patient rows may legitimately share one phone.
        const { data: existingPatient } = await db
          .from("patients")
          .select("*")
          .eq("hospital_id", hospitalId)
          .in("normalized_phone", [normalizedPhone, body.patientPhone])
          .eq("is_deleted", false)
          .limit(1)
          .maybeSingle();

        if (existingPatient) {
          patient = existingPatient as DbPatient;
          // Update patient details if changed (age, village, health flags)
          const { error: patientUpdateError } = await db
            .from("patients")
            .update({
              full_name: body.patientName,
              age: body.patientAge ?? patient.age,
              gender: body.patientGender ?? patient.gender,
              village: body.village ?? patient.village,
              blood_group: body.bloodGroup ?? patient.blood_group,
              has_diabetes: body.hasDiabetes,
              has_bp: body.hasBp,
              updated_at: new Date().toISOString(),
            })
            .eq("id", patient.id);

          if (patientUpdateError) {
            logger.warn("Patient update failed", {
              patientId: patient.id,
              error: patientUpdateError.message,
            });
          }
        } else {
          const { data: newPatient, error: patientError } = await db
            .from("patients")
            .insert({
              hospital_id: hospitalId,
              full_name: body.patientName,
              // Persist the SAME canonical E.164 form the lookup above
              // filters on — the column's declared meaning.
              normalized_phone: normalizedPhone,
              age: body.patientAge,
              gender: body.patientGender,
              village: body.village,
              blood_group: body.bloodGroup,
              has_diabetes: body.hasDiabetes,
              has_bp: body.hasBp,
            })
            .select("*")
            .single();

          if (patientError || !newPatient) {
            // Race condition: another request created the same patient
            // Retry fetch once (same dual-form phone match as above).
            const { data: racePatient } = await db
              .from("patients")
              .select("*")
              .eq("hospital_id", hospitalId)
              .in("normalized_phone", [normalizedPhone, body.patientPhone])
              .eq("is_deleted", false)
              .limit(1)
              .maybeSingle();

            if (!racePatient) {
              throw new InternalError("Failed to create patient", {
                error: patientError?.message,
              });
            }
            patient = racePatient as DbPatient;
          } else {
            patient = newPatient as DbPatient;
          }
        }
        patientTimer.stop();

        // ── Resolve fees ─────────────────────────────────────────────────────
        const { data: fees, error: feesError } = await db.rpc(
          "get_effective_fees",
          {
            p_hospital_id: hospitalId,
            p_booking_source: body.bookingSource,
          },
        );

        if (feesError || !fees) {
          throw new InternalError("Failed to resolve fees", {
            error: feesError?.message,
          });
        }

        const feeRow = (fees as Array<{
          platform_fee: number;
          receptionist_fee: number;
          hospital_fee: number;
          total_amount: number;
        }>)[0];

        // ── Atomic booking creation ───────────────────────────────────────────
        const bookingTimer = metrics.startTimer("db.create_booking");
        const { data: bookingResult, error: bookingError } = await db.rpc(
          "create_booking",
          {
            p_hospital_id: hospitalId,
            p_queue_session_id: queueSessionId ?? undefined,
            p_patient_id: patient.id,
            p_patient_name: body.patientName,
            p_patient_phone: body.patientPhone,
            p_patient_age: body.patientAge ?? undefined,
            p_patient_gender: body.patientGender ?? undefined,
            p_village: body.village ?? undefined,
            p_blood_group: body.bloodGroup ?? undefined,
            p_has_diabetes: body.hasDiabetes,
            p_has_bp: body.hasBp,
            p_booking_source: body.bookingSource,
            p_doctor_id: body.doctorId ?? undefined,
            p_booked_by: auth.userId,
            p_appointment_date: body.appointmentDate,
            p_platform_fee: feeRow.platform_fee,
            p_receptionist_fee: feeRow.receptionist_fee,
            p_hospital_fee: feeRow.hospital_fee,
            p_idempotency_key: idempotencyKey,
          },
        );

        if (bookingError) {
          // Detect unique constraint violations (idempotency_key conflict)
          if (bookingError.code === "23505") {
            // Booking already exists — fetch and return it
            const { data: existingBooking } = await db
              .from("bookings")
              .select(
                "id, token_number, booking_reference, estimated_wait_minutes, queue_session_id",
              )
              .eq("idempotency_key", idempotencyKey)
              .single();

            if (existingBooking) {
              const eb = existingBooking as {
                id: string;
                token_number: number;
                booking_reference: string;
                estimated_wait_minutes: number | null;
                queue_session_id: string | null;
              };
              return {
                statusCode: 200,
                body: {
                  bookingId: eb.id,
                  tokenNumber: eb.token_number,
                  bookingReference: eb.booking_reference,
                  estimatedWaitMinutes: eb.estimated_wait_minutes,
                  patientId: patient.id,
                  appointmentDate: body.appointmentDate,
                  queueSessionId: eb.queue_session_id,
                  fees: {
                    platformFee: feeRow.platform_fee,
                    receptionistFee: feeRow.receptionist_fee,
                    hospitalFee: feeRow.hospital_fee,
                    totalAmount: feeRow.total_amount,
                  },
                } satisfies CreateBookingResponse,
              };
            }
          }

          throw new InternalError("Booking creation failed", {
            code: bookingError.code,
            message: bookingError.message,
          });
        }

        const booking = (bookingResult as Array<
          { booking_id: string; token_number: number }
        >)[0];
        bookingTimer.stop();

        logger.info("Booking created", {
          bookingId: booking.booking_id,
          tokenNumber: booking.token_number,
          patientId: patient.id,
          source: body.bookingSource,
        });

        // ── Estimate wait time ────────────────────────────────────────────────
        let estimatedWaitMinutes: number | null = null;
        if (queueSessionId) {
          const { data: waitData } = await db.rpc(
            "estimate_wait_minutes",
            {
              p_queue_session_id: queueSessionId,
              p_token_number: booking.token_number,
            },
          );
          estimatedWaitMinutes = typeof waitData === "number" ? waitData : null;
        }

        // ── Enqueue WhatsApp confirmation ────────────────────────────────────
        if (hs.send_whatsapp_confirmation) {
          const waIdemKey = `wa_confirm_${booking.booking_id}`;
          const { error: waError } = await db.rpc("enqueue_job", {
            p_job_type: "send_whatsapp_message",
            p_payload: {
              template_name: "booking_confirmation",
              booking_id: booking.booking_id,
              patient_id: patient.id,
              phone: normalizedPhone,
              token_number: booking.token_number,
              appointment_date: body.appointmentDate,
              estimated_wait: estimatedWaitMinutes,
            },
            p_priority: "high",
            p_scheduled_at: new Date().toISOString(),
            p_idempotency_key: waIdemKey,
            p_hospital_id: hospitalId,
            p_booking_id: booking.booking_id,
          });

          if (waError) {
            // Non-fatal: log but do not fail the booking
            logger.warn("Failed to enqueue WhatsApp confirmation", {
              error: waError.message,
              bookingId: booking.booking_id,
            });
          }
        }

        // ── Enqueue reminder (scheduled for reminder_before_minutes before clinic) ──
        if (hs.send_whatsapp_reminder) {
          const workingHoursRow = await db
            .from("hospital_working_hours")
            .select("open_time")
            .eq("hospital_id", hospitalId)
            .eq("weekday", weekday)
            .single();

          if (workingHoursRow.data?.open_time) {
            const openTime = workingHoursRow.data.open_time as string;
            const reminderDate = new Date(
              `${body.appointmentDate}T${openTime}`,
            );
            reminderDate.setMinutes(
              reminderDate.getMinutes() - hs.reminder_before_minutes,
            );

            if (reminderDate > new Date()) {
              await db.rpc("enqueue_job", {
                p_job_type: "send_whatsapp_message",
                p_payload: {
                  template_name: "appointment_reminder",
                  booking_id: booking.booking_id,
                  phone: normalizedPhone,
                  token_number: booking.token_number,
                },
                p_priority: "normal",
                p_scheduled_at: reminderDate.toISOString(),
                p_idempotency_key: `wa_reminder_${booking.booking_id}`,
                p_hospital_id: hospitalId,
                p_booking_id: booking.booking_id,
              });
            }
          }
        }

        // ── Audit log ─────────────────────────────────────────────────────────
        // Fire-and-forget: never fails the booking
        logAuditEvent(
          {
            hospitalId,
            actorUserId: auth.userId,
            entityType: "booking",
            entityId: booking.booking_id,
            actionType: "booking_create",
            severity: "low",
            newData: {
              tokenNumber: booking.token_number,
              patientId: patient.id,
              bookingSource: body.bookingSource,
              appointmentDate: body.appointmentDate,
              doctorId: body.doctorId ?? null,
              totalAmount: feeRow.total_amount,
            },
          },
          logger,
        ).catch(() => {/* swallowed */});

        // ── Fetch booking reference ───────────────────────────────────────────
        const { data: bookingRow } = await db
          .from("bookings")
          .select("booking_reference")
          .eq("id", booking.booking_id)
          .single();

        const responseBody: CreateBookingResponse = {
          bookingId: booking.booking_id,
          tokenNumber: booking.token_number,
          bookingReference:
            (bookingRow as { booking_reference: string })?.booking_reference ??
              "",
          estimatedWaitMinutes,
          patientId: patient.id,
          appointmentDate: body.appointmentDate,
          queueSessionId,
          fees: {
            platformFee: feeRow.platform_fee,
            receptionistFee: feeRow.receptionist_fee,
            hospitalFee: feeRow.hospital_fee,
            totalAmount: feeRow.total_amount,
          },
        };

        return { statusCode: 201, body: responseBody };
      }, // end withIdempotency handler
    );

    // ── Emit metrics ──────────────────────────────────────────────────────────
    metrics.timing("request.total", elapsedMs(trace));
    metrics.increment(
      result.wasDuplicate ? "booking.duplicate" : "booking.created",
    );
    // ── P0.3: billable usage counters (best-effort, never blocks booking) ───
    if (!result.wasDuplicate) {
      const { error: usageError } = await getServiceClient().rpc(
        "record_subscription_usage",
        {
          p_hospital_id: hospitalId,
          p_metric: "booking",
        },
      );

      if (usageError) {
        logger.warn("Booking usage counter update failed", {
          hospitalId,
          error: usageError.message,
        });
      } else {
        metrics.increment("booking.usage_recorded");
      }
    }

    metrics.flush(logger);

    logger.info("Request completed", {
      statusCode: result.statusCode,
      wasDuplicate: result.wasDuplicate,
      durationMs: elapsedMs(trace),
    });

    return successResponse(
      result.body,
      trace.correlationId,
      req,
      { wasDuplicate: result.wasDuplicate },
      result.statusCode,
    );
  } catch (err) {
    metrics.increment("booking.error");
    metrics.timing("request.total", elapsedMs(trace));
    metrics.flush(logger);
    logger.error("Request failed", err, { durationMs: elapsedMs(trace) });
    return handleErrorResponse(err, trace.correlationId, req);
  }
});
