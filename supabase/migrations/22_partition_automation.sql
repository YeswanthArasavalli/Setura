-- ============================================================
-- SETURA - Script 22: Partition Automation
-- FINAL PRODUCTION SAFE VERSION
-- FULL RERUN SAFE
-- ============================================================

BEGIN;

-- ============================================================
-- CLEAN OLD DEPENDENT OBJECTS FIRST
-- Prevent:
-- cannot drop function because other objects depend on it
-- ============================================================

DROP VIEW IF EXISTS public.partition_health;

DROP FUNCTION IF EXISTS public.check_partition_readiness();
DROP FUNCTION IF EXISTS public.get_partition_health();
DROP FUNCTION IF EXISTS public.plan_partitions(TEXT,INTEGER,DATE);

-- ============================================================
-- ENUM
-- ============================================================

DO $$
BEGIN
    CREATE TYPE public.partition_state AS ENUM (
        'planned',
        'created',
        'attached',
        'detached',
        'archived'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- PARTITION MANIFEST
-- ============================================================

CREATE TABLE IF NOT EXISTS public.partition_manifest (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    parent_table TEXT NOT NULL,

    partition_name TEXT NOT NULL UNIQUE,

    partition_schema TEXT NOT NULL DEFAULT 'public',

    range_start TEXT NOT NULL,
    range_end TEXT NOT NULL,

    range_column TEXT NOT NULL,

    partition_state public.partition_state
        NOT NULL DEFAULT 'planned',

    estimated_rows BIGINT,
    actual_rows BIGINT,
    size_bytes BIGINT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    attached_at TIMESTAMPTZ,
    detached_at TIMESTAMPTZ,

    last_analyzed_at TIMESTAMPTZ,

    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_partition_manifest_parent
ON public.partition_manifest(
    parent_table,
    partition_state
);

CREATE INDEX IF NOT EXISTS idx_partition_manifest_name
ON public.partition_manifest(
    partition_name
);

-- ============================================================
-- PARTITION CONFIG
-- ============================================================

CREATE TABLE IF NOT EXISTS public.partition_config (
    parent_table TEXT PRIMARY KEY,

    range_column TEXT NOT NULL,

    range_type TEXT NOT NULL DEFAULT 'date'
        CHECK (
            range_type IN (
                'date',
                'timestamptz'
            )
        ),

    row_threshold INTEGER NOT NULL DEFAULT 300000,

    create_ahead_months INTEGER NOT NULL DEFAULT 2,

    is_auto_enabled BOOLEAN NOT NULL DEFAULT false,

    last_auto_run TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.partition_config (
    parent_table,
    range_column,
    range_type,
    row_threshold,
    create_ahead_months
)
VALUES
(
    'bookings',
    'appointment_date',
    'date',
    300000,
    2
),
(
    'audit_logs',
    'created_at',
    'timestamptz',
    500000,
    2
),
(
    'whatsapp_messages',
    'created_at',
    'timestamptz',
    400000,
    2
)
ON CONFLICT (parent_table)
DO NOTHING;

-- ============================================================
-- PARTITION NAME HELPER
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_partition_name(
    p_parent_table TEXT,
    p_month DATE
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT
        p_parent_table
        || '_'
        || to_char(p_month, 'YYYY_MM');
$$;

-- ============================================================
-- GENERATE PARTITION DDL
-- ============================================================

CREATE OR REPLACE FUNCTION public.generate_partition_ddl(
    p_parent_table TEXT,
    p_month DATE
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_config RECORD;

    v_name TEXT;

    v_start TEXT;
    v_end TEXT;

    v_end_date DATE;

    v_ddl TEXT;
BEGIN

    SELECT *
    INTO v_config
    FROM public.partition_config
    WHERE parent_table = p_parent_table;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Partition config missing for %',
            p_parent_table;
    END IF;

    v_name :=
        public.get_partition_name(
            p_parent_table,
            p_month
        );

    v_end_date :=
        (p_month + interval '1 month')::DATE;

    IF v_config.range_type = 'date' THEN

        v_start := p_month::TEXT;
        v_end := v_end_date::TEXT;

    ELSE

        v_start :=
            (p_month::TIMESTAMP AT TIME ZONE 'UTC')::TEXT;

        v_end :=
            (v_end_date::TIMESTAMP AT TIME ZONE 'UTC')::TEXT;

    END IF;

    v_ddl := format(
$ddl$
CREATE TABLE IF NOT EXISTS public.%1$I
PARTITION OF public.%2$I
FOR VALUES FROM ('%3$s') TO ('%4$s');

INSERT INTO public.partition_manifest (
    parent_table,
    partition_name,
    range_start,
    range_end,
    range_column,
    partition_state,
    attached_at
)
VALUES (
    '%2$s',
    '%1$s',
    '%3$s',
    '%4$s',
    '%5$s',
    'attached',
    now()
)
ON CONFLICT (partition_name)
DO UPDATE SET
    partition_state = 'attached',
    attached_at = now();
$ddl$,
        v_name,
        p_parent_table,
        v_start,
        v_end,
        v_config.range_column
    );

    RETURN v_ddl;

END;
$$;

-- ============================================================
-- PLAN PARTITIONS
-- ============================================================

CREATE FUNCTION public.plan_partitions(
    p_parent_table TEXT,
    p_months_ahead INTEGER DEFAULT 3,
    p_start_month DATE DEFAULT date_trunc(
        'month',
        CURRENT_DATE
    )::DATE
)
RETURNS TABLE (
    partition_name TEXT,
    range_start TEXT,
    state public.partition_state
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_config RECORD;

    v_month DATE;

    v_name TEXT;

    v_end_date DATE;

    v_start_str TEXT;
    v_end_str TEXT;

    i INTEGER;
BEGIN

    SELECT *
    INTO v_config
    FROM public.partition_config
    WHERE parent_table = p_parent_table;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Partition config missing for %',
            p_parent_table;
    END IF;

    FOR i IN 0..(p_months_ahead - 1)
    LOOP

        v_month :=
            (
                p_start_month
                + (i || ' months')::INTERVAL
            )::DATE;

        v_end_date :=
            (
                v_month
                + interval '1 month'
            )::DATE;

        v_name :=
            public.get_partition_name(
                p_parent_table,
                v_month
            );

        IF v_config.range_type = 'date' THEN

            v_start_str := v_month::TEXT;
            v_end_str := v_end_date::TEXT;

        ELSE

            v_start_str :=
                (
                    v_month::TIMESTAMP
                    AT TIME ZONE 'UTC'
                )::TEXT;

            v_end_str :=
                (
                    v_end_date::TIMESTAMP
                    AT TIME ZONE 'UTC'
                )::TEXT;

        END IF;

        INSERT INTO public.partition_manifest (
            parent_table,
            partition_name,
            range_start,
            range_end,
            range_column,
            partition_state
        )
        VALUES (
            p_parent_table,
            v_name,
            v_start_str,
            v_end_str,
            v_config.range_column,
            'planned'
        )
        ON CONFLICT (partition_name)
        DO NOTHING;

        partition_name := v_name;
        range_start := v_start_str;
        state := 'planned';

        RETURN NEXT;

    END LOOP;

END;
$$;

-- ============================================================
-- PARTITION READINESS
-- ============================================================

CREATE FUNCTION public.check_partition_readiness()
RETURNS TABLE (
    table_name TEXT,
    estimated_rows BIGINT,
    threshold_value INTEGER,
    threshold_reached BOOLEAN,
    auto_enabled BOOLEAN,
    action_recommended TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        pc.parent_table,

        COALESCE(
            c.reltuples::BIGINT,
            0
        ),

        pc.row_threshold,

        (
            COALESCE(c.reltuples, 0)
            >= pc.row_threshold
        ),

        pc.is_auto_enabled,

        CASE
            WHEN
                COALESCE(c.reltuples, 0)
                >= pc.row_threshold
                AND NOT pc.is_auto_enabled
            THEN
                'Enable auto partitioning'

            WHEN
                COALESCE(c.reltuples, 0)
                >= pc.row_threshold
                AND pc.is_auto_enabled
            THEN
                'Partitions will auto-create'

            ELSE
                'Healthy'
        END

    FROM public.partition_config pc

    LEFT JOIN pg_class c
        ON c.relname = pc.parent_table
       AND c.relkind = 'r'

    ORDER BY
        COALESCE(c.reltuples, 0) DESC;
$$;

-- ============================================================
-- PARTITION HEALTH
-- ============================================================

CREATE FUNCTION public.get_partition_health()
RETURNS TABLE (
    partition_name TEXT,
    parent_table TEXT,
    range_start TEXT,
    range_end TEXT,
    state public.partition_state,
    actual_rows BIGINT,
    size_pretty TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rec RECORD;

    v_rows BIGINT;

    v_size TEXT;
BEGIN

    FOR v_rec IN
        SELECT *
        FROM public.partition_manifest
        WHERE partition_state IN (
            'created',
            'attached'
        )
        ORDER BY
            parent_table,
            range_start
    LOOP

        BEGIN

            EXECUTE format(
                'SELECT COUNT(*) FROM public.%I',
                v_rec.partition_name
            )
            INTO v_rows;

        EXCEPTION
            WHEN undefined_table THEN
                v_rows := NULL;
        END;

        BEGIN

            EXECUTE format(
                'SELECT pg_size_pretty(pg_total_relation_size(%L::regclass))',
                'public.' || v_rec.partition_name
            )
            INTO v_size;

        EXCEPTION
            WHEN undefined_table THEN
                v_size := NULL;
        END;

        partition_name := v_rec.partition_name;
        parent_table := v_rec.parent_table;
        range_start := v_rec.range_start;
        range_end := v_rec.range_end;
        state := v_rec.partition_state;
        actual_rows := v_rows;
        size_pretty := v_size;

        RETURN NEXT;

    END LOOP;

END;
$$;

-- ============================================================
-- VIEW
-- ============================================================

CREATE VIEW public.partition_health AS
SELECT *
FROM public.check_partition_readiness();

-- ============================================================
-- AUTO PARTITION SCHEDULER
-- ============================================================

CREATE OR REPLACE FUNCTION public.schedule_partition_creation()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_config RECORD;

    v_month DATE;

    v_name TEXT;

    v_planned INTEGER := 0;

    i INTEGER;
BEGIN

    FOR v_config IN
        SELECT *
        FROM public.partition_config
        WHERE is_auto_enabled = true
    LOOP

        FOR i IN 0..v_config.create_ahead_months
        LOOP

            v_month :=
                (
                    date_trunc(
                        'month',
                        CURRENT_DATE
                    )
                    +
                    (i || ' months')::INTERVAL
                )::DATE;

            v_name :=
                public.get_partition_name(
                    v_config.parent_table,
                    v_month
                );

            IF NOT EXISTS (
                SELECT 1
                FROM public.partition_manifest
                WHERE partition_name = v_name
            )
            THEN

                PERFORM public.plan_partitions(
                    v_config.parent_table,
                    1,
                    v_month
                );

                v_planned := v_planned + 1;

            END IF;

        END LOOP;

        UPDATE public.partition_config
        SET last_auto_run = now()
        WHERE parent_table = v_config.parent_table;

    END LOOP;

    RETURN jsonb_build_object(
        'partitions_planned',
        v_planned,

        'computed_at',
        now()
    );

END;
$$;

-- ============================================================
-- OPERATIONAL NOTES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.operational_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    category TEXT NOT NULL,

    title TEXT NOT NULL UNIQUE,

    body TEXT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE public.partition_manifest
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.partition_manifest
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.partition_config
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.partition_config
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.operational_notes
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.operational_notes
FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partition_manifest_global_admin
ON public.partition_manifest;

DROP POLICY IF EXISTS partition_config_global_admin
ON public.partition_config;

DROP POLICY IF EXISTS operational_notes_read
ON public.operational_notes;

CREATE POLICY partition_manifest_global_admin
ON public.partition_manifest
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

CREATE POLICY partition_config_global_admin
ON public.partition_config
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

CREATE POLICY operational_notes_read
ON public.operational_notes
FOR SELECT
USING (
    public.is_global_admin()
);

COMMIT;