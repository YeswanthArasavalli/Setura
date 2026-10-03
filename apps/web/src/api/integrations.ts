import { callFunction } from "@/lib/api";
import type {
  IntegrationConfigurationReadResponseBody,
  IntegrationProvider,
  IntegrationRotateSecretResponseBody,
  IntegrationTestResponseBody,
  IntegrationUpdateResponseBody,
} from "@/types/api";

/**
 * Boundary over the WS-ONBOARD-3 `integration-configuration` Edge Function -
 * the ONLY path an authorized SETURA admin uses to read, configure,
 * connection-test and rotate a hospital's external integrations from the UI,
 * so onboarding needs no SQL, no source edit and no manual env-var edit.
 *
 * The browser owns NOTHING of the write path: role authorization, tenant
 * cross-check, versioned optimistic concurrency, allowlist validation,
 * Vault writes, sanitized connection tests and audit all live behind the
 * service-role SECURITY DEFINER RPCs added by migration 67.
 *
 * The security contract is asymmetric on purpose:
 *   - `rotateIntegrationSecret` SUBMITS a secret over authenticated HTTPS.
 *     The value is written straight to Supabase Vault server-side and is
 *     NEVER returned by any read, so there is no client path that can read a
 *     stored secret back.
 *   - `getIntegrationConfiguration` returns ONLY per-hospital public
 *     identifiers, lifecycle status and platform-global secret PRESENCE
 *     markers - never a credential.
 */

/** Editable per-hospital SAFE metadata. Mirrors the RPC allowlist; there is
 *  deliberately NO secret field here - a credential cannot be smuggled
 *  through the metadata path. Absent fields are OMITTED (never coerced to "")
 *  so the RPC leaves the existing column untouched. */
export interface IntegrationPatch {
  public_identifier?: string;
  waba_id?: string;
  contact_number?: string;
  enabled?: boolean;
}

/** POST /functions/v1/integration-configuration `mode: "read"`. No
 *  Idempotency-Key is required for a read. */
export function getIntegrationConfiguration(
  hospitalId: string,
): Promise<IntegrationConfigurationReadResponseBody> {
  return callFunction<IntegrationConfigurationReadResponseBody>(
    "integration-configuration",
    { mode: "read" },
    { hospitalId },
  );
}

/** POST `mode: "update"`. `idempotencyKey` is REQUIRED; a retry of the same
 *  key replays the stored result rather than re-running the RPC. */
export function updateIntegration(
  hospitalId: string,
  idempotencyKey: string,
  input: {
    provider: IntegrationProvider;
    expectedVersion: number;
    patch: IntegrationPatch;
  },
): Promise<IntegrationUpdateResponseBody> {
  return callFunction<IntegrationUpdateResponseBody>(
    "integration-configuration",
    {
      mode: "update",
      provider: input.provider,
      expectedVersion: input.expectedVersion,
      patch: input.patch,
    },
    { hospitalId, idempotencyKey },
  );
}

/** POST `mode: "test"`. The connection test runs SERVER-SIDE against the
 *  resolved credential; the browser receives only a sanitized result enum.
 *  `idempotencyKey` is REQUIRED (the mutation records the outcome). */
export function testIntegration(
  hospitalId: string,
  idempotencyKey: string,
  provider: IntegrationProvider,
): Promise<IntegrationTestResponseBody> {
  return callFunction<IntegrationTestResponseBody>(
    "integration-configuration",
    { mode: "test", provider },
    { hospitalId, idempotencyKey },
  );
}

/** POST `mode: "rotate_secret"` (global_admin only). The plaintext travels
 *  to the backend and is written to Vault; it is NEVER echoed in the
 *  response. `idempotencyKey` is REQUIRED. */
export function rotateIntegrationSecret(
  hospitalId: string,
  idempotencyKey: string,
  provider: IntegrationProvider,
  secret: string,
): Promise<IntegrationRotateSecretResponseBody> {
  return callFunction<IntegrationRotateSecretResponseBody>(
    "integration-configuration",
    { mode: "rotate_secret", provider, secret },
    { hospitalId, idempotencyKey },
  );
}
