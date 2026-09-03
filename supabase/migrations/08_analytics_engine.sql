-- =============================================================
-- SETURA HOSPITAL OS
-- Script 08: Analytics Engine
-- PRODUCTION SAFE VERSION
-- =============================================================

-- =============================================================
-- BASE PERFORMANCE INDEXES
-- Critical for analytics scalability
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_bookings_analytics_core
ON public.bookings(
    hospital_id,
    appointment_date,
    status
)
WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_bookings_analytics_doctor
ON public.bookings(
    assigned_doctor_id,
    appointment_date
)
WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_bookings_consultation_times
ON public.bookings(
    consultation_started_at,
    consultation_completed_at
)
WHERE consultation_started_at IS NOT NULL
  AND consultation_completed_at IS NOT NULL
  AND is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_bookings_village
ON public.bookings(
    hospital_id,
    village,
    appointment_date
)
WHERE is_deleted = false;

-- =============================================================
-- DAILY HOSPITAL STATS
-- =============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_daily_hospital_stats
AS
SELECT
    b.hospital_id,

    b.appointment_date AS report_date,

    COUNT(*) AS total_patients,

    COUNT(*) FILTER (
        WHERE b.status = 'completed'
    ) AS completed_patients,

    COUNT(*) FILTER (
        WHERE b.status = 'cancelled'
    ) AS cancelled_patients,

    COUNT(*) FILTER (
        WHERE b.status = 'no_show'
    ) AS no_show_patients,

    COUNT(*) FILTER (
        WHERE p.total_visits > 1
    ) AS repeat_patients,

    COALESCE(
        SUM(
            CASE
                WHEN b.status = 'completed'
                THEN b.total_amount_snapshot
                ELSE 0
            END
        ),
        0
    ) AS total_revenue,

    COALESCE(
        SUM(
            CASE
                WHEN b.status = 'completed'
                THEN b.platform_fee_snapshot
                ELSE 0
            END
        ),
        0
    ) AS platform_revenue,

    ROUND(
        AVG(
            CASE
                WHEN b.called_at IS NOT NULL
                 AND b.consultation_started_at IS NOT NULL
                THEN
                    EXTRACT(
                        EPOCH FROM (
                            b.consultation_started_at
                            -
                            b.called_at
                        )
                    ) / 60
            END
        ),
        2
    ) AS avg_wait_minutes,

    ROUND(
        AVG(
            CASE
                WHEN b.consultation_started_at IS NOT NULL
                 AND b.consultation_completed_at IS NOT NULL
                THEN
                    EXTRACT(
                        EPOCH FROM (
                            b.consultation_completed_at
                            -
                            b.consultation_started_at
                        )
                    ) / 60
            END
        ),
        2
    ) AS avg_consultation_minutes

FROM public.bookings b

LEFT JOIN public.patients p
ON p.id = b.patient_id

WHERE b.is_deleted = false

GROUP BY
    b.hospital_id,
    b.appointment_date

WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_mv_daily_stats
ON public.mv_daily_hospital_stats(
    hospital_id,
    report_date
);

-- =============================================================
-- DOCTOR PERFORMANCE
-- =============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_doctor_performance
AS
SELECT
    b.hospital_id,

    b.assigned_doctor_id,

    b.appointment_date,

    COUNT(*) AS total_patients,

    COUNT(*) FILTER (
        WHERE b.status = 'completed'
    ) AS completed_patients,

    ROUND(
        AVG(
            CASE
                WHEN b.consultation_started_at IS NOT NULL
                 AND b.consultation_completed_at IS NOT NULL
                THEN
                    EXTRACT(
                        EPOCH FROM (
                            b.consultation_completed_at
                            -
                            b.consultation_started_at
                        )
                    ) / 60
            END
        ),
        2
    ) AS avg_consultation_minutes,

    ROUND(
        AVG(
            CASE
                WHEN b.called_at IS NOT NULL
                 AND b.consultation_started_at IS NOT NULL
                THEN
                    EXTRACT(
                        EPOCH FROM (
                            b.consultation_started_at
                            -
                            b.called_at
                        )
                    ) / 60
            END
        ),
        2
    ) AS avg_wait_minutes,

    COALESCE(
        SUM(
            CASE
                WHEN b.status = 'completed'
                THEN b.total_amount_snapshot
                ELSE 0
            END
        ),
        0
    ) AS total_revenue

FROM public.bookings b

WHERE b.assigned_doctor_id IS NOT NULL
  AND b.is_deleted = false

GROUP BY
    b.hospital_id,
    b.assigned_doctor_id,
    b.appointment_date

WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_mv_doctor_perf
ON public.mv_doctor_performance(
    hospital_id,
    assigned_doctor_id,
    appointment_date
);

-- =============================================================
-- PEAK HOUR ANALYSIS
-- =============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_peak_hour_analysis
AS
SELECT
    hospital_id,

    appointment_date,

    EXTRACT(
        HOUR FROM consultation_started_at
    )::INTEGER AS consultation_hour,

    COUNT(*) AS consultation_count

FROM public.bookings

WHERE consultation_started_at IS NOT NULL
  AND is_deleted = false

GROUP BY
    hospital_id,
    appointment_date,
    EXTRACT(HOUR FROM consultation_started_at)

WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_mv_peak_hour
ON public.mv_peak_hour_analysis(
    hospital_id,
    appointment_date,
    consultation_hour
);

-- =============================================================
-- VILLAGE ANALYSIS
-- =============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_village_analysis
AS
SELECT
    hospital_id,

    appointment_date,

    COALESCE(
        NULLIF(TRIM(village), ''),
        'Unknown'
    ) AS village,

    COUNT(*) AS patient_count

FROM public.bookings

WHERE is_deleted = false

GROUP BY
    hospital_id,
    appointment_date,
    COALESCE(
        NULLIF(TRIM(village), ''),
        'Unknown'
    )

WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_mv_village
ON public.mv_village_analysis(
    hospital_id,
    appointment_date,
    village
);

-- =============================================================
-- REVENUE FORECAST
-- =============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_revenue_forecast
AS
SELECT
    hospital_id,

    report_date,

    total_revenue,

    ROUND(
        AVG(total_revenue)
        OVER (
            PARTITION BY hospital_id
            ORDER BY report_date
            ROWS BETWEEN 6 PRECEDING
            AND CURRENT ROW
        ),
        2
    ) AS rolling_7day_avg_revenue,

    ROUND(
        AVG(total_patients)
        OVER (
            PARTITION BY hospital_id
            ORDER BY report_date
            ROWS BETWEEN 6 PRECEDING
            AND CURRENT ROW
        ),
        1
    ) AS rolling_7day_avg_patients

FROM public.mv_daily_hospital_stats

WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_mv_revenue_forecast
ON public.mv_revenue_forecast(
    hospital_id,
    report_date
);

-- =============================================================
-- ANALYTICS REFRESH TRACKER
-- =============================================================

CREATE TABLE IF NOT EXISTS public.analytics_refresh_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    refresh_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    refresh_completed_at TIMESTAMPTZ,

    success BOOLEAN,

    error_message TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- SAFE CONCURRENT REFRESH
-- =============================================================

CREATE OR REPLACE FUNCTION public.refresh_analytics_views()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_log_id UUID;
BEGIN

    -- Prevent concurrent refreshes
    IF NOT pg_try_advisory_lock(
        hashtext('setura_analytics_refresh')
    ) THEN
        RETURN FALSE;
    END IF;

    INSERT INTO public.analytics_refresh_logs (
        success
    )
    VALUES (NULL)
    RETURNING id INTO v_log_id;

    BEGIN

        REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_daily_hospital_stats;

        REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_doctor_performance;

        REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_peak_hour_analysis;

        REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_village_analysis;

        REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_revenue_forecast;

        UPDATE public.analytics_refresh_logs
        SET
            success = true,
            refresh_completed_at = now()
        WHERE id = v_log_id;

    EXCEPTION
        WHEN OTHERS THEN

            UPDATE public.analytics_refresh_logs
            SET
                success = false,
                error_message = SQLERRM,
                refresh_completed_at = now()
            WHERE id = v_log_id;

            PERFORM pg_advisory_unlock(
                hashtext('setura_analytics_refresh')
            );

            RAISE;

    END;

    PERFORM pg_advisory_unlock(
        hashtext('setura_analytics_refresh')
    );

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.refresh_analytics_views()
SET row_security = off;