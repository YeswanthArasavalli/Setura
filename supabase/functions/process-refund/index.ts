/**
 * process-refund/index.ts
 *
 * Initiates a refund for a captured payment via Razorpay Refunds API.
 * Marks the booking as cancelled. Writes to financial_ledger on confirmation.
 *
 * Idempotent: same booking_id returns existing refund if already initiated.
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
import { getRazorpayKeySecret } from "../_shared/integration_secrets.ts";
import {
  ForbiddenError,
  InternalError,
  ValidationError,
} from "../_shared/errors.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { parseBody } from "../_shared/validation.ts";
import { Env } from "../_shared/env.ts";
import type { Json } from "../_shared/types.ts";

const ENDPOINT = "process-refund";

const Schema = z.object({
  bookingId: z.string().uuid(),
  reason: z.string().min(3).max(500),
  fullRefund: z.boolean().default(true),
  amountInr: z.number().positive().optional(),
});

type RefundStatus =
  | "cancelled"
  | "pending"
  | "processing"
  | "failed"
  | "processed";

async function callRazorpayRefund(
  gatewayPaymentId: string,
  amountPaise: number,
  keyId: string,
  keySecret: string,
  notes: Record<string, string>,
): Promise<{
  id: string;
  status: string;
}> {
  const creds = btoa(
    `${keyId}:${keySecret}`,
  );

  let resp: Response;

  try {
    resp = await fetch(
      `https://api.razorpay.com/v1/payments/${gatewayPaymentId}/refund`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${creds}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: amountPaise,
          notes,
        }),
        signal: AbortSignal.timeout(
          15000,
        ),
      },
    );
  } catch (err) {
    throw new InternalError(
      "Razorpay refund request failed",
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  if (!resp.ok) {
    const err = await resp.json()
      .catch(() => ({})) as Record<string, unknown>;

    throw new InternalError(
      `Razorpay refund failed: ${
        (
          err.error as Record<
            string,
            unknown
          >
        )?.description ??
          resp.status
      }`,
    );
  }

  return resp.json();
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

  try {
    const hospitalId = req.headers.get("X-Hospital-ID");
    if (!hospitalId) {
      throw new ValidationError("Missing X-Hospital-ID header", {
        header: ["Required"],
      });
    }
    const idempotencyKey = extractIdempotencyKey(req, true)!;
    const auth = await resolveAuth(req, hospitalId, logger);
    requireRole(auth, ["hospital_admin", "global_admin"]);

    const body = await parseBody(req, Schema);
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
        // Load booking + payment order
        const {
          data: booking,
          error: bookingError,
        } = await db
          .from("bookings")
          .select(
            `
            id,
            hospital_id,
            payment_completed,
            total_amount_snapshot
            `,
          )
          .eq("id", body.bookingId)
          .eq("is_deleted", false)
          .single();

        if (bookingError || !booking) {
          throw new ValidationError(
            "Booking not found",
            {
              bookingId: ["Not found"],
            },
          );
        }
        if (booking.hospital_id !== hospitalId) {
          throw new ForbiddenError("Hospital mismatch");
        }
        if (!booking.payment_completed) {
          throw new ValidationError(
            "Booking has no captured payment to refund",
            {
              payment: ["No payment has been captured for this booking"],
            },
          );
        }

        const {
          data: paymentOrder,
          error: paymentOrderError,
        } = await db
          .from("payment_orders")
          .select(
            `
            id,
            gateway_payment_id,
            amount_inr,
            payment_status
            `,
          )
          .eq("booking_id", body.bookingId)
          // F3B-01: accept the same refundable states the canonical SQL
          // path (initiate_refund, migration 60) allows — 'captured' and
          // 'partially_refunded' — so sequential partial refunds reach the
          // DB. The cumulative total_refunded <= total_collected cap in SQL
          // remains the authoritative guard; this prefetch only routes to it.
          .in("payment_status", ["captured", "partially_refunded"])
          .maybeSingle();

        if (paymentOrderError || !paymentOrder) {
          throw new ValidationError("No refundable payment found", {
            bookingId: ["Payment not in a refundable state"],
          });
        }

        // D16 (Q2): the canonical refund basis is the amount SETURA
        // actually collected on this payment order (payment_orders
        // .amount_inr == booking_fee_inr once create-payment-order
        // charges the platform fee), NOT the booking display total.
        // Every refund path (direct, cancel-booking, WhatsApp) shares
        // this basis; initiate_refund additionally enforces the
        // cumulative total_refunded <= total_collected invariant.
        const totalInr = Number(paymentOrder.amount_inr);
        const refundInr = body.fullRefund
          ? totalInr
          : (body.amountInr ?? totalInr);

        if (
          !body.fullRefund &&
          refundInr < 1
        ) {
          throw new ValidationError(
            "Refund amount too small",
            {
              amountInr: [
                "Minimum refund amount is ₹1",
              ],
            },
          );
        }

        if (refundInr > totalInr) {
          throw new ValidationError("Refund amount exceeds captured amount", {
            amountInr: [`Maximum refundable: ₹${totalInr}`],
          });
        }

        // Check existing refund (idempotent)
        const { data: existingRefund } = await db
          .from("payment_refunds")
          .select("id, refund_status, gateway_refund_id")
          .eq("booking_id", body.bookingId)
          .in("refund_status", ["pending", "processing", "processed"])
          .single();

        if (existingRefund) {
          return {
            statusCode: 200,
            body: {
              refundId: existingRefund.id,
              gatewayRefundId: existingRefund.gateway_refund_id,
              refundStatus: existingRefund.refund_status as RefundStatus,
              amountInr: refundInr,
              alreadyInitiated: true,
            },
          };
        }

        // Initiate DB refund record first (before calling Razorpay)
        const { data: refundRecord, error: refundErr } = await db
          .rpc("initiate_refund", {
            p_booking_id: body.bookingId,
            p_refund_amount_inr: refundInr,
            p_refund_reason: body.reason,
            p_initiated_by: auth.userId,
          });

        if (refundErr) {
          throw new InternalError("Failed to initiate refund record", {
            error: refundErr.message,
          });
        }
        const refundId = refundRecord as string;

        // Call Razorpay Refunds API
        const keyId = Env.RAZORPAY_KEY_ID;
        // WS-ONBOARD-3: Vault-first key_secret resolution with env fallback.
        const keySecret = await getRazorpayKeySecret(db, logger);
        if (!keyId || !keySecret) {
          throw new InternalError("Razorpay credentials not configured");
        }

        const refundPaise = Math.round(refundInr * 100);
        const rzpRefund = await callRazorpayRefund(
          paymentOrder.gateway_payment_id as string,
          refundPaise,
          keyId,
          keySecret,
          { refund_id: refundId },
        );

        // Confirm processed if Razorpay returns immediately processed
        if (rzpRefund.status === "processed") {
          const { data: confirmed, error: confirmErr } = await db.rpc(
            "confirm_refund_processed",
            {
              p_refund_id: refundId,
              p_gateway_refund_id: rzpRefund.id,
              p_gateway_response: rzpRefund as unknown as Json,
            },
          );

          if (confirmErr) {
            throw new InternalError("Failed to confirm refund processing", {
              error: confirmErr.message,
            });
          }

          metrics.increment(
            confirmed === false
              ? "payment.refund.confirm_duplicate"
              : "payment.refund.confirmed",
          );
        } else {
          // Update refund record with gateway ID (webhook will confirm later)
          await db.from("payment_refunds")
            .update({
              gateway_refund_id: rzpRefund.id,
              refund_status: "processing",
            })
            .eq("id", refundId);
        }

        await logAuditEvent({
          hospitalId,
          actorUserId: auth.userId,
          entityType: "payment_refund",
          entityId: refundId,
          actionType: "payment_refund",
          severity: "high",
          newData: {
            bookingId: body.bookingId,
            refundInr,
            gatewayRefundId: rzpRefund.id,
            reason: body.reason,
          },
        }, logger);

        return {
          statusCode: 201,
          body: {
            refundId,
            gatewayRefundId: rzpRefund.id,
            refundStatus: rzpRefund.status as RefundStatus,
            amountInr: refundInr,
            alreadyInitiated: false,
          },
        };
      },
    );

    metrics.increment(
      result.body.alreadyInitiated
        ? "payment.refund.duplicate"
        : "payment.refund.initiated",
    );
    metrics.timing("request.total", elapsedMs(trace));
    metrics.flush(logger);

    return successResponse(
      result.body,
      trace.correlationId,
      req,
      undefined,
      result.statusCode,
    );
  } catch (err) {
    metrics.increment(
      "payment.refund.error",
    );

    logger.error(
      "process-refund failed",
      err,
    );

    return handleErrorResponse(
      err,
      trace.correlationId,
      req,
    );
  }
});
