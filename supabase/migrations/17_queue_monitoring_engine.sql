-- =============================================================
-- SETURA HOSPITAL OS
-- Script 17: Queue Monitoring Engine
-- FINAL PRODUCTION SAFE VERSION
-- Run AFTER ALL SCRIPTS
-- =============================================================

BEGIN;

-- =============================================================
-- QUEUE METRICS SNAPSHOTS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.queue_metrics_snapshots (

    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    snapshot_type TEXT NOT NULL,

    pending_count INTEGER NOT NULL DEFAULT 0
        CHECK (pending_count >= 0),

    processing_count INTEGER NOT NULL DEFAULT 0
        CHECK (processing_count >= 0),

    failed_count INTEGER NOT NULL DEFAULT 0
        CHECK (failed_count >= 0),

    dead_count INTEGER NOT NULL DEFAULT 0
        CHECK (dead_count >= 0),

    avg_processing_ms NUMERIC(12,2),

    p95_processing_ms NUMERIC(12,2),

    oldest_pending_age_secs INTEGER
        CHECK (oldest_pending_age_secs IS NULL OR oldest_pending_age_secs >= 0),

    throughput_per_minute NUMERIC(10,2),

    avg_retry_count NUMERIC(6,2),

    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- INDEXES
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_queue_metrics_captured
ON public.queue_metrics_snapshots(
    snapshot_type,
    captured_at DESC
);

CREATE INDEX IF NOT EXISTS idx_queue_metrics_hospital
ON public.queue_metrics_snapshots(
    hospital_id,
    captured_at DESC
);

CREATE INDEX IF NOT EXISTS idx_queue_metrics_snapshot_type
ON public.queue_metrics_snapshots(
    snapshot_type,
    hospital_id,
    captured_at DESC
);

-- =============================================================
-- MV REFRESH LOG
-- =============================================================

CREATE TABLE IF NOT EXISTS public.mv_refresh_log (

    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    view_name TEXT NOT NULL,

    started_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    completed_at TIMESTAMPTZ,

    duration_ms INTEGER GENERATED ALWAYS AS (
        CASE
            WHEN completed_at IS NULL THEN NULL
            ELSE EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
        END
    ) STORED,

    success BOOLEAN,

    error_message TEXT,

    row_count BIGINT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mv_refresh_log_view
ON public.mv_refresh_log(
    view_name,
    started_at DESC
);

CREATE INDEX IF NOT EXISTS idx_mv_refresh_log_success
ON public.mv_refresh_log(
    success,
    started_at DESC
);

-- =============================================================
-- LIVE QUEUE HEALTH
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_queue_health()

RETURNS TABLE (

    queue_type TEXT,

    pending_count BIGINT,

    processing_count BIGINT,

    failed_count BIGINT,

    dead_count BIGINT,

    oldest_pending_age INTERVAL,

    avg_attempts NUMERIC,

    throughput_last_hour BIGINT

)

LANGUAGE sql
STABLE
AS $$

    -- =========================================================
    -- JOB QUEUE
    -- =========================================================

    SELECT

        'job_queue'::TEXT,

        COUNT(*) FILTER (
            WHERE status = 'pending'
        ),

        COUNT(*) FILTER (
            WHERE status = 'processing'
        ),

        COUNT(*) FILTER (
            WHERE status = 'failed'
        ),

        COUNT(*) FILTER (
            WHERE status = 'dead'
        ),

        now() - MIN(scheduled_at)
            FILTER (WHERE status = 'pending'),

        ROUND(
            AVG(attempt_count)::NUMERIC,
            2
        ),

        COUNT(*) FILTER (
            WHERE status = 'completed'
            AND processing_completed_at >
                now() - interval '1 hour'
        )

    FROM public.job_queue

    UNION ALL

    -- =========================================================
    -- WHATSAPP
    -- =========================================================

    SELECT

        'whatsapp'::TEXT,

        COUNT(*) FILTER (
            WHERE message_status = 'queued'
        ),

        COUNT(*) FILTER (
            WHERE message_status = 'processing'
        ),

        COUNT(*) FILTER (
            WHERE message_status IN (
                'failed',
                'retrying'
            )
        ),

        COUNT(*) FILTER (
            WHERE message_status = 'permanently_failed'
        ),

        now() - MIN(created_at)
            FILTER (
                WHERE message_status = 'queued'
            ),

        ROUND(
            AVG(retry_count)::NUMERIC,
            2
        ),

        COUNT(*) FILTER (
            WHERE message_status = 'sent'
            AND sent_at > now() - interval '1 hour'
        )

    FROM public.whatsapp_messages

    UNION ALL

    -- =========================================================
    -- NOTIFICATIONS
    -- =========================================================

    SELECT

        'notifications'::TEXT,

        COUNT(*) FILTER (
            WHERE status = 'pending'
        ),

        COUNT(*) FILTER (
            WHERE status = 'queued'
        ),

        COUNT(*) FILTER (
            WHERE status = 'failed'
        ),

        0::BIGINT,

        now() - MIN(scheduled_for)
            FILTER (
                WHERE status = 'pending'
            ),

        ROUND(
            AVG(retry_count)::NUMERIC,
            2
        ),

        COUNT(*) FILTER (
            WHERE status = 'sent'
            AND sent_at > now() - interval '1 hour'
        )

    FROM public.notification_queue;

$$;

-- =============================================================
-- STUCK JOB DETECTOR
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_stuck_jobs(
    p_stuck_threshold_minutes INTEGER DEFAULT 10
)

RETURNS TABLE (

    job_id UUID,

    job_type TEXT,

    hospital_id UUID,

    worker_id TEXT,

    processing_started TIMESTAMPTZ,

    stuck_for INTERVAL,

    attempt_count INTEGER,

    payload JSONB

)

LANGUAGE sql
STABLE
AS $$

    SELECT

        id,

        job_type,

        hospital_id,

        worker_id,

        processing_started_at,

        now() - processing_started_at,

        attempt_count,

        payload

    FROM public.job_queue

    WHERE status = 'processing'

    AND processing_started_at <
        now()
        -
        make_interval(
            mins => p_stuck_threshold_minutes
        )

    ORDER BY processing_started_at ASC;

$$;

-- =============================================================
-- BACKLOG ALERTS
-- =============================================================

CREATE OR REPLACE FUNCTION public.check_queue_backlog_alerts(
    p_pending_threshold INTEGER DEFAULT 50,
    p_age_threshold_minutes INTEGER DEFAULT 15
)

RETURNS TABLE (

    queue_type TEXT,

    alert_reason TEXT,

    pending_count BIGINT,

    oldest_age INTERVAL

)

LANGUAGE sql
STABLE
AS $$

    SELECT

        queue_type,

        CASE

            WHEN pending_count > p_pending_threshold
            THEN 'HIGH_BACKLOG'

            WHEN oldest_pending_age >
                make_interval(
                    mins => p_age_threshold_minutes
                )
            THEN 'STUCK_OLDEST_JOB'

            ELSE 'OK'

        END,

        pending_count,

        oldest_pending_age

    FROM public.get_queue_health()

    WHERE pending_count > p_pending_threshold

    OR oldest_pending_age >
        make_interval(
            mins => p_age_threshold_minutes
        );

$$;

-- =============================================================
-- SNAPSHOT WRITER
-- =============================================================

CREATE OR REPLACE FUNCTION public.write_queue_metrics_snapshot()

RETURNS VOID

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_row RECORD;

BEGIN

    FOR v_row IN
        SELECT *
        FROM public.get_queue_health()
    LOOP

        INSERT INTO public.queue_metrics_snapshots (

            snapshot_type,

            pending_count,

            processing_count,

            failed_count,

            dead_count,

            oldest_pending_age_secs,

            throughput_per_minute,

            avg_retry_count

        )
        VALUES (

            v_row.queue_type,

            COALESCE(v_row.pending_count, 0),

            COALESCE(v_row.processing_count, 0),

            COALESCE(v_row.failed_count, 0),

            COALESCE(v_row.dead_count, 0),

            CASE
                WHEN v_row.oldest_pending_age IS NULL
                THEN NULL
                ELSE EXTRACT(
                    EPOCH FROM v_row.oldest_pending_age
                )::INTEGER
            END,

            ROUND(
                COALESCE(
                    v_row.throughput_last_hour,
                    0
                )::NUMERIC / 60.0,
                2
            ),

            COALESCE(v_row.avg_attempts, 0)

        );

    END LOOP;

    -- =========================================================
    -- RETENTION CLEANUP
    -- =========================================================

    DELETE FROM public.queue_metrics_snapshots
    WHERE captured_at <
        now() - interval '7 days';

END;
$$;

ALTER FUNCTION public.write_queue_metrics_snapshot()
SET row_security = off;

-- =============================================================
-- REFRESH SINGLE MATERIALIZED VIEW
-- =============================================================

CREATE OR REPLACE FUNCTION public.refresh_single_mv(
    p_view_name TEXT
)

RETURNS BOOLEAN

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_log_id UUID;

    v_rows BIGINT;

BEGIN

    INSERT INTO public.mv_refresh_log (
        view_name
    )
    VALUES (
        p_view_name
    )
    RETURNING id
    INTO v_log_id;

    BEGIN

        CASE p_view_name

            WHEN 'mv_daily_hospital_stats' THEN
                REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_daily_hospital_stats;

            WHEN 'mv_doctor_performance' THEN
                REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_doctor_performance;

            WHEN 'mv_peak_hour_analysis' THEN
                REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_peak_hour_analysis;

            WHEN 'mv_village_analysis' THEN
                REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_village_analysis;

            WHEN 'mv_revenue_forecast' THEN
                REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_revenue_forecast;

            ELSE
                RAISE EXCEPTION
                    'Unknown materialized view: %',
                    p_view_name;

        END CASE;

        EXECUTE format(
            'SELECT COUNT(*) FROM public.%I',
            p_view_name
        )
        INTO v_rows;

        UPDATE public.mv_refresh_log
        SET

            completed_at = now(),

            success = true,

            row_count = v_rows

        WHERE id = v_log_id;

        RETURN TRUE;

    EXCEPTION
        WHEN OTHERS THEN

            UPDATE public.mv_refresh_log
            SET

                completed_at = now(),

                success = false,

                error_message = LEFT(SQLERRM, 5000)

            WHERE id = v_log_id;

            RETURN FALSE;

    END;

END;
$$;

ALTER FUNCTION public.refresh_single_mv(TEXT)
SET row_security = off;

-- =============================================================
-- ORDERED ANALYTICS REFRESH
-- =============================================================

CREATE OR REPLACE FUNCTION public.refresh_analytics_views_ordered()

RETURNS JSONB

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_views TEXT[] := ARRAY[
        'mv_daily_hospital_stats',
        'mv_doctor_performance',
        'mv_peak_hour_analysis',
        'mv_village_analysis',
        'mv_revenue_forecast'
    ];

    v_view TEXT;

    v_ok BOOLEAN;

    v_results JSONB := '{}';

BEGIN

    FOREACH v_view IN ARRAY v_views
    LOOP

        v_ok :=
            public.refresh_single_mv(
                v_view
            );

        v_results :=
            v_results
            ||
            jsonb_build_object(
                v_view,
                v_ok
            );

    END LOOP;

    RETURN v_results;

END;
$$;

ALTER FUNCTION public.refresh_analytics_views_ordered()
SET row_security = off;

-- =============================================================
-- MV HEALTH CHECK
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_mv_refresh_health()

RETURNS TABLE (

    view_name TEXT,

    last_refresh TIMESTAMPTZ,

    duration_ms INTEGER,

    last_success BOOLEAN,

    row_count BIGINT,

    is_stale BOOLEAN

)

LANGUAGE sql
STABLE
AS $$

    SELECT DISTINCT ON (view_name)

        view_name,

        started_at,

        duration_ms,

        success,

        row_count,

        started_at <
            now() - interval '26 hours'

    FROM public.mv_refresh_log

    ORDER BY
        view_name,
        started_at DESC;

$$;

-- =============================================================
-- UPDATED run_scheduled_tasks
-- =============================================================

CREATE OR REPLACE FUNCTION public.run_scheduled_tasks()

RETURNS JSONB

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_stale_jobs INTEGER := 0;

    v_stale_presence INTEGER := 0;

    v_expired_restrict INTEGER := 0;

BEGIN

    -- =========================================================
    -- SAFE OPTIONAL CALLS
    -- =========================================================

    BEGIN
        v_stale_jobs :=
            public.reclaim_stale_jobs(10);
    EXCEPTION
        WHEN undefined_function THEN
            v_stale_jobs := 0;
    END;

    BEGIN
        v_stale_presence :=
            public.cleanup_stale_presence();
    EXCEPTION
        WHEN undefined_function THEN
            v_stale_presence := 0;
    END;

    BEGIN
        v_expired_restrict :=
            public.cleanup_expired_restrictions();
    EXCEPTION
        WHEN undefined_function THEN
            v_expired_restrict := 0;
    END;

    -- =========================================================
    -- METRICS SNAPSHOT
    -- =========================================================

    PERFORM public.write_queue_metrics_snapshot();

    RETURN jsonb_build_object(

        'reclaimed_jobs',
        v_stale_jobs,

        'cleaned_presence',
        v_stale_presence,

        'expired_restrictions',
        v_expired_restrict,

        'metrics_snapshot',
        true,

        'run_at',
        now()

    );

END;
$$;

ALTER FUNCTION public.run_scheduled_tasks()
SET row_security = off;

-- =============================================================
-- UPDATED NIGHTLY TASKS
-- =============================================================

CREATE OR REPLACE FUNCTION public.run_nightly_tasks(
    p_hospital_id UUID DEFAULT NULL
)

RETURNS JSONB

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_hospital RECORD;

    v_carried INTEGER := 0;

    v_mv_results JSONB;

BEGIN

    -- =========================================================
    -- CARRY FORWARD TOKENS
    -- =========================================================

    FOR v_hospital IN

        SELECT id
        FROM public.hospitals
        WHERE is_active = true
        AND (
            p_hospital_id IS NULL
            OR id = p_hospital_id
        )

    LOOP

        BEGIN

            v_carried :=
                v_carried
                +
                public.carry_forward_pending_tokens(
                    v_hospital.id,
                    CURRENT_DATE - 1,
                    CURRENT_DATE
                );

        EXCEPTION
            WHEN OTHERS THEN
                NULL;
        END;

    END LOOP;

    -- =========================================================
    -- REFRESH ANALYTICS
    -- =========================================================

    v_mv_results :=
        public.refresh_analytics_views_ordered();

    RETURN jsonb_build_object(

        'carry_forward_count',
        v_carried,

        'mv_refresh_results',
        v_mv_results,

        'run_at',
        now()

    );

END;
$$;

ALTER FUNCTION public.run_nightly_tasks(UUID)
SET row_security = off;

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.queue_metrics_snapshots
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.queue_metrics_snapshots
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.mv_refresh_log
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.mv_refresh_log
FORCE ROW LEVEL SECURITY;

-- =============================================================
-- DROP OLD POLICIES
-- =============================================================

DROP POLICY IF EXISTS queue_metrics_global_admin
ON public.queue_metrics_snapshots;

DROP POLICY IF EXISTS queue_metrics_hospital_admin
ON public.queue_metrics_snapshots;

DROP POLICY IF EXISTS mv_refresh_log_global_admin
ON public.mv_refresh_log;

-- =============================================================
-- POLICIES
-- =============================================================

CREATE POLICY queue_metrics_global_admin
ON public.queue_metrics_snapshots
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

CREATE POLICY queue_metrics_hospital_admin
ON public.queue_metrics_snapshots
FOR SELECT
USING (

    hospital_id IS NOT NULL

    AND public.current_user_role(hospital_id)
        = 'hospital_admin'

);

CREATE POLICY mv_refresh_log_global_admin
ON public.mv_refresh_log
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

COMMIT;