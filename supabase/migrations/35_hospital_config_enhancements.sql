-- =============================================================
-- SETURA HOSPITAL OS
-- Script 35: Hospital Configuration Enhancements (v2 - Enterprise Refactor)
-- Run AFTER Script 34
-- =============================================================
-- PURPOSE: Adds business-model clarity fields to hospital_settings.
--
-- v2 CRITICAL FIX (Enterprise Refactor):
--   v1 of this script redefined get_effective_fees(hospital_id,
--   booking_source) with an 8-column return (platform_fee,
--   receptionist_fee, hospital_fee, booking_fee, gst_amount,
--   total_amount, consultation_fee, collect_at_hospital). But
--   migration 12 ALREADY defines get_effective_fees() with that
--   EXACT name and parameter signature, returning a 4-column TABLE
--   (platform_fee, receptionist_fee, hospital_fee, total_amount).
--   CREATE OR REPLACE FUNCTION cannot change a return type, so
--   deploying v1 would have thrown:
--     ERROR: cannot change return type of existing function
--
--   FIX: get_effective_fees() keeps its EXACT original 4-column
--   signature. Its body is updated to prefer booking_fee_policies
--   (Script 28) when a row exists, falling back to hospital_settings
--   otherwise - hospital_fee remains hard-coded 0 either way, exactly
--   as migration 12 already had it. The GST + consultation-fee detail
--   that v1 tried to bolt onto this function is NOT duplicated here:
--   Script 28's get_booking_fee() already returns that exact
--   information (booking_fee, gst_amount, total_fee, consultation_fee,
--   collect_consultation_at_hospital) under its own name. Anything
--   needing GST/consultation detail should call get_booking_fee(),
--   not get_effective_fees().
-- =============================================================

BEGIN;

-- ============================================================
-- PART A: Enhance hospital_settings
-- ============================================================

-- Booking fee alias (clarity: same value as platform_fee_online)
ALTER TABLE public.hospital_settings
    ADD COLUMN IF NOT EXISTS booking_fee_amount NUMERIC(10,2)
        NOT NULL DEFAULT 20 CHECK (booking_fee_amount >= 0);

COMMENT ON COLUMN public.hospital_settings.booking_fee_amount IS
'Alias for platform_fee_online added in Script 35 for code clarity.
SETURA collects this from the patient via Razorpay. Synced automatically.';

-- Consultation fee (informational - hospital sets, SETURA displays)
ALTER TABLE public.hospital_settings
    ADD COLUMN IF NOT EXISTS default_consultation_fee_inr NUMERIC(10,2)
        CHECK (default_consultation_fee_inr IS NULL
            OR default_consultation_fee_inr >= 0);

COMMENT ON COLUMN public.hospital_settings.default_consultation_fee_inr IS
'INFORMATIONAL ONLY. Patient pays this directly to the hospital.
SETURA never collects, handles, or refunds this amount.';

-- Explicit flag (always true in SETURA model - for frontend clarity)
ALTER TABLE public.hospital_settings
    ADD COLUMN IF NOT EXISTS collect_consultation_at_hospital BOOLEAN
        NOT NULL DEFAULT true;

COMMENT ON COLUMN public.hospital_settings.collect_consultation_at_hospital IS
'Always TRUE: SETURA model requires patients to pay consultation
fees directly at the hospital. SETURA only collects the booking fee.';

-- GST
ALTER TABLE public.hospital_settings
    ADD COLUMN IF NOT EXISTS gst_enabled BOOLEAN
        NOT NULL DEFAULT false;

ALTER TABLE public.hospital_settings
    ADD COLUMN IF NOT EXISTS gst_percentage NUMERIC(5,2)
        NOT NULL DEFAULT 18.00
        CHECK (gst_percentage BETWEEN 0 AND 100);

ALTER TABLE public.hospital_settings
    ADD COLUMN IF NOT EXISTS gst_registration_number TEXT;

COMMENT ON COLUMN public.hospital_settings.gst_enabled IS
'When true, GST is applied to the SETURA booking fee.
Per-hospital override. Global default is false.';

-- Backfill booking_fee_amount from existing platform_fee_online
UPDATE public.hospital_settings
   SET booking_fee_amount = platform_fee_online
 WHERE booking_fee_amount IS NOT DISTINCT FROM 20
   AND platform_fee_online IS DISTINCT FROM 20;

-- ============================================================
-- PART B: System settings - business model constants
-- ============================================================

INSERT INTO public.system_settings (key, value, description)
VALUES
    ('setura_collects_booking_fee_only',
     'true'::jsonb,
     'SETURA only collects booking fees. Consultation fees paid directly to hospitals.'),

    ('consultation_fee_collection_model',
     '"at_hospital"'::jsonb,
     'How consultation fee is collected: at_hospital (SETURA default) or online.'),

    ('gst_enabled_platform',
     'false'::jsonb,
     'Global GST switch. Per-hospital override via hospital_settings.gst_enabled.'),

    ('gst_percentage_default',
     '18'::jsonb,
     'Default GST percentage on booking fee (India standard rate).'),

    ('razorpay_gateway_fee_pct',
     '2.0'::jsonb,
     'Razorpay processing fee % used for internal reconciliation estimates.'),

    ('booking_fee_refund_window_hours',
     '24'::jsonb,
     'Default hours within which booking fee refund is eligible.')

ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- PART C: Update get_effective_fees() body only
-- EXACT original signature and 4-column return type from
-- migration 12 are preserved. Now prefers booking_fee_policies
-- (Script 28) when a row exists for the hospital, falling back to
-- hospital_settings otherwise. hospital_fee stays hard-coded 0,
-- exactly as migration 12 already had it (SETURA model has no
-- hospital-fee component) - this is not a behavior change, only a
-- different fee source for platform_fee/receptionist_fee.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_effective_fees(
    p_hospital_id    UUID,
    p_booking_source public.booking_source
)
RETURNS TABLE (
    platform_fee     NUMERIC(10,2),
    receptionist_fee NUMERIC(10,2),
    hospital_fee     NUMERIC(10,2),
    total_amount     NUMERIC(10,2)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH policy_source AS (
        -- Prefer booking_fee_policies (Script 28) when available
        SELECT
            CASE
                WHEN NOT bfp.booking_fee_enabled          THEN 0
                WHEN p_booking_source = 'online'          THEN bfp.booking_fee_online
                WHEN p_booking_source = 'manual_whatsapp' THEN bfp.booking_fee_whatsapp
                WHEN p_booking_source = 'walkin'          THEN bfp.booking_fee_walkin
                ELSE 0
            END::NUMERIC(10,2)                            AS pf,

            CASE
                WHEN p_booking_source = 'manual_whatsapp'
                THEN COALESCE(hs.receptionist_fee, 0)
                ELSE 0
            END::NUMERIC(10,2)                            AS rf

        FROM  public.hospital_settings    hs
        JOIN  public.booking_fee_policies bfp
            ON bfp.hospital_id = hs.hospital_id
        WHERE hs.hospital_id = p_hospital_id
        ORDER BY bfp.created_at DESC
        LIMIT 1
    ),
    settings_fallback AS (
        -- Used only when no booking_fee_policies row exists yet
        SELECT
            CASE
                WHEN p_booking_source = 'online'          THEN COALESCE(hs.platform_fee_online,   20)
                WHEN p_booking_source = 'manual_whatsapp' THEN COALESCE(hs.platform_fee_whatsapp,  10)
                ELSE 0
            END::NUMERIC(10,2)                            AS pf,
            CASE
                WHEN p_booking_source = 'manual_whatsapp'
                THEN COALESCE(hs.receptionist_fee, 0)
                ELSE 0
            END::NUMERIC(10,2)                            AS rf
        FROM public.hospital_settings hs
        WHERE hs.hospital_id = p_hospital_id
        LIMIT 1
    ),
    resolved AS (
        SELECT * FROM policy_source
        UNION ALL
        SELECT * FROM settings_fallback
        WHERE NOT EXISTS (SELECT 1 FROM policy_source)
    )
    SELECT
        r.pf,
        r.rf,
        0::NUMERIC(10,2)        AS hospital_fee,   -- SETURA model: always 0
        (r.pf + r.rf)::NUMERIC(10,2) AS total_amount
    FROM resolved r
    LIMIT 1;
$$;

REVOKE ALL     ON FUNCTION public.get_effective_fees(UUID, public.booking_source) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_effective_fees(UUID, public.booking_source) TO authenticated;

COMMENT ON FUNCTION public.get_effective_fees(UUID, public.booking_source) IS
'Original signature/return type from migration 12 preserved exactly:
returns (platform_fee, receptionist_fee, hospital_fee, total_amount).
Enhanced in Script 35 to prefer booking_fee_policies over
hospital_settings when both exist. For GST and consultation-fee
detail, call get_booking_fee() from Script 28 instead - it returns
that information under its own distinct name/signature.';

COMMIT;
