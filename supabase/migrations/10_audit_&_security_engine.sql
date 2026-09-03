-- =============================================================
-- SETURA HOSPITAL OS
-- Script 10: Audit & Security Logging
-- PRODUCTION SAFE VERSION
-- =============================================================

-- =============================================================
-- ENUMS
-- =============================================================

DO $$
BEGIN
    CREATE TYPE public.audit_action_severity AS ENUM (
        'low',
        'medium',
        'high',
        'critical'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE public.security_event_type AS ENUM (
        'failed_login',
        'unauthorized_access',
        'role_escalation_attempt',
        'suspicious_activity',
        'multiple_failed_requests',
        'token_abuse',
        'manual_security_flag'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================
-- AUDIT LOGS
-- APPEND-ONLY
-- =============================================================

CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    actor_user_id UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    entity_type TEXT NOT NULL,

    entity_id UUID,

    action_type TEXT NOT NULL,

    action_severity public.audit_action_severity
        NOT NULL DEFAULT 'low',

    old_data JSONB
        CHECK (
            old_data IS NULL
            OR jsonb_typeof(old_data) = 'object'
        ),

    new_data JSONB
        CHECK (
            new_data IS NULL
            OR jsonb_typeof(new_data) = 'object'
        ),

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    ip_address INET,

    user_agent TEXT,

    session_id TEXT,

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- AUDIT INDEXES
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
ON public.audit_logs(
    entity_type,
    entity_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_hospital_date
ON public.audit_logs(
    hospital_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
ON public.audit_logs(
    actor_user_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_severity
ON public.audit_logs(
    action_severity,
    created_at DESC
)
WHERE action_severity IN (
    'high',
    'critical'
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action
ON public.audit_logs(
    action_type,
    created_at DESC
);

-- =============================================================
-- SECURITY EVENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.security_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    user_id UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    event_type public.security_event_type
        NOT NULL,

    event_details JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(event_details) = 'object'
        ),

    risk_score INTEGER NOT NULL DEFAULT 1
        CHECK (
            risk_score BETWEEN 1 AND 100
        ),

    ip_address INET,

    user_agent TEXT,

    event_fingerprint TEXT,

    resolved BOOLEAN NOT NULL DEFAULT false,

    resolved_by UUID
        REFERENCES public.profiles(id),

    resolved_at TIMESTAMPTZ,

    resolution_notes TEXT,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_resolution_state
        CHECK (
            (
                resolved = false
                AND resolved_at IS NULL
            )
            OR (
                resolved = true
                AND resolved_at IS NOT NULL
            )
        )
);

-- =============================================================
-- SECURITY EVENT INDEXES
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_security_events_unresolved
ON public.security_events(
    hospital_id,
    created_at DESC
)
WHERE resolved = false;

CREATE INDEX IF NOT EXISTS idx_security_events_risk
ON public.security_events(
    risk_score DESC,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_security_events_type
ON public.security_events(
    event_type,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_security_events_user
ON public.security_events(
    user_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_security_events_fingerprint
ON public.security_events(
    event_fingerprint
);

-- =============================================================
-- IMMUTABILITY ENFORCEMENT
-- Audit logs must NEVER be updated/deleted
-- =============================================================

CREATE OR REPLACE FUNCTION public.prevent_audit_log_modification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'audit_logs are immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_logs_no_update
ON public.audit_logs;

CREATE TRIGGER trg_audit_logs_no_update
BEFORE UPDATE OR DELETE
ON public.audit_logs
FOR EACH ROW
EXECUTE FUNCTION public.prevent_audit_log_modification();

-- =============================================================
-- CENTRAL AUDIT WRITER
-- =============================================================

CREATE OR REPLACE FUNCTION public.write_audit_log(
    p_hospital_id UUID,
    p_actor_id UUID,
    p_entity_type TEXT,
    p_entity_id UUID,
    p_action TEXT,
    p_severity public.audit_action_severity DEFAULT 'low',
    p_old_data JSONB DEFAULT NULL,
    p_new_data JSONB DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
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

    INSERT INTO public.audit_logs (
        hospital_id,
        actor_user_id,
        entity_type,
        entity_id,
        action_type,
        action_severity,
        old_data,
        new_data,
        notes,
        metadata
    )
    VALUES (
        p_hospital_id,
        p_actor_id,
        p_entity_type,
        p_entity_id,
        p_action,
        COALESCE(p_severity, 'low'),
        p_old_data,
        p_new_data,
        p_notes,
        COALESCE(p_metadata, '{}')
    )
    RETURNING id INTO v_id;

    RETURN v_id;

END;
$$;

ALTER FUNCTION public.write_audit_log(
    UUID,
    UUID,
    TEXT,
    UUID,
    TEXT,
    public.audit_action_severity,
    JSONB,
    JSONB,
    TEXT,
    JSONB
)
SET row_security = off;

-- =============================================================
-- SECURITY EVENT LOGGER
-- =============================================================

CREATE OR REPLACE FUNCTION public.log_security_event(
    p_hospital_id UUID,
    p_user_id UUID,
    p_event_type public.security_event_type,
    p_event_details JSONB DEFAULT '{}',
    p_risk_score INTEGER DEFAULT 1,
    p_ip_address INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL,
    p_event_fingerprint TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
BEGIN

    INSERT INTO public.security_events (
        hospital_id,
        user_id,
        event_type,
        event_details,
        risk_score,
        ip_address,
        user_agent,
        event_fingerprint
    )
    VALUES (
        p_hospital_id,
        p_user_id,
        p_event_type,
        COALESCE(p_event_details, '{}'),
        LEAST(
            GREATEST(
                p_risk_score,
                1
            ),
            100
        ),
        p_ip_address,
        p_user_agent,
        p_event_fingerprint
    )
    RETURNING id INTO v_id;

    RETURN v_id;

END;
$$;

ALTER FUNCTION public.log_security_event(
    UUID,
    UUID,
    public.security_event_type,
    JSONB,
    INTEGER,
    INET,
    TEXT,
    TEXT
)
SET row_security = off;

-- =============================================================
-- RESOLVE SECURITY EVENT
-- =============================================================

CREATE OR REPLACE FUNCTION public.resolve_security_event(
    p_event_id UUID,
    p_resolved_by UUID,
    p_notes TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    UPDATE public.security_events
    SET
        resolved = true,
        resolved_by = p_resolved_by,
        resolved_at = now(),
        resolution_notes = p_notes
    WHERE id = p_event_id
      AND resolved = false;

    RETURN FOUND;

END;
$$;

ALTER FUNCTION public.resolve_security_event(UUID,UUID,TEXT)
SET row_security = off;

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.audit_logs
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.security_events
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.audit_logs
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.security_events
FORCE ROW LEVEL SECURITY;

-- =============================================================
-- POLICIES
-- =============================================================

CREATE POLICY audit_logs_hospital_admin
ON public.audit_logs
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

CREATE POLICY security_events_admin
ON public.security_events
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

CREATE POLICY security_events_resolve
ON public.security_events
FOR UPDATE
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

-- =============================================================
-- REALTIME SAFE REGISTRATION
-- =============================================================

DO $$
BEGIN

    BEGIN
        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.security_events;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;

END $$;