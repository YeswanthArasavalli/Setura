-- ============================================================
-- SETURA - Script 38: Missing RPC Functions
-- Phase 0 migration verification found two RPCs called by
-- Edge Functions and by migrations 11/17 that were never
-- defined anywhere:
--   * public.carry_forward_pending_tokens(UUID, DATE, DATE)
--     - called by carry-forward-tokens Edge Function
--     - called by migrations 11 and 17 nightly/scheduled tasks
--       (silently swallowed by their EXCEPTION handlers)
--   * public.compute_sla_tracking(UUID, DATE)
--     - called by compute-sla Edge Function (recompute mode)
--     - sla_daily_tracking (migration 24) had no writer at all
-- This script implements both and adds the SLA breach flag
-- columns the compute-sla function reads.
-- ============================================================

BEGIN;

-- ============================================================
-- PART A: SLA breach flag columns
-- compute-sla/index.ts filters rows by sla_wait_breached /
-- sla_completion_breached; migration 24 never created them.
-- ============================================================

ALTER TABLE public.sla_daily_tracking
    ADD COLUMN IF NOT EXISTS sla_wait_breached BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.sla_daily_tracking
    ADD COLUMN IF NOT EXISTS sla_completion_breached BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- PART B: carry_forward_pending_tokens
-- Moves still-booked (not yet checked in) bookings from one
-- date to a later date. Re-issues token numbers via the atomic
-- counter so no duplicates occur on the target date.
-- Returns the number of bookings carried forward.
-- ============================================================

CREATE OR REPLACE FUNCTION public.carry_forward_pending_tokens(
    p_hospital_id UUID,
    p_from_date DATE,
    p_to_date DATE
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_booking RECORD;
    v_new_token INTEGER;
    v_carried INTEGER := 0;
BEGIN

    IF p_to_date <= p_from_date THEN
        RAISE EXCEPTION 'carry-forward target date must be after source date'
            USING ERRCODE = '22023';
    END IF;

    -- Serialize per hospital so concurrent cron runs cannot
    -- double-carry the same bookings.
    IF NOT pg_try_advisory_xact_lock(
        hashtext('carry_forward:' || p_hospital_id::text)
    ) THEN
        RAISE EXCEPTION 'carry-forward already running for hospital'
            USING ERRCODE = '55P03';
    END IF;

    FOR v_booking IN
        SELECT id
        FROM public.bookings
        WHERE hospital_id = p_hospital_id
          AND appointment_date = p_from_date
          AND status = 'booked'
          AND is_deleted = false
        ORDER BY token_number
        FOR UPDATE SKIP LOCKED
    LOOP

        v_new_token := public.generate_next_token(
            p_hospital_id,
            p_to_date
        );

        UPDATE public.bookings
        SET
            appointment_date = p_to_date,
            token_number = v_new_token,
            is_carry_forward = true,
            carry_forwarded_from = COALESCE(carry_forwarded_from, id),
            -- Queue sessions are date-bound; patient is
            -- re-assigned to a session at check-in.
            queue_session_id = NULL,
            estimated_wait_minutes = NULL
        WHERE id = v_booking.id;

        v_carried := v_carried + 1;

    END LOOP;

    RETURN v_carried;

END;
$$;

ALTER FUNCTION public.carry_forward_pending_tokens(UUID, DATE, DATE)
SET row_security = off;

REVOKE ALL
ON FUNCTION public.carry_forward_pending_tokens(UUID, DATE, DATE)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.carry_forward_pending_tokens(UUID, DATE, DATE)
TO authenticated, service_role;

-- ============================================================
-- PART C: compute_sla_tracking
-- Computes one (hospital, date) row of SLA metrics from the
-- bookings table and upserts it into sla_daily_tracking.
-- Thresholds come from alert_thresholds when configured
-- (keys sla_max_wait_minutes / sla_min_completion_pct,
-- hospital-specific first, then global), otherwise defaults
-- of 45 minutes / 80 percent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.compute_sla_tracking(
    p_hospital_id UUID,
    p_date DATE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_total INTEGER;
    v_completed INTEGER;
    v_no_show INTEGER;
    v_cancelled INTEGER;
    v_avg_wait NUMERIC(8,2);
    v_completion NUMERIC(5,2);
    v_no_show_pct NUMERIC(5,2);
    v_cancel_pct NUMERIC(5,2);
    v_wait_threshold NUMERIC;
    v_completion_threshold NUMERIC;
BEGIN

    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE status = 'completed'),
        COUNT(*) FILTER (WHERE status = 'no_show'),
        COUNT(*) FILTER (WHERE status = 'cancelled'),
        ROUND(AVG(
            EXTRACT(EPOCH FROM (called_at - checked_in_at)) / 60.0
        ) FILTER (
            WHERE checked_in_at IS NOT NULL
              AND called_at IS NOT NULL
        ), 2)
    INTO
        v_total,
        v_completed,
        v_no_show,
        v_cancelled,
        v_avg_wait
    FROM public.bookings
    WHERE hospital_id = p_hospital_id
      AND appointment_date = p_date
      AND is_deleted = false;

    v_completion := CASE
        WHEN v_total = 0 THEN NULL
        ELSE ROUND(100.0 * v_completed / v_total, 2)
    END;

    v_no_show_pct := CASE
        WHEN v_total = 0 THEN NULL
        ELSE ROUND(100.0 * v_no_show / v_total, 2)
    END;

    v_cancel_pct := CASE
        WHEN v_total = 0 THEN NULL
        ELSE ROUND(100.0 * v_cancelled / v_total, 2)
    END;

    -- Hospital-specific threshold wins over the global one.
    SELECT threshold_value INTO v_wait_threshold
    FROM public.alert_thresholds
    WHERE alert_key = 'sla_max_wait_minutes'
      AND is_active = true
      AND (hospital_id = p_hospital_id OR hospital_id IS NULL)
    ORDER BY hospital_id NULLS LAST
    LIMIT 1;

    SELECT threshold_value INTO v_completion_threshold
    FROM public.alert_thresholds
    WHERE alert_key = 'sla_min_completion_pct'
      AND is_active = true
      AND (hospital_id = p_hospital_id OR hospital_id IS NULL)
    ORDER BY hospital_id NULLS LAST
    LIMIT 1;

    v_wait_threshold := COALESCE(v_wait_threshold, 45);
    v_completion_threshold := COALESCE(v_completion_threshold, 80);

    INSERT INTO public.sla_daily_tracking (
        hospital_id,
        tracking_date,
        avg_wait_minutes,
        completion_rate_pct,
        no_show_rate_pct,
        cancellation_rate_pct,
        sla_wait_breached,
        sla_completion_breached,
        computed_at
    )
    VALUES (
        p_hospital_id,
        p_date,
        v_avg_wait,
        v_completion,
        v_no_show_pct,
        v_cancel_pct,
        v_avg_wait > v_wait_threshold,
        v_completion IS NOT NULL
            AND v_completion < v_completion_threshold,
        now()
    )
    ON CONFLICT (hospital_id, tracking_date)
    DO UPDATE SET
        avg_wait_minutes = EXCLUDED.avg_wait_minutes,
        completion_rate_pct = EXCLUDED.completion_rate_pct,
        no_show_rate_pct = EXCLUDED.no_show_rate_pct,
        cancellation_rate_pct = EXCLUDED.cancellation_rate_pct,
        sla_wait_breached = EXCLUDED.sla_wait_breached,
        sla_completion_breached = EXCLUDED.sla_completion_breached,
        computed_at = now();

END;
$$;

ALTER FUNCTION public.compute_sla_tracking(UUID, DATE)
SET row_security = off;

REVOKE ALL
ON FUNCTION public.compute_sla_tracking(UUID, DATE)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.compute_sla_tracking(UUID, DATE)
TO authenticated, service_role;

COMMIT;
