-- =============================================================
-- SETURA HOSPITAL OS
-- Script 30: Device Sessions
-- Run AFTER Script 29
-- =============================================================
-- PURPOSE: Track authenticated sessions per user/device.
--   - Keyed on session_token_hash (hashed Supabase session token)
--   - Supports multi-device access per user
--   - Nightly cleanup of stale sessions (> 7 days inactive)
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.device_sessions (
    id                   UUID  PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id              UUID  NOT NULL
        REFERENCES public.profiles(id) ON DELETE CASCADE,

    hospital_id          UUID
        REFERENCES public.hospitals(id) ON DELETE SET NULL,

    device_name          TEXT,
    device_type          TEXT
        CHECK (device_type IS NULL OR device_type IN (
            'web', 'mobile_android', 'mobile_ios',
            'tablet', 'desktop', 'kiosk', 'unknown'
        )),

    ip_address           INET,
    user_agent           TEXT,

    -- SHA-256 hash of the Supabase JWT; UNIQUE enforces one row per session
    session_token_hash TEXT NOT NULL UNIQUE
        CHECK (length(trim(session_token_hash)) > 0),

    last_action TEXT,

    is_active            BOOLEAN     NOT NULL DEFAULT true,
    last_seen            TIMESTAMPTZ NOT NULL DEFAULT now(),
    login_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    logout_at            TIMESTAMPTZ,

    city                 TEXT,
    country              TEXT,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(metadata) = 'object'),

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_device_sessions_user
    ON public.device_sessions (user_id, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_device_sessions_active
    ON public.device_sessions (user_id, is_active)
    WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_device_sessions_hospital
    ON public.device_sessions (hospital_id, last_seen DESC)
    WHERE hospital_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_device_sessions_ip
    ON public.device_sessions (ip_address, created_at DESC);

DROP TRIGGER IF EXISTS trg_device_sessions_updated_at ON public.device_sessions;
CREATE TRIGGER trg_device_sessions_updated_at
    BEFORE UPDATE ON public.device_sessions
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- upsert_device_session()
-- Called from Edge Functions on every authenticated request
-- ============================================================

CREATE OR REPLACE FUNCTION public.upsert_device_session(
    p_user_id            UUID,
    p_hospital_id        UUID,
    p_device_name        TEXT,
    p_device_type        TEXT,
    p_ip_address         INET,
    p_user_agent         TEXT,
    p_session_token_hash TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
BEGIN

    IF p_device_type NOT IN (
        'web',
        'mobile_android',
        'mobile_ios',
        'tablet',
        'desktop',
        'kiosk',
        'unknown'
    ) THEN
        p_device_type := 'unknown';
    END IF;

    INSERT INTO public.device_sessions (
        user_id, hospital_id, device_name, device_type,
        ip_address, user_agent, session_token_hash, last_seen, last_action
    )
    VALUES (
        p_user_id, p_hospital_id, p_device_name, p_device_type,
        p_ip_address, p_user_agent, p_session_token_hash, now(), 'LOGIN'
    )
    ON CONFLICT (session_token_hash) DO UPDATE
        SET last_seen   = now(),
            ip_address  = EXCLUDED.ip_address,
            hospital_id = EXCLUDED.hospital_id,
            is_active   = true,
            last_action = 'REQUEST',
            updated_at  = now()
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;
REVOKE ALL     ON FUNCTION public.upsert_device_session(UUID,UUID,TEXT,TEXT,INET,TEXT,TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.upsert_device_session(UUID,UUID,TEXT,TEXT,INET,TEXT,TEXT) TO authenticated;

-- ============================================================
-- terminate_device_session()
-- ============================================================

CREATE OR REPLACE FUNCTION public.terminate_device_session(
    p_session_id UUID,
    p_user_id    UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.device_sessions
       SET is_active  = false,
           logout_at  = now(),
           updated_at = now()
     WHERE id      = p_session_id
       AND user_id = p_user_id;

    RETURN FOUND;
END;
$$;
REVOKE ALL     ON FUNCTION public.terminate_device_session(UUID, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.terminate_device_session(UUID, UUID) TO authenticated;

-- ============================================================
-- expire_stale_device_sessions()
-- Called by nightly cron (migration 19 worker engine)
-- ============================================================

CREATE OR REPLACE FUNCTION public.expire_stale_device_sessions(
    p_inactive_days INTEGER DEFAULT 7
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE public.device_sessions
       SET is_active  = false,
           logout_at  = COALESCE(logout_at, now()),
           updated_at = now()
     WHERE is_active = true
       AND last_seen < now() - (p_inactive_days || ' days')::INTERVAL;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE public.device_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_sessions FORCE  ROW LEVEL SECURITY;

-- Users see their own sessions; hospital_admin sees all sessions for their hospital
DROP POLICY IF EXISTS ds_read ON public.device_sessions;
CREATE POLICY ds_read
    ON public.device_sessions FOR SELECT
    USING (
        user_id = auth.uid()
        OR public.is_global_admin()
    );

DROP POLICY IF EXISTS ds_manage ON public.device_sessions;
CREATE POLICY ds_manage
    ON public.device_sessions FOR ALL
    USING      (user_id = auth.uid() OR public.is_global_admin())
    WITH CHECK (user_id = auth.uid() OR public.is_global_admin());

COMMIT;
