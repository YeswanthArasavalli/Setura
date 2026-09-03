-- =============================================================
-- SETURA HOSPITAL OS
-- Script 06: Background Job Queue
-- PRODUCTION SAFE VERSION
-- Run AFTER Script 05
-- =============================================================

-- =============================================================
-- ENUMS
-- =============================================================

DO $$
BEGIN
    CREATE TYPE public.job_status AS ENUM (
        'pending',
        'processing',
        'completed',
        'failed',
        'dead'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE public.job_priority AS ENUM (
        'low',
        'normal',
        'high',
        'critical'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================
-- JOB QUEUE
-- =============================================================

CREATE TABLE IF NOT EXISTS public.job_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    job_type TEXT NOT NULL,

    payload JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(payload) = 'object'
        ),

    priority public.job_priority
        NOT NULL DEFAULT 'normal',

    status public.job_status
        NOT NULL DEFAULT 'pending',

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    related_booking_id UUID
        REFERENCES public.bookings(id)
        ON DELETE SET NULL,

    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    processing_started_at TIMESTAMPTZ,

    processing_completed_at TIMESTAMPTZ,

    lease_expires_at TIMESTAMPTZ,

    worker_id TEXT,

    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),

    max_attempts INTEGER NOT NULL DEFAULT 5
        CHECK (max_attempts BETWEEN 1 AND 50),

    last_error TEXT,

    next_attempt_at TIMESTAMPTZ,

    idempotency_key TEXT UNIQUE,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- INDEXES
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_job_queue_claim
ON public.job_queue(
    scheduled_at,
    created_at
)
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_job_queue_retry
ON public.job_queue(
    next_attempt_at
)
WHERE status = 'failed';

CREATE INDEX IF NOT EXISTS idx_job_queue_processing
ON public.job_queue(
    lease_expires_at
)
WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_job_queue_hospital
ON public.job_queue(
    hospital_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_job_queue_type_status
ON public.job_queue(
    job_type,
    status
);

CREATE INDEX IF NOT EXISTS idx_job_queue_worker
ON public.job_queue(
    worker_id,
    processing_started_at
)
WHERE status = 'processing';

-- =============================================================
-- TRIGGERS
-- =============================================================

DROP TRIGGER IF EXISTS trg_job_queue_updated_at
ON public.job_queue;

CREATE TRIGGER trg_job_queue_updated_at
BEFORE UPDATE ON public.job_queue
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_job_queue_hospital_immutable
ON public.job_queue;

CREATE TRIGGER trg_job_queue_hospital_immutable
BEFORE UPDATE ON public.job_queue
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- DEAD LETTER QUEUE
-- =============================================================

CREATE TABLE IF NOT EXISTS public.dead_letter_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    original_job_id UUID NOT NULL UNIQUE,

    job_type TEXT NOT NULL,

    payload JSONB NOT NULL
        CHECK (
            jsonb_typeof(payload) = 'object'
        ),

    hospital_id UUID,

    attempt_count INTEGER NOT NULL,

    last_error TEXT,

    failed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dead_jobs_hospital
ON public.dead_letter_jobs(
    hospital_id,
    failed_at DESC
);

-- =============================================================
-- ENQUEUE JOB
-- =============================================================

CREATE OR REPLACE FUNCTION public.enqueue_job(
    p_job_type TEXT,
    p_payload JSONB,
    p_priority public.job_priority DEFAULT 'normal',
    p_scheduled_at TIMESTAMPTZ DEFAULT now(),
    p_idempotency_key TEXT DEFAULT NULL,
    p_hospital_id UUID DEFAULT NULL,
    p_booking_id UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
BEGIN

    IF p_payload IS NULL THEN
        p_payload := '{}';
    END IF;

    INSERT INTO public.job_queue (
        job_type,
        payload,
        priority,
        scheduled_at,
        idempotency_key,
        hospital_id,
        related_booking_id,
        metadata
    )
    VALUES (
        p_job_type,
        p_payload,
        COALESCE(p_priority, 'normal'),
        COALESCE(p_scheduled_at, now()),
        p_idempotency_key,
        p_hospital_id,
        p_booking_id,
        COALESCE(p_metadata, '{}')
    )
    ON CONFLICT (idempotency_key)
    DO UPDATE
    SET updated_at = now()
    RETURNING id INTO v_id;

    RETURN v_id;

END;
$$;

ALTER FUNCTION public.enqueue_job(
    TEXT,
    JSONB,
    public.job_priority,
    TIMESTAMPTZ,
    TEXT,
    UUID,
    UUID,
    JSONB
)
SET row_security = off;

-- =============================================================
-- CLAIM JOBS
-- Worker-safe using SKIP LOCKED
-- =============================================================

CREATE OR REPLACE FUNCTION public.claim_jobs(
    p_worker_id TEXT,
    p_job_types TEXT[] DEFAULT NULL,
    p_batch_size INTEGER DEFAULT 10,
    p_lease_minutes INTEGER DEFAULT 10
)
RETURNS SETOF public.job_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    RETURN QUERY

    UPDATE public.job_queue jq
    SET
        status = 'processing',
        processing_started_at = now(),
        lease_expires_at =
            now()
            +
            make_interval(
                mins => p_lease_minutes
            ),
        worker_id = p_worker_id,
        attempt_count = attempt_count + 1
    WHERE jq.id IN (

        SELECT id
        FROM public.job_queue
        WHERE status = 'pending'
          AND scheduled_at <= now()
          AND (
                p_job_types IS NULL
                OR job_type = ANY(p_job_types)
          )
        ORDER BY
            CASE priority
                WHEN 'critical' THEN 1
                WHEN 'high' THEN 2
                WHEN 'normal' THEN 3
                ELSE 4
            END,
            scheduled_at ASC
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED

    )

    RETURNING *;

END;
$$;

ALTER FUNCTION public.claim_jobs(TEXT,TEXT[],INTEGER,INTEGER)
SET row_security = off;

-- =============================================================
-- COMPLETE JOB
-- =============================================================

CREATE OR REPLACE FUNCTION public.complete_job(
    p_job_id UUID
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
        lease_expires_at = NULL,
        worker_id = NULL
    WHERE id = p_job_id
      AND status = 'processing';

    RETURN FOUND;

END;
$$;

ALTER FUNCTION public.complete_job(UUID)
SET row_security = off;

-- =============================================================
-- FAIL JOB
-- =============================================================

CREATE OR REPLACE FUNCTION public.fail_job(
    p_job_id UUID,
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

    IF v_job.attempt_count >= v_job.max_attempts THEN

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
            worker_id = NULL,
            lease_expires_at = NULL
        WHERE id = p_job_id;

        RETURN TRUE;

    END IF;

    UPDATE public.job_queue
    SET
        status = 'pending',
        worker_id = NULL,
        processing_started_at = NULL,
        lease_expires_at = NULL,
        last_error = p_error,

        next_attempt_at =
            now()
            +
            make_interval(
                mins => LEAST(
                    POWER(2, v_job.attempt_count)::INTEGER,
                    1440
                )
            ),

        scheduled_at =
            now()
            +
            make_interval(
                mins => LEAST(
                    POWER(2, v_job.attempt_count)::INTEGER,
                    1440
                )
            )

    WHERE id = p_job_id;

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.fail_job(UUID,TEXT)
SET row_security = off;

-- =============================================================
-- RECLAIM STALE JOBS
-- =============================================================

CREATE OR REPLACE FUNCTION public.reclaim_stale_jobs(
    p_timeout_minutes INTEGER DEFAULT 15
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN

    UPDATE public.job_queue
    SET
        status = 'pending',
        worker_id = NULL,
        processing_started_at = NULL,
        lease_expires_at = NULL
    WHERE status = 'processing'
      AND lease_expires_at < now();

    GET DIAGNOSTICS v_count = ROW_COUNT;

    RETURN v_count;

END;
$$;

ALTER FUNCTION public.reclaim_stale_jobs(INTEGER)
SET row_security = off;

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.job_queue
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.dead_letter_jobs
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.job_queue
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.dead_letter_jobs
FORCE ROW LEVEL SECURITY;

-- =============================================================
-- POLICIES
-- =============================================================

DROP POLICY IF EXISTS job_queue_admin
ON public.job_queue;

CREATE POLICY job_queue_admin
ON public.job_queue
FOR ALL
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
)
WITH CHECK (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

DROP POLICY IF EXISTS dead_letter_global_admin
ON public.dead_letter_jobs;

CREATE POLICY dead_letter_global_admin
ON public.dead_letter_jobs
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

-- =============================================================
-- REALTIME
-- =============================================================

DO $$
BEGIN

    BEGIN
        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.job_queue;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;

END $$;