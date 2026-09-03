/**
 * send-whatsapp-message/index.ts
 * Meta Cloud API sender.
 * Worker-only endpoint protected by X-Worker-Secret.
 */

import { handleCors } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { handleErrorResponse, successResponse } from "../_shared/response.ts";
import { InternalError, ValidationError } from "../_shared/errors.ts";
import { Env } from "../_shared/env.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { parseBody } from "../_shared/validation.ts";
import { logAuditEvent } from "../_shared/audit.ts";
import type { Json } from "../_shared/types.ts";

const ENDPOINT = "send-whatsapp-message";

const ALLOWED_TEMPLATES = new Set([
  "booking_confirmation",
  "patient_called",
  "please_come_now",
  "appointment_reminder",
  "booking_cancelled",
  "booking_rescheduled",
  "carry_forward_notice",
  "feedback_request",
  "consultation_started",
  "consultation_completed",
]);

type TemplatePayload = {
  template_name?: string;
  phone: string;
  text?: string;
  idem_key?: string;
  booking_id?: string;
  patient_name?: string;
  token_number?: number;
  appointment_date?: string;
  new_date?: string;
  estimated_wait?: number | null;
  cancellation_reason?: string;
  wa_message_id?: string;
  hospital_id?: string;
};

const Schema = z.object({
  phone: z
    .string()
    .regex(
      /^\+?[1-9]\d{9,14}$/,
      "Invalid phone number",
    ),

  template_name: z.string().min(1).optional(),

  // Free-text session replies (Phase 1.1 conversational flows).
  // Sent inside the 24h session window; mutually exclusive with
  // template_name.
  text: z.string().min(1).max(4096).optional(),

  idem_key: z.string().min(1).max(200).optional(),

  booking_id: z.string().uuid().optional(),

  patient_name: z.string().optional(),

  token_number: z.number().optional(),

  appointment_date: z.string().optional(),

  new_date: z.string().optional(),

  estimated_wait: z.number().nullable().optional(),

  cancellation_reason: z.string().optional(),

  wa_message_id: z.string().uuid().optional(),

  hospital_id: z.string().uuid().optional(),
}).refine(
  (v: { text?: string; template_name?: string }) =>
    (v.text && v.text.length > 0) || (v.template_name ?? "").length > 0,
  { message: "Either text or template_name is required" },
);

function constantTimeEqual(
  a: string,
  b: string,
): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^
      b.charCodeAt(i);
  }

  return diff === 0;
}

function buildComponents(
  p: TemplatePayload,
): unknown[] {
  const vars = (texts: string[]) =>
    texts.map((text) => ({
      type: "text",
      text,
    }));

  switch (p.template_name) {
    case "booking_confirmation":
      return [
        {
          type: "body",
          parameters: vars([
            p.patient_name ?? "Patient",
            String(
              p.token_number ?? "",
            ),
            p.appointment_date ?? "",
            p.estimated_wait ? `~${p.estimated_wait} min` : "soon",
          ]),
        },
      ];

    case "patient_called":
    case "please_come_now":
      return [
        {
          type: "body",
          parameters: vars([
            p.patient_name ?? "Patient",
            String(
              p.token_number ?? "",
            ),
          ]),
        },
      ];

    case "appointment_reminder":
      return [
        {
          type: "body",
          parameters: vars([
            p.patient_name ?? "Patient",
            String(
              p.token_number ?? "",
            ),
            p.appointment_date ?? "",
          ]),
        },
      ];

    case "booking_cancelled":
      return [
        {
          type: "body",
          parameters: vars([
            p.patient_name ?? "Patient",
            p.cancellation_reason ??
              "Hospital request",
          ]),
        },
      ];

    case "booking_rescheduled":
    case "carry_forward_notice":
      return [
        {
          type: "body",
          parameters: vars([
            p.patient_name ?? "Patient",
            String(
              p.token_number ?? "",
            ),
            p.new_date ??
              p.appointment_date ??
              "",
          ]),
        },
      ];

    default:
      return [
        {
          type: "body",
          parameters: vars([
            p.patient_name ??
              "Patient",
          ]),
        },
      ];
  }
}

interface MetaResult {
  success: boolean;
  messageId?: string;
  error?: string;
  retryAfterMs?: number;
  isRateLimited: boolean;
  isPermanentFail: boolean;
}

async function callMeta(
  messageBody: Record<string, unknown>,
  phoneNumberId: string,
  accessToken: string,
  apiVersion: string,
): Promise<MetaResult> {
  let resp: Response;

  try {
    resp = await fetch(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(messageBody),
        signal: AbortSignal.timeout(
          15_000,
        ),
      },
    );
  } catch (e) {
    return {
      success: false,
      error: `Network error: ${e instanceof Error ? e.message : String(e)}`,
      isRateLimited: false,
      isPermanentFail: false,
    };
  }

  if (resp.status === 429) {
    const retryAfter = parseInt(
      resp.headers.get(
        "Retry-After",
      ) ?? "60",
      10,
    ) * 1000;

    return {
      success: false,
      error: "Meta rate limited",
      retryAfterMs: retryAfter,
      isRateLimited: true,
      isPermanentFail: false,
    };
  }

  let data: Record<
    string,
    unknown
  > = {};

  try {
    data = await resp.json();
  } catch {
    data = {};
  }

  if (!resp.ok) {
    const errObj = data.error as
      | Record<
        string,
        unknown
      >
      | undefined;

    const code = errObj?.code as
      | number
      | undefined;

    const permanentCodes = new Set([
      131047,
      131051,
      131052,
      131053,
      131056,
    ]);

    return {
      success: false,
      error: `Meta ${resp.status}: ${
        errObj?.message ??
          JSON.stringify(data)
      }`,
      isRateLimited: false,
      isPermanentFail: permanentCodes.has(
        code ?? 0,
      ) ||
        resp.status === 400,
    };
  }

  const messages = Array.isArray(
      data.messages,
    )
    ? (data.messages as Array<{
      id: string;
    }>)
    : [];

  return {
    success: true,
    messageId: messages[0]?.id,
    isRateLimited: false,
    isPermanentFail: false,
  };
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

    let payload:
      | TemplatePayload
      | undefined;

    try {
      const workerSecret = req.headers.get(
        "X-Worker-Secret",
      ) ?? "";

      const expectedSecret = Env.WORKER_SECRET ?? "";

      if (
        !workerSecret ||
        !expectedSecret ||
        !constantTimeEqual(
          workerSecret,
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

      payload = await parseBody(
        req,
        Schema,
      ) as TemplatePayload;

      // Free-text session replies bypass the template allowlist
      // (they are only ever enqueued by the conversation engine).
      const isSessionText = typeof payload.text === "string" &&
        payload.text.length > 0;

      if (
        !isSessionText &&
        !ALLOWED_TEMPLATES.has(
          payload.template_name ?? "",
        )
      ) {
        throw new ValidationError(
          "Unsupported template",
          {
            template_name: [
              payload.template_name ?? "",
            ],
          },
        );
      }

      const db = getServiceClient();

      let phoneNumberId = Env.META_PHONE_NUMBER_ID;

      const accessToken = Env.META_ACCESS_TOKEN;

      if (
        payload.hospital_id
      ) {
        const {
          data: hs,
          error: hsError,
        } = await db
          .from(
            "hospital_settings",
          )
          .select(`
            meta_phone_number_id
          `)
          .eq(
            "hospital_id",
            payload.hospital_id,
          )
          .maybeSingle();

        if (hsError) {
          logger.warn(
            "Failed loading hospital settings",
            {
              hospitalId: payload.hospital_id,
              error: hsError.message,
            },
          );
        }

        if (
          hs?.meta_phone_number_id
        ) {
          phoneNumberId = hs.meta_phone_number_id;
        }
      }

      if (
        !phoneNumberId ||
        !accessToken
      ) {
        throw new InternalError(
          "Meta credentials not configured",
        );
      }

      // ── Resolve / create the whatsapp_messages record ────────────────
      // Duplicate-send protection: the record is idempotent on its key
      // and terminal states short-circuit before any Meta call.
      let waMessageId: string | null = null;

      if (payload.wa_message_id) {
        waMessageId = payload.wa_message_id;
      } else if (payload.hospital_id) {
        const idemKey = isSessionText
          ? (payload.idem_key ?? `session_reply_${payload.phone}`)
          : payload.booking_id
          ? `${payload.template_name}_${payload.booking_id}`
          : `${payload.template_name}_${payload.phone}`;

        const { data: queuedId, error: queueError } = await db.rpc(
          "queue_whatsapp_message",
          {
            p_hospital_id: payload.hospital_id,
            // SQL params accept NULL; generated types are string-only
            p_patient_id: null as unknown as string,
            p_booking_id: (payload.booking_id ?? null) as unknown as string,
            p_phone: payload.phone,
            p_template_name: isSessionText
              ? "session_reply"
              : (payload.template_name ?? ""),
            p_message_text: isSessionText ? (payload.text ?? "") : "",
            p_idempotency_key: idemKey,
          },
        );

        if (queueError) {
          logger.warn("WhatsApp message bookkeeping failed", {
            error: queueError.message,
            idempotencyKey: idemKey,
          });
        } else if (queuedId) {
          waMessageId = queuedId as string;
        }
      }

      if (waMessageId) {
        const { data: existingMsg } = await db
          .from("whatsapp_messages")
          .select("message_status, whatsapp_message_id")
          .eq("id", waMessageId)
          .maybeSingle();

        const existing = existingMsg as {
          message_status?: string;
          whatsapp_message_id?: string | null;
        } | null;

        // Terminal states never re-send
        if (
          existing?.message_status === "sent" ||
          existing?.message_status === "delivered" ||
          existing?.message_status === "read" ||
          existing?.message_status === "permanently_failed"
        ) {
          metrics.increment("whatsapp.duplicate_send_blocked");
          metrics.flush(logger);

          return successResponse(
            {
              sent: existing.message_status !== "permanently_failed",
              duplicate: true,
              messageStatus: existing.message_status,
              messageId: existing.whatsapp_message_id ?? null,
              messageRecordId: waMessageId,
            },
            trace.correlationId,
            req,
          );
        }

        // Mark processing so concurrent claims and crash recovery
        // can reason about in-flight sends
        await db
          .from("whatsapp_messages")
          .update({
            message_status: "processing",
            processing_started_at: new Date().toISOString(),
          })
          .eq("id", waMessageId);
      }

      const to = payload.phone
        .replace(/^\+/, "")
        .replace(/\D/g, "");

      let messageBody: Record<string, unknown>;

      if (isSessionText) {
        messageBody = {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: {
            preview_url: false,
            body: payload.text,
          },
        };
      } else {
        const components = buildComponents(
          payload,
        );

        if (
          components.length ===
            0
        ) {
          throw new ValidationError(
            "Template has no components",
            {
              template_name: [
                payload.template_name ?? "",
              ],
            },
          );
        }

        messageBody = {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "template",
          template: {
            name: payload.template_name,
            language: {
              code: "en",
            },
            components,
          },
        };
      }

      const timer = metrics.startTimer(
        "meta.send",
      );

      const result = await callMeta(
        messageBody,
        phoneNumberId,
        accessToken,
        Env.META_API_VERSION,
      );

      timer.stop();

      logger.info(
        "Meta result",
        {
          success: result.success,
          messageId: result.messageId,
          isRateLimited: result.isRateLimited,
          isPermanentFail: result.isPermanentFail,
          template: payload.template_name,
        },
      );

      if (
        result.isRateLimited
      ) {
        metrics.increment(
          "whatsapp.rate_limited",
        );
      }

      if (
        result.isPermanentFail
      ) {
        metrics.increment(
          "whatsapp.permanent_fail",
        );
      }

      // ── Post-send bookkeeping ────────────────────────────────────────
      if (waMessageId) {
        const nowIso = new Date().toISOString();

        if (result.success) {
          const { error: sentError } = await db
            .from("whatsapp_messages")
            .update({
              message_status: "sent",
              whatsapp_message_id: result.messageId ?? null,
              sent_at: nowIso,
              error_message: null,
            })
            .eq("id", waMessageId);

          if (sentError) {
            logger.warn("Failed recording sent WhatsApp message", {
              waMessageId,
              error: sentError.message,
            });
          } else {
            metrics.increment("whatsapp.bookkeeping.sent");
          }

          // Booking notification flags
          const flagColumn = payload.template_name === "booking_confirmation"
            ? "whatsapp_confirmation_sent"
            : payload.template_name === "appointment_reminder"
            ? "whatsapp_reminder_sent"
            : null;

          if (flagColumn && payload.booking_id) {
            const { error: flagError } = await db
              .from("bookings")
              .update({ [flagColumn]: true })
              .eq("id", payload.booking_id);

            if (flagError) {
              logger.warn("Failed updating booking notification flag", {
                bookingId: payload.booking_id,
                flag: flagColumn,
                error: flagError.message,
              });
            }
          }

          // Billable usage counter (best-effort)
          if (payload.hospital_id) {
            const { error: usageError } = await db.rpc(
              "record_subscription_usage",
              {
                p_hospital_id: payload.hospital_id,
                p_metric: "whatsapp_message",
              },
            );

            if (usageError) {
              logger.warn("Usage counter update failed", {
                metric: "whatsapp_message",
                error: usageError.message,
              });
            }
          }
        } else {
          // Failure path: preserve retry history, then classify
          const { data: failRow } = await db
            .from("whatsapp_messages")
            .select("metadata")
            .eq("id", waMessageId)
            .maybeSingle();

          const failMeta = ((failRow as {
            metadata?: Record<string, unknown> | null;
          } | null)?.metadata ?? {}) as Record<string, unknown>;

          const retryHistory = Array.isArray(failMeta.retry_history)
            ? (failMeta.retry_history as unknown[])
            : [];

          retryHistory.push({
            at: nowIso,
            error: result.error ?? "Send failed",
            retryable: !result.isPermanentFail,
            rate_limited: result.isRateLimited,
          });

          const { error: metaError } = await db
            .from("whatsapp_messages")
            .update({
              metadata: {
                ...failMeta,
                retry_history: retryHistory,
              } as unknown as Json,
              error_message: result.error ?? "Send failed",
            })
            .eq("id", waMessageId);

          if (metaError) {
            logger.warn("Failed persisting WhatsApp failure metadata", {
              waMessageId,
              error: metaError.message,
            });
          }

          if (result.isPermanentFail) {
            const { error: permError } = await db
              .from("whatsapp_messages")
              .update({
                message_status: "permanently_failed",
                failed_at: nowIso,
              })
              .eq("id", waMessageId);

            if (permError) {
              logger.warn("Failed marking message permanently failed", {
                waMessageId,
                error: permError.message,
              });
            }

            metrics.increment("whatsapp.bookkeeping.permanent_fail");

            if (payload.hospital_id) {
              await logAuditEvent({
                hospitalId: payload.hospital_id,
                actorUserId: "system",
                entityType: "whatsapp_message",
                entityId: waMessageId,
                actionType: "whatsapp_send",
                severity: "medium",
                newData: {
                  outcome: "permanently_failed",
                  template: payload.template_name,
                  bookingId: payload.booking_id ?? null,
                  error: result.error ?? "Permanent Meta failure",
                },
              }, logger).catch((auditErr) => {
                logger.warn("Audit log failed", {
                  error: String(auditErr),
                });
              });
            }
          } else {
            // Retryable: exponential backoff via the messaging engine.
            // Returns false once max_retries is exhausted (the RPC then
            // marks the row permanently_failed itself).
            const { data: retryScheduled, error: retryError } = await db.rpc(
              "schedule_whatsapp_retry",
              {
                p_message_id: waMessageId,
                p_error: result.error ?? "Send failed",
              },
            );

            if (retryError) {
              logger.warn("Retry scheduling failed", {
                waMessageId,
                error: retryError.message,
              });
            } else if (retryScheduled === false) {
              metrics.increment("whatsapp.bookkeeping.retries_exhausted");
            } else {
              metrics.increment("whatsapp.bookkeeping.retry_scheduled");
            }
          }
        }
      }

      metrics.increment(
        result.success ? "whatsapp.sent" : "whatsapp.failed",
      );

      metrics.timing(
        "request.total",
        elapsedMs(trace),
      );

      metrics.flush(
        logger,
      );

      if (!result.success) {
        throw new InternalError(
          result.error ??
            "WhatsApp send failed",
          {
            isRateLimited: result.isRateLimited,
            isPermanentFail: result.isPermanentFail,
            retryAfterMs: result.retryAfterMs,
          },
        );
      }

      return successResponse(
        {
          sent: true,
          messageId: result.messageId,
          messageRecordId: waMessageId,
        },
        trace.correlationId,
        req,
      );
    } catch (err) {
      metrics.increment(
        "whatsapp.error",
      );

      logger.error(
        "send-whatsapp-message failed",
        err,
        {
          template: payload
            ?.template_name,
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
