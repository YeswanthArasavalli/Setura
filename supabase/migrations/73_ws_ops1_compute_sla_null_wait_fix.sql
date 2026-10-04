-- ============================================================
-- SETURA - Script 73: compute_sla_tracking NULL wait-breach fix
--
-- Defect (WS-OPS-1 staging dead-letter finding, CASE B real defect):
-- migration 38 computes the SLA breach flags and upserts them into
-- sla_daily_tracking. sla_daily_tracking.sla_wait_breached is
-- BOOLEAN NOT NULL (migration 38 PART A). The INSERT supplies the
-- column EXPLICITLY, so the column DEFAULT false never applies to it.
--
-- The wait-breach value was derived as:
--
--     v_avg_wait > v_wait_threshold
--
-- where
--
--     v_avg_wait = AVG(...) FILTER (WHERE checked_in_at IS NOT NULL
--                                        AND called_at IS NOT NULL)
--
-- Whenever a (hospital, date) has NO qualifying wait samples - i.e. no
-- booking has yet been BOTH checked in AND called (a normal state for a
-- freshly booked / not-yet-run service day, an idle day, or a newly
-- onboarded tenant) - v_avg_wait is NULL, and SQL three-valued logic
-- makes `NULL > threshold` evaluate to NULL, not false. The explicit
-- NULL then violates the NOT NULL column and dead-letters the job with:
--
--     null value in column "sla_wait_breached" ... violates
--     not-null constraint
--
-- The sibling flag sla_completion_breached was already guarded against
-- this exact case in migration 38:
--
--     v_completion IS NOT NULL AND v_completion < v_completion_threshold
--
-- which yields false (never NULL) when there are no samples. This fix
-- applies the SAME established semantics to the wait flag: no measured
-- wait means nothing was breached -> false. It does NOT weaken the
-- constraint, does NOT add a DB default hack, and preserves the
-- function signature (UUID, DATE) -> VOID so the existing SECURITY
-- DEFINER ACL/grants carry over unchanged.
--
-- No schema change is required: the table, column and NOT NULL
-- constraint are correct; only the derivation was unsound.
-- ============================================================

BEGIN;

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
        -- Guarded so an unmeasured wait is FALSE (nothing breached),
        -- never NULL. Mirrors sla_completion_breached below.
        v_avg_wait IS NOT NULL AND v_avg_wait > v_wait_threshold,
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

-- Preserve migration 38's security posture explicitly. CREATE OR REPLACE
-- of an identical signature retains the prior ACL, but re-asserting keeps
-- the intent readable and independent of the default-privilege caveat in
-- F16-04 (a SECURITY DEFINER function always needs its own explicit
-- REVOKE/GRANT).
ALTER FUNCTION public.compute_sla_tracking(UUID, DATE)
SET row_security = off;

REVOKE ALL
ON FUNCTION public.compute_sla_tracking(UUID, DATE)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.compute_sla_tracking(UUID, DATE)
TO authenticated, service_role;

COMMIT;
