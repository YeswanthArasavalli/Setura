import { callFunction } from "@/lib/api";
import type {
  HospitalConfigurationReadResponseBody,
  HospitalConfigurationUpdateResponseBody,
} from "@/types/api";

/**
 * Boundary over the WS-ONBOARD-2 `hospital-configuration` Edge Function -
 * the ONLY path an authorized operator uses to read or write a hospital's
 * operational configuration from the SETURA UI.
 *
 * The browser supplies ONLY the field-level patches the backend `Schema`
 * reads. Every absent optional field is OMITTED (never coerced to "" /
 * null) so the RPC leaves the existing column untouched. The frontend
 * owns NONE of the write path: role authorization, tenant cross-check,
 * atomicity, expected-version concurrency, configuration versioning
 * (via the existing AFTER-UPDATE trigger) and audit all live behind
 * the service-role SECURITY DEFINER RPCs added by migration 66.
 */

/** Field-level editable subset of `hospitals`. Mirrors the RPC allowlist;
 *  the RPC remains authoritative. `slug`, `id`, `deleted_at`, `is_active`,
 *  `subscription_active` and `created_by` are system-managed and NEVER
 *  present here. */
export interface HospitalPatch {
  name?: string;
  name_te?: string;
  phone?: string;
  email?: string;
  country?: string;
  state?: string;
  district?: string;
  town?: string;
  address?: string;
  timezone?: string;
  online_booking_enabled?: boolean;
  max_advance_booking_days?: number;
}

/** Field-level editable subset of `hospital_settings`. Mirrors the RPC
 *  allowlist. Razorpay / Meta credential columns and the
 *  collect_consultation_at_hospital business-model invariant are NOT
 *  present. */
export interface SettingsPatch {
  display_name?: string;
  logo_url?: string;
  platform_fee_online?: number;
  platform_fee_whatsapp?: number;
  receptionist_fee?: number;
  online_booking_fee_enabled?: boolean;
  default_consultation_fee_inr?: number | null;
  gst_enabled?: boolean;
  gst_percentage?: number;
  gst_registration_number?: string;
  max_tokens_per_day?: number;
  allow_walkin_tokens?: boolean;
  allow_online_booking?: boolean;
  allow_carry_forward?: boolean;
  queue_display_enabled?: boolean;
  send_whatsapp_confirmation?: boolean;
  send_whatsapp_reminder?: boolean;
  send_feedback_request?: boolean;
  reminder_before_minutes?: number;
  preferred_language?: string;
  timezone?: string;
  metadata?: Record<string, unknown>;
}

/** One tenant-scoped override row. The RPC upserts
 *  `feature_flags(hospital_id, flag_key)`. */
export interface FeatureOverrideInput {
  flag_key: string;
  is_enabled: boolean;
}

/** POST /functions/v1/hospital-configuration with `mode: "read"`. No
 *  Idempotency-Key is required for a read. */
export function getHospitalConfiguration(
  hospitalId: string,
): Promise<HospitalConfigurationReadResponseBody> {
  return callFunction<HospitalConfigurationReadResponseBody>(
    "hospital-configuration",
    { mode: "read" },
    { hospitalId },
  );
}

/** POST /functions/v1/hospital-configuration with `mode: "update"`. The
 *  `idempotencyKey` is REQUIRED (backend `extractIdempotencyKey(req,
 *  true)`); a retry of the same key replays the stored result rather
 *  than re-running the RPC. */
export function updateHospitalConfiguration(
  hospitalId: string,
  idempotencyKey: string,
  input: {
    expectedVersion: number;
    hospitalPatch?: HospitalPatch;
    settingsPatch?: SettingsPatch;
    featureOverrides?: FeatureOverrideInput[];
  },
): Promise<HospitalConfigurationUpdateResponseBody> {
  return callFunction<HospitalConfigurationUpdateResponseBody>(
    "hospital-configuration",
    {
      mode: "update",
      expectedVersion: input.expectedVersion,
      ...(input.hospitalPatch ? { hospitalPatch: input.hospitalPatch } : {}),
      ...(input.settingsPatch ? { settingsPatch: input.settingsPatch } : {}),
      ...(input.featureOverrides
        ? { featureOverrides: input.featureOverrides }
        : {}),
    },
    { hospitalId, idempotencyKey },
  );
}
