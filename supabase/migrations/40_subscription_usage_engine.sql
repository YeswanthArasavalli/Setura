-- =============================================================
-- SETURA HOSPITAL OS
-- Script 40: Subscription Usage Engine (Phase 0.5 / P0.3)
-- Run AFTER Script 39
-- =============================================================
-- PURPOSE: Real usage accounting for hospital subscriptions.
--   - Atomic counter increments (bookings, WhatsApp messages,
--     API calls, queue operations)
--   - Gauge sync for doctor/receptionist counts + storage rows
--   - Calendar-month rollover for all monthly counters
--   - Extended per-metric counters live in the existing
--     hospital_subscriptions.metadata JSONB (no schema change)
-- =============================================================

BEGIN;

-- ============================================================
-- RECORD SUBSCRIPTION USAGE
-- Atomic increment. Safe under concurrency (row lock).
-- p_metric values:
--   booking            -> current_month_bookings  (counter)
--   whatsapp_message   -> metadata.usage.whatsapp_messages (counter)
--   api_call           -> metadata.usage.api_calls (counter)
--   queue_operation    -> metadata.usage.queue_operations (counter)
--   doctor_count       -> current_doctor_count (gauge, absolute)
--   receptionist_count -> current_receptionist_count (gauge, absolute)
--   storage_rows       -> metadata.usage.storage_rows (gauge, absolute)
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_subscription_usage(
    p_hospital_id UUID,
    p_metric TEXT,
    p_increment INTEGER DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_sub RECORD;
    v_period TEXT := to_char(now(), 'YYYY-MM');
    v_usage JSONB;
    v_key TEXT;
BEGIN

    IF p_increment < 0 THEN
        RAISE EXCEPTION 'Usage increment must be non-negative';
    END IF;

    SELECT *
    INTO v_sub
    FROM public.hospital_subscriptions
    WHERE hospital_id = p_hospital_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No subscription found for hospital %', p_hospital_id;
    END IF;

    v_usage := COALESCE(v_sub.metadata -> 'usage', '{}'::jsonb);

    -- Calendar-month rollover: reset all monthly counters
    IF COALESCE(v_sub.metadata ->> 'usage_period', '') <> v_period THEN
        v_usage := '{}'::jsonb;
        v_sub.current_month_bookings := 0;
    END IF;

    CASE p_metric
        WHEN 'booking' THEN
            v_sub.current_month_bookings :=
                v_sub.current_month_bookings + p_increment;

        WHEN 'doctor_count' THEN
            v_sub.current_doctor_count := p_increment;

        WHEN 'receptionist_count' THEN
            v_sub.current_receptionist_count := p_increment;

        WHEN 'whatsapp_message' THEN
            v_key := 'whatsapp_messages';
            v_usage := jsonb_set(
                v_usage,
                ARRAY[v_key],
                to_jsonb(
                    COALESCE((v_usage ->> v_key)::INTEGER, 0) + p_increment
                )
            );

        WHEN 'api_call' THEN
            v_key := 'api_calls';
            v_usage := jsonb_set(
                v_usage,
                ARRAY[v_key],
                to_jsonb(
                    COALESCE((v_usage ->> v_key)::INTEGER, 0) + p_increment
                )
            );

        WHEN 'queue_operation' THEN
            v_key := 'queue_operations';
            v_usage := jsonb_set(
                v_usage,
                ARRAY[v_key],
                to_jsonb(
                    COALESCE((v_usage ->> v_key)::INTEGER, 0) + p_increment
                )
            );

        WHEN 'storage_rows' THEN
            v_key := 'storage_rows';
            v_usage := jsonb_set(
                v_usage,
                ARRAY[v_key],
                to_jsonb(p_increment)
            );

        ELSE
            RAISE EXCEPTION 'Unknown usage metric: %', p_metric;
    END CASE;

    UPDATE public.hospital_subscriptions
    SET
        current_month_bookings     = v_sub.current_month_bookings,
        current_doctor_count       = v_sub.current_doctor_count,
        current_receptionist_count = v_sub.current_receptionist_count,
        metadata = COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object(
                'usage_period', v_period,
                'usage', v_usage,
                'usage_updated_at', now()
            ),
        updated_at = now()
    WHERE hospital_id = p_hospital_id;

    RETURN jsonb_build_object(
        'metric', p_metric,
        'period', v_period,
        'current_month_bookings', v_sub.current_month_bookings,
        'current_doctor_count', v_sub.current_doctor_count,
        'current_receptionist_count', v_sub.current_receptionist_count,
        'usage', v_usage
    );

END;
$$;

ALTER FUNCTION public.record_subscription_usage(UUID, TEXT, INTEGER)
SET row_security = off;

-- ============================================================
-- SYNC SUBSCRIPTION USAGE
-- Recomputes gauges and monthly booking count from source of
-- truth tables. Designed for nightly cron reconciliation.
-- ============================================================

CREATE OR REPLACE FUNCTION public.sync_subscription_usage(
    p_hospital_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_sub RECORD;
    v_period TEXT := to_char(now(), 'YYYY-MM');
    v_doctors INTEGER;
    v_receptionists INTEGER;
    v_month_bookings INTEGER;
    v_storage_rows INTEGER;
    v_usage JSONB;
BEGIN

    SELECT *
    INTO v_sub
    FROM public.hospital_subscriptions
    WHERE hospital_id = p_hospital_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No subscription found for hospital %', p_hospital_id;
    END IF;

    SELECT COUNT(DISTINCT ur.user_id)::INTEGER
    INTO v_doctors
    FROM public.user_roles ur
    WHERE ur.hospital_id = p_hospital_id
      AND ur.role = 'doctor';

    SELECT COUNT(DISTINCT ur.user_id)::INTEGER
    INTO v_receptionists
    FROM public.user_roles ur
    WHERE ur.hospital_id = p_hospital_id
      AND ur.role = 'receptionist';

    SELECT COUNT(*)::INTEGER
    INTO v_month_bookings
    FROM public.bookings b
    WHERE b.hospital_id = p_hospital_id
      AND b.is_deleted = false
      AND b.created_at >= date_trunc('month', now());

    -- Storage proxy: operational row volume for this hospital
    SELECT (
        (
            SELECT COUNT(*) FROM public.bookings
            WHERE hospital_id = p_hospital_id
        ) + (
            SELECT COUNT(*) FROM public.whatsapp_messages
            WHERE hospital_id = p_hospital_id
        )
    )::INTEGER
    INTO v_storage_rows;

    -- Preserve in-flight monthly counters unless the period rolled over
    IF COALESCE(v_sub.metadata ->> 'usage_period', '') = v_period THEN
        v_usage := COALESCE(v_sub.metadata -> 'usage', '{}'::jsonb);
    ELSE
        v_usage := '{}'::jsonb;
    END IF;

    v_usage := jsonb_set(v_usage, ARRAY['storage_rows'], to_jsonb(v_storage_rows));

    UPDATE public.hospital_subscriptions
    SET
        current_doctor_count       = v_doctors,
        current_receptionist_count = v_receptionists,
        current_month_bookings     = v_month_bookings,
        metadata = COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object(
                'usage_period', v_period,
                'usage', v_usage,
                'usage_synced_at', now()
            ),
        updated_at = now()
    WHERE hospital_id = p_hospital_id;

    RETURN jsonb_build_object(
        'period', v_period,
        'current_doctor_count', v_doctors,
        'current_receptionist_count', v_receptionists,
        'current_month_bookings', v_month_bookings,
        'storage_rows', v_storage_rows,
        'usage', v_usage
    );

END;
$$;

ALTER FUNCTION public.sync_subscription_usage(UUID)
SET row_security = off;

-- ============================================================
-- GET SUBSCRIPTION USAGE (read snapshot for dashboards/API)
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_subscription_usage(
    p_hospital_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_sub RECORD;
BEGIN

    SELECT *
    INTO v_sub
    FROM public.hospital_subscriptions
    WHERE hospital_id = p_hospital_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('error', 'No subscription found');
    END IF;

    RETURN jsonb_build_object(
        'plan_name', v_sub.plan_name,
        'subscription_status', v_sub.subscription_status,
        'period', COALESCE(v_sub.metadata ->> 'usage_period', to_char(now(), 'YYYY-MM')),
        'limits', jsonb_build_object(
            'max_doctors', v_sub.max_doctors,
            'max_receptionists', v_sub.max_receptionists,
            'max_bookings_per_month', v_sub.max_bookings_per_month
        ),
        'counters', jsonb_build_object(
            'current_month_bookings', v_sub.current_month_bookings,
            'current_doctor_count', v_sub.current_doctor_count,
            'current_receptionist_count', v_sub.current_receptionist_count
        ),
        'usage', COALESCE(v_sub.metadata -> 'usage', '{}'::jsonb)
    );

END;
$$;

ALTER FUNCTION public.get_subscription_usage(UUID)
SET row_security = off;

-- ============================================================
-- GRANTS (edge functions call via service_role)
-- ============================================================

REVOKE ALL ON FUNCTION public.record_subscription_usage(UUID, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_subscription_usage(UUID, TEXT, INTEGER)
    TO service_role, authenticated;

REVOKE ALL ON FUNCTION public.sync_subscription_usage(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_subscription_usage(UUID)
    TO service_role, authenticated;

REVOKE ALL ON FUNCTION public.get_subscription_usage(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_subscription_usage(UUID)
    TO service_role, authenticated;

COMMIT;
