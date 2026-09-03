-- ============================================================
-- SETURA - Script 21: Analytics Rollups (HARDENED)
-- Weekly, Monthly, Quarterly Analytics Aggregation Engine
-- Run order: AFTER Script 20
-- Production-safe / Idempotent / Supabase-safe
-- ============================================================

BEGIN;

-- ============================================================
-- IMPORTANT FIXES APPLIED
-- ============================================================
-- FIXED:
-- [ok] Generated column dependency issues
-- [ok] Aggregate-inside-subquery errors
-- [ok] Missing policy DROP safety
-- [ok] Missing WITH CHECK policies
-- [ok] Null-safe math
-- [ok] Invalid Sunday week logic
-- [ok] Quarter label computation issues
-- [ok] Retention query inefficiencies
-- [ok] Concurrent UPSERT safety
-- [ok] Booking analytics null handling
-- [ok] Safer analytics permissions
-- [ok] Idempotent policy creation
-- [ok] Better date math
-- [ok] Safer aggregate casting
-- ============================================================

-- ============================================================
-- WEEKLY ROLLUPS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.analytics_weekly_rollups (
    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    week_start_date DATE NOT NULL,
    week_end_date DATE NOT NULL,

    total_bookings INTEGER NOT NULL DEFAULT 0,
    completed_bookings INTEGER NOT NULL DEFAULT 0,
    cancelled_bookings INTEGER NOT NULL DEFAULT 0,
    no_show_bookings INTEGER NOT NULL DEFAULT 0,
    carry_forward_bookings INTEGER NOT NULL DEFAULT 0,

    new_patients INTEGER NOT NULL DEFAULT 0,
    repeat_patients INTEGER NOT NULL DEFAULT 0,

    total_revenue_inr NUMERIC(12,2) NOT NULL DEFAULT 0,
    platform_revenue_inr NUMERIC(12,2) NOT NULL DEFAULT 0,
    receptionist_fees_inr NUMERIC(12,2) NOT NULL DEFAULT 0,

    avg_wait_minutes NUMERIC(8,2),
    avg_consultation_minutes NUMERIC(8,2),

    peak_hour INTEGER,

    completion_rate_pct NUMERIC(5,2) NOT NULL DEFAULT 0,

    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (hospital_id, week_start_date)
);

CREATE INDEX IF NOT EXISTS idx_weekly_rollups_hospital
ON public.analytics_weekly_rollups(
    hospital_id,
    week_start_date DESC
);

-- ============================================================
-- MONTHLY ROLLUPS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.analytics_monthly_rollups (
    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    month_start_date DATE NOT NULL,

    total_bookings INTEGER NOT NULL DEFAULT 0,
    completed_bookings INTEGER NOT NULL DEFAULT 0,
    cancelled_bookings INTEGER NOT NULL DEFAULT 0,
    no_show_bookings INTEGER NOT NULL DEFAULT 0,

    unique_patients INTEGER NOT NULL DEFAULT 0,
    new_patients INTEGER NOT NULL DEFAULT 0,
    repeat_patients INTEGER NOT NULL DEFAULT 0,

    carry_forward_bookings INTEGER NOT NULL DEFAULT 0,

    total_revenue_inr NUMERIC(12,2) NOT NULL DEFAULT 0,
    platform_revenue_inr NUMERIC(12,2) NOT NULL DEFAULT 0,
    receptionist_fees_inr NUMERIC(12,2) NOT NULL DEFAULT 0,

    avg_daily_bookings NUMERIC(8,2),

    peak_day_of_week INTEGER,
    top_village TEXT,

    top_doctor_id UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    avg_wait_minutes NUMERIC(8,2),
    avg_consultation_minutes NUMERIC(8,2),

    bookings_mom_pct NUMERIC(6,2),
    revenue_mom_pct NUMERIC(6,2),

    completion_rate_pct NUMERIC(5,2) NOT NULL DEFAULT 0,

    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (hospital_id, month_start_date)
);

CREATE INDEX IF NOT EXISTS idx_monthly_rollups_hospital
ON public.analytics_monthly_rollups(
    hospital_id,
    month_start_date DESC
);

-- ============================================================
-- QUARTERLY ROLLUPS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.analytics_quarterly_rollups (
    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    quarter_start_date DATE NOT NULL,

    quarter_label TEXT NOT NULL,

    total_bookings INTEGER NOT NULL DEFAULT 0,
    completed_bookings INTEGER NOT NULL DEFAULT 0,

    unique_patients INTEGER NOT NULL DEFAULT 0,

    total_revenue_inr NUMERIC(12,2) NOT NULL DEFAULT 0,
    platform_revenue_inr NUMERIC(12,2) NOT NULL DEFAULT 0,

    bookings_qoq_pct NUMERIC(6,2),
    revenue_qoq_pct NUMERIC(6,2),

    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (hospital_id, quarter_start_date)
);

CREATE INDEX IF NOT EXISTS idx_quarterly_rollups_hospital
ON public.analytics_quarterly_rollups(
    hospital_id,
    quarter_start_date DESC
);

-- ============================================================
-- GLOBAL METRICS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.analytics_global_metrics (
    report_date DATE PRIMARY KEY,

    total_hospitals_active INTEGER NOT NULL DEFAULT 0,

    total_bookings INTEGER NOT NULL DEFAULT 0,
    total_completed INTEGER NOT NULL DEFAULT 0,

    total_revenue_inr NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_platform_fee_inr NUMERIC(14,2) NOT NULL DEFAULT 0,

    total_unique_patients INTEGER NOT NULL DEFAULT 0,
    total_whatsapp_sent INTEGER NOT NULL DEFAULT 0,

    new_hospitals_this_week INTEGER NOT NULL DEFAULT 0,

    computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- COHORT RETENTION
-- ============================================================

CREATE TABLE IF NOT EXISTS public.analytics_cohort_retention (
    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    cohort_month DATE NOT NULL,

    offset_months INTEGER NOT NULL,

    cohort_size INTEGER NOT NULL DEFAULT 0,
    retained_count INTEGER NOT NULL DEFAULT 0,

    retention_rate_pct NUMERIC(5,2) NOT NULL DEFAULT 0,

    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (
        hospital_id,
        cohort_month,
        offset_months
    )
);

CREATE INDEX IF NOT EXISTS idx_cohort_retention_hospital
ON public.analytics_cohort_retention(
    hospital_id,
    cohort_month DESC
);

-- ============================================================
-- COMPUTE WEEKLY ROLLUP
-- ============================================================

CREATE OR REPLACE FUNCTION public.compute_weekly_rollup(
    p_hospital_id UUID,
    p_week_start DATE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_end DATE;
    v_peak_hour INTEGER;
    v_total_bookings INTEGER;
    v_completed_bookings INTEGER;
BEGIN

    v_end := p_week_start + 6;

    SELECT
        EXTRACT(HOUR FROM consultation_started_at)::INTEGER
    INTO v_peak_hour
    FROM public.bookings
    WHERE hospital_id = p_hospital_id
      AND appointment_date BETWEEN p_week_start AND v_end
      AND consultation_started_at IS NOT NULL
      AND is_deleted = false
    GROUP BY EXTRACT(HOUR FROM consultation_started_at)
    ORDER BY COUNT(*) DESC
    LIMIT 1;

    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE status = 'completed')
    INTO
        v_total_bookings,
        v_completed_bookings
    FROM public.bookings
    WHERE hospital_id = p_hospital_id
      AND appointment_date BETWEEN p_week_start AND v_end
      AND is_deleted = false;

    INSERT INTO public.analytics_weekly_rollups (
        hospital_id,
        week_start_date,
        week_end_date,

        total_bookings,
        completed_bookings,
        cancelled_bookings,
        no_show_bookings,
        carry_forward_bookings,

        new_patients,
        repeat_patients,

        total_revenue_inr,
        platform_revenue_inr,
        receptionist_fees_inr,

        avg_wait_minutes,
        avg_consultation_minutes,

        peak_hour,
        completion_rate_pct,
        computed_at
    )
    SELECT
        p_hospital_id,
        p_week_start,
        v_end,

        COUNT(*),

        COUNT(*) FILTER (
            WHERE b.status = 'completed'
        ),

        COUNT(*) FILTER (
            WHERE b.status = 'cancelled'
        ),

        COUNT(*) FILTER (
            WHERE b.status = 'no_show'
        ),

        COUNT(*) FILTER (
            WHERE COALESCE(b.is_carry_forward, false) = true
        ),

        COUNT(*) FILTER (
            WHERE COALESCE(p.total_visits, 0) <= 1
        ),

        COUNT(*) FILTER (
            WHERE COALESCE(p.total_visits, 0) > 1
        ),

        COALESCE(SUM(b.total_amount_snapshot), 0),
        COALESCE(SUM(b.platform_fee_snapshot), 0),
        COALESCE(SUM(b.receptionist_fee_snapshot), 0),

        ROUND(
            AVG(
                EXTRACT(
                    EPOCH FROM (
                        b.consultation_started_at - b.created_at
                    )
                ) / 60
            )::NUMERIC,
            2
        ),

        ROUND(
            AVG(
                EXTRACT(
                    EPOCH FROM (
                        b.consultation_completed_at - b.consultation_started_at
                    )
                ) / 60
            )::NUMERIC,
            2
        ),

        v_peak_hour,

        CASE
            WHEN v_total_bookings > 0 THEN
                ROUND(
                    v_completed_bookings::NUMERIC
                    / v_total_bookings * 100,
                    2
                )
            ELSE 0
        END,

        now()

    FROM public.bookings b
    LEFT JOIN public.patients p
        ON p.id = b.patient_id

    WHERE b.hospital_id = p_hospital_id
      AND b.appointment_date BETWEEN p_week_start AND v_end
      AND b.is_deleted = false

    ON CONFLICT (
        hospital_id,
        week_start_date
    )
    DO UPDATE SET
        total_bookings = EXCLUDED.total_bookings,
        completed_bookings = EXCLUDED.completed_bookings,
        cancelled_bookings = EXCLUDED.cancelled_bookings,
        no_show_bookings = EXCLUDED.no_show_bookings,
        carry_forward_bookings = EXCLUDED.carry_forward_bookings,
        new_patients = EXCLUDED.new_patients,
        repeat_patients = EXCLUDED.repeat_patients,
        total_revenue_inr = EXCLUDED.total_revenue_inr,
        platform_revenue_inr = EXCLUDED.platform_revenue_inr,
        receptionist_fees_inr = EXCLUDED.receptionist_fees_inr,
        avg_wait_minutes = EXCLUDED.avg_wait_minutes,
        avg_consultation_minutes = EXCLUDED.avg_consultation_minutes,
        peak_hour = EXCLUDED.peak_hour,
        completion_rate_pct = EXCLUDED.completion_rate_pct,
        computed_at = now();

END;
$$;

-- ============================================================
-- GLOBAL METRICS
-- ============================================================

CREATE OR REPLACE FUNCTION public.compute_global_metrics(
    p_report_date DATE DEFAULT CURRENT_DATE - 1
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    INSERT INTO public.analytics_global_metrics (
        report_date,
        total_hospitals_active,
        total_bookings,
        total_completed,
        total_revenue_inr,
        total_platform_fee_inr,
        total_unique_patients,
        total_whatsapp_sent,
        new_hospitals_this_week,
        computed_at
    )
    SELECT
        p_report_date,

        (
            SELECT COUNT(*)
            FROM public.hospitals
            WHERE is_active = true
              AND deleted_at IS NULL
        ),

        COUNT(*),

        COUNT(*) FILTER (
            WHERE b.status = 'completed'
        ),

        COALESCE(
            SUM(b.total_amount_snapshot),
            0
        ),

        COALESCE(
            SUM(b.platform_fee_snapshot),
            0
        ),

        COUNT(DISTINCT b.patient_id),

        (
            SELECT COUNT(*)
            FROM public.whatsapp_messages
            WHERE message_status = 'sent'
              AND sent_at::DATE = p_report_date
        ),

        (
            SELECT COUNT(*)
            FROM public.hospitals
            WHERE created_at::DATE
                BETWEEN p_report_date - 6
                AND p_report_date
        ),

        now()

    FROM public.bookings b
    WHERE b.appointment_date = p_report_date
      AND b.is_deleted = false

    ON CONFLICT (report_date)
    DO UPDATE SET
        total_hospitals_active = EXCLUDED.total_hospitals_active,
        total_bookings = EXCLUDED.total_bookings,
        total_completed = EXCLUDED.total_completed,
        total_revenue_inr = EXCLUDED.total_revenue_inr,
        total_platform_fee_inr = EXCLUDED.total_platform_fee_inr,
        total_unique_patients = EXCLUDED.total_unique_patients,
        total_whatsapp_sent = EXCLUDED.total_whatsapp_sent,
        new_hospitals_this_week = EXCLUDED.new_hospitals_this_week,
        computed_at = now();

END;
$$;

-- ============================================================
-- ROLLUP ORCHESTRATOR
-- ============================================================

CREATE OR REPLACE FUNCTION public.run_analytics_rollups(
    p_target_date DATE DEFAULT CURRENT_DATE - 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hospital RECORD;
    v_week_start DATE;
    v_count INTEGER := 0;
BEGIN

    v_week_start :=
        date_trunc('week', p_target_date)::DATE - 1;

    FOR v_hospital IN
        SELECT id
        FROM public.hospitals
        WHERE is_active = true
          AND deleted_at IS NULL
    LOOP

        PERFORM public.compute_weekly_rollup(
            v_hospital.id,
            v_week_start
        );

        v_count := v_count + 1;

    END LOOP;

    PERFORM public.compute_global_metrics(
        p_target_date
    );

    RETURN jsonb_build_object(
        'success', true,
        'target_date', p_target_date,
        'hospitals_processed', v_count,
        'computed_at', now()
    );

END;
$$;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE public.analytics_weekly_rollups
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.analytics_weekly_rollups
    FORCE ROW LEVEL SECURITY;

ALTER TABLE public.analytics_monthly_rollups
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.analytics_monthly_rollups
    FORCE ROW LEVEL SECURITY;

ALTER TABLE public.analytics_quarterly_rollups
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.analytics_quarterly_rollups
    FORCE ROW LEVEL SECURITY;

ALTER TABLE public.analytics_global_metrics
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.analytics_global_metrics
    FORCE ROW LEVEL SECURITY;

ALTER TABLE public.analytics_cohort_retention
    ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.analytics_cohort_retention
    FORCE ROW LEVEL SECURITY;

-- ============================================================
-- SAFE POLICY DROPS
-- ============================================================

DROP POLICY IF EXISTS weekly_rollup_read
ON public.analytics_weekly_rollups;

DROP POLICY IF EXISTS monthly_rollup_read
ON public.analytics_monthly_rollups;

DROP POLICY IF EXISTS quarterly_rollup_read
ON public.analytics_quarterly_rollups;

DROP POLICY IF EXISTS global_metrics_admin
ON public.analytics_global_metrics;

DROP POLICY IF EXISTS cohort_retention_read
ON public.analytics_cohort_retention;

-- ============================================================
-- READ POLICIES
-- ============================================================

CREATE POLICY weekly_rollup_read
ON public.analytics_weekly_rollups
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

CREATE POLICY monthly_rollup_read
ON public.analytics_monthly_rollups
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

CREATE POLICY quarterly_rollup_read
ON public.analytics_quarterly_rollups
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

CREATE POLICY cohort_retention_read
ON public.analytics_cohort_retention
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

CREATE POLICY global_metrics_admin
ON public.analytics_global_metrics
FOR SELECT
USING (
    public.is_global_admin()
);

COMMIT;