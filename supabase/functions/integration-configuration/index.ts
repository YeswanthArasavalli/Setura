/**
 * integration-configuration/index.ts
 *
 * WS-ONBOARD-3 - Integration Configuration & Secure Credential
 * Management.
 *
 * The single canonical HTTP surface an authorized SETURA admin uses to
 * read, configure, connection-test and rotate external integrations from
 * the SETURA UI, so onboarding a hospital's integrations requires no SQL,
 * no source edit and no manual environment-variable edit.
 *
 * Security model (the browser may SUBMIT a secret over authenticated
 * HTTPS but must NEVER read a stored secret back):
 *   - Per-hospital metadata (public identifiers, enabled, lifecycle
 *     status, test bookkeeping) is frontend-safe and returned sanitized.
 *   - Provider SECRETS are platform-global (Razorpay merchant account and
 *     Meta access token are documented platform-global in the existing
 *     engine; this workstream does not convert them to per-hospital
 *     merchant accounts - see migration 67 header). A secret is written
 *     straight into Supabase Vault by set_integration_secret and is
 *     NEVER echoed in any response, audit payload, log line or error.
 *
 * Flow (the canonical SETURA shape, per AGENTS.md sec 6):
 *   HTTP -> resolveAuth(req, X-Hospital-ID) -> requireRole(...) ->
 *   (mode==='read'          -> get_integration_configuration RPC,
 *    mode==='update'        -> Idempotency-Key gate -> withIdempotency ->
 *                              update_integration_configuration RPC ->
 *                              best-effort audit (no secret)),
 *   (mode==='test'          -> Idempotency-Key gate -> server-side
 *                              connection test via _shared/
 *                              integration_secrets (Vault-first, env
 *                              fallback) -> record_integration_test_result
 *                              RPC -> sanitized result),
 *   (mode==='rotate_secret' -> global_admin only -> Idempotency-Key gate
 *                              -> set_integration_secret RPC -> audit the
 *                              ROTATION only, never the value)).
 *
 * Authorization is enforced at BOTH boundaries: the Edge layer gates on
 * the resolved JWT role + tenant, and each RPC independently re-checks
 * that p_actor_user_id genuinely holds global_admin, or hospital_admin
 * scoped to the target tenant (SQLSTATE 42501 on any mismatch). The
 * frontend X-Hospital-ID is not the security boundary.
 */

import { handleCors } from "../_shared/cors.ts";
import { requireRole, resolveAuth } from "../_shared/auth.ts";
import { getServiceClient } from "../_shared/db.ts";
import { createRequestLogger } from "../_shared/logger.ts";
import { createTraceContext, elapsedMs } from "../_shared/tracing.ts";
import { createMetrics } from "../_shared/metrics.ts";
import { logAuditEvent } from "../_shared/audit.ts";
import { handleErrorResponse, successResponse } from "../_shared/response.ts";
import {
  ConcurrencyError,
  ForbiddenError,
  InternalError,
  ValidationError,
} from "../_shared/errors.ts";
import {
  extractIdempotencyKey,
  withIdempotency,
} from "../_shared/idempotency.ts";
import { Env } from "../_shared/env.ts";
import {
  type ConnectionTestResult,
  getMetaAccessToken,
  getRazorpayKeySecret,
  testMetaConnection,
  testRazorpayConnection,
} from "../_shared/integration_secrets.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { parseBody } from "../_shared/validation.ts";

const ENDPOINT = "integration-configuration";

const ProviderSchema = z.enum(["razorpay", "meta_whatsapp"]);

/** Per-hospital SAFE metadata. No secret field is accepted here; the
 *  strict schema rejects any attempt to smuggle a credential through the
 *  metadata path (the RPC allowlist is the second, authoritative gate). */
const IntegrationPatchSchema = z.object({
  public_identifier: z.string().trim().max(200).optional(),
  waba_id: z.string().trim().max(200).optional(),
  contact_number: z.string().trim().max(32).optional(),
  enabled: z.boolean().optional(),
}).strict();

const ReadSchema = z.object({ mode: z.literal("read") }).strict();

const UpdateSchema = z.object({
  mode: z.literal("update"),
  provider: ProviderSchema,
  expectedVersion: z.number().int().min(0),
  patch: IntegrationPatchSchema,
}).strict();

const TestSchema = z.object({
  mode: z.literal("test"),
  provider: ProviderSchema,
}).strict();

/** The only body that carries a secret. It travels over authenticated
 *  HTTPS to the backend and is written straight to Vault; it is NEVER
 *  returned, audited or logged. */
const RotateSecretSchema = z.object({
  mode: z.literal("rotate_secret"),
  provider: ProviderSchema,
  secret: z.string().min(1).max(1024),
}).strict();

const BodySchema = z.discriminatedUnion("mode", [
  ReadSchema,
  UpdateSchema,
  TestSchema,
  RotateSecretSchema,
]);
type Body = z.infer<typeof BodySchema>;

interface IntegrationRow {
  provider?: string;
  public_identifier?: string | null;
  enabled?: boolean;
  status?: string;
  version?: number;
}

interface RpcReadOutcome {
  ok?: boolean;
  hospital_id?: string;
  integrations?: IntegrationRow[];
  platform_secrets?: Array<{
    provider?: string;
    secret_present?: boolean;
    last_rotated_at?: string | null;
  }>;
}

interface RpcWriteOutcome {
  ok?: boolean;
  reason?: string;
  provider?: string;
  version?: number;
  status?: string;
}

interface RpcSecretOutcome {
  ok?: boolean;
  provider?: string;
  secret_present?: boolean;
  last_rotated_at?: string | null;
}

/** Map RPC SQLSTATE codes onto the SETURA HTTP error contract. The
 *  PostgreSQL driver message is never leaked (and can never contain a
 *  secret, since no RPC body persists one in an error path). */
function mapRpcError(err: { code?: string; message?: string }): never {
  const code = err.code ?? "";
  if (code === "42501" || code === "P0002") {
    throw new ForbiddenError(
      "Not authorized for this integration configuration",
    );
  }
  if (code === "P0001") {
    throw new ConcurrencyError(
      "Integration configuration was changed by someone else. Reload and try again.",
      { expectedVersion: true },
    );
  }
  if (code === "22023" || code === "23514" || code === "22P02") {
    throw new ValidationError("Integration configuration rejected", {
      value: [String(err.message ?? "invalid")],
    });
  }
  throw new InternalError("Integration configuration failed", { code });
}

/** Coarse human copy per sanitized test outcome. No provider detail. */
function describeTestResult(result: ConnectionTestResult): string {
  switch (result) {
    case "CONNECTED":
      return "Connection verified.";
    case "INVALID_CREDENTIAL":
      return "The stored credential was rejected by the provider.";
    case "UNAUTHORIZED":
      return "The credential is authenticated but not permitted for this resource.";
    case "PROVIDER_UNAVAILABLE":
      return "The provider could not be reached.";
    case "CONFIGURATION_INVALID":
      return "The integration is not fully configured.";
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const trace = createTraceContext(req);
  const logger = createRequestLogger(req, ENDPOINT).child({
    correlationId: trace.correlationId,
  });
  const metrics = createMetrics(ENDPOINT, trace.correlationId);

  try {
    const headerHospitalId = req.headers.get("X-Hospital-ID");
    if (!headerHospitalId) {
      throw new ValidationError("Missing X-Hospital-ID header", {
        header: ["Required"],
      });
    }

    const auth = await resolveAuth(req, headerHospitalId, logger);
    const db = getServiceClient();
    const hospitalId = auth.hospitalId ?? headerHospitalId;
    if (!hospitalId) {
      throw new ForbiddenError("No hospital context resolved");
    }

    const body = await parseBody<Body>(req, BodySchema);

    // rotate_secret is a platform-global operation: global_admin ONLY.
    // Every other mode is tenant-scoped and open to hospital_admin.
    if (body.mode === "rotate_secret") {
      requireRole(auth, ["global_admin"]);
    } else {
      requireRole(auth, ["global_admin", "hospital_admin"]);
    }

    // -- READ ---------------------------------------------------------------
    if (body.mode === "read") {
      const { data, error } = await db.rpc("get_integration_configuration", {
        p_actor_user_id: auth.userId,
        p_hospital_id: hospitalId,
      });
      if (error) mapRpcError(error as { code?: string; message?: string });
      const outcome = (data ?? {}) as RpcReadOutcome;
      if (outcome.ok !== true) {
        throw new InternalError(
          "Integration configuration read returned no data",
        );
      }
      metrics.increment("integration_configuration.read");
      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);
      return successResponse(
        {
          hospitalId,
          integrations: outcome.integrations ?? [],
          platformSecrets: outcome.platform_secrets ?? [],
        },
        trace.correlationId,
        req,
      );
    }

    // -- UPDATE (tenant-scoped, safe metadata only) -------------------------
    if (body.mode === "update") {
      const idempotencyKey = extractIdempotencyKey(req, true)!;
      const result = await withIdempotency<
        { provider: string; version: number; status: string }
      >(
        idempotencyKey,
        ENDPOINT,
        auth.userId,
        hospitalId,
        body,
        crypto.randomUUID(),
        logger,
        async () => {
          const { data, error } = await db.rpc(
            "update_integration_configuration",
            {
              p_actor_user_id: auth.userId,
              p_hospital_id: hospitalId,
              p_provider: body.provider,
              p_expected_version: body.expectedVersion,
              p_patch: body.patch,
            },
          );
          if (error) mapRpcError(error as { code?: string; message?: string });
          const outcome = (data ?? {}) as RpcWriteOutcome;
          if (outcome.ok !== true) {
            throw new InternalError(
              "Integration configuration update returned no result",
            );
          }

          const actionType = body.patch.enabled === true
            ? "integration_enabled"
            : body.patch.enabled === false
            ? "integration_disabled"
            : "integration_config_update";

          // Audit SAFE metadata only. The patch never contains a secret,
          // and no secret is fetched into this path.
          await logAuditEvent(
            {
              hospitalId,
              actorUserId: auth.userId,
              entityType: "integration_config",
              entityId: hospitalId,
              actionType,
              severity: "high",
              oldData: { expectedVersion: body.expectedVersion },
              newData: {
                provider: body.provider,
                patch: body.patch,
                version: outcome.version ?? null,
                status: outcome.status ?? null,
              },
            },
            logger,
            metrics,
          );

          return {
            statusCode: 200,
            body: {
              provider: body.provider,
              version: outcome.version ?? body.expectedVersion,
              status: outcome.status ?? "unconfigured",
            },
          };
        },
      );

      metrics.increment(
        result.wasDuplicate
          ? "integration_configuration.replay"
          : "integration_configuration.update",
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
    }

    // -- TEST (server-side only; never a secret exfiltration path) ----------
    if (body.mode === "test") {
      const idempotencyKey = extractIdempotencyKey(req, true)!;
      const result = await withIdempotency<{
        provider: string;
        result: ConnectionTestResult;
        message: string;
      }>(
        idempotencyKey,
        ENDPOINT,
        auth.userId,
        hospitalId,
        body,
        crypto.randomUUID(),
        logger,
        async () => {
          // Resolve the credential Vault-first, env-fallback (server-side).
          let testResult: ConnectionTestResult;
          if (body.provider === "razorpay") {
            const keySecret = await getRazorpayKeySecret(db, logger);
            testResult = await testRazorpayConnection({
              keyId: Env.RAZORPAY_KEY_ID || null,
              keySecret,
            });
          } else {
            const accessToken = await getMetaAccessToken(db, logger);
            // The tenant phone-number id is a SAFE public identifier, read
            // from the sanitized config the actor is already entitled to.
            const { data: cfgData } = await db.rpc(
              "get_integration_configuration",
              { p_actor_user_id: auth.userId, p_hospital_id: hospitalId },
            );
            const cfg = (cfgData ?? {}) as RpcReadOutcome;
            const metaRow = (cfg.integrations ?? []).find((r) =>
              r.provider === "meta_whatsapp"
            );
            testResult = await testMetaConnection({
              accessToken,
              phoneNumberId: metaRow?.public_identifier ?? null,
            });
          }

          // Persist the sanitized outcome (never the credential).
          await db.rpc("record_integration_test_result", {
            p_actor_user_id: auth.userId,
            p_hospital_id: hospitalId,
            p_provider: body.provider,
            p_test_status: testResult,
          });

          await logAuditEvent(
            {
              hospitalId,
              actorUserId: auth.userId,
              entityType: "integration_config",
              entityId: hospitalId,
              actionType: "integration_connection_tested",
              severity: "low",
              newData: { provider: body.provider, result: testResult },
            },
            logger,
            metrics,
          );

          return {
            statusCode: 200,
            body: {
              provider: body.provider,
              result: testResult,
              message: describeTestResult(testResult),
            },
          };
        },
      );

      metrics.increment("integration_configuration.test");
      metrics.timing("request.total", elapsedMs(trace));
      metrics.flush(logger);
      return successResponse(
        result.body,
        trace.correlationId,
        req,
        undefined,
        result.statusCode,
      );
    }

    // -- ROTATE SECRET (global_admin; the value goes to Vault only) --------
    // body.mode === 'rotate_secret'
    const idempotencyKey = extractIdempotencyKey(req, true)!;
    const result = await withIdempotency<{
      provider: string;
      secret_present: boolean;
      last_rotated_at: string | null;
    }>(
      idempotencyKey,
      ENDPOINT,
      auth.userId,
      hospitalId,
      // Hash only the non-secret parts for the idempotency body; the
      // secret is intentionally NOT part of the stored request summary.
      { mode: body.mode, provider: body.provider },
      crypto.randomUUID(),
      logger,
      async () => {
        const { data, error } = await db.rpc("set_integration_secret", {
          p_actor_user_id: auth.userId,
          p_provider: body.provider,
          p_secret: body.secret,
        });
        if (error) mapRpcError(error as { code?: string; message?: string });
        const outcome = (data ?? {}) as RpcSecretOutcome;
        if (outcome.ok !== true) {
          throw new InternalError(
            "Integration secret rotation returned no result",
          );
        }

        // Audit the ROTATION as an event only. Never the value.
        await logAuditEvent(
          {
            hospitalId,
            actorUserId: auth.userId,
            entityType: "integration_config",
            entityId: hospitalId,
            actionType: "integration_secret_rotated",
            severity: "critical",
            newData: {
              provider: body.provider,
              secret_present: true,
            },
          },
          logger,
          metrics,
        );

        return {
          statusCode: 200,
          body: {
            provider: body.provider,
            secret_present: outcome.secret_present ?? true,
            last_rotated_at: outcome.last_rotated_at ?? null,
          },
        };
      },
    );

    metrics.increment("integration_configuration.secret_rotated");
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
    metrics.increment("integration_configuration.error");
    logger.error("integration-configuration failed", err, {
      durationMs: elapsedMs(trace),
    });
    return handleErrorResponse(err, trace.correlationId, req);
  }
});
