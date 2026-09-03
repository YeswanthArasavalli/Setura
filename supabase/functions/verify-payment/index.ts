/**
 * verify-payment/index.ts
 *
 * Handles Razorpay payment webhook events and verifies payment capture.
 * This is the canonical handler for all Razorpay webhook events.
 *
 * Two call patterns:
 *   1. Razorpay webhook (POST from Razorpay servers) — event-driven
 *   2. Frontend callback verification (POST from browser after checkout) — synchronous
 *
 * Security:
 *   - Webhook: X-Razorpay-Signature HMAC-SHA256 verified
 *   - Frontend: payment signature verified with HMAC(order_id|payment_id, key_secret)
 *   - Both paths use idempotent_capture_payment() — safe to call multiple times
 *   - key_secret never exposed; used server-side only
 *
 * Concurrency:
 *   - idempotent_capture_payment() wraps register_webhook_event_v2() (hash dedup)
 *   - Two simultaneous webhook deliveries for the same payment → only one processes
 *   - Financial ledger write is atomic within capture_payment() SQL function
 */

import { handleCors } from "../_shared/cors.ts";
import { requireRole, resolveAuth } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { logAuditEvent } from "../_shared/audit.ts";
import { handleErrorResponse, successResponse } from "../_shared/response.ts";
import type { Json } from "../_shared/types.ts";
import { InternalError, ValidationError } from "../_shared/errors.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { parseBody } from "../_shared/validation.ts";
import { Env } from "../_shared/env.ts";

const ENDPOINT = "verify-payment";

// ─── HMAC-SHA256 helper ───────────────────────────────────────────────────────

async function hmacSha256(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(sig)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

async function verifyWebhookSignature(
  rawBody: string,
  signature: string,
): Promise<boolean> {
  const expected = await hmacSha256(rawBody, Env.RAZORPAY_KEY_SECRET);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyPaymentSignature(
  orderId: string,
  paymentId: string,
  providedSignature: string,
): Promise<boolean> {
  if (!Env.RAZORPAY_KEY_SECRET) {
    throw new InternalError(
      "Razorpay key secret not configured",
    );
  }

  const message = `${orderId}|${paymentId}`;

  const expectedSignature = await hmacSha256(
    message,
    Env.RAZORPAY_KEY_SECRET,
  );

  // Constant-time comparison
  if (
    expectedSignature.length !==
      providedSignature.length
  ) {
    return false;
  }

  let diff = 0;

  for (
    let i = 0;
    i < expectedSignature.length;
    i++
  ) {
    diff |= expectedSignature.charCodeAt(i) ^
      providedSignature.charCodeAt(i);
  }

  return diff === 0;
}

async function computeHash(body: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(buf)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

// ─── Frontend verify schema (browser callback after Razorpay checkout) ────────

const FrontendVerifySchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().min(1),
  bookingId: z.string().uuid(),
});

// ─── Process captured payment ─────────────────────────────────────────────────

async function processCapturedPayment(
  db: ReturnType<typeof getServiceClient>,
  gatewayOrderId: string,
  gatewayPaymentId: string,
  gatewaySignature: string,
  rawPayload: Record<string, unknown>,
  logger: ReturnType<typeof createRequestLogger>,
  _correlationId: string,
): Promise<{ success: boolean; wasDuplicate: boolean; bookingId?: string }> {
  const payloadHash = await computeHash(JSON.stringify(rawPayload));

  const { data: captureResult, error: captureError } = await db.rpc(
    "idempotent_capture_payment",
    {
      p_provider_event_id: gatewayPaymentId,
      p_payload_hash: payloadHash,
      p_raw_payload: rawPayload as unknown as Json,
      p_gateway_order_id: gatewayOrderId,
      p_gateway_payment_id: gatewayPaymentId,
      p_gateway_signature: gatewaySignature,
    },
  );

  if (captureError) {
    logger.error("Payment capture RPC failed", captureError);
    return { success: false, wasDuplicate: false };
  }

  const result = (captureResult as Array<{
    success: boolean;
    was_duplicate: boolean;
    message: string;
  }>)?.[0];

  if (!result?.success && !result?.was_duplicate) {
    logger.warn("Payment capture returned failure", {
      message: result?.message,
    });
    return { success: false, wasDuplicate: false };
  }

  // Fetch booking ID from payment order for audit
  const { data: po } = await db
    .from("payment_orders")
    .select("booking_id")
    .eq("gateway_payment_id", gatewayPaymentId)
    .single();

  return {
    success: result.success || result.was_duplicate,
    wasDuplicate: result.was_duplicate,
    bookingId: (po as { booking_id: string } | null)?.booking_id,
  };
}

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
  const db = getServiceClient();

  // ── Determine call source: Razorpay webhook vs frontend verify ───────────

  const razorpaySignatureHeader = req.headers.get("X-Razorpay-Signature");
  const isWebhook = !!razorpaySignatureHeader;

  try {
    if (isWebhook) {
      // ── WEBHOOK PATH ──────────────────────────────────────────────────────
      const rawBody = await req.text();

      // Verify HMAC signature
      if (!Env.RAZORPAY_KEY_SECRET) {
        throw new InternalError("Razorpay key secret not configured");
      }

      const valid = await verifyWebhookSignature(
        rawBody,
        razorpaySignatureHeader!,
      );
      if (!valid) {
        logger.warn("Razorpay webhook signature verification failed");
        return new Response("Forbidden", { status: 403 });
      }

      const payload = JSON.parse(rawBody) as Record<string, unknown>;
      const eventType = typeof payload.event === "string" ? payload.event : "";

      logger.info("Razorpay webhook received", { eventType });

      // Only process payment.captured events
      if (eventType === "payment.captured") {
        const payloadData = payload.payload as
          | Record<string, unknown>
          | undefined;

        const paymentEntity = payloadData?.payment as
          | Record<string, unknown>
          | undefined;

        const payment = paymentEntity?.entity as
          | Record<string, unknown>
          | undefined;

        if (
          !payment ||
          typeof payment.id !== "string" ||
          typeof payment.order_id !== "string"
        ) {
          logger.warn(
            "Malformed Razorpay payment payload",
          );

          return new Response(
            JSON.stringify({ status: "ok" }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
              },
            },
          );
        }

        if (!payment) {
          return new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
          });
        }

        const result = await processCapturedPayment(
          db,
          payment.order_id as string,
          payment.id as string,
          razorpaySignatureHeader!,
          payload,
          logger,
          trace.correlationId,
        );

        if (result.success && !result.wasDuplicate && result.bookingId) {
          await logAuditEvent({
            hospitalId: null,
            actorUserId: "razorpay_webhook",
            entityType: "payment_order",
            entityId: result.bookingId,
            actionType: "payment_capture",
            severity: "high",
            newData: {
              gatewayPaymentId: payment.id,
              gatewayOrderId: payment.order_id,
              amount: payment.amount,
            },
          }, logger);

          // Enqueue settlement job
          await db.rpc("enqueue_job", {
            p_job_type: "compute_sla",
            p_payload: { booking_id: result.bookingId },
            p_priority: "low",
            p_scheduled_at: new Date(Date.now() + 60_000).toISOString(),
            p_idempotency_key: `post_payment_sla_${payment.id}`,
          });
        }

        metrics.increment(
          result.success ? "payment.captured" : "payment.capture_failed",
        );
      }

      if (eventType === "refund.processed") {
        const refundEntity = (payload.payload as Record<string, unknown>)
          ?.refund as Record<string, unknown>;
        const refund = refundEntity?.entity as Record<string, unknown>;

        if (refund?.id) {
          const refundNotes = typeof refund.notes === "object" &&
              refund.notes !== null
            ? refund.notes as Record<string, unknown>
            : {};

          let refundId = typeof refundNotes.refund_id === "string"
            ? refundNotes.refund_id
            : undefined;

          // Fallback reconciliation when notes are missing
          if (!refundId) {
            const { data: matchedRefund } = await db
              .from("payment_refunds")
              .select("id")
              .eq("gateway_refund_id", refund.id as string)
              .maybeSingle();

            refundId = (matchedRefund as { id: string } | null)?.id ??
              undefined;
          }

          if (refundId) {
            // Dedupe webhook replays before applying any state change
            const payloadHash = await computeHash(rawBody);
            const { data: regRows, error: regError } = await db.rpc(
              "register_webhook_event_v2",
              {
                p_provider: "razorpay",
                p_provider_event_id: `refund_${refund.id}`,
                p_event_type: "refund.processed",
                p_payload_hash: payloadHash,
                p_raw_payload: payload as unknown as Json,
              },
            );

            const reg = (regRows as
              | Array<{
                is_new: boolean;
                event_id: string;
              }>
              | null)?.[0];

            if (regError) {
              logger.warn("Refund webhook dedupe registration failed", {
                error: regError.message,
              });
            }

            if (reg && reg.is_new === false) {
              metrics.increment("payment.refund.webhook_duplicate");
              logger.info("Duplicate refund webhook ignored", {
                gatewayRefundId: refund.id,
              });
            } else {
              const { data: confirmed, error: refundErr } = await db.rpc(
                "confirm_refund_processed",
                {
                  p_refund_id: refundId,
                  p_gateway_refund_id: refund.id as string,
                  p_gateway_response: payload as unknown as Json,
                },
              );

              if (refundErr) {
                logger.warn(
                  "Failed to confirm refund processing",
                  {
                    refundId,
                    gatewayRefundId: refund.id,
                    error: refundErr.message,
                  },
                );
                metrics.increment("payment.refund.webhook_error");

                if (reg?.event_id) {
                  await db.rpc("fail_webhook_event", {
                    p_event_id: reg.event_id,
                    p_error: refundErr.message,
                  });
                }
              } else {
                metrics.increment(
                  confirmed === false
                    ? "payment.refund.webhook_already_processed"
                    : "payment.refund.webhook_confirmed",
                );

                if (confirmed === true) {
                  const { data: refundRow } = await db
                    .from("payment_refunds")
                    .select(
                      "booking_id, hospital_id, refund_amount_inr",
                    )
                    .eq("id", refundId)
                    .maybeSingle();

                  const rr = refundRow as {
                    booking_id: string;
                    hospital_id: string;
                    refund_amount_inr: number;
                  } | null;

                  await logAuditEvent({
                    hospitalId: rr?.hospital_id ?? null,
                    actorUserId: "razorpay_webhook",
                    entityType: "payment_refund",
                    entityId: refundId,
                    actionType: "payment_refund",
                    severity: "high",
                    newData: {
                      source: "webhook",
                      bookingId: rr?.booking_id ?? null,
                      gatewayRefundId: refund.id,
                      amountInr: rr?.refund_amount_inr ?? null,
                    },
                  }, logger);
                }

                if (reg?.event_id) {
                  await db.rpc("complete_webhook_event", {
                    p_event_id: reg.event_id,
                  });
                }
              }
            }
          } else {
            logger.warn(
              "Refund webhook could not be matched",
              {
                gatewayRefundId: refund.id,
              },
            );
            metrics.increment("payment.refund.webhook_unmatched");
          }
        }
      }

      // Always return 200 to Razorpay — prevents infinite retries
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } else {
      // ── FRONTEND VERIFY PATH ──────────────────────────────────────────────
      const hospitalId = req.headers.get("X-Hospital-ID");
      if (!hospitalId) {
        throw new ValidationError("Missing X-Hospital-ID header", {
          header: ["Required"],
        });
      }

      const auth = await resolveAuth(req, hospitalId, logger);
      requireRole(auth, ["receptionist", "hospital_admin", "global_admin"]);

      const body = await parseBody(req, FrontendVerifySchema);

      const { data: booking } = await db
        .from("bookings")
        .select(`
          id,
          hospital_id
        `)
        .eq("id", body.bookingId)
        .single();

      if (!booking) {
        throw new ValidationError(
          "Booking not found",
          {
            bookingId: ["Invalid booking"],
          },
        );
      }

      if (booking.hospital_id !== hospitalId) {
        throw new ValidationError(
          "Booking does not belong to hospital",
          {
            bookingId: [
              "Cross-hospital access denied",
            ],
          },
        );
      }

      // Verify Razorpay payment signature
      const signatureValid = await verifyPaymentSignature(
        body.razorpayOrderId,
        body.razorpayPaymentId,
        body.razorpaySignature,
      );

      if (!signatureValid) {
        throw new ValidationError("Payment signature verification failed", {
          razorpaySignature: ["Invalid signature"],
        });
      }

      const result = await processCapturedPayment(
        db,
        body.razorpayOrderId,
        body.razorpayPaymentId,
        body.razorpaySignature,
        {
          order_id: body.razorpayOrderId,
          payment_id: body.razorpayPaymentId,
          signature: body.razorpaySignature,
        },
        logger,
        trace.correlationId,
      );

      if (!result.success && !result.wasDuplicate) {
        throw new InternalError("Payment verification failed");
      }

      if (result.success && !result.wasDuplicate) {
        await logAuditEvent({
          hospitalId,
          actorUserId: auth.userId,
          entityType: "payment_order",
          entityId: result.bookingId,
          actionType: "payment_capture",
          severity: "high",
          newData: {
            gatewayPaymentId: body.razorpayPaymentId,
            gatewayOrderId: body.razorpayOrderId,
            bookingId: body.bookingId,
          },
        }, logger);
      }

      metrics.increment(
        result.wasDuplicate ? "payment.verify.duplicate" : "payment.verified",
      );
      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);

      return successResponse(
        {
          verified: true,
          wasDuplicate: result.wasDuplicate,
          bookingId: body.bookingId,
        },
        trace.correlationId,
        req,
      );
    }
  } catch (err) {
    metrics.increment("payment.verify.error");
    logger.error("verify-payment failed", err);
    if (isWebhook) {
      return new Response(JSON.stringify({ status: "error" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return handleErrorResponse(err, trace.correlationId, req);
  }
});
