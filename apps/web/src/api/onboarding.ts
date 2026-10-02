import { callFunction } from "@/lib/api";
import type { ProvisionHospitalResponseBody } from "@/types/api";

/**
 * Boundary over the WS-ONBOARD-1 `provision-hospital` Edge Function — the only
 * path a global_admin uses to create a new hospital tenant from the UI.
 *
 * The browser supplies ONLY the hospital identity fields the backend `Schema`
 * reads. Every absent optional field is OMITTED (never coerced to `""`/null) so
 * the table defaults apply server-side. The frontend owns NONE of the
 * provisioning logic: role authorization, tenant creation and the default
 * `hospital_settings` row all live behind the service-role
 * `provision_hospital` RPC. The backend is the authority; this is transport.
 *
 * Two header facts, stated honestly rather than hidden:
 *  - This is a genuine TENANT-FREE global action (the target hospital does not
 *    exist yet), so the Edge Function never reads or trusts `X-Hospital-ID` —
 *    it resolves the actor across all roles and re-checks `global_admin` in the
 *    RPC. `callFunction`, however, requires a hospital id for every call, so the
 *    caller passes the same bounded "acting hospital" context the established
 *    G-08 portfolio / C2b composer surfaces use purely to satisfy the shared
 *    transport. That id has no effect on this endpoint.
 *  - Replay safety is the backend's EXISTING `api_idempotency_keys` registry, so
 *    the caller MUST supply an `Idempotency-Key` (a stable UUID-v4 minted by
 *    `useAsyncAction` and reused across retries of the same submission). No
 *    second idempotency mechanism is introduced here.
 */

/** The tenant identity fields the backend reads. Only `name` and `slug` are
 *  required; the rest are optional and omitted when blank. */
export interface ProvisionHospitalInput {
  name: string;
  slug: string;
  phone?: string;
  email?: string;
  country?: string;
  state?: string;
  district?: string;
  town?: string;
  address?: string;
  timezone?: string;
}

/** POST /functions/v1/provision-hospital. `idempotencyKey` is REQUIRED by the
 *  backend (`extractIdempotencyKey(req, true)`); a retry of the same key replays
 *  the stored result instead of creating a duplicate tenant. */
export function provisionHospital(
  actingHospitalId: string,
  idempotencyKey: string,
  input: ProvisionHospitalInput,
): Promise<ProvisionHospitalResponseBody> {
  return callFunction<ProvisionHospitalResponseBody>(
    "provision-hospital",
    {
      name: input.name,
      slug: input.slug,
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.country ? { country: input.country } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.district ? { district: input.district } : {}),
      ...(input.town ? { town: input.town } : {}),
      ...(input.address ? { address: input.address } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
    },
    { hospitalId: actingHospitalId, idempotencyKey },
  );
}
