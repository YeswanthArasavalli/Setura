-- =============================================================
-- MIGRATION 50: P0-A fail_job_v2 DEAD-LETTER COLUMN FIX
-- =============================================================
--
-- One confirmed defect from the final roadmap (P0-A), fixed by
-- redefining the Phase 1.5-era worker failure function. No table,
-- no trigger, no enum, no historical migration is touched.
--
--   fail_job_v2 (migration 19:739-755) dead-letters a
--   retry-exhausted job with:
--
--       INSERT INTO public.dead_letter_jobs (
--           job_id, job_type, payload, last_error
--       )
--
--   but dead_letter_jobs (migration 06:163-182) has no job_id
--   column. Its columns are:
--
--       original_job_id  UUID NOT NULL UNIQUE
--       job_type         TEXT NOT NULL
--       payload          JSONB NOT NULL
--       hospital_id      UUID (nullable)
--       attempt_count    INTEGER NOT NULL
--       last_error       TEXT (nullable)
--       failed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
--
--   No RENAME or ALTER ever touched that column (exhaustive grep
--   of all migrations). So the INSERT raised 42703 on every
--   retry-exhausted job, which aborted the whole fail_job_v2
--   call: the job was never marked dead, never rescheduled, and
--   stayed 'processing' forever with a stale lease. The only
--   runtime caller is the worker loop
--   (supabase/functions/_shared/worker.ts failJob -> fail_job_v2),
--   so every terminal failure in the v2 path hit this.
--
-- Fix: reproduce the migration 19 body verbatim except the
-- INSERT column list, which now matches migration 06's table
-- exactly and carries hospital_id and attempt_count the way the
-- v1 fail_job (migration 06:382-399) already does. The conflict
-- target is made explicit: ON CONFLICT (original_job_id), which
-- is the table's UNIQUE constraint, instead of a bare DO NOTHING.
--
-- The retry branch (attempt_count < max_attempts) is unchanged.
-- The lease outcome update, worker_registry counter and job
-- status transitions are unchanged.
--
-- Privileges (F16-04 / CLAUDE.md section 7): CREATE OR REPLACE does not
-- reset the ACL, but a redefinition is exactly where a grant
-- silently diverges, so the service_role-only boundary of
-- migration 48 is restated explicitly and verified at catalog
-- level in the verification section.
--
-- Verification (section 5) executes the real function against
-- real job_queue rows inside this migration's transaction:
-- retryable failure, terminal dead-letter failure, repeat
-- (idempotent) failure, and unknown-job failure. The test rows
-- are deleted before COMMIT, so the migration leaves no data
-- behind. The direct job_queue / dead_letter_jobs DML in the
-- verification block runs as the migration role, which bypasses
-- the FORCE RLS on those tables the same way every migration
-- DML does; the production paths remain the SECURITY DEFINER
-- RPCs with row_security = off.
-- =============================================================

BEGIN;

-- =============================================================
-- 1. fail_job_v2 - DEAD-LETTER INSERT COLUMN FIX
-- =============================================================

CREATE OR REPLACE FUNCTION public.fail_job_v2(
    p_job_id UUID,
    p_worker_id TEXT,
    p_error TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_job RECORD;
BEGIN
    SELECT *
    INTO v_job
    FROM public.job_queue
    WHERE id = p_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    UPDATE public.worker_job_leases
    SET
        failed_at = now(),
        outcome = 'failed',
        error_message = p_error
    WHERE job_queue_id = p_job_id
      AND worker_id = p_worker_id
      AND outcome IS NULL;

    UPDATE public.worker_registry
    SET
        jobs_failed = jobs_failed + 1,
        updated_at = now()
    WHERE worker_id = p_worker_id;

    IF v_job.attempt_count >= v_job.max_attempts THEN
        -- Migration 50 (P0-A): the column list now matches
        -- dead_letter_jobs (migration 06). The old list used a
        -- non-existent job_id column, so this INSERT raised 42703
        -- and the whole failure handling aborted.
        INSERT INTO public.dead_letter_jobs (
            original_job_id,
            job_type,
            payload,
            hospital_id,
            attempt_count,
            last_error
        )
        VALUES (
            v_job.id,
            v_job.job_type,
            v_job.payload,
            v_job.hospital_id,
            v_job.attempt_count,
            p_error
        )
        ON CONFLICT (original_job_id)
        DO NOTHING;

        UPDATE public.job_queue
        SET
            status = 'dead',
            last_error = p_error,
            updated_at = now()
        WHERE id = p_job_id;

    ELSE
        UPDATE public.job_queue
        SET
            status = 'pending',
            worker_id = NULL,
            processing_started_at = NULL,
            last_error = p_error,
            scheduled_at =
                now()
                +
                make_interval(
                    mins => LEAST(
                        POWER(2, v_job.attempt_count)::INTEGER,
                        1440
                    )
                ),
            updated_at = now()
        WHERE id = p_job_id;
    END IF;

    RETURN TRUE;
END;
$$;

-- SET clauses come from the new definition (see migration 49),
-- so row_security = off is re-applied explicitly.
ALTER FUNCTION public.fail_job_v2(UUID, TEXT, TEXT)
SET row_security = off;

-- =============================================================
-- 2. PRIVILEGE BOUNDARY (service_role only, per migration 48)
-- =============================================================

REVOKE ALL ON FUNCTION public.fail_job_v2(UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_job_v2(UUID, TEXT, TEXT)
    TO service_role;

-- =============================================================
-- 3. VERIFICATION
-- =============================================================
--
-- Catalog checks first (no data), then the real function is
-- executed against real rows that are deleted before COMMIT.
-- A dead_letter_jobs row for a job we never dead-lettered would
-- also be caught: the cleanup at the end only removes rows whose
-- original_job_id is one of the two test job ids.

DO $$
DECLARE
    v_job_retry UUID;
    v_job_dead UUID;
    v_status TEXT;
    v_scheduled_at TIMESTAMPTZ;
    v_last_error TEXT;
    v_dlq RECORD;
    v_count INTEGER;
BEGIN

    -- 3.1 The installed definition writes original_job_id, not
    -- job_id. ('original_job_id' does not match the pattern
    -- '% job_id,%' because the preceding character is '_'.)
    IF (
        SELECT COUNT(*)
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = 'fail_job_v2'
          AND pg_get_functiondef(p.oid) LIKE '%original_job_id%'
          AND pg_get_functiondef(p.oid) NOT LIKE '% job_id,%'
    ) <> 1 THEN
        RAISE EXCEPTION
            'verification 3.1 failed: fail_job_v2 does not insert '
            'original_job_id (or still references job_id)';
    END IF;

    -- 3.2 row_security = off survived the redefinition.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = 'fail_job_v2'
          AND p.proconfig @> ARRAY['row_security=off']
    ) THEN
        RAISE EXCEPTION
            'verification 3.2 failed: fail_job_v2 lost '
            'row_security = off';
    END IF;

    -- 3.3 service_role-only EXECUTE at catalog level.
    IF has_function_privilege(
        'anon', 'public.fail_job_v2(UUID,TEXT,TEXT)', 'EXECUTE'
    ) OR has_function_privilege(
        'authenticated', 'public.fail_job_v2(UUID,TEXT,TEXT)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role', 'public.fail_job_v2(UUID,TEXT,TEXT)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION
            'verification 3.3 failed: fail_job_v2 EXECUTE is not '
            'service_role-only';
    END IF;

    -- 3.4 Unknown job id returns FALSE, no error, no rows touched.
    IF public.fail_job_v2(
        gen_random_uuid(), 'migration-50-verify', 'unknown job'
    ) IS NOT FALSE THEN
        RAISE EXCEPTION
            'verification 3.4 failed: unknown job id did not '
            'return FALSE';
    END IF;

    -- 3.5 Retryable failure: status back to pending with
    -- exponential backoff, last_error recorded, NO dead-letter row.
    v_job_retry := public.enqueue_job(
        'migration_50_selftest',
        '{"selftest": true}'::jsonb,
        'low',
        now(),
        'migration-50-verify-retry',
        NULL,
        NULL,
        '{"migration_verify": true}'::jsonb
    );

    IF public.fail_job_v2(
        v_job_retry, 'migration-50-verify', 'verify retryable'
    ) IS NOT TRUE THEN
        RAISE EXCEPTION
            'verification 3.5 failed: fail_job_v2 did not return '
            'TRUE for a retryable failure';
    END IF;

    SELECT status, scheduled_at, last_error
    INTO v_status, v_scheduled_at, v_last_error
    FROM public.job_queue
    WHERE id = v_job_retry;

    IF v_status <> 'pending'
       OR v_last_error <> 'verify retryable'
       OR v_scheduled_at <= now() THEN
        RAISE EXCEPTION
            'verification 3.5 failed: retryable failure state is '
            '(%, %, %), expected pending / last_error / future '
            'scheduled_at',
            v_status, v_last_error, v_scheduled_at;
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM public.dead_letter_jobs
    WHERE original_job_id = v_job_retry;

    IF v_count <> 0 THEN
        RAISE EXCEPTION
            'verification 3.5 failed: retryable failure wrote a '
            'dead-letter row';
    END IF;

    -- 3.6 Terminal failure: dead-letter row carries the exact
    -- columns the old insert got wrong, job status is dead.
    v_job_dead := public.enqueue_job(
        'migration_50_selftest',
        '{"selftest": true}'::jsonb,
        'low',
        now(),
        'migration-50-verify-terminal',
        NULL,
        NULL,
        '{"migration_verify": true}'::jsonb
    );

    UPDATE public.job_queue
    SET attempt_count = max_attempts
    WHERE id = v_job_dead;

    IF public.fail_job_v2(
        v_job_dead, 'migration-50-verify', 'verify terminal'
    ) IS NOT TRUE THEN
        RAISE EXCEPTION
            'verification 3.6 failed: terminal fail_job_v2 did not '
            'return TRUE (dead-letter insert raised?)';
    END IF;

    SELECT *
    INTO v_dlq
    FROM public.dead_letter_jobs
    WHERE original_job_id = v_job_dead;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'verification 3.6 failed: no dead_letter_jobs row for '
            'the terminal failure';
    END IF;

    IF v_dlq.job_type <> 'migration_50_selftest'
       OR v_dlq.payload ->> 'selftest' <> 'true'
       OR v_dlq.attempt_count <> 5
       OR v_dlq.last_error <> 'verify terminal'
       OR v_dlq.failed_at IS NULL THEN
        RAISE EXCEPTION
            'verification 3.6 failed: dead-letter row content is '
            'wrong (job_type=%, attempt=%, last_error=%)',
            v_dlq.job_type, v_dlq.attempt_count, v_dlq.last_error;
    END IF;

    SELECT status INTO v_status
    FROM public.job_queue
    WHERE id = v_job_dead;

    IF v_status <> 'dead' THEN
        RAISE EXCEPTION
            'verification 3.6 failed: terminal job status is %, '
            'expected dead',
            v_status;
    END IF;

    -- 3.7 Repeat terminal failure is idempotent: still exactly one
    -- dead-letter row, job still dead, call still TRUE.
    IF public.fail_job_v2(
        v_job_dead, 'migration-50-verify', 'verify repeat'
    ) IS NOT TRUE THEN
        RAISE EXCEPTION
            'verification 3.7 failed: repeated terminal failure '
            'did not return TRUE';
    END IF;

    SELECT COUNT(*) INTO v_count
    FROM public.dead_letter_jobs
    WHERE original_job_id = v_job_dead;

    IF v_count <> 1 THEN
        RAISE EXCEPTION
            'verification 3.7 failed: repeated failure produced % '
            'dead-letter rows, expected 1',
            v_count;
    END IF;

    -- 3.8 Cleanup: remove every row this verification created.
    DELETE FROM public.dead_letter_jobs
    WHERE original_job_id = v_job_dead;

    DELETE FROM public.job_queue
    WHERE id IN (v_job_retry, v_job_dead);

    SELECT COUNT(*) INTO v_count
    FROM public.job_queue
    WHERE id IN (v_job_retry, v_job_dead)
       OR metadata ->> 'migration_verify' = 'true';

    IF v_count <> 0 THEN
        RAISE EXCEPTION
            'verification 3.8 failed: % verification rows remain in '
            'job_queue',
            v_count;
    END IF;

    RAISE NOTICE 'migration 50 verification passed';

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
    '50_p0a_fail_job_v2_dead_letter_fix',
    '50_p0a_fail_job_v2_dead_letter_fix.sql',
    'P0-A: fail_job_v2 dead-letter insert used a non-existent '
    'job_id column (migration 19 vs dead_letter_jobs of migration '
    '06), so every retry-exhausted job aborted its failure '
    'handling. The insert now targets original_job_id with '
    'hospital_id and attempt_count; conflict target made explicit; '
    'service_role-only EXECUTE restated and verified',
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
