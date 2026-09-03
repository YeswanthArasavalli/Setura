/**
 * create-payment-order/index.ts
 *
 * Creates a Razorpay payment order for an existing booking.
 *
 * Flow:
 *   1. Validate JWT + hospital access + role
 *   2. Idempotency check (same booking cannot have two active orders)
 *   3. Load booking + validate payment-eligible status
 *   4. Resolve fees from hospital settings
 *   5. Call Razorpay Orders API
 *   6. Store payment_order row (immutable after creation)
 *   7. Return order details to frontend (for Razorpay SDK checkout)
 *
 * Security:
 *   - Razorpay key_secret never returned to client
 *   - Amount verified server-side against DB snapshot (never trust client amount)
 *   - Idempotent: same booking returns same order if already pending
 *
 * Concurrency:
 *   - UNIQUE (gateway_order_id) on payment_orders prevents duplicate orders
 *   - idempotency_key from booking ID prevents double-creation
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
import { parseBody } from "../_shared/validation.ts";
import { Env } from "../_shared/env.ts";
import type { Json } from "../_shared/types.ts";

const ENDPOINT = "create-payment-order";

const Schema = z.object({
  bookingId: z.string().uuid(),
});

// ─── Razorpay API helper ──────────────────────────────────────────────────────

interface RazorpayOrder {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  status: string;
  receipt: string;
}

async function createRazorpayOrder(
  amountPaise: number,
  currency: string,
  receipt: string,
  keyId: string,
  keySecret: string,
): Promise<RazorpayOrder> {
  const credentials = btoa(`${keyId}:${keySecret}`);

  const resp = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency,
      receipt,
      payment_capture: 1, // auto-capture
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({})) as Record<
      string,
      unknown
    >;
    const errMsg = (errBody.error as Record<string, unknown>)?.description ??
      `HTTP ${resp.status}`;
    throw new InternalError(`Razorpay order creation failed: ${errMsg}`, {
      status: resp.status,
      razorpayError: errBody,
    });
  }

  return resp.json() as Promise<RazorpayOrder>;
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
    requireRole(auth, ["receptionist", "hospital_admin", "global_admin"]);

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
        // ── Load booking ────────────────────────────────────────────────────
        const { data: booking, error: bookingErr } = await db
          .from("bookings")
          .select(
            "id, hospital_id, status, payment_completed, total_amount_snapshot, booking_reference, patient_name",
          )
          .eq("id", body.bookingId)
          .eq("is_deleted", false)
          .single();

        if (bookingErr || !booking) {
          throw new ValidationError("Booking not found", {
            bookingId: ["Not found"],
          });
        }
        if (booking.hospital_id !== hospitalId) {
          throw new ForbiddenError("Booking does not belong to this hospital");
        }
        if (booking.payment_completed) {
          throw new ValidationError("Booking is already paid", {
            bookingId: ["Payment already captured"],
          });
        }

        if (
          booking.status === "cancelled"
        ) {
          throw new ValidationError(
            "Cannot create payment order for cancelled booking",
            {
              bookingId: [
                "Booking cancelled",
              ],
            },
          );
        }

        if (
          booking.status === "completed"
        ) {
          throw new ValidationError(
            "Cannot create payment order for completed booking",
            {
              bookingId: [
                "Booking already completed",
              ],
            },
          );
        }

        const amountInr = Number(
          booking.total_amount_snapshot ??
            0,
        );

        if (
          !Number.isFinite(amountInr)
        ) {
          throw new InternalError(
            "Invalid booking amount",
          );
        }
        if (amountInr <= 0) {
          throw new ValidationError(
            "No payment required for this booking (zero fee)",
            {
              amount: ["Total amount is 0"],
            },
          );
        }
        const amountPaise = Math.round(amountInr * 100);

        // ── Check for existing pending order ────────────────────────────────
        const {
          data: existingOrders,
          error: existingOrderError,
        } = await db
          .from("payment_orders")
          .select(
            "id, gateway_order_id, amount_inr, created_at",
          )
          .eq("booking_id", body.bookingId)
          .in("payment_status", [
            "initiated",
            "pending",
            "authorized",
          ])
          .order("created_at", {
            ascending: false,
          })
          .limit(1);

        if (existingOrderError) {
          throw new InternalError(
            "Failed to check existing payment orders",
            {
              error: existingOrderError.message,
            },
          );
        }

        const existingOrder = existingOrders?.[0];

        if (existingOrder) {
          logger.info("Returning existing payment order", {
            orderId: existingOrder.gateway_order_id,
            bookingId: body.bookingId,
          });
          return {
            statusCode: 200,
            body: {
              paymentOrderId: existingOrder.id,
              razorpayOrderId: existingOrder.gateway_order_id,
              amountPaise,
              currency: "INR",
              bookingId: body.bookingId,
              bookingReference: booking.booking_reference,
              razorpayKeyId: Env.RAZORPAY_KEY_ID,
            },
          };
        }

        // ── Resolve hospital Razorpay credentials ───────────────────────────
        const {
          data: hs,
          error: hsError,
        } = await db
          .from("hospital_settings")
          .select(
            "razorpay_key_id, payment_enabled",
          )
          .eq("hospital_id", hospitalId)
          .single();

        if (hsError || !hs) {
          throw new InternalError(
            "Hospital settings not found",
            {
              error: hsError?.message,
            },
          );
        }

        if (!hs?.payment_enabled) {
          throw new ValidationError(
            "Payment is not enabled for this hospital",
            {
              payment: ["Contact SETURA support to enable payments"],
            },
          );
        }

        const keyId = Env.RAZORPAY_KEY_ID;
        const keySecret = Env.RAZORPAY_KEY_SECRET;
        if (!keyId || !keySecret) {
          throw new InternalError("Razorpay credentials not configured");
        }

        // ── Create Razorpay order ────────────────────────────────────────────
        const receipt = `SETURA-${booking.booking_reference}`;
        const orderTimer = metrics.startTimer("razorpay.create_order");
        const rzpOrder = await createRazorpayOrder(
          amountPaise,
          "INR",
          receipt,
          keyId,
          keySecret,
        );

        if (
          !rzpOrder.id ||
          rzpOrder.amount !== amountPaise
        ) {
          throw new InternalError(
            "Invalid Razorpay order response",
            {
              razorpayOrderId: rzpOrder.id,
              expectedAmount: amountPaise,
              actualAmount: rzpOrder.amount,
            },
          );
        }

        orderTimer.stop();

        logger.info("Razorpay order created", {
          razorpayOrderId: rzpOrder.id,
          amountPaise,
          bookingId: body.bookingId,
        });

        // ── Persist payment_order row ────────────────────────────────────────
        const { data: paymentOrder, error: poErr } = await db
          .from("payment_orders")
          .insert({
            hospital_id: hospitalId,
            booking_id: body.bookingId,
            patient_id: null,
            gateway: "razorpay",
            gateway_order_id: rzpOrder.id,
            amount_inr: amountInr,
            currency: "INR",
            payment_status: "initiated",
            idempotency_key: idempotencyKey,
            gateway_response: rzpOrder as unknown as Json,
          })
          .select("id")
          .single();

        if (poErr || !paymentOrder) {
          throw new InternalError("Failed to store payment order", {
            error: poErr?.message,
          });
        }

        // ── Audit ────────────────────────────────────────────────────────────
        await logAuditEvent({
          hospitalId,
          actorUserId: auth.userId,
          entityType: "payment_order",
          entityId: (paymentOrder as { id: string }).id,
          actionType: "payment_order_created",
          severity: "medium",
          newData: {
            bookingId: body.bookingId,
            razorpayOrderId: rzpOrder.id,
            amountInr,
          },
        }, logger);

        return {
          statusCode: 201,
          body: {
            paymentOrderId: (paymentOrder as { id: string }).id,
            razorpayOrderId: rzpOrder.id,
            amountPaise,
            currency: "INR",
            bookingId: body.bookingId,
            bookingReference: booking.booking_reference,
            razorpayKeyId: keyId, // public key — safe to send to client
          },
        };
      },
    );

    metrics.timing("request.total", elapsedMs(trace));
    metrics.increment(
      result.statusCode === 201
        ? "payment.order.created"
        : "payment.order.reused",
    );
    metrics.flush(logger);

    return successResponse(
      result.body,
      trace.correlationId,
      req,
      undefined,
      result.statusCode,
    );
  } catch (err) {
    metrics.increment("payment.order.error");
    logger.error("create-payment-order failed", err);
    return handleErrorResponse(err, trace.correlationId, req);
  }
});
