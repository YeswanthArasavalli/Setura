/**
 * process-whatsapp-webhook/index.ts
 *
 * GET:
 *   Meta webhook verification challenge
 *
 * POST:
 *   Delivery receipts
 *   Read receipts
 *   Incoming WhatsApp messages
 *
 * Signature enforcement is FAIL-CLOSED. A POST is processed only when
 * X-Hub-Signature-256 is present, well-formed and matches an HMAC of the
 * raw body keyed by META_APP_SECRET. Unsigned requests are rejected.
 *
 * Once a request is proven to come from Meta, internal processing
 * failures return HTTP 200 to prevent endless webhook retries.
 */

import { handleCors } from "../_shared/cors.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { Env } from "../_shared/env.ts";
import {
  constantTimeEqual,
  signatureFailureStatus,
  verifyMetaSignature,
} from "../_shared/webhook_signature.ts";
import type { Json } from "../_shared/types.ts";

const ENDPOINT = "process-whatsapp-webhook";

type WebhookEventRow = {
  is_new: boolean;
  event_id: string;
};

async function bodyHash(
  body: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );

  return Array.from(
    new Uint8Array(digest),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const OK_200 = (
  status = "ok",
): Response =>
  new Response(
    JSON.stringify({ status }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
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

    //
    // GET
    // Meta verification challenge
    //
    if (req.method === "GET") {
      const url = new URL(req.url);

      const mode = url.searchParams.get(
        "hub.mode",
      ) ?? "";

      const token = url.searchParams.get(
        "hub.verify_token",
      ) ?? "";

      const challenge = url.searchParams.get(
        "hub.challenge",
      ) ?? "";

      const expected = Env.META_WEBHOOK_VERIFY_TOKEN;

      if (!expected) {
        logger.error(
          "META_WEBHOOK_VERIFY_TOKEN missing",
        );

        return new Response(
          "Server Misconfigured",
          {
            status: 500,
          },
        );
      }

      if (
        mode === "subscribe" &&
        constantTimeEqual(
          token,
          expected,
        )
      ) {
        logger.info(
          "Webhook verification OK",
        );

        return new Response(
          challenge,
          {
            status: 200,
          },
        );
      }

      logger.warn(
        "Webhook verification failed",
      );

      return new Response(
        "Forbidden",
        {
          status: 403,
        },
      );
    }

    if (req.method !== "POST") {
      return new Response(
        "Method Not Allowed",
        {
          status: 405,
        },
      );
    }

    try {
      const rawBody = await req.text();

      //
      // Signature verification — FAIL CLOSED
      //
      // The body is verified before it is parsed, against the exact
      // bytes received. Every outcome other than a matching digest is
      // a rejection: a missing secret, a missing header, a malformed
      // header and a wrong digest are all refusals, never a bypass.
      //
      // Deliberately not 200. The "always 200 to Meta" rule exists to
      // stop retry storms for internal processing failures. A request
      // that fails signature verification did not come from Meta, so
      // there is no retry loop to protect.
      //
      const verification = await verifyMetaSignature({
        rawBody,
        signatureHeader: req.headers.get(
          "X-Hub-Signature-256",
        ),
        appSecret: Env.META_APP_SECRET,
      });

      if (!verification.ok) {
        const status = signatureFailureStatus(
          verification.reason,
        );

        // Reason codes only. The secret, the received signature and
        // the computed digest are never logged.
        if (verification.reason === "secret_missing") {
          logger.error(
            "META_APP_SECRET missing - webhook cannot be verified",
          );
        } else {
          logger.warn(
            "Webhook signature rejected",
            {
              reason: verification.reason,
            },
          );
        }

        metrics.increment(
          `webhook.signature_rejected.${verification.reason}`,
        );

        metrics.flush(
          logger,
        );

        return new Response(
          status === 500 ? "Server Misconfigured" : "Forbidden",
          {
            status,
          },
        );
      }

      //
      // Safe JSON parse
      //
      let payload: Record<
        string,
        unknown
      > = {};

      try {
        payload = JSON.parse(
          rawBody,
        );
      } catch {
        logger.warn(
          "Invalid webhook JSON",
        );

        return OK_200(
          "invalid_json",
        );
      }

      const db = getServiceClient();

      const entries = Array.isArray(
          payload.entry,
        )
        ? (
          payload.entry as Array<
            Record<
              string,
              unknown
            >
          >
        )
        : [];

      if (
        entries.length > 100
      ) {
        logger.warn(
          "Large webhook batch",
          {
            entries: entries.length,
          },
        );
      }

      for (
        const entry of entries
      ) {
        const changes = Array.isArray(
            entry.changes,
          )
          ? (
            entry.changes as Array<
              Record<
                string,
                unknown
              >
            >
          )
          : [];

        for (
          const change of changes
        ) {
          const value = (change.value ??
            {}) as Record<
              string,
              unknown
            >;

          const statuses = Array.isArray(
              value.statuses,
            )
            ? (
              value.statuses as Array<
                Record<
                  string,
                  unknown
                >
              >
            )
            : [];

          const messages = Array.isArray(
              value.messages,
            )
            ? (
              value.messages as Array<
                Record<
                  string,
                  unknown
                >
              >
            )
            : [];

          //
          // Delivery statuses
          //
          for (
            const status of statuses
          ) {
            const statusId = String(
              status.id ??
                "",
            );

            const statusName = String(
              status.status ??
                "",
            );

            const eventId = `status_${statusId}_${statusName}`;

            const statusPayload = JSON.stringify(
              status,
            );

            const payloadHash = await bodyHash(
              statusPayload,
            );

            const {
              data: reg,
            } = await db.rpc(
              "register_webhook_event_v2",
              {
                p_provider: "meta_whatsapp",
                p_provider_event_id: eventId,
                p_event_type: `messages.${statusName}`,
                p_payload_hash: payloadHash,
                p_raw_payload: {
                  status: status as unknown as Json,
                },
              },
            );

            const row = (
              Array.isArray(
                  reg,
                )
                ? reg[0]
                : reg
            ) as
              | WebhookEventRow
              | null;

            if (
              !row?.is_new
            ) {
              logger.debug(
                "Duplicate webhook",
                {
                  eventId,
                },
              );

              continue;
            }

            const mapped = ({
              delivered: "delivered",
              read: "read",
              sent: "sent",
              failed: "failed",
            } as Record<
              string,
              | "delivered"
              | "read"
              | "sent"
              | "failed"
              | undefined
            >)[statusName];

            if (
              !mapped ||
              !statusId
            ) {
              continue;
            }

            const {
              error: deliveryError,
            } = await db.rpc(
              "handle_whatsapp_delivery_status",
              {
                p_meta_message_id: statusId,
                p_status: mapped,
                p_payload: {
                  status: status as unknown as Json,
                },
              },
            );

            if (
              deliveryError
            ) {
              logger.error(
                "Delivery status processing failed",
                {
                  messageId: statusId,
                  error: deliveryError.message,
                },
              );

              continue;
            }

            metrics.increment(
              `webhook.status.${mapped}`,
            );

            // Failed receipts re-enter the retry pipeline so outbound
            // state converges even when the original send "succeeded".
            if (
              mapped === "failed"
            ) {
              const { data: failedMsg } = await db
                .from("whatsapp_messages")
                .select("id")
                .eq("whatsapp_message_id", statusId)
                .maybeSingle();

              const failedMsgId = (failedMsg as { id: string } | null)?.id;

              if (failedMsgId) {
                const { error: retryError } = await db.rpc(
                  "schedule_whatsapp_retry",
                  {
                    p_message_id: failedMsgId,
                    p_error: "Meta delivery webhook reported failure",
                  },
                );

                if (retryError) {
                  logger.warn(
                    "Webhook-triggered retry scheduling failed",
                    {
                      messageId: statusId,
                      error: retryError.message,
                    },
                  );
                } else {
                  metrics.increment(
                    "webhook.status.failed_retry_scheduled",
                  );
                }
              }
            }

            const {
              error: completeError,
            } = await db.rpc(
              "complete_webhook_event",
              {
                p_event_id: row.event_id,
              },
            );

            if (
              completeError
            ) {
              logger.error(
                "Webhook completion failed",
                {
                  eventId: row.event_id,
                  error: completeError.message,
                },
              );
            }
          }

          //
          // Incoming messages
          //
          for (
            const msg of messages
          ) {
            const msgId = String(
              msg.id ??
                "",
            );

            const eventId = `msg_${msgId}`;

            const msgPayload = JSON.stringify(
              msg,
            );

            const payloadHash = await bodyHash(
              msgPayload,
            );

            const {
              data: reg,
            } = await db.rpc(
              "register_webhook_event_v2",
              {
                p_provider: "meta_whatsapp",
                p_provider_event_id: eventId,
                p_event_type: "messages.incoming",
                p_payload_hash: payloadHash,
                p_raw_payload: {
                  msg: msg as unknown as Json,
                },
              },
            );

            const row = (
              Array.isArray(
                  reg,
                )
                ? reg[0]
                : reg
            ) as
              | WebhookEventRow
              | null;

            if (
              !row?.is_new
            ) {
              continue;
            }

            const {
              error: enqueueError,
            } = await db.rpc(
              "enqueue_job",
              {
                p_job_type: "process_incoming_whatsapp",
                p_payload: {
                  message: msg as unknown as Json,
                  from: value.metadata as unknown as Json,
                },
                p_priority: "normal",
                p_scheduled_at: new Date().toISOString(),
                p_idempotency_key: `incoming_${msgId}`,
              },
            );

            if (
              enqueueError
            ) {
              logger.error(
                "Incoming message enqueue failed",
                {
                  messageId: msgId,
                  error: enqueueError.message,
                },
              );

              continue;
            }

            metrics.increment(
              "webhook.incoming",
            );

            const {
              error: completeError,
            } = await db.rpc(
              "complete_webhook_event",
              {
                p_event_id: row.event_id,
              },
            );

            if (
              completeError
            ) {
              logger.error(
                "Webhook completion failed",
                {
                  eventId: row.event_id,
                  error: completeError.message,
                },
              );
            }

            logger.info(
              "Incoming WA queued",
              {
                from: String(
                  msg.from ??
                    "",
                ).slice(-4),
                type: msg.type,
              },
            );
          }
        }
      }

      metrics.increment(
        "webhook.success",
      );

      metrics.increment(
        "webhook.processed",
      );

      metrics.timing(
        "request.total",
        elapsedMs(trace),
      );

      metrics.flush(
        logger,
      );

      return OK_200();
    } catch (err) {
      metrics.increment(
        "webhook.error",
      );

      logger.error(
        "webhook processing failed",
        err,
        {
          durationMs: elapsedMs(trace),
        },
      );

      metrics.flush(
        logger,
      );

      return OK_200(
        "error",
      );
    }
  },
);
