-- =============================================================
-- MIGRATION 52: W1 detect_crashed_workers AMBIGUOUS-COLUMN FIX
-- =============================================================
--
-- A defect surfaced while proving the W1 worker lifecycle. This is
-- the P0-01 "wiring half" precondition: the crash-recovery chain
-- (detect_crashed_workers -> reclaim_crashed_worker_jobs) can only
-- be wired if detect_crashed_workers actually runs. It did not.
--
--   detect_crashed_workers (migration 19:377-414) is declared:
--
--       RETURNS TABLE (crashed_worker_id TEXT, worker_type TEXT,
--                      last_seen TIMESTAMPTZ)
--       ...
--       RETURN QUERY
--       UPDATE public.worker_registry
--       SET status = 'crashed', updated_at = now()
--       WHERE status = 'active' AND lease_expires_at < now()
--       RETURNING worker_id, worker_type, last_heartbeat_at;
--
--   Because a RETURNS TABLE output column is also a PL/pgSQL OUT
--   variable, the unqualified `worker_type` in the RETURNING list
--   is ambiguous between the OUT variable and the
--   worker_registry.worker_type column. The function raises
--   42702 ("column reference worker_type is ambiguous") the moment
--   it is executed.
--
--   It has ZERO callers today (no migration and no Edge Function
--   invokes it - confirmed by exhaustive grep), so this has never
--   fired at runtime. W1 proves the operational chain, and driving
--   the recovery path exposed a function that was dead-on-arrival
--   the moment anything tried to call it. "Dead in both paths"
--   (roadmap section 2.2) understated it: the v2 recovery detector
--   does not merely go uncalled, it errors when called.
--
-- Fix (smallest correct): qualify every column in the RETURNING
-- list with its table. crashed_worker_id <- worker_registry.worker_id,
-- worker_type <- worker_registry.worker_type,
-- last_seen <- worker_registry.last_heartbeat_at. Values, filter,
-- side effect (status -> 'crashed') and the OUT signature are all
-- unchanged. Nothing else in the function is touched.
--
-- Privileges (F16-04 / CLAUDE.md section 7): detect_crashed_workers
-- is a category-B worker function locked to service_role by
-- migration 48. CREATE OR REPLACE preserves the prior ACL, but a
-- redefinition is exactly where a grant silently diverges, so the
-- service_role-only boundary is restated explicitly and verified at
-- catalog level below.
--
-- Verification (section 3) executes the real function inside this
-- migration's transaction: seed one active worker whose registry
-- lease has aged out, one active worker whose lease is still live,
-- and one already-terminal worker; run detect_crashed_workers();
-- assert it RETURNS without error, marks exactly the expired-active
-- worker crashed, and leaves the live-active and already-crashed
-- workers untouched. Test rows are deleted before COMMIT. The
-- direct worker_registry DML runs as the migration role, which
-- bypasses FORCE RLS the same way every migration DML does.
-- =============================================================

BEGIN;

-- =============================================================
-- 1. detect_crashed_workers - QUALIFY RETURNING COLUMNS
-- =============================================================

CREATE OR REPLACE FUNCTION public.detect_crashed_workers()

RETURNS TABLE (

    crashed_worker_id TEXT,

    worker_type TEXT,

    last_seen TIMESTAMPTZ

)

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    RETURN QUERY

    UPDATE public.worker_registry
    SET

        status = 'crashed',

        updated_at = now()

    WHERE status = 'active'

    AND lease_expires_at < now()

    -- Migration 52 (W1): the RETURNING list is qualified with the
    -- table name. An unqualified `worker_type` collided with this
    -- function's own RETURNS TABLE output variable of the same name
    -- and raised 42702 on every execution.
    RETURNING
        public.worker_registry.worker_id,
        public.worker_registry.worker_type,
        public.worker_registry.last_heartbeat_at;

END;
$$;

-- SET clauses come from the new definition, so row_security = off
-- is re-applied explicitly (matches migration 19:416-417).
ALTER FUNCTION public.detect_crashed_workers()
SET row_security = off;

-- =============================================================
-- 2. PRIVILEGE BOUNDARY (service_role only, per migration 48)
-- =============================================================

REVOKE ALL ON FUNCTION public.detect_crashed_workers()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_crashed_workers()
    TO service_role;

-- =============================================================
-- 3. VERIFICATION
-- =============================================================
--
-- Catalog checks first (no data), then the real function is
-- executed against real rows that are deleted before COMMIT.

DO $$
DECLARE
    v_rows INTEGER;
    v_status TEXT;
    v_count INTEGER;
BEGIN

    -- 3.1 The installed definition qualifies the RETURNING columns
    -- with the table name (the old unqualified form raised 42702).
    IF (
        SELECT COUNT(*)
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = 'detect_crashed_workers'
          AND pg_get_functiondef(p.oid)
              LIKE '%worker_registry.worker_type%'
    ) <> 1 THEN
        RAISE EXCEPTION
            'verification 3.1 failed: detect_crashed_workers does '
            'not qualify RETURNING worker_registry.worker_type';
    END IF;

    -- 3.2 row_security = off survived the redefinition.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = 'detect_crashed_workers'
          AND p.proconfig @> ARRAY['row_security=off']
    ) THEN
        RAISE EXCEPTION
            'verification 3.2 failed: detect_crashed_workers lost '
            'row_security = off';
    END IF;

    -- 3.3 service_role-only EXECUTE at catalog level.
    IF has_function_privilege(
        'anon', 'public.detect_crashed_workers()', 'EXECUTE'
    ) OR has_function_privilege(
        'authenticated', 'public.detect_crashed_workers()', 'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role', 'public.detect_crashed_workers()', 'EXECUTE'
    ) THEN
        RAISE EXCEPTION
            'verification 3.3 failed: detect_crashed_workers EXECUTE '
            'is not service_role-only';
    END IF;

    -- 3.4 Functional: the function must EXECUTE (the 42702 bug meant
    -- it could not) and mark exactly the expired-active worker crashed.
    INSERT INTO public.worker_registry (
        worker_id, worker_type, instance_id, lease_expires_at, status
    )
    VALUES
        -- expired lease + active -> should be detected crashed
        ('migration-52-expired', 'test', 'migration-52',
         now() - interval '1 minute', 'active'),
        -- live lease + active -> must stay active
        ('migration-52-live', 'test', 'migration-52',
         now() + interval '10 minutes', 'active'),
        -- already crashed -> must be left alone
        ('migration-52-crashed', 'test', 'migration-52',
         now() - interval '1 minute', 'crashed');

    -- Before the fix this SELECT raised 42702.
    SELECT COUNT(*) INTO v_rows
    FROM public.detect_crashed_workers()
    WHERE crashed_worker_id = 'migration-52-expired';

    IF v_rows <> 1 THEN
        RAISE EXCEPTION
            'verification 3.4 failed: detect_crashed_workers did not '
            'return the expired-active worker (returned % rows)',
            v_rows;
    END IF;

    SELECT status INTO v_status
    FROM public.worker_registry
    WHERE worker_id = 'migration-52-expired';

    IF v_status <> 'crashed' THEN
        RAISE EXCEPTION
            'verification 3.4 failed: expired-active worker status '
            'is %, expected crashed',
            v_status;
    END IF;

    SELECT status INTO v_status
    FROM public.worker_registry
    WHERE worker_id = 'migration-52-live';

    IF v_status <> 'active' THEN
        RAISE EXCEPTION
            'verification 3.4 failed: live worker status is %, '
            'expected active',
            v_status;
    END IF;

    -- 3.5 Cleanup: remove every row this verification created.
    DELETE FROM public.worker_registry
    WHERE worker_id IN (
        'migration-52-expired',
        'migration-52-live',
        'migration-52-crashed'
    );

    SELECT COUNT(*) INTO v_count
    FROM public.worker_registry
    WHERE worker_id LIKE 'migration-52-%';

    IF v_count <> 0 THEN
        RAISE EXCEPTION
            'verification 3.5 failed: % verification rows remain in '
            'worker_registry',
            v_count;
    END IF;

    RAISE NOTICE 'migration 52 verification passed';

END $$;

-- =============================================================
-- 4. REGISTRY
-- =============================================================

INSERT INTO public.migration_registry (
    migration_id,
    script_filename,
    description,
    category,
    status,
    applied_at
)
VALUES (
    '52_w1_detect_crashed_workers_ambiguity_fix',
    '52_w1_detect_crashed_workers_ambiguity_fix.sql',
    'W1: detect_crashed_workers declared worker_type as a RETURNS '
    'TABLE output column AND selected the worker_registry.worker_type '
    'column in the same RETURNING list, so the unqualified reference '
    'was ambiguous and the function raised 42702 on every call. It '
    'has zero callers today so the crash-recovery path was dead-on-'
    'arrival; the RETURNING columns are now table-qualified, and the '
    'function is proven to execute and mark only expired-active '
    'workers crashed; service_role-only EXECUTE restated and verified',
    'function',
    'applied',
    now()
)
ON CONFLICT (migration_id) DO UPDATE
SET description = EXCLUDED.description,
    category = EXCLUDED.category,
    status = EXCLUDED.status,
    applied_at = EXCLUDED.applied_at;

COMMIT;
