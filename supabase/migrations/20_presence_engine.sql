-- ============================================================
-- SETURA - Script 20: Presence Engine
-- FINAL MIGRATION-SAFE PRODUCTION VERSION
-- ============================================================

BEGIN;

-- ============================================================
-- ENUM
-- ============================================================

DO $$
BEGIN

    CREATE TYPE public.presence_channel AS ENUM (
        'receptionist_dashboard',
        'doctor_dashboard',
        'queue_display',
        'admin_dashboard',
        'global_admin'
    );

EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- MIGRATION-SAFE DASHBOARD PRESENCE TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS public.dashboard_presence (

    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    user_id UUID NOT NULL
        REFERENCES public.profiles(id)
        ON DELETE CASCADE,

    role public.user_role_type NOT NULL,

    channel public.presence_channel NOT NULL
        DEFAULT 'receptionist_dashboard',

    tab_id TEXT NOT NULL DEFAULT 'default',

    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    metadata JSONB NOT NULL DEFAULT '{}',

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- SAFE COLUMN MIGRATIONS
-- Handles old Script 11 schema
-- ============================================================

ALTER TABLE public.dashboard_presence
ADD COLUMN IF NOT EXISTS channel public.presence_channel
DEFAULT 'receptionist_dashboard';

ALTER TABLE public.dashboard_presence
ADD COLUMN IF NOT EXISTS tab_id TEXT
DEFAULT 'default';

ALTER TABLE public.dashboard_presence
ADD COLUMN IF NOT EXISTS metadata JSONB
DEFAULT '{}';

ALTER TABLE public.dashboard_presence
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
DEFAULT now();

-- ============================================================
-- SAFE UNIQUE CONSTRAINT
-- ============================================================

DO $$
BEGIN

    IF NOT EXISTS (

        SELECT 1
        FROM pg_constraint
        WHERE conname = 'uq_presence_unique'

    ) THEN

        ALTER TABLE public.dashboard_presence
        ADD CONSTRAINT uq_presence_unique
        UNIQUE (
            hospital_id,
            user_id,
            channel,
            tab_id
        );

    END IF;

END $$;

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_presence_active
ON public.dashboard_presence(
    hospital_id,
    last_seen_at DESC
);

CREATE INDEX IF NOT EXISTS idx_presence_channel
ON public.dashboard_presence(
    hospital_id,
    channel,
    last_seen_at DESC
);

CREATE INDEX IF NOT EXISTS idx_presence_user
ON public.dashboard_presence(
    user_id,
    hospital_id
);

-- ============================================================
-- ONLINE STATE TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS public.hospital_online_state (

    hospital_id UUID PRIMARY KEY
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    is_online BOOLEAN NOT NULL DEFAULT false,

    active_users INTEGER NOT NULL DEFAULT 0,

    active_receptionists INTEGER NOT NULL DEFAULT 0,

    active_doctors INTEGER NOT NULL DEFAULT 0,

    active_queue_displays INTEGER NOT NULL DEFAULT 0,

    last_activity_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.hospital_online_state (
    hospital_id
)
SELECT id
FROM public.hospitals
ON CONFLICT (hospital_id)
DO NOTHING;

-- ============================================================
-- UPDATED_AT TRIGGERS
-- ============================================================

DROP TRIGGER IF EXISTS trg_presence_updated_at
ON public.dashboard_presence;

CREATE TRIGGER trg_presence_updated_at
BEFORE UPDATE
ON public.dashboard_presence
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_online_state_updated_at
ON public.hospital_online_state;

CREATE TRIGGER trg_online_state_updated_at
BEFORE UPDATE
ON public.hospital_online_state
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- RECOMPUTE ONLINE STATE
-- ============================================================

CREATE OR REPLACE FUNCTION public.recompute_hospital_online_state(
    p_hospital_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_active_users INTEGER;

    v_active_recs INTEGER;

    v_active_docs INTEGER;

    v_active_displays INTEGER;

BEGIN

    PERFORM pg_advisory_xact_lock(
        hashtext(p_hospital_id::text)
    );

    SELECT

        COUNT(DISTINCT user_id),

        COUNT(DISTINCT user_id)
            FILTER (
                WHERE role = 'receptionist'
            ),

        COUNT(DISTINCT user_id)
            FILTER (
                WHERE role = 'doctor'
            ),

        COUNT(*)
            FILTER (
                WHERE channel = 'queue_display'
            )

    INTO

        v_active_users,
        v_active_recs,
        v_active_docs,
        v_active_displays

    FROM public.dashboard_presence

    WHERE hospital_id = p_hospital_id

    AND last_seen_at > now() - interval '2 minutes';

    INSERT INTO public.hospital_online_state (

        hospital_id,
        is_online,
        active_users,
        active_receptionists,
        active_doctors,
        active_queue_displays,
        last_activity_at,
        updated_at

    )
    VALUES (

        p_hospital_id,

        (
            v_active_users > 0
            OR v_active_displays > 0
        ),

        v_active_users,
        v_active_recs,
        v_active_docs,
        v_active_displays,

        now(),
        now()

    )

    ON CONFLICT (hospital_id)

    DO UPDATE SET

        is_online = EXCLUDED.is_online,

        active_users = EXCLUDED.active_users,

        active_receptionists =
            EXCLUDED.active_receptionists,

        active_doctors =
            EXCLUDED.active_doctors,

        active_queue_displays =
            EXCLUDED.active_queue_displays,

        last_activity_at =
            EXCLUDED.last_activity_at,

        updated_at = now();

END;
$$;

ALTER FUNCTION public.recompute_hospital_online_state(UUID)
SET row_security = off;

-- ============================================================
-- HEARTBEAT
-- ============================================================

CREATE OR REPLACE FUNCTION public.presence_heartbeat(

    p_hospital_id UUID,

    p_role public.user_role_type,

    p_channel public.presence_channel,

    p_tab_id TEXT DEFAULT 'default',

    p_metadata JSONB DEFAULT '{}'

)
RETURNS TABLE (

    active_users INTEGER,

    active_receptionists INTEGER,

    hospital_is_online BOOLEAN

)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_user_id UUID;

BEGIN

    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;

    INSERT INTO public.dashboard_presence (

        hospital_id,
        user_id,
        role,
        channel,
        tab_id,
        last_seen_at,
        metadata

    )
    VALUES (

        p_hospital_id,
        v_user_id,
        p_role,
        p_channel,
        p_tab_id,
        now(),
        p_metadata

    )

    ON CONFLICT (
        hospital_id,
        user_id,
        channel,
        tab_id
    )

    DO UPDATE SET

        last_seen_at = now(),

        metadata = EXCLUDED.metadata,

        updated_at = now();

    PERFORM public.recompute_hospital_online_state(
        p_hospital_id
    );

    RETURN QUERY

    SELECT

        hos.active_users,
        hos.active_receptionists,
        hos.is_online

    FROM public.hospital_online_state hos

    WHERE hos.hospital_id = p_hospital_id;

END;
$$;

ALTER FUNCTION public.presence_heartbeat(
    UUID,
    public.user_role_type,
    public.presence_channel,
    TEXT,
    JSONB
)
SET row_security = off;

-- ============================================================
-- LEAVE
-- ============================================================

CREATE OR REPLACE FUNCTION public.presence_leave(

    p_hospital_id UUID,

    p_channel public.presence_channel,

    p_tab_id TEXT DEFAULT 'default'

)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    DELETE FROM public.dashboard_presence

    WHERE hospital_id = p_hospital_id
    AND user_id = auth.uid()
    AND channel = p_channel
    AND tab_id = p_tab_id;

    PERFORM public.recompute_hospital_online_state(
        p_hospital_id
    );

END;
$$;

ALTER FUNCTION public.presence_leave(
    UUID,
    public.presence_channel,
    TEXT
)
SET row_security = off;

-- ============================================================
-- CLEANUP
-- ============================================================

CREATE OR REPLACE FUNCTION public.cleanup_stale_presence()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_count INTEGER;

BEGIN

    DELETE FROM public.dashboard_presence
    WHERE last_seen_at < now() - interval '2 minutes';

    GET DIAGNOSTICS v_count = ROW_COUNT;

    UPDATE public.hospital_online_state hos
    SET
        updated_at = now();

    PERFORM public.recompute_hospital_online_state(h.id)
    FROM public.hospitals h;

    RETURN v_count;

END;
$$;

ALTER FUNCTION public.cleanup_stale_presence()
SET row_security = off;

-- ============================================================
-- REALTIME
-- ============================================================

ALTER TABLE public.dashboard_presence
REPLICA IDENTITY FULL;

ALTER TABLE public.hospital_online_state
REPLICA IDENTITY FULL;

DO $$
BEGIN

    BEGIN
        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.dashboard_presence;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
        WHEN undefined_object THEN NULL;
    END;

    BEGIN
        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.hospital_online_state;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
        WHEN undefined_object THEN NULL;
    END;

END $$;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE public.dashboard_presence
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.dashboard_presence
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.hospital_online_state
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.hospital_online_state
FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS presence_hospital_read
ON public.dashboard_presence;

DROP POLICY IF EXISTS presence_self_write
ON public.dashboard_presence;

DROP POLICY IF EXISTS hospital_online_state_read
ON public.hospital_online_state;

CREATE POLICY presence_hospital_read
ON public.dashboard_presence
FOR SELECT
USING (

    public.is_global_admin()

    OR EXISTS (

        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = auth.uid()
        AND ur.hospital_id = dashboard_presence.hospital_id

    )

);

CREATE POLICY presence_self_write
ON public.dashboard_presence
FOR ALL
USING (

    user_id = auth.uid()

    OR public.is_global_admin()

)
WITH CHECK (

    user_id = auth.uid()

    OR public.is_global_admin()

);

CREATE POLICY hospital_online_state_read
ON public.hospital_online_state
FOR SELECT
USING (

    public.is_global_admin()

    OR EXISTS (

        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = auth.uid()
        AND ur.hospital_id = hospital_online_state.hospital_id

    )

);

COMMIT;