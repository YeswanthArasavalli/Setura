-- ============================================================
-- SETURA - Script 19: Background Worker Engine
-- FINAL HARDENED PRODUCTION VERSION
-- ============================================================

BEGIN;

-- ============================================================
-- SAFETY
-- ============================================================

SET statement_timeout = '0';

-- ============================================================
-- WORKER REGISTRY
-- ============================================================

CREATE TABLE IF NOT EXISTS public.worker_registry (

    worker_id TEXT PRIMARY KEY,

    worker_type TEXT NOT NULL,

    instance_id TEXT NOT NULL,

    hostname TEXT,

    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    lease_duration_secs INTEGER NOT NULL DEFAULT 30
        CHECK (lease_duration_secs BETWEEN 5 AND 3600),

    lease_expires_at TIMESTAMPTZ NOT NULL,

    status TEXT NOT NULL DEFAULT 'active'
        CHECK (
            status IN (
                'active',
                'draining',
                'crashed',
                'stopped'
            )
        ),

    jobs_claimed INTEGER NOT NULL DEFAULT 0
        CHECK (jobs_claimed >= 0),

    jobs_completed INTEGER NOT NULL DEFAULT 0
        CHECK (jobs_completed >= 0),

    jobs_failed INTEGER NOT NULL DEFAULT 0
        CHECK (jobs_failed >= 0),

    metadata JSONB NOT NULL DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_worker_registry_active
ON public.worker_registry(
    status,
    lease_expires_at
)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_worker_registry_type
ON public.worker_registry(
    worker_type,
    status
);

-- ============================================================
-- HEARTBEAT LOG
-- ============================================================

CREATE TABLE IF NOT EXISTS public.worker_heartbeat_log (

    id BIGSERIAL PRIMARY KEY,

    worker_id TEXT NOT NULL
        REFERENCES public.worker_registry(worker_id)
        ON DELETE CASCADE,

    worker_type TEXT NOT NULL,

    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    jobs_in_flight INTEGER NOT NULL DEFAULT 0
        CHECK (jobs_in_flight >= 0),

    metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_worker_heartbeat_worker
ON public.worker_heartbeat_log(
    worker_id,
    heartbeat_at DESC
);

-- ============================================================
-- WORKER LEASES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.worker_job_leases (

    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    worker_id TEXT NOT NULL
        REFERENCES public.worker_registry(worker_id)
        ON DELETE CASCADE,

    job_queue_id UUID
        REFERENCES public.job_queue(id)
        ON DELETE CASCADE,

    job_type TEXT NOT NULL,

    leased_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    lease_expires_at TIMESTAMPTZ NOT NULL,

    completed_at TIMESTAMPTZ,

    failed_at TIMESTAMPTZ,

    outcome TEXT
        CHECK (
            outcome IS NULL
            OR outcome IN (
                'completed',
                'failed',
                'reclaimed'
            )
        ),

    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_worker_leases_active
ON public.worker_job_leases(
    lease_expires_at
)
WHERE outcome IS NULL;

-- ============================================================
-- REGISTER WORKER
-- ============================================================

CREATE OR REPLACE FUNCTION public.register_worker(

    p_worker_id TEXT,

    p_worker_type TEXT,

    p_instance_id TEXT,

    p_hostname TEXT DEFAULT NULL,

    p_lease_duration INTEGER DEFAULT 30

)

RETURNS public.worker_registry

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_row public.worker_registry;

BEGIN

    INSERT INTO public.worker_registry (

        worker_id,
        worker_type,
        instance_id,
        hostname,
        last_heartbeat_at,
        lease_duration_secs,
        lease_expires_at,
        status

    )
    VALUES (

        p_worker_id,
        p_worker_type,
        p_instance_id,
        p_hostname,
        now(),
        p_lease_duration,
        now() + make_interval(secs => p_lease_duration),
        'active'

    )

    ON CONFLICT (worker_id)

    DO UPDATE SET

        instance_id = EXCLUDED.instance_id,

        last_heartbeat_at = now(),

        lease_duration_secs = EXCLUDED.lease_duration_secs,

        lease_expires_at =
            now()
            +
            make_interval(
                secs => EXCLUDED.lease_duration_secs
            ),

        status = 'active',

        updated_at = now()

    RETURNING *
    INTO v_row;

    RETURN v_row;

END;
$$;

ALTER FUNCTION public.register_worker(
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    INTEGER
)
SET row_security = off;

-- ============================================================
-- WORKER HEARTBEAT
-- ============================================================

CREATE OR REPLACE FUNCTION public.worker_heartbeat(

    p_worker_id TEXT,

    p_jobs_in_flight INTEGER DEFAULT 0,

    p_metadata JSONB DEFAULT '{}'

)

RETURNS BOOLEAN

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_type TEXT;

BEGIN

    UPDATE public.worker_registry
    SET

        last_heartbeat_at = now(),

        lease_expires_at =
            now()
            +
            make_interval(
                secs => lease_duration_secs
            ),

        updated_at = now()

    WHERE worker_id = p_worker_id
    AND status = 'active'

    RETURNING worker_type
    INTO v_type;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- sample heartbeat logging
    IF random() < 0.25 THEN

        INSERT INTO public.worker_heartbeat_log (

            worker_id,
            worker_type,
            jobs_in_flight,
            metadata

        )
        VALUES (

            p_worker_id,
            v_type,
            p_jobs_in_flight,
            p_metadata

        );

    END IF;

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.worker_heartbeat(
    TEXT,
    INTEGER,
    JSONB
)
SET row_security = off;

-- ============================================================
-- LEASE EXTENSION
-- ============================================================

CREATE OR REPLACE FUNCTION public.extend_job_lease(

    p_job_id UUID,

    p_worker_id TEXT,

    p_extend_seconds INTEGER DEFAULT 120

)

RETURNS BOOLEAN

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    UPDATE public.worker_job_leases
    SET
        lease_expires_at =
            now()
            +
            make_interval(
                secs => p_extend_seconds
            )
    WHERE job_queue_id = p_job_id
    AND worker_id = p_worker_id
    AND outcome IS NULL;

    RETURN FOUND;

END;
$$;

ALTER FUNCTION public.extend_job_lease(
    UUID,
    TEXT,
    INTEGER
)
SET row_security = off;

-- ============================================================
-- DETECT CRASHED WORKERS
-- ============================================================

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

    RETURNING
        worker_id,
        worker_type,
        last_heartbeat_at;

END;
$$;

ALTER FUNCTION public.detect_crashed_workers()
SET row_security = off;

-- ============================================================
-- RECLAIM CRASHED JOBS
-- ============================================================

CREATE OR REPLACE FUNCTION public.reclaim_crashed_worker_jobs()

RETURNS INTEGER

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_count INTEGER := 0;

BEGIN

    UPDATE public.job_queue jq
    SET

        status = 'pending',

        worker_id = NULL,

        processing_started_at = NULL,

        scheduled_at = now(),

        updated_at = now()

    WHERE jq.status = 'processing'

    AND EXISTS (

        SELECT 1
        FROM public.worker_registry wr
        WHERE wr.worker_id = jq.worker_id
        AND wr.status = 'crashed'

    )

    AND EXISTS (

        SELECT 1
        FROM public.worker_job_leases wjl
        WHERE wjl.job_queue_id = jq.id
        AND wjl.outcome IS NULL
        AND wjl.lease_expires_at < now()

    );

    GET DIAGNOSTICS v_count = ROW_COUNT;

    UPDATE public.worker_job_leases
    SET

        outcome = 'reclaimed',

        failed_at = now(),

        error_message = 'worker crashed'

    WHERE outcome IS NULL
    AND lease_expires_at < now();

    RETURN v_count;

END;
$$;

ALTER FUNCTION public.reclaim_crashed_worker_jobs()
SET row_security = off;

-- ============================================================
-- CLAIM JOBS V2
-- ============================================================

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

ALTER FUNCTION public.claim_jobs_v2(
    TEXT,
    TEXT[],
    INTEGER
)
SET row_security = off;

-- ============================================================
-- COMPLETE JOB
-- ============================================================

CREATE OR REPLACE FUNCTION public.complete_job_v2(

    p_job_id UUID,

    p_worker_id TEXT

)

RETURNS BOOLEAN

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    UPDATE public.job_queue
    SET

        status = 'completed',

        processing_completed_at = now(),

        updated_at = now()

    WHERE id = p_job_id
    AND worker_id = p_worker_id;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    UPDATE public.worker_job_leases
    SET

        completed_at = now(),

        outcome = 'completed'

    WHERE job_queue_id = p_job_id
    AND worker_id = p_worker_id
    AND outcome IS NULL;

    UPDATE public.worker_registry
    SET

        jobs_completed = jobs_completed + 1,

        updated_at = now()

    WHERE worker_id = p_worker_id;

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.complete_job_v2(
    UUID,
    TEXT
)
SET row_security = off;

-- ============================================================
-- FAIL JOB
-- ============================================================

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

        INSERT INTO public.dead_letter_jobs (

            job_id,
            job_type,
            payload,
            last_error

        )
        VALUES (

            v_job.id,
            v_job.job_type,
            v_job.payload,
            p_error

        )
        ON CONFLICT DO NOTHING;

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

ALTER FUNCTION public.fail_job_v2(
    UUID,
    TEXT,
    TEXT
)
SET row_security = off;

-- ============================================================
-- RECOVERY ORCHESTRATOR
-- ============================================================

CREATE OR REPLACE FUNCTION public.run_worker_crash_recovery()

RETURNS JSONB

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_reclaimed INTEGER;

BEGIN

    PERFORM public.detect_crashed_workers();

    v_reclaimed :=
        public.reclaim_crashed_worker_jobs();

    DELETE FROM public.worker_heartbeat_log
    WHERE heartbeat_at < now() - interval '1 hour';

    DELETE FROM public.worker_job_leases
    WHERE outcome IS NOT NULL
    AND leased_at < now() - interval '24 hours';

    RETURN jsonb_build_object(

        'reclaimed_jobs',
        v_reclaimed,

        'run_at',
        now()

    );

END;
$$;

ALTER FUNCTION public.run_worker_crash_recovery()
SET row_security = off;

-- ============================================================
-- VIEW
-- ============================================================

CREATE OR REPLACE VIEW public.worker_performance AS

SELECT

    wr.worker_id,

    wr.worker_type,

    wr.status,

    wr.last_heartbeat_at,

    wr.lease_expires_at,

    wr.jobs_claimed,

    wr.jobs_completed,

    wr.jobs_failed,

    CASE
        WHEN wr.jobs_claimed > 0
        THEN ROUND(
            wr.jobs_completed::numeric
            /
            wr.jobs_claimed::numeric
            * 100,
            1
        )
        ELSE 0
    END AS success_rate_pct,

    (wr.lease_expires_at < now())
        AS is_lease_expired

FROM public.worker_registry wr;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE public.worker_registry
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.worker_registry
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.worker_heartbeat_log
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.worker_heartbeat_log
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.worker_job_leases
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.worker_job_leases
FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS worker_registry_global_admin
ON public.worker_registry;

DROP POLICY IF EXISTS worker_heartbeat_global_admin
ON public.worker_heartbeat_log;

DROP POLICY IF EXISTS worker_leases_global_admin
ON public.worker_job_leases;

CREATE POLICY worker_registry_global_admin
ON public.worker_registry
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

CREATE POLICY worker_heartbeat_global_admin
ON public.worker_heartbeat_log
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

CREATE POLICY worker_leases_global_admin
ON public.worker_job_leases
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

COMMIT;