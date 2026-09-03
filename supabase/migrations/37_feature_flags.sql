-- =============================================================
-- SETURA HOSPITAL OS
-- Script 37: Feature Flags Enhancement
-- Run AFTER Script 36
-- =============================================================
--
-- REQUIRED PRECONDITIONS
--
-- 1. Migration 12 must contain:
--
--    UNIQUE INDEX feature_flags_global_unique
--        ON public.feature_flags(flag_key)
--        WHERE hospital_id IS NULL;
--
--    UNIQUE INDEX feature_flags_hospital_unique
--        ON public.feature_flags(hospital_id, flag_key)
--        WHERE hospital_id IS NOT NULL;
--
-- 2. Authorization helper must exist:
--
--    public.current_user_role(UUID)
--
--    and return:
--
--        'hospital_admin'
--
--    for hospital administrators.
--
-- This script relies on those indexes for safe feature flag
-- seeding and deterministic feature flag resolution.
--
-- =============================================================
-- ARCHITECTURE NOTE
-- =============================================================
--
-- The requested feature_flags table already exists in Migration 12:
--
--     public.feature_flags (
--         id,
--         hospital_id,
--         flag_key,
--         is_enabled,
--         rollout_pct,
--         metadata,
--         updated_by,
--         updated_at
--     )
--
-- Global defaults:
--     hospital_id IS NULL
--
-- Hospital overrides:
--     hospital_id IS NOT NULL
--
-- Migration 18 already includes feature_flags in the
-- configuration versioning and rollback infrastructure.
--
-- Therefore this migration:
--
--     1. Seeds additional global feature flags
--     2. Adds hospital-admin management policy
--     3. Adds bulk feature flag resolution helper
--
-- No duplicate feature_flags table is created.
-- =============================================================

BEGIN;

-- ============================================================
-- GLOBAL FEATURE FLAGS
-- ============================================================

INSERT INTO public.feature_flags (
    hospital_id,
    flag_key,
    is_enabled,
    metadata
)
VALUES
(
    NULL,
    'online_booking',
    TRUE,
    '{"display_name":"Online Booking","description":"Patients can book and pay online via Razorpay."}'::JSONB
),
(
    NULL,
    'whatsapp_notifications',
    TRUE,
    '{"display_name":"WhatsApp Notifications","description":"Booking confirmations and reminders sent via WhatsApp."}'::JSONB
),
(
    NULL,
    'analytics_dashboard',
    TRUE,
    '{"display_name":"Analytics Dashboard","description":"Revenue, queue, and patient analytics for hospital staff."}'::JSONB
),
(
    NULL,
    'telemedicine',
    FALSE,
    '{"display_name":"Telemedicine","description":"Remote video consultations."}'::JSONB
),
(
    NULL,
    'subscription_billing',
    TRUE,
    '{"display_name":"Subscription Billing","description":"SaaS plan billing and invoicing for the hospital."}'::JSONB
),
(
    NULL,
    'smart_queue',
    TRUE,
    '{"display_name":"Smart Queue","description":"Predictive wait-time and queue optimization."}'::JSONB
),
(
    NULL,
    'ai_insights',
    FALSE,
    '{"display_name":"AI Insights","description":"AI-generated operational and clinical insights."}'::JSONB
)
ON CONFLICT DO NOTHING;

-- ============================================================
-- HOSPITAL ADMIN FEATURE FLAG MANAGEMENT
-- ============================================================

DROP POLICY IF EXISTS feature_flags_hospital_admin_manage
ON public.feature_flags;

CREATE POLICY feature_flags_hospital_admin_manage
ON public.feature_flags
FOR ALL
USING (
    hospital_id IS NOT NULL
    AND public.current_user_role(hospital_id) = 'hospital_admin'
)
WITH CHECK (
    hospital_id IS NOT NULL
    AND public.current_user_role(hospital_id) = 'hospital_admin'
);

-- ============================================================
-- EFFECTIVE FEATURE FLAGS
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_hospital_feature_flags(
    p_hospital_id UUID
)
RETURNS TABLE (
    flag_key      TEXT,
    display_name  TEXT,
    description   TEXT,
    is_enabled    BOOLEAN,
    is_override   BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH global_flags AS (
    SELECT DISTINCT ON (flag_key)
        flag_key,
        metadata ->> 'display_name' AS display_name,
        metadata ->> 'description'  AS description,
        is_enabled                  AS global_enabled
    FROM public.feature_flags
    WHERE hospital_id IS NULL
    ORDER BY flag_key, updated_at DESC NULLS LAST
),

hospital_overrides AS (
    SELECT DISTINCT ON (flag_key)
        flag_key,
        is_enabled AS override_enabled
    FROM public.feature_flags
    WHERE hospital_id = p_hospital_id
    ORDER BY flag_key, updated_at DESC NULLS LAST
)

SELECT
    gf.flag_key,
    gf.display_name,
    gf.description,

    COALESCE(
        ho.override_enabled,
        gf.global_enabled
    ) AS is_enabled,

    (ho.flag_key IS NOT NULL) AS is_override

FROM global_flags gf

LEFT JOIN hospital_overrides ho
       ON ho.flag_key = gf.flag_key

ORDER BY gf.flag_key;
$$;

REVOKE ALL
ON FUNCTION public.get_hospital_feature_flags(UUID)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.get_hospital_feature_flags(UUID)
TO authenticated;

COMMENT ON FUNCTION public.get_hospital_feature_flags(UUID)
IS
'Returns effective feature flags for a hospital.

Resolution order:
1. Hospital-specific override
2. Global default
3. No row = excluded from result

Uses feature_flags architecture introduced in migration 12.

For single-flag evaluation use:
is_feature_enabled(hospital_id, flag_key).';

COMMIT;
