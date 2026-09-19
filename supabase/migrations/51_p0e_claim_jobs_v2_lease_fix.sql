-- =============================================================
-- MIGRATION 51: P0-E claim_jobs_v2 LEASE PERSISTENCE FIX
-- =============================================================
--
-- One confirmed defect from the final roadmap (P0-E, the
-- mechanical half of P0-01), fixed by redefining the v2 claim
-- function. No table, no trigger, no enum, no historical
-- migration is touched.
--
--   claim_jobs_v2 (migration 19:497-603) moves a job to
--   'processing' with:
--
--       UPDATE public.job_queue
--       SET status = 'processing',
--           processing_started_at = now(),
--           worker_id = p_worker_id,
--           attempt_count = attempt_count + 1,
--           updated_at = now()
--
--   and separately records the per-job lease in worker_job_leases
--   with lease_expires_at = now() + interval '2 minutes'.
--
--   But job_queue itself has a lease_expires_at column
--   (migration 06:71) that the v1 claim_jobs
--   (migration 06:264-317) populated. The v2 path never writes
--   it, so a v2-claimed job keeps lease_expires_at = NULL.
--
--   reclaim_stale_jobs (migration 06:455-481) requeues crashed
--   work with:
--
--       ... WHERE status = 'processing' AND lease_expires_at < now()
--
--   NULL < now() is never true, so a v2-claimed job stranded in
--   'processing' by a worker that died before completing or
--   failing it is invisible to that recovery path: it can never
--   be reclaimed. This is the "crash recovery cannot reclaim
--   v2-claimed jobs" regression recorded in AGENTS.md section 13.
--
-- Fix (mechanical half only): claim_jobs_v2 now also writes
-- job_queue.lease_expires_at, using the SAME
-- now() + interval '2 minutes' expression the worker_job_leases
-- INSERT already uses. now() is transaction-stable, so the two
-- values are byte-identical within a claim, giving one coherent
-- lease expiry across job_queue and worker_job_leases. The
-- recovery WIRING (which recovery path owns reclaim, retiring
-- the dead v1 reclaim_stale_jobs, scheduling) is deferred to
-- Phase 1 / W1 and is out of scope here.
--
-- Nothing else in the function changes: the non-active worker
-- guard, the FOR UPDATE SKIP LOCKED selection, the attempt_count
-- increment, the worker_job_leases insert, the worker_registry
-- jobs_claimed counter and the RETURN NEXT are preserved exactly.
--
-- Privileges (F16-04 / CLAUDE.md section 7): claim_jobs_v2 is a
-- category-B worker function locked to service_role by migration
-- 48. CREATE OR REPLACE preserves the prior ACL, but a
-- redefinition is exactly where a grant silently diverges, so the
-- service_role-only boundary is restated explicitly and verified
-- at catalog level in the verification section.
--
-- Verification (section 3) executes the real function against
-- real rows inside this migration's transaction: enqueue a
-- uniquely-typed self-test job, register a worker, claim it, and
-- assert job_queue.lease_expires_at is now NOT NULL and equals
-- worker_job_leases.lease_expires_at. The test rows are deleted
-- before COMMIT, so the migration leaves no data behind. The
-- direct DML in the verification block runs as the migration
-- role, which bypasses FORCE RLS the same way every migration DML
-- does; the production path remains the SECURITY DEFINER RPC with
-- row_security = off.
-- =============================================================

BEGIN;

-- =============================================================
-- 1. claim_jobs_v2 - PERSIST job_queue.lease_expires_at
-- =============================================================

CREATE OR REPLACE FUNCTION public.claim_jobs_v2(

    p_worker_id TEXT,

    p_job_types TEXT[] DEFAULT NULL,

    p_batch_size INTEGER DEFAULT 5

)

RETURNS SETOF public.job_queue

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_job public.job_queue;

BEGIN

    -- prevent draining workers from claiming
    IF EXISTS (

        SELECT 1
        FROM public.worker_registry
        WHERE worker_id = p_worker_id
        AND status <> 'active'

    ) THEN

        RETURN;

    END IF;

    FOR v_job IN

        UPDATE public.job_queue
        SET

            status = 'processing',

            processing_started_at = now(),

            worker_id = p_worker_id,

            attempt_count = attempt_count + 1,

            -- Migration 51 (P0-E): the v2 claim path recorded the
            -- lease only in worker_job_leases, leaving
            -- job_queue.lease_expires_at NULL, so reclaim_stale_jobs
            -- could never see a crashed v2 job. now() is
            -- transaction-stable, so this is identical to the
            -- worker_job_leases lease_expires_at below.
            lease_expires_at = now() + interval '2 minutes',

            updated_at = now()

        WHERE id IN (

            SELECT id
            FROM public.job_queue
            WHERE status = 'pending'
            AND scheduled_at <= now()

            AND (
                p_job_types IS NULL
                OR job_type = ANY(p_job_types)
            )

            ORDER BY priority DESC, scheduled_at ASC

            LIMIT p_batch_size

            FOR UPDATE SKIP LOCKED

        )

        RETURNING *

    LOOP

        INSERT INTO public.worker_job_leases (

            worker_id,
            job_queue_id,
            job_type,
            lease_expires_at

        )
        VALUES (

            p_worker_id,
            v_job.id,
            v_job.job_type,
            now() + interval '2 minutes'

        );

        UPDATE public.worker_registry
        SET

            jobs_claimed = jobs_claimed + 1,

            updated_at = now()

        WHERE worker_id = p_worker_id;

        RETURN NEXT v_job;

    END LOOP;

END;
$$;

-- SET clauses come from the new definition, so row_security = off
-- is re-applied explicitly (matches migration 19:605-610).
ALTER FUNCTION public.claim_jobs_v2(
    TEXT,
    TEXT[],
    INTEGER
)
SET row_security = off;

-- =============================================================
-- 2. PRIVILEGE BOUNDARY (service_role only, per migration 48)
-- =============================================================

REVOKE ALL ON FUNCTION public.claim_jobs_v2(TEXT, TEXT[], INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_jobs_v2(TEXT, TEXT[], INTEGER)
    TO service_role;

-- =============================================================
-- 3. VERIFICATION
-- =============================================================
--
-- Catalog checks first (no data), then the real function is
-- executed against real rows that are deleted before COMMIT.

DO $$
DECLARE
    v_job_id UUID;
    v_claimed UUID;
    v_jq_lease TIMESTAMPTZ;
    v_wjl_lease TIMESTAMPTZ;
    v_status TEXT;
    v_count INTEGER;
BEGIN

    -- 3.1 The installed definition assigns lease_expires_at on the
    -- job_queue UPDATE. The worker_job_leases INSERT lists the
    -- column but never uses the 'lease_expires_at = now()'
    -- assignment form, so this pattern is unique to the UPDATE.
    IF (
        SELECT COUNT(*)
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = 'claim_jobs_v2'
          AND pg_get_functiondef(p.oid) LIKE '%lease_expires_at = now()%'
    ) <> 1 THEN
        RAISE EXCEPTION
            'verification 3.1 failed: claim_jobs_v2 does not set '
            'job_queue.lease_expires_at on the claim UPDATE';
    END IF;

    -- 3.2 row_security = off survived the redefinition.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname = 'claim_jobs_v2'
          AND p.proconfig @> ARRAY['row_security=off']
    ) THEN
        RAISE EXCEPTION
            'verification 3.2 failed: claim_jobs_v2 lost '
            'row_security = off';
    END IF;

    -- 3.3 service_role-only EXECUTE at catalog level.
    IF has_function_privilege(
        'anon', 'public.claim_jobs_v2(TEXT,TEXT[],INTEGER)', 'EXECUTE'
    ) OR has_function_privilege(
        'authenticated', 'public.claim_jobs_v2(TEXT,TEXT[],INTEGER)',
        'EXECUTE'
    ) OR NOT has_function_privilege(
        'service_role', 'public.claim_jobs_v2(TEXT,TEXT[],INTEGER)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION
            'verification 3.3 failed: claim_jobs_v2 EXECUTE is not '
            'service_role-only';
    END IF;

    -- 3.4 Functional: a v2-claimed job must carry a NOT NULL
    -- lease_expires_at that matches its worker_job_leases row.
    v_job_id := public.enqueue_job(
        'migration_51_selftest',
        '{"selftest": true}'::jsonb,
        'low',
        now(),
        'migration-51-verify',
        NULL,
        NULL,
        '{"migration_verify": true}'::jsonb
    );

    PERFORM public.register_worker(
        'migration-51-verify',
        'test',
        'migration-51-verify',
        NULL,
        300
    );

    -- Filter to the unique self-test type so no unrelated pending
    -- job is claimed by this verification.
    SELECT id INTO v_claimed
    FROM public.claim_jobs_v2(
        'migration-51-verify',
        ARRAY['migration_51_selftest'],
        10
    )
    WHERE id = v_job_id;

    IF v_claimed IS NULL THEN
        RAISE EXCEPTION
            'verification 3.4 failed: the self-test job was not '
            'claimed by the test worker';
    END IF;

    SELECT lease_expires_at, status
    INTO v_jq_lease, v_status
    FROM public.job_queue
    WHERE id = v_job_id;

    IF v_status <> 'processing' THEN
        RAISE EXCEPTION
            'verification 3.4 failed: claimed job status is %, '
            'expected processing',
            v_status;
    END IF;

    IF v_jq_lease IS NULL THEN
        RAISE EXCEPTION
            'verification 3.4 failed: job_queue.lease_expires_at is '
            'still NULL after claim (the P0-E defect persists)';
    END IF;

    SELECT lease_expires_at
    INTO v_wjl_lease
    FROM public.worker_job_leases
    WHERE job_queue_id = v_job_id
      AND worker_id = 'migration-51-verify'
    ORDER BY leased_at DESC
    LIMIT 1;

    IF v_wjl_lease IS NULL THEN
        RAISE EXCEPTION
            'verification 3.4 failed: no worker_job_leases row for '
            'the claimed job';
    END IF;

    IF v_jq_lease <> v_wjl_lease THEN
        RAISE EXCEPTION
            'verification 3.4 failed: job_queue.lease_expires_at '
            '(%) does not match worker_job_leases.lease_expires_at '
            '(%)',
            v_jq_lease, v_wjl_lease;
    END IF;

    -- 3.5 Cleanup: remove every row this verification created.
    DELETE FROM public.worker_job_leases
    WHERE job_queue_id = v_job_id;

    DELETE FROM public.job_queue
    WHERE id = v_job_id;

    DELETE FROM public.worker_registry
    WHERE worker_id = 'migration-51-verify';

    SELECT COUNT(*) INTO v_count
    FROM public.job_queue
    WHERE id = v_job_id
       OR metadata ->> 'migration_verify' = 'true';

    IF v_count <> 0 THEN
        RAISE EXCEPTION
            'verification 3.5 failed: % verification rows remain in '
            'job_queue',
            v_count;
    END IF;

    RAISE NOTICE 'migration 51 verification passed';

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
    '51_p0e_claim_jobs_v2_lease_fix',
    '51_p0e_claim_jobs_v2_lease_fix.sql',
    'P0-E: claim_jobs_v2 recorded the per-job lease only in '
    'worker_job_leases and never set job_queue.lease_expires_at '
    '(the v1 claim_jobs did), so a v2-claimed job stranded in '
    'processing by a dead worker had a NULL lease and was '
    'invisible to reclaim_stale_jobs. The claim UPDATE now writes '
    'the same transaction-stable now() + 2 minutes as the lease '
    'row; recovery wiring deferred to W1; service_role-only '
    'EXECUTE restated and verified',
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
