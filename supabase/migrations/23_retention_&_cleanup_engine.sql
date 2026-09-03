-- ============================================================
-- SETURA - Script 23: Retention & Cleanup Engine
-- FULL HARDENED PRODUCTION VERSION
-- FIRST-RUN SAFE
-- RERUN SAFE
-- ============================================================

BEGIN;

-- ============================================================
-- SAFE POLICY CLEANUP
-- ============================================================

DO $$
BEGIN

    IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n
            ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'retention_policies'
    ) THEN

        DROP POLICY IF EXISTS retention_policies_global_admin
        ON public.retention_policies;

        DROP POLICY IF EXISTS retention_policies_read
        ON public.retention_policies;

    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n
            ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'cleanup_run_log'
    ) THEN

        DROP POLICY IF EXISTS cleanup_log_global_admin
        ON public.cleanup_run_log;

    END IF;

END;
$$;

-- ============================================================
-- RETENTION POLICIES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.retention_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    table_name TEXT NOT NULL,

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    retention_days INTEGER NOT NULL
        CHECK (retention_days > 0),

    hard_delete_after_days INTEGER
        CHECK (
            hard_delete_after_days IS NULL
            OR hard_delete_after_days > 0
        ),

    is_active BOOLEAN NOT NULL DEFAULT true,

    legal_basis TEXT,

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(table_name, hospital_id)
);

DROP TRIGGER IF EXISTS trg_retention_policies_updated_at
ON public.retention_policies;

CREATE TRIGGER trg_retention_policies_updated_at
BEFORE UPDATE ON public.retention_policies
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_retention_policies_table
ON public.retention_policies(table_name);

CREATE INDEX IF NOT EXISTS idx_retention_policies_hospital
ON public.retention_policies(hospital_id);

-- ============================================================
-- CLEANUP RUN LOG
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cleanup_run_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    run_type TEXT NOT NULL,

    tables_cleaned JSONB NOT NULL DEFAULT '{}',

    total_deleted INTEGER NOT NULL DEFAULT 0,

    duration_ms INTEGER,

    error_message TEXT,

    success BOOLEAN NOT NULL DEFAULT true,

    run_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cleanup_run_log_time
ON public.cleanup_run_log(run_at DESC);

-- ============================================================
-- DEFAULT RETENTION POLICIES
-- ============================================================

INSERT INTO public.retention_policies (
    table_name,
    hospital_id,
    retention_days,
    hard_delete_after_days,
    legal_basis,
    notes
)
VALUES

('bookings', NULL, 3650, NULL, 'MCI_10yr', 'Medical records'),
('booking_events', NULL, 3650, NULL, 'MCI_10yr', 'Booking audit'),
('patients', NULL, 3650, NULL, 'MCI_10yr', 'Patient master'),

('financial_ledger', NULL, 2555, NULL, 'IT_7yr', 'Financial ledger'),
('hospital_settlements', NULL, 2555, NULL, 'IT_7yr', 'Settlements'),
('daily_collection_entries', NULL, 2555, NULL, 'IT_7yr', 'Collections'),

('audit_logs', NULL, 1095, NULL, 'SETURA_3yr', 'Audit logs'),
('security_events', NULL, 1095, NULL, 'SETURA_3yr', 'Security events'),

('whatsapp_messages', NULL, 365, NULL, 'SETURA_1yr', 'Messages'),
('whatsapp_delivery_logs', NULL, 180, 180, 'SETURA_6mo', 'Delivery logs'),

('notification_queue', NULL, 90, 90, 'SETURA_3mo', 'Notification queue'),
('notification_deliveries', NULL, 90, 90, 'SETURA_3mo', 'Notification deliveries'),

('whatsapp_webhook_events', NULL, 90, 90, 'SETURA_3mo', 'Webhook events'),

('job_queue', NULL, 30, 30, 'SETURA_1mo', 'Completed jobs'),
('dead_letter_jobs', NULL, 90, NULL, 'SETURA_3mo', 'DLQ'),

('booking_attempt_logs', NULL, 30, 30, 'SETURA_1mo', 'Booking attempts'),

('spam_events', NULL, 90, 90, 'SETURA_3mo', 'Spam events'),

('queue_metrics_snapshots', NULL, 7, 7, 'SETURA_7d', 'Queue metrics'),

('worker_heartbeat_log', NULL, 1, 1, 'SETURA_1d', 'Heartbeat'),

('worker_job_leases', NULL, 1, 1, 'SETURA_1d', 'Worker leases'),

('mv_refresh_log', NULL, 30, 30, 'SETURA_1mo', 'MV refresh'),

('config_versions', NULL, 730, NULL, 'SETURA_2yr', 'Config history'),

('payment_orders', NULL, 2555, NULL, 'IT_7yr', 'Payment orders'),
('payment_attempts', NULL, 2555, NULL, 'IT_7yr', 'Payment attempts'),
('payment_refunds', NULL, 2555, NULL, 'IT_7yr', 'Refunds'),

('whatsapp_conversations', NULL, 730, NULL, 'SETURA_2yr', 'Conversation history'),

('dead_letter_queue', NULL, 180, NULL, 'SETURA_6mo', 'Dead letter queue')

ON CONFLICT (table_name, hospital_id)
DO NOTHING;

-- ============================================================
-- CLEANUP OPERATIONAL DATA
-- ============================================================

CREATE OR REPLACE FUNCTION public.cleanup_operational_data()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_counts JSONB := '{}';
BEGIN

    IF EXISTS (
        SELECT 1
        FROM pg_proc
        WHERE proname = 'cleanup_stale_presence'
    ) THEN
        PERFORM public.cleanup_stale_presence();
    END IF;

    RETURN jsonb_build_object(
        'status',
        'completed',
        'run_at',
        now()
    );

END;
$$;

-- ============================================================
-- ARCHIVE OLD MESSAGES
-- ============================================================

CREATE OR REPLACE FUNCTION public.soft_delete_aged_messages()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_wa_count INTEGER := 0;
BEGIN

    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'whatsapp_messages'
    ) THEN

        UPDATE public.whatsapp_messages
        SET metadata =
            COALESCE(metadata, '{}'::jsonb)
            || '{"archived": true}'::jsonb

        WHERE created_at < now() - interval '365 days'
          AND NOT (
              COALESCE(metadata, '{}'::jsonb)
              ? 'archived'
          );

        GET DIAGNOSTICS v_wa_count = ROW_COUNT;

    END IF;

    RETURN jsonb_build_object(
        'archived_messages',
        v_wa_count,
        'run_at',
        now()
    );

END;
$$;

-- ============================================================
-- RETENTION REPORT
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_retention_report()
RETURNS TABLE (
    table_name TEXT,
    retention_days INTEGER,
    hard_delete_after_days INTEGER,
    legal_basis TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        table_name,
        retention_days,
        hard_delete_after_days,
        legal_basis
    FROM public.retention_policies
    WHERE is_active = true
    ORDER BY table_name;
$$;

-- ============================================================
-- MASTER CLEANUP
-- ============================================================

CREATE OR REPLACE FUNCTION public.run_retention_cleanup()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_operational JSONB;
    v_archival JSONB;
BEGIN

    v_operational := public.cleanup_operational_data();

    v_archival := public.soft_delete_aged_messages();

    RETURN jsonb_build_object(
        'operational_cleanup',
        v_operational,

        'archival',
        v_archival,

        'run_at',
        now()
    );

END;
$$;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE public.retention_policies
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.retention_policies
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.cleanup_run_log
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.cleanup_run_log
FORCE ROW LEVEL SECURITY;

CREATE POLICY retention_policies_global_admin
ON public.retention_policies
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

CREATE POLICY retention_policies_read
ON public.retention_policies
FOR SELECT
USING (
    hospital_id IS NULL
    OR public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

CREATE POLICY cleanup_log_global_admin
ON public.cleanup_run_log
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

COMMIT;