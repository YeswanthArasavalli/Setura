-- ============================================================
-- SETURA - Script 26: Migration Metadata & Registry
-- FINAL HARDENED PRODUCTION VERSION
-- SUPABASE SAFE
-- FIRST RUN SAFE
-- RE-RUN SAFE
-- ============================================================

BEGIN;

-- ============================================================
-- ENUMS
-- ============================================================

DO $$
BEGIN
    CREATE TYPE public.migration_status AS ENUM (
        'pending',
        'applied',
        'failed',
        'rolled_back',
        'skipped'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END;
$$;

-- ============================================================
-- MIGRATION REGISTRY
-- ============================================================

CREATE TABLE IF NOT EXISTS public.migration_registry (

    migration_id TEXT PRIMARY KEY,

    script_filename TEXT NOT NULL UNIQUE,

    script_version TEXT NOT NULL DEFAULT '1.0',

    description TEXT NOT NULL,

    category TEXT NOT NULL
        DEFAULT 'schema'
        CHECK (
            category IN (
                'schema',
                'data',
                'function',
                'policy',
                'index',
                'trigger',
                'view',
                'config'
            )
        ),

    depends_on TEXT[]
        NOT NULL DEFAULT '{}',

    status public.migration_status
        NOT NULL DEFAULT 'pending',

    applied_at TIMESTAMPTZ,

    duration_ms INTEGER,

    applied_by TEXT,

    checksum_sha256 TEXT,

    checksum_verified BOOLEAN
        NOT NULL DEFAULT false,

    rollback_script TEXT,

    is_reversible BOOLEAN
        NOT NULL DEFAULT false,

    last_error TEXT,

    attempt_count INTEGER
        NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ
        NOT NULL DEFAULT now()
);

-- ============================================================
-- SAFE CLEANUP (AFTER TABLE EXISTS)
-- ============================================================

DROP POLICY IF EXISTS migration_registry_global_admin
ON public.migration_registry;

DROP TRIGGER IF EXISTS trg_migration_registry_updated_at
ON public.migration_registry;

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_migration_registry_status
ON public.migration_registry(
    status,
    applied_at DESC
);

CREATE INDEX IF NOT EXISTS idx_migration_registry_category
ON public.migration_registry(
    category
);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================

CREATE TRIGGER trg_migration_registry_updated_at
BEFORE UPDATE ON public.migration_registry
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- EXECUTION LOG
-- ============================================================

CREATE TABLE IF NOT EXISTS public.migration_execution_log (

    id BIGSERIAL PRIMARY KEY,

    migration_id TEXT NOT NULL
        REFERENCES public.migration_registry(migration_id)
        ON DELETE CASCADE,

    action TEXT NOT NULL
        CHECK (
            action IN (
                'apply',
                'rollback',
                'verify',
                'skip'
            )
        ),

    status TEXT NOT NULL
        CHECK (
            status IN (
                'started',
                'completed',
                'failed'
            )
        ),

    duration_ms INTEGER,

    applied_by TEXT,

    error_message TEXT,

    postgres_version TEXT
        NOT NULL DEFAULT current_setting('server_version'),

    supabase_project TEXT,

    executed_at TIMESTAMPTZ
        NOT NULL DEFAULT now()
);

-- ============================================================
-- SAFE CLEANUP
-- ============================================================

DROP POLICY IF EXISTS migration_log_global_admin
ON public.migration_execution_log;

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_migration_log_id
ON public.migration_execution_log(
    migration_id,
    executed_at DESC
);

CREATE INDEX IF NOT EXISTS idx_migration_log_status
ON public.migration_execution_log(
    status,
    executed_at DESC
);

-- ============================================================
-- REGISTER MIGRATION
-- ============================================================

CREATE OR REPLACE FUNCTION public.register_migration(
    p_migration_id TEXT,
    p_filename TEXT,
    p_description TEXT,
    p_category TEXT DEFAULT 'schema',
    p_depends_on TEXT[] DEFAULT '{}',
    p_version TEXT DEFAULT '1.0',
    p_duration_ms INTEGER DEFAULT NULL,
    p_checksum TEXT DEFAULT NULL,
    p_is_reversible BOOLEAN DEFAULT false,
    p_rollback_script TEXT DEFAULT NULL,
    p_applied_by TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    INSERT INTO public.migration_registry (
        migration_id,
        script_filename,
        script_version,
        description,
        category,
        depends_on,
        status,
        applied_at,
        duration_ms,
        applied_by,
        checksum_sha256,
        is_reversible,
        rollback_script
    )
    VALUES (
        p_migration_id,
        p_filename,
        p_version,
        p_description,
        p_category,
        p_depends_on,
        'applied',
        now(),
        p_duration_ms,
        p_applied_by,
        p_checksum,
        p_is_reversible,
        p_rollback_script
    )
    ON CONFLICT (migration_id)
    DO UPDATE SET
        status = 'applied',
        applied_at = COALESCE(
            migration_registry.applied_at,
            now()
        ),
        duration_ms = COALESCE(
            EXCLUDED.duration_ms,
            migration_registry.duration_ms
        ),
        checksum_sha256 = COALESCE(
            EXCLUDED.checksum_sha256,
            migration_registry.checksum_sha256
        ),
        updated_at = now();

    INSERT INTO public.migration_execution_log (
        migration_id,
        action,
        status,
        duration_ms,
        applied_by
    )
    VALUES (
        p_migration_id,
        'apply',
        'completed',
        p_duration_ms,
        p_applied_by
    );

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.register_migration(
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT[],
    TEXT,
    INTEGER,
    TEXT,
    BOOLEAN,
    TEXT,
    TEXT
)
SET row_security = off;

-- ============================================================
-- FAIL MIGRATION
-- ============================================================

CREATE OR REPLACE FUNCTION public.fail_migration(
    p_migration_id TEXT,
    p_error TEXT,
    p_applied_by TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    UPDATE public.migration_registry
    SET
        status = 'failed',
        last_error = left(p_error, 4000),
        attempt_count = attempt_count + 1,
        updated_at = now()
    WHERE migration_id = p_migration_id;

    INSERT INTO public.migration_execution_log (
        migration_id,
        action,
        status,
        error_message,
        applied_by
    )
    VALUES (
        p_migration_id,
        'apply',
        'failed',
        left(p_error, 4000),
        p_applied_by
    );

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.fail_migration(
    TEXT,
    TEXT,
    TEXT
)
SET row_security = off;

-- ============================================================
-- MIGRATION STATUS VIEW
-- ============================================================

CREATE OR REPLACE VIEW public.migration_status_view AS
SELECT
    migration_id,
    script_filename,
    status,
    applied_at,
    duration_ms,
    depends_on,
    description
FROM public.migration_registry
ORDER BY applied_at NULLS LAST;

-- ============================================================
-- DEPLOYMENT SNAPSHOTS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.deployment_snapshots (

    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    snapshot_label TEXT NOT NULL,

    postgres_version TEXT
        NOT NULL DEFAULT current_setting('server_version'),

    total_migrations INTEGER
        NOT NULL DEFAULT 0,

    applied_migrations INTEGER
        NOT NULL DEFAULT 0,

    failed_migrations INTEGER
        NOT NULL DEFAULT 0,

    database_size_bytes BIGINT,

    table_count INTEGER,

    function_count INTEGER,

    snapshot_data JSONB
        NOT NULL DEFAULT '{}',

    created_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    created_by TEXT
);

-- ============================================================
-- SAFE CLEANUP
-- ============================================================

DROP POLICY IF EXISTS deployment_snapshots_global_admin
ON public.deployment_snapshots;

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_deployment_snapshots_created
ON public.deployment_snapshots(
    created_at DESC
);

-- ============================================================
-- TAKE SNAPSHOT
-- ============================================================

CREATE OR REPLACE FUNCTION public.take_deployment_snapshot(
    p_label TEXT,
    p_created_by TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_id UUID;
    v_db_size BIGINT;
    v_table_count INTEGER;
    v_fn_count INTEGER;
    v_snapshot JSONB;
    v_total INTEGER;
    v_applied INTEGER;
    v_failed INTEGER;

BEGIN

    SELECT pg_database_size(current_database())
    INTO v_db_size;

    SELECT COUNT(*)
    INTO v_table_count
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE';

    SELECT COUNT(*)
    INTO v_fn_count
    FROM information_schema.routines
    WHERE routine_schema = 'public';

    SELECT
        COUNT(*),
        COUNT(*) FILTER (WHERE status = 'applied'),
        COUNT(*) FILTER (WHERE status = 'failed')
    INTO
        v_total,
        v_applied,
        v_failed
    FROM public.migration_registry;

    SELECT COALESCE(
        jsonb_agg(row_to_json(ms)),
        '[]'::jsonb
    )
    INTO v_snapshot
    FROM public.migration_status_view ms;

    INSERT INTO public.deployment_snapshots (
        snapshot_label,
        postgres_version,
        total_migrations,
        applied_migrations,
        failed_migrations,
        database_size_bytes,
        table_count,
        function_count,
        snapshot_data,
        created_by
    )
    VALUES (
        p_label,
        current_setting('server_version'),
        v_total,
        v_applied,
        v_failed,
        v_db_size,
        v_table_count,
        v_fn_count,
        v_snapshot,
        p_created_by
    )
    RETURNING id INTO v_id;

    RETURN v_id;

END;
$$;

ALTER FUNCTION public.take_deployment_snapshot(
    TEXT,
    TEXT
)
SET row_security = off;

-- ============================================================
-- SAFE BACKFILL
-- ============================================================

INSERT INTO public.migration_registry (
    migration_id,
    script_filename,
    description,
    category,
    status,
    applied_at
)
VALUES
(
    '01_foundation',
    '01_foundation.sql',
    'Foundation schema',
    'schema',
    'applied',
    now()
),
(
    '26_migration_metadata',
    '26_migration_metadata.sql',
    'Migration metadata engine',
    'schema',
    'applied',
    now()
)
ON CONFLICT (migration_id)
DO NOTHING;

-- ============================================================
-- INITIAL SNAPSHOT
-- ============================================================

SELECT public.take_deployment_snapshot(
    'initial-deploy-v1',
    'migration-runner'
);

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE public.migration_registry
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.migration_registry
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.migration_execution_log
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.migration_execution_log
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.deployment_snapshots
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.deployment_snapshots
FORCE ROW LEVEL SECURITY;

-- ============================================================
-- POLICIES
-- ============================================================

CREATE POLICY migration_registry_global_admin
ON public.migration_registry
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

CREATE POLICY migration_log_global_admin
ON public.migration_execution_log
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

CREATE POLICY deployment_snapshots_global_admin
ON public.deployment_snapshots
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

COMMIT;