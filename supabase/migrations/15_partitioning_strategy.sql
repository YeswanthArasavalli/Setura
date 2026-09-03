-- =============================================================
-- SETURA HOSPITAL OS
-- Script 15: Partitioning Strategy
-- FINAL PRODUCTION SAFE VERSION
-- =============================================================

BEGIN;

-- =============================================================
-- IMPORTANT NOTES
-- =============================================================
--
-- This script DOES NOT partition tables immediately.
--
-- It provides:
--
-- 1. Partition planning helpers
-- 2. Partition DDL generators
-- 3. Readiness monitoring
-- 4. Migration-safe utilities
--
-- Actual partition migrations should happen:
--
-- - during maintenance windows
-- - after backup verification
-- - after benchmark testing
-- - after row thresholds are reached
--
-- =============================================================

-- =============================================================
-- PARTITION MANAGEMENT CONFIG
-- =============================================================

CREATE TABLE IF NOT EXISTS public.partition_management (

    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    table_name TEXT NOT NULL UNIQUE,

    partition_strategy TEXT NOT NULL
        CHECK (
            partition_strategy IN (
                'monthly',
                'quarterly',
                'yearly'
            )
        ),

    partition_column TEXT NOT NULL,

    recommended_threshold BIGINT NOT NULL
        CHECK (recommended_threshold > 0),

    partition_enabled BOOLEAN NOT NULL DEFAULT false,

    last_partition_created_for DATE,

    retention_months INTEGER
        CHECK (
            retention_months IS NULL
            OR retention_months > 0
        ),

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ
        NOT NULL DEFAULT now()
);

-- =============================================================
-- INDEXES
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_partition_mgmt_enabled
ON public.partition_management(
    partition_enabled,
    table_name
);

CREATE INDEX IF NOT EXISTS idx_partition_mgmt_table
ON public.partition_management(table_name);

-- =============================================================
-- TRIGGERS
-- =============================================================

DROP TRIGGER IF EXISTS trg_partition_mgmt_updated_at
ON public.partition_management;

CREATE TRIGGER trg_partition_mgmt_updated_at
BEFORE UPDATE
ON public.partition_management
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- DEFAULT PARTITION CONFIGURATION
-- =============================================================

INSERT INTO public.partition_management (
    table_name,
    partition_strategy,
    partition_column,
    recommended_threshold,
    retention_months
)
VALUES

(
    'bookings',
    'monthly',
    'appointment_date',
    500000,
    36
),

(
    'audit_logs',
    'monthly',
    'created_at',
    2000000,
    24
),

(
    'whatsapp_messages',
    'monthly',
    'created_at',
    1000000,
    12
),

(
    'financial_ledger',
    'monthly',
    'created_at',
    1000000,
    60
),

(
    'payment_attempts',
    'monthly',
    'created_at',
    500000,
    24
),

(
    'booking_events',
    'monthly',
    'created_at',
    1000000,
    12
)

ON CONFLICT (table_name)
DO NOTHING;

-- =============================================================
-- BOOKINGS PARTITION DDL GENERATOR
-- =============================================================

CREATE OR REPLACE FUNCTION public.generate_booking_partition_ddl(
    p_months INTEGER DEFAULT 12
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_sql TEXT := '';
    v_start DATE;
    v_end DATE;
    v_suffix TEXT;

BEGIN

    v_sql :=
        '-- ===================================================' || chr(10) ||
        '-- GENERATED BOOKINGS PARTITION DDL' || chr(10) ||
        '-- ===================================================' || chr(10) ||
        chr(10);

    v_sql := v_sql ||

        'CREATE TABLE IF NOT EXISTS public.bookings_partitioned' || chr(10) ||
        '(' || chr(10) ||
        '    LIKE public.bookings INCLUDING DEFAULTS' || chr(10) ||
        '    INCLUDING CONSTRAINTS' || chr(10) ||
        '    INCLUDING GENERATED' || chr(10) ||
        '    INCLUDING STORAGE' || chr(10) ||
        ')' || chr(10) ||
        'PARTITION BY RANGE (appointment_date);' ||
        chr(10) || chr(10);

    FOR i IN 0..(p_months - 1)
    LOOP

        v_start :=
            date_trunc(
                'month',
                now() + (i || ' months')::interval
            )::date;

        v_end :=
            (
                v_start + interval '1 month'
            )::date;

        v_suffix :=
            to_char(v_start, 'YYYY_MM');

        v_sql := v_sql ||

            format(
                'CREATE TABLE IF NOT EXISTS public.bookings_%s' ||
                chr(10) ||
                'PARTITION OF public.bookings_partitioned' ||
                chr(10) ||
                'FOR VALUES FROM (''%s'') TO (''%s'');' ||
                chr(10) || chr(10),
                v_suffix,
                v_start,
                v_end
            );

    END LOOP;

    RETURN v_sql;

END;
$$;

ALTER FUNCTION public.generate_booking_partition_ddl(INTEGER)
SET row_security = off;

-- =============================================================
-- AUDIT LOG PARTITION GENERATOR
-- =============================================================

CREATE OR REPLACE FUNCTION public.generate_audit_log_partition_ddl(
    p_months INTEGER DEFAULT 12
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_sql TEXT := '';
    v_start DATE;
    v_end DATE;
    v_suffix TEXT;

BEGIN

    v_sql :=
        '-- ===================================================' || chr(10) ||
        '-- GENERATED AUDIT LOG PARTITION DDL' || chr(10) ||
        '-- ===================================================' || chr(10) ||
        chr(10);

    v_sql := v_sql ||

        'CREATE TABLE IF NOT EXISTS public.audit_logs_partitioned' || chr(10) ||
        '(' || chr(10) ||
        '    LIKE public.audit_logs INCLUDING DEFAULTS' || chr(10) ||
        '    INCLUDING CONSTRAINTS' || chr(10) ||
        '    INCLUDING GENERATED' || chr(10) ||
        '    INCLUDING STORAGE' || chr(10) ||
        ')' || chr(10) ||
        'PARTITION BY RANGE (created_at);' ||
        chr(10) || chr(10);

    FOR i IN 0..(p_months - 1)
    LOOP

        v_start :=
            date_trunc(
                'month',
                now() + (i || ' months')::interval
            )::date;

        v_end :=
            (
                v_start + interval '1 month'
            )::date;

        v_suffix :=
            to_char(v_start, 'YYYY_MM');

        v_sql := v_sql ||

            format(
                'CREATE TABLE IF NOT EXISTS public.audit_logs_%s' ||
                chr(10) ||
                'PARTITION OF public.audit_logs_partitioned' ||
                chr(10) ||
                'FOR VALUES FROM (''%s'') TO (''%s'');' ||
                chr(10) || chr(10),
                v_suffix,
                v_start::timestamptz,
                v_end::timestamptz
            );

    END LOOP;

    RETURN v_sql;

END;
$$;

ALTER FUNCTION public.generate_audit_log_partition_ddl(INTEGER)
SET row_security = off;

-- =============================================================
-- WHATSAPP MESSAGE PARTITION GENERATOR
-- =============================================================

CREATE OR REPLACE FUNCTION public.generate_wa_messages_partition_ddl(
    p_months INTEGER DEFAULT 12
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_sql TEXT := '';
    v_start DATE;
    v_end DATE;
    v_suffix TEXT;

BEGIN

    v_sql :=
        '-- ===================================================' || chr(10) ||
        '-- GENERATED WHATSAPP MESSAGE PARTITION DDL' || chr(10) ||
        '-- ===================================================' || chr(10) ||
        chr(10);

    v_sql := v_sql ||

        'CREATE TABLE IF NOT EXISTS public.whatsapp_messages_partitioned' || chr(10) ||
        '(' || chr(10) ||
        '    LIKE public.whatsapp_messages INCLUDING DEFAULTS' || chr(10) ||
        '    INCLUDING CONSTRAINTS' || chr(10) ||
        '    INCLUDING GENERATED' || chr(10) ||
        '    INCLUDING STORAGE' || chr(10) ||
        ')' || chr(10) ||
        'PARTITION BY RANGE (created_at);' ||
        chr(10) || chr(10);

    FOR i IN 0..(p_months - 1)
    LOOP

        v_start :=
            date_trunc(
                'month',
                now() + (i || ' months')::interval
            )::date;

        v_end :=
            (
                v_start + interval '1 month'
            )::date;

        v_suffix :=
            to_char(v_start, 'YYYY_MM');

        v_sql := v_sql ||

            format(
                'CREATE TABLE IF NOT EXISTS public.whatsapp_messages_%s' ||
                chr(10) ||
                'PARTITION OF public.whatsapp_messages_partitioned' ||
                chr(10) ||
                'FOR VALUES FROM (''%s'') TO (''%s'');' ||
                chr(10) || chr(10),
                v_suffix,
                v_start::timestamptz,
                v_end::timestamptz
            );

    END LOOP;

    RETURN v_sql;

END;
$$;

ALTER FUNCTION public.generate_wa_messages_partition_ddl(INTEGER)
SET row_security = off;

-- =============================================================
-- PARTITION READINESS CHECK
-- =============================================================

CREATE OR REPLACE FUNCTION public.check_partition_readiness()
RETURNS TABLE (

    table_name TEXT,
    estimated_rows BIGINT,
    recommended_threshold BIGINT,
    recommends_partition BOOLEAN

)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$

    SELECT

        pm.table_name,

        COALESCE(pc.reltuples, 0)::BIGINT,

        pm.recommended_threshold,

        (
            COALESCE(pc.reltuples, 0)
            >= pm.recommended_threshold
        )

    FROM public.partition_management pm

    LEFT JOIN pg_class pc
        ON pc.relname = pm.table_name

    WHERE pc.relkind = 'r'

    ORDER BY pc.reltuples DESC NULLS LAST;

$$;

ALTER FUNCTION public.check_partition_readiness()
SET row_security = off;

-- =============================================================
-- PARTITION HEALTH VIEW
-- =============================================================

CREATE OR REPLACE VIEW public.partition_health AS
SELECT *
FROM public.check_partition_readiness();

-- =============================================================
-- PARTITION MAINTENANCE ADVISOR
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_partition_maintenance_advice()
RETURNS TABLE (

    table_name TEXT,
    recommendation TEXT,
    estimated_rows BIGINT

)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$

    SELECT

        table_name,

        CASE

            WHEN recommends_partition = true
            THEN 'Partition migration recommended immediately'

            WHEN estimated_rows >= (recommended_threshold * 0.7)
            THEN 'Prepare partition migration soon'

            ELSE 'No partitioning needed yet'

        END,

        estimated_rows

    FROM public.check_partition_readiness();

$$;

ALTER FUNCTION public.get_partition_maintenance_advice()
SET row_security = off;

-- =============================================================
-- RLS
-- =============================================================

ALTER TABLE public.partition_management
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.partition_management
FORCE ROW LEVEL SECURITY;

-- =============================================================
-- POLICIES
-- =============================================================

DROP POLICY IF EXISTS partition_mgmt_read
ON public.partition_management;

CREATE POLICY partition_mgmt_read
ON public.partition_management
FOR SELECT
USING (
    public.is_global_admin()
);

DROP POLICY IF EXISTS partition_mgmt_manage
ON public.partition_management;

CREATE POLICY partition_mgmt_manage
ON public.partition_management
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

COMMIT;