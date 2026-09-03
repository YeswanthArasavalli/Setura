-- =============================================================
-- SETURA HOSPITAL OS
-- Script 11: Realtime Presence + Scheduled Tasks
-- PRODUCTION SAFE VERSION
-- =============================================================

-- =============================================================
-- REALTIME PRESENCE
-- =============================================================

CREATE TABLE IF NOT EXISTS public.dashboard_presence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    user_id UUID NOT NULL
        REFERENCES public.profiles(id)
        ON DELETE CASCADE,

    role public.user_role_type NOT NULL,

    tab_id TEXT NOT NULL,

    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT dashboard_presence_unique
        UNIQUE(hospital_id, user_id, tab_id)
);

-- =============================================================
-- INDEXES
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_dashboard_presence_hospital
ON public.dashboard_presence(
    hospital_id,
    last_seen_at DESC
);

CREATE INDEX IF NOT EXISTS idx_dashboard_presence_cleanup
ON public.dashboard_presence(
    last_seen_at
);

CREATE INDEX IF NOT EXISTS idx_dashboard_presence_user
ON public.dashboard_presence(
    user_id,
    hospital_id
);

-- =============================================================
-- UPDATED_AT TRIGGER
-- =============================================================

DROP TRIGGER IF EXISTS trg_dashboard_presence_updated_at
ON public.dashboard_presence;

CREATE TRIGGER trg_dashboard_presence_updated_at
BEFORE UPDATE
ON public.dashboard_presence
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- =============================================================
-- IMMUTABLE HOSPITAL PROTECTION
-- =============================================================

DROP TRIGGER IF EXISTS trg_dashboard_presence_hospital_immutable
ON public.dashboard_presence;

CREATE TRIGGER trg_dashboard_presence_hospital_immutable
BEFORE UPDATE
ON public.dashboard_presence
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- HEARTBEAT UPSERT
-- =============================================================

CREATE OR REPLACE FUNCTION public.upsert_presence(
    p_hospital_id UUID,
    p_tab_id TEXT,
    p_metadata JSONB DEFAULT '{}'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role public.user_role_type;
BEGIN

    SELECT ur.role
    INTO v_role
    FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.hospital_id = p_hospital_id
    LIMIT 1;

    IF v_role IS NULL THEN
        RAISE EXCEPTION
            'User does not belong to hospital';
    END IF;

    INSERT INTO public.dashboard_presence (
        hospital_id,
        user_id,
        role,
        tab_id,
        last_seen_at,
        metadata
    )
    VALUES (
        p_hospital_id,
        auth.uid(),
        v_role,
        COALESCE(p_tab_id, 'default'),
        now(),
        COALESCE(p_metadata, '{}')
    )
    ON CONFLICT (hospital_id, user_id, tab_id)
    DO UPDATE SET
        last_seen_at = now(),
        updated_at = now(),
        metadata = EXCLUDED.metadata;

END;
$$;

ALTER FUNCTION public.upsert_presence(UUID,TEXT,JSONB)
SET row_security = off;

-- =============================================================
-- CLEANUP STALE PRESENCE
-- =============================================================

CREATE OR REPLACE FUNCTION public.cleanup_stale_presence(
    p_batch_size INTEGER DEFAULT 1000
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_deleted INTEGER;
BEGIN

    DELETE FROM public.dashboard_presence
    WHERE id IN (
        SELECT id
        FROM public.dashboard_presence
        WHERE last_seen_at < now() - interval '2 minutes'
        LIMIT p_batch_size
        FOR UPDATE SKIP LOCKED
    );

    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    RETURN v_deleted;

END;
$$;

ALTER FUNCTION public.cleanup_stale_presence(INTEGER)
SET row_security = off;

-- =============================================================
-- HOSPITAL ONLINE STATUS
-- =============================================================

CREATE OR REPLACE FUNCTION public.is_hospital_online(
    p_hospital_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.dashboard_presence
        WHERE hospital_id = p_hospital_id
          AND last_seen_at > now() - interval '2 minutes'
          AND role IN (
              'hospital_admin',
              'receptionist'
          )
    );
$$;

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.dashboard_presence
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.dashboard_presence
FORCE ROW LEVEL SECURITY;

-- =============================================================
-- RLS POLICIES
-- =============================================================

CREATE POLICY presence_hospital_read
ON public.dashboard_presence
FOR SELECT
USING (
    public.is_global_admin()
    OR public.user_has_hospital_access(hospital_id)
);

CREATE POLICY presence_self_insert
ON public.dashboard_presence
FOR INSERT
WITH CHECK (
    user_id = auth.uid()
);

CREATE POLICY presence_self_update
ON public.dashboard_presence
FOR UPDATE
USING (
    user_id = auth.uid()
    OR public.is_global_admin()
)
WITH CHECK (
    user_id = auth.uid()
    OR public.is_global_admin()
);

CREATE POLICY presence_self_delete
ON public.dashboard_presence
FOR DELETE
USING (
    user_id = auth.uid()
    OR public.is_global_admin()
);

-- =============================================================
-- REALTIME SAFE REGISTRATION
-- =============================================================

DO $$
BEGIN

    BEGIN
        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.dashboard_presence;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;

END $$;

-- =============================================================
-- MASTER TASK RUNNER
-- =============================================================

CREATE OR REPLACE FUNCTION public.run_scheduled_tasks()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_stale_jobs INTEGER := 0;
    v_stale_presence INTEGER := 0;
    v_expired_restrict INTEGER := 0;
BEGIN

    -- prevent overlapping scheduler execution
    IF NOT pg_try_advisory_lock(987654321) THEN
        RETURN jsonb_build_object(
            'status',
            'already_running'
        );
    END IF;

    BEGIN

        v_stale_jobs := public.reclaim_stale_jobs(10);

    EXCEPTION
        WHEN OTHERS THEN
            v_stale_jobs := -1;
    END;

    BEGIN

        v_stale_presence := public.cleanup_stale_presence();

    EXCEPTION
        WHEN OTHERS THEN
            v_stale_presence := -1;
    END;

    BEGIN

        v_expired_restrict := public.cleanup_expired_restrictions();

    EXCEPTION
        WHEN OTHERS THEN
            v_expired_restrict := -1;
    END;

    PERFORM pg_advisory_unlock(987654321);

    RETURN jsonb_build_object(
        'reclaimed_jobs', v_stale_jobs,
        'cleaned_presence', v_stale_presence,
        'expired_restrictions', v_expired_restrict,
        'run_at', now()
    );

END;
$$;

ALTER FUNCTION public.run_scheduled_tasks()
SET row_security = off;

-- =============================================================
-- NIGHTLY TASKS
-- =============================================================

CREATE OR REPLACE FUNCTION public.run_nightly_tasks(
    p_hospital_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hospital RECORD;
    v_carried INTEGER := 0;
BEGIN

    IF NOT pg_try_advisory_lock(987654322) THEN
        RETURN jsonb_build_object(
            'status',
            'already_running'
        );
    END IF;

    FOR v_hospital IN
        SELECT id
        FROM public.hospitals
        WHERE is_active = true
          AND deleted_at IS NULL
          AND (
              p_hospital_id IS NULL
              OR id = p_hospital_id
          )
    LOOP

        BEGIN

            v_carried :=
                v_carried
                +
                public.carry_forward_pending_tokens(
                    v_hospital.id,
                    CURRENT_DATE - 1,
                    CURRENT_DATE
                );

        EXCEPTION
            WHEN OTHERS THEN
                CONTINUE;
        END;

    END LOOP;

    BEGIN

        PERFORM public.refresh_analytics_views();

    EXCEPTION
        WHEN OTHERS THEN
            NULL;
    END;

    PERFORM pg_advisory_unlock(987654322);

    RETURN jsonb_build_object(
        'carry_forward_count', v_carried,
        'analytics_refreshed', true,
        'run_at', now()
    );

END;
$$;

ALTER FUNCTION public.run_nightly_tasks(UUID)
SET row_security = off;

-- =============================================================
-- DUPLICATE PATIENT DETECTION
-- =============================================================

CREATE OR REPLACE FUNCTION public.find_duplicate_patient_candidates(
    p_hospital_id UUID,
    p_similarity FLOAT DEFAULT 0.7
)
RETURNS TABLE (
    patient_a_id UUID,
    patient_b_id UUID,
    phone_a TEXT,
    phone_b TEXT,
    name_a TEXT,
    name_b TEXT,
    name_similarity FLOAT
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        a.id,
        b.id,
        a.normalized_phone,
        b.normalized_phone,
        a.full_name,
        b.full_name,
        similarity(a.full_name, b.full_name)::FLOAT
    FROM public.patients a
    JOIN public.patients b
        ON a.hospital_id = b.hospital_id
       AND a.id < b.id
       AND a.full_name % b.full_name
    WHERE a.hospital_id = p_hospital_id
      AND a.is_deleted = false
      AND b.is_deleted = false
      AND similarity(a.full_name, b.full_name)
            >= p_similarity
    ORDER BY similarity(a.full_name, b.full_name) DESC
    LIMIT 500;
$$;

-- =============================================================
-- QUEUE FORECAST
-- =============================================================

CREATE OR REPLACE FUNCTION public.forecast_queue_depth(
    p_hospital_id UUID,
    p_date DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
    doctor_id UUID,
    booked_count INTEGER,
    max_capacity INTEGER,
    capacity_pct NUMERIC,
    avg_wait_minutes NUMERIC
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        ds.doctor_id,

        COUNT(b.id)::INTEGER,

        ds.max_tokens,

        ROUND(
            (
                COUNT(b.id)::NUMERIC
                /
                NULLIF(ds.max_tokens, 0)
            ) * 100,
            1
        ),

        (
            COUNT(b.id)
            *
            ds.average_consultation_minutes
        )::NUMERIC

    FROM public.doctor_schedules ds

    LEFT JOIN public.bookings b
        ON b.assigned_doctor_id = ds.doctor_id
       AND b.hospital_id = ds.hospital_id
       AND b.appointment_date = p_date
       AND b.status NOT IN (
           'cancelled',
           'no_show'
       )
       AND b.is_deleted = false

    WHERE ds.hospital_id = p_hospital_id
      AND ds.weekday = EXTRACT(DOW FROM p_date)::INTEGER
      AND ds.is_active = true
      AND ds.is_deleted = false

    GROUP BY
        ds.doctor_id,
        ds.max_tokens,
        ds.average_consultation_minutes;
$$;