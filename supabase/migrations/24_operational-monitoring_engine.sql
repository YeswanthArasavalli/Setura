-- ============================================================
-- SETURA - Script 24: Operational Monitoring Engine
-- FULL HARDENED PRODUCTION VERSION
-- SUPABASE SAFE
-- FIRST RUN SAFE
-- RE-RUN SAFE
-- ============================================================

BEGIN;

-- ============================================================
-- SAFE CLEANUP
-- ============================================================

DROP VIEW IF EXISTS public.monitoring_dashboard;

-- ============================================================
-- ENUMS
-- ============================================================

DO $$
BEGIN
    CREATE TYPE public.alert_severity_level AS ENUM (
        'info',
        'warning',
        'critical'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

-- ============================================================
-- ALERT THRESHOLDS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.alert_thresholds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    alert_key TEXT NOT NULL,

    threshold_value NUMERIC NOT NULL,

    threshold_unit TEXT NOT NULL DEFAULT 'count',

    severity TEXT NOT NULL
        DEFAULT 'warning'
        CHECK (
            severity IN (
                'info',
                'warning',
                'critical'
            )
        ),

    is_active BOOLEAN NOT NULL DEFAULT true,

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(hospital_id, alert_key)
);

CREATE INDEX IF NOT EXISTS idx_alert_thresholds_lookup
ON public.alert_thresholds(alert_key, hospital_id);

DROP TRIGGER IF EXISTS trg_alert_thresholds_updated_at
ON public.alert_thresholds;

CREATE TRIGGER trg_alert_thresholds_updated_at
BEFORE UPDATE ON public.alert_thresholds
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- DEFAULT THRESHOLDS
-- ============================================================

INSERT INTO public.alert_thresholds (
    hospital_id,
    alert_key,
    threshold_value,
    threshold_unit,
    severity,
    notes
)
VALUES
(NULL, 'queue_backlog_pending', 50, 'count', 'warning', 'Pending jobs'),
(NULL, 'queue_backlog_pending_critical', 200, 'count', 'critical', 'Critical queue'),
(NULL, 'worker_crash_count', 1, 'count', 'critical', 'Worker crashed'),
(NULL, 'wa_permanently_failed_daily', 10, 'count', 'warning', 'WhatsApp failures'),
(NULL, 'dlq_unresolved_count', 5, 'count', 'warning', 'DLQ backlog'),
(NULL, 'dlq_unresolved_critical', 20, 'count', 'critical', 'Critical DLQ'),
(NULL, 'mv_refresh_lag_hours', 26, 'hours', 'warning', 'Analytics refresh lag')
ON CONFLICT (hospital_id, alert_key)
DO NOTHING;

-- ============================================================
-- ALERT EVENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.alert_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    alert_key TEXT NOT NULL,

    severity public.alert_severity_level NOT NULL,

    current_value NUMERIC,

    threshold_value NUMERIC,

    threshold_unit TEXT,

    message TEXT NOT NULL,

    is_resolved BOOLEAN NOT NULL DEFAULT false,

    resolved_at TIMESTAMPTZ,

    resolved_by UUID
        REFERENCES public.profiles(id),

    notified BOOLEAN NOT NULL DEFAULT false,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_events_open
ON public.alert_events(
    severity,
    created_at DESC
)
WHERE is_resolved = false;

CREATE INDEX IF NOT EXISTS idx_alert_events_hospital
ON public.alert_events(
    hospital_id,
    created_at DESC
);

-- ============================================================
-- SYSTEM HEALTH SNAPSHOTS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.system_health_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    job_queue_pending INTEGER NOT NULL DEFAULT 0,

    job_queue_processing INTEGER NOT NULL DEFAULT 0,

    job_queue_dead INTEGER NOT NULL DEFAULT 0,

    wa_queue_pending INTEGER NOT NULL DEFAULT 0,

    wa_permanently_failed INTEGER NOT NULL DEFAULT 0,

    active_workers INTEGER NOT NULL DEFAULT 0,

    crashed_workers INTEGER NOT NULL DEFAULT 0,

    dlq_unresolved INTEGER NOT NULL DEFAULT 0,

    payments_pending INTEGER NOT NULL DEFAULT 0,

    mv_oldest_refresh_hrs NUMERIC(8,2),

    alerts_fired INTEGER NOT NULL DEFAULT 0,

    health_score INTEGER NOT NULL DEFAULT 100
);

CREATE INDEX IF NOT EXISTS idx_health_snapshots_recent
ON public.system_health_snapshots(snapshot_at DESC);

-- ============================================================
-- HEALTH SCORE
-- ============================================================

CREATE OR REPLACE FUNCTION public.compute_health_score(
    p_critical_alerts INTEGER,
    p_warning_alerts INTEGER,
    p_crashed_workers INTEGER
)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT GREATEST(
        0,
        100
        - (p_critical_alerts * 20)
        - (p_warning_alerts * 5)
        - (p_crashed_workers * 15)
    )::INTEGER;
$$;

-- ============================================================
-- FIRE ALERT
-- ============================================================

CREATE OR REPLACE FUNCTION public.fire_alert(
    p_hospital_id UUID,
    p_alert_key TEXT,
    p_severity public.alert_severity_level,
    p_current_value NUMERIC,
    p_threshold_value NUMERIC,
    p_threshold_unit TEXT,
    p_message TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
BEGIN

    SELECT id
    INTO v_id
    FROM public.alert_events
    WHERE (
        hospital_id = p_hospital_id
        OR (
            hospital_id IS NULL
            AND p_hospital_id IS NULL
        )
    )
    AND alert_key = p_alert_key
    AND severity = p_severity
    AND is_resolved = false
    AND created_at > now() - interval '1 hour'
    LIMIT 1;

    IF FOUND THEN
        RETURN v_id;
    END IF;

    INSERT INTO public.alert_events (
        hospital_id,
        alert_key,
        severity,
        current_value,
        threshold_value,
        threshold_unit,
        message
    )
    VALUES (
        p_hospital_id,
        p_alert_key,
        p_severity,
        p_current_value,
        p_threshold_value,
        p_threshold_unit,
        p_message
    )
    RETURNING id INTO v_id;

    RETURN v_id;

END;
$$;

-- ============================================================
-- SYSTEM HEALTH CHECK
-- ============================================================

CREATE OR REPLACE FUNCTION public.run_health_check()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_jq_pending INTEGER := 0;
    v_jq_processing INTEGER := 0;
    v_jq_dead INTEGER := 0;

    v_wa_pending INTEGER := 0;
    v_wa_failed INTEGER := 0;

    v_health_score INTEGER;

    v_snapshot_id UUID;

BEGIN

    -- ========================================================
    -- JOB QUEUE CHECK
    -- ========================================================

    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'job_queue'
    ) THEN

        SELECT
            COUNT(*) FILTER (WHERE status = 'pending'),
            COUNT(*) FILTER (WHERE status = 'processing'),
            COUNT(*) FILTER (WHERE status = 'dead')
        INTO
            v_jq_pending,
            v_jq_processing,
            v_jq_dead
        FROM public.job_queue;

    END IF;

    -- ========================================================
    -- WHATSAPP CHECK
    -- ========================================================

    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'whatsapp_messages'
    ) THEN

        SELECT
            COUNT(*) FILTER (WHERE message_status = 'queued'),
            COUNT(*) FILTER (
                WHERE message_status = 'permanently_failed'
                AND created_at > now() - interval '24 hours'
            )
        INTO
            v_wa_pending,
            v_wa_failed
        FROM public.whatsapp_messages;

    END IF;

    -- ========================================================
    -- HEALTH SCORE
    -- ========================================================

    v_health_score :=
        public.compute_health_score(
            CASE WHEN v_jq_pending > 200 THEN 1 ELSE 0 END,
            CASE WHEN v_jq_pending > 50 THEN 1 ELSE 0 END,
            0
        );

    -- ========================================================
    -- SNAPSHOT
    -- ========================================================

    INSERT INTO public.system_health_snapshots (
        job_queue_pending,
        job_queue_processing,
        job_queue_dead,
        wa_queue_pending,
        wa_permanently_failed,
        health_score
    )
    VALUES (
        v_jq_pending,
        v_jq_processing,
        v_jq_dead,
        v_wa_pending,
        v_wa_failed,
        v_health_score
    )
    RETURNING id
    INTO v_snapshot_id;

    DELETE FROM public.system_health_snapshots
    WHERE snapshot_at < now() - interval '7 days';

    RETURN jsonb_build_object(
        'snapshot_id', v_snapshot_id,
        'health_score', v_health_score,
        'job_queue_pending', v_jq_pending,
        'wa_pending', v_wa_pending,
        'run_at', now()
    );

END;
$$;

-- ============================================================
-- SLA TRACKING
-- ============================================================

CREATE TABLE IF NOT EXISTS public.sla_daily_tracking (
    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    tracking_date DATE NOT NULL,

    avg_wait_minutes NUMERIC(8,2),

    completion_rate_pct NUMERIC(5,2),

    no_show_rate_pct NUMERIC(5,2),

    cancellation_rate_pct NUMERIC(5,2),

    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY(hospital_id, tracking_date)
);

CREATE INDEX IF NOT EXISTS idx_sla_tracking_hospital
ON public.sla_daily_tracking(
    hospital_id,
    tracking_date DESC
);

-- ============================================================
-- MONITORING DASHBOARD VIEW
-- ============================================================

CREATE OR REPLACE VIEW public.monitoring_dashboard AS
SELECT
    snapshot_at,
    health_score,
    job_queue_pending,
    job_queue_dead,
    wa_queue_pending,
    wa_permanently_failed,
    active_workers,
    crashed_workers,
    dlq_unresolved,
    alerts_fired
FROM public.system_health_snapshots
ORDER BY snapshot_at DESC
LIMIT 1;

-- ============================================================
-- SAFE POLICY CLEANUP
-- ============================================================

DROP POLICY IF EXISTS alert_thresholds_read
ON public.alert_thresholds;

DROP POLICY IF EXISTS alert_thresholds_manage
ON public.alert_thresholds;

DROP POLICY IF EXISTS alert_events_read
ON public.alert_events;

DROP POLICY IF EXISTS alert_events_manage
ON public.alert_events;

DROP POLICY IF EXISTS health_snapshots_global_admin
ON public.system_health_snapshots;

DROP POLICY IF EXISTS sla_tracking_read
ON public.sla_daily_tracking;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE public.alert_thresholds
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.alert_thresholds
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.alert_events
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.alert_events
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.system_health_snapshots
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.system_health_snapshots
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.sla_daily_tracking
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.sla_daily_tracking
FORCE ROW LEVEL SECURITY;

-- ============================================================
-- POLICIES
-- ============================================================

CREATE POLICY alert_thresholds_read
ON public.alert_thresholds
FOR SELECT
USING (
    hospital_id IS NULL
    OR public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

CREATE POLICY alert_thresholds_manage
ON public.alert_thresholds
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

CREATE POLICY alert_events_read
ON public.alert_events
FOR SELECT
USING (
    public.is_global_admin()
);

CREATE POLICY alert_events_manage
ON public.alert_events
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

CREATE POLICY health_snapshots_global_admin
ON public.system_health_snapshots
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

CREATE POLICY sla_tracking_read
ON public.sla_daily_tracking
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

COMMIT;