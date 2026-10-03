import { supabase } from "@/lib/supabase";
import { callFunction } from "@/lib/api";
import { ApiError } from "@/lib/errors";
import type {
  HospitalActivationResponseBody,
  HospitalActivationRow,
  HospitalValidationResponseBody,
} from "@/types/api";

/**
 * Boundary over the WS-ONBOARD-5 `hospital-activation` Edge Function - the ONLY
 * path a global_admin uses to validate a tenant's configuration completeness and
 * to activate / de-activate it from the SETURA UI.
 *
 * Like WS-ONBOARD-1 provisioning this is a genuine TENANT-FREE global action:
 * the actor is the cross-tenant `global_admin` and the TARGET hospital id
 * travels in the BODY (never trusted from a header). The Edge Function resolves
 * the actor from the JWT, requires `global_admin`, and each service-role RPC
 * re-verifies the actor at the DB (SQLSTATE 42501). The frontend owns NONE of
 * the activation logic: the readiness invariant, the row-locked write and the
 * audit all live behind `validate_hospital_configuration` /
 * `set_hospital_activation`.
 *
 * The shared `callFunction` transport still requires an `X-Hospital-ID` header,
 * so the caller passes the same bounded "acting hospital" context the
 * established G-08 portfolio / WS-ONBOARD-1 onboarding surfaces use purely to
 * satisfy the transport. That id has no effect on this endpoint's authorization
 * or tenancy (the target comes from the body).
 *
 * `validate` is a READ: no Idempotency-Key. `activate` / `deactivate` are
 * MUTATIONS: they REQUIRE a stable UUID-v4 `Idempotency-Key` minted by
 * `useAsyncAction` so a replay returns the stored result instead of re-running
 * the RPC (the existing `api_idempotency_keys` registry; no new mechanism).
 */

/** List the live tenants a global_admin may review for activation. This is a
 *  plain RLS-scoped browser read of `hospitals` (the `hospitals_read` policy
 *  already grants a global_admin visibility across tenants) - NOT a new RPC and
 *  NOT a privileged write path. `activated_at` is included so the UI can show
 *  whether the tenant has ever been formally activated. */
export async function listHospitalsForActivation(): Promise<HospitalActivationRow[]> {
  const { data, error } = await supabase
    .from("hospitals")
    .select("id,name,slug,is_active,activated_at,deleted_at")
    .is("deleted_at", null)
    .order("name", { ascending: true });

  if (error) {
    throw new ApiError({
      code: error.code ?? "INVALID_RESPONSE",
      message: "Could not load hospitals for activation.",
      status: error.code === "42501" ? 403 : 500,
    });
  }

  return (data ?? []) as HospitalActivationRow[];
}

/** POST /functions/v1/hospital-activation with `mode: "validate"`. A read; no
 *  Idempotency-Key is required. Returns the server-computed completeness
 *  checklist for the target tenant. */
export function validateHospitalConfiguration(
  actingHospitalId: string,
  targetHospitalId: string,
): Promise<HospitalValidationResponseBody> {
  return callFunction<HospitalValidationResponseBody>(
    "hospital-activation",
    { mode: "validate", hospitalId: targetHospitalId },
    { hospitalId: actingHospitalId },
  );
}

/** POST /functions/v1/hospital-activation with `mode: "activate"` or
 *  `"deactivate"`. `idempotencyKey` is REQUIRED (backend
 *  `extractIdempotencyKey(req, true)`); a retry of the same key replays the
 *  stored result rather than re-running the activation RPC. */
export function setHospitalActivation(
  actingHospitalId: string,
  idempotencyKey: string,
  targetHospitalId: string,
  activate: boolean,
): Promise<HospitalActivationResponseBody> {
  return callFunction<HospitalActivationResponseBody>(
    "hospital-activation",
    {
      mode: activate ? "activate" : "deactivate",
      hospitalId: targetHospitalId,
    },
    { hospitalId: actingHospitalId, idempotencyKey },
  );
}
