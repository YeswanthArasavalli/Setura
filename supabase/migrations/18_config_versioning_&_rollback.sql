-- =============================================================
-- SETURA HOSPITAL OS
-- Script 18: Config Versioning & Rollback
-- FINAL PRODUCTION SAFE VERSION
-- Run AFTER:
--   12_hospital_config_engine.sql
-- =============================================================

BEGIN;

-- =============================================================
-- ENUMS
-- =============================================================

DO $$ BEGIN

    CREATE TYPE public.config_table_name AS ENUM (

        'system_settings',
        'hospital_settings',
        'feature_flags',
        'queue_configs'

    );

EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================
-- CONFIG VERSION STORE
-- Append-only immutable audit/version history
-- =============================================================

CREATE TABLE IF NOT EXISTS public.config_versions (

    id UUID PRIMARY KEY
        DEFAULT gen_random_uuid(),

    config_table public.config_table_name
        NOT NULL,

    hospital_id UUID
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    config_key TEXT NOT NULL,

    version_number INTEGER NOT NULL
        CHECK (version_number > 0),

    previous_value JSONB,

    new_value JSONB NOT NULL,

    change_reason TEXT,

    changed_by UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    is_rollback BOOLEAN NOT NULL DEFAULT false,

    rolled_back_from UUID
        REFERENCES public.config_versions(id)
        ON DELETE SET NULL,

    created_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    CONSTRAINT unique_config_version
    UNIQUE (
        config_table,
        hospital_id,
        config_key,
        version_number
    )
);

-- =============================================================
-- INDEXES
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_config_versions_key
ON public.config_versions(
    config_table,
    hospital_id,
    config_key,
    version_number DESC
);

CREATE INDEX IF NOT EXISTS idx_config_versions_actor
ON public.config_versions(
    changed_by,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_config_versions_hospital
ON public.config_versions(
    hospital_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS idx_config_versions_rollbacks
ON public.config_versions(
    is_rollback,
    created_at DESC
)
WHERE is_rollback = true;

-- =============================================================
-- IMMUTABILITY GUARD
-- =============================================================

CREATE OR REPLACE FUNCTION public.prevent_config_version_mutation()

RETURNS TRIGGER

LANGUAGE plpgsql
AS $$
BEGIN

    RAISE EXCEPTION
        'config_versions is append-only';

END;
$$;

-- =============================================================
-- SAFE RERUN TRIGGERS
-- =============================================================

DROP TRIGGER IF EXISTS trg_config_versions_no_update
ON public.config_versions;

CREATE TRIGGER trg_config_versions_no_update
BEFORE UPDATE
ON public.config_versions
FOR EACH ROW
EXECUTE FUNCTION public.prevent_config_version_mutation();

DROP TRIGGER IF EXISTS trg_config_versions_no_delete
ON public.config_versions;

CREATE TRIGGER trg_config_versions_no_delete
BEFORE DELETE
ON public.config_versions
FOR EACH ROW
EXECUTE FUNCTION public.prevent_config_version_mutation();

-- =============================================================
-- ENSURE updated_by EXISTS
-- =============================================================

DO $$
BEGIN

    IF EXISTS (

        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'hospital_settings'

    ) THEN

        IF NOT EXISTS (

            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'public'
            AND table_name = 'hospital_settings'
            AND column_name = 'updated_by'

        ) THEN

            ALTER TABLE public.hospital_settings
            ADD COLUMN updated_by UUID
                REFERENCES public.profiles(id);

        END IF;

    END IF;

END $$;

-- =============================================================
-- VERSION SYSTEM SETTINGS
-- =============================================================

CREATE OR REPLACE FUNCTION public.version_system_settings()

RETURNS TRIGGER

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_ver INTEGER;

BEGIN

    SELECT
        COALESCE(MAX(version_number), 0) + 1
    INTO v_ver

    FROM public.config_versions

    WHERE config_table = 'system_settings'
    AND config_key = NEW.key;

    INSERT INTO public.config_versions (

        config_table,
        config_key,
        version_number,
        previous_value,
        new_value,
        changed_by

    )
    VALUES (

        'system_settings',

        NEW.key,

        v_ver,

        to_jsonb(OLD.value),

        to_jsonb(NEW.value),

        COALESCE(
            NEW.updated_by,
            auth.uid()
        )

    );

    RETURN NEW;

END;
$$;

ALTER FUNCTION public.version_system_settings()
SET row_security = off;

-- =============================================================
-- SAFE RERUN
-- =============================================================

DROP TRIGGER IF EXISTS trg_system_settings_version
ON public.system_settings;

CREATE TRIGGER trg_system_settings_version
AFTER UPDATE
ON public.system_settings
FOR EACH ROW
WHEN (
    OLD.value IS DISTINCT FROM NEW.value
)
EXECUTE FUNCTION public.version_system_settings();

-- =============================================================
-- VERSION HOSPITAL SETTINGS
-- =============================================================

CREATE OR REPLACE FUNCTION public.version_hospital_settings()

RETURNS TRIGGER

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_ver INTEGER;

BEGIN

    SELECT
        COALESCE(MAX(version_number), 0) + 1
    INTO v_ver

    FROM public.config_versions

    WHERE config_table = 'hospital_settings'
    AND hospital_id = NEW.hospital_id
    AND config_key = 'settings';

    INSERT INTO public.config_versions (

        config_table,
        hospital_id,
        config_key,
        version_number,
        previous_value,
        new_value,
        changed_by

    )
    VALUES (

        'hospital_settings',

        NEW.hospital_id,

        'settings',

        v_ver,

        row_to_json(OLD)::jsonb,

        row_to_json(NEW)::jsonb,

        COALESCE(
            NEW.updated_by,
            auth.uid()
        )

    );

    RETURN NEW;

END;
$$;

ALTER FUNCTION public.version_hospital_settings()
SET row_security = off;

DROP TRIGGER IF EXISTS trg_hospital_settings_version
ON public.hospital_settings;

CREATE TRIGGER trg_hospital_settings_version
AFTER UPDATE
ON public.hospital_settings
FOR EACH ROW
EXECUTE FUNCTION public.version_hospital_settings();

-- =============================================================
-- VERSION FEATURE FLAGS
-- =============================================================

CREATE OR REPLACE FUNCTION public.version_feature_flag()

RETURNS TRIGGER

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_ver INTEGER;

BEGIN

    SELECT
        COALESCE(MAX(version_number), 0) + 1
    INTO v_ver

    FROM public.config_versions

    WHERE config_table = 'feature_flags'

    AND (
        hospital_id = NEW.hospital_id
        OR (
            hospital_id IS NULL
            AND NEW.hospital_id IS NULL
        )
    )

    AND config_key = NEW.flag_key;

    INSERT INTO public.config_versions (

        config_table,
        hospital_id,
        config_key,
        version_number,
        previous_value,
        new_value,
        changed_by

    )
    VALUES (

        'feature_flags',

        NEW.hospital_id,

        NEW.flag_key,

        v_ver,

        jsonb_build_object(
            'is_enabled', OLD.is_enabled,
            'rollout_pct', OLD.rollout_pct,
            'metadata', OLD.metadata
        ),

        jsonb_build_object(
            'is_enabled', NEW.is_enabled,
            'rollout_pct', NEW.rollout_pct,
            'metadata', NEW.metadata
        ),

        COALESCE(
            NEW.updated_by,
            auth.uid()
        )

    );

    NEW.updated_at := now();

    RETURN NEW;

END;
$$;

ALTER FUNCTION public.version_feature_flag()
SET row_security = off;

DROP TRIGGER IF EXISTS trg_feature_flags_version
ON public.feature_flags;

CREATE TRIGGER trg_feature_flags_version
BEFORE UPDATE
ON public.feature_flags
FOR EACH ROW
WHEN (

    OLD.is_enabled IS DISTINCT FROM NEW.is_enabled

    OR OLD.rollout_pct IS DISTINCT FROM NEW.rollout_pct

    OR OLD.metadata IS DISTINCT FROM NEW.metadata

)
EXECUTE FUNCTION public.version_feature_flag();

-- =============================================================
-- ROLLBACK SYSTEM SETTING
-- =============================================================

CREATE OR REPLACE FUNCTION public.rollback_system_setting(

    p_key TEXT,

    p_target_version INTEGER,

    p_rolled_back_by UUID,

    p_reason TEXT DEFAULT 'manual rollback'

)

RETURNS BOOLEAN

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_cv RECORD;

    v_new_version INTEGER;

BEGIN

    SELECT *
    INTO v_cv

    FROM public.config_versions

    WHERE config_table = 'system_settings'

    AND config_key = p_key

    AND version_number = p_target_version;

    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Version % not found for system setting %',
            p_target_version,
            p_key;

    END IF;

    UPDATE public.system_settings

    SET

        value = v_cv.new_value,

        updated_by = p_rolled_back_by,

        updated_at = now()

    WHERE key = p_key;

    -- =========================================================
    -- MARK NEW VERSION AS ROLLBACK
    -- =========================================================

    SELECT MAX(version_number)
    INTO v_new_version
    FROM public.config_versions
    WHERE config_table = 'system_settings'
    AND config_key = p_key;

    UPDATE public.config_versions

    SET

        is_rollback = true,

        rolled_back_from = v_cv.id,

        change_reason = p_reason

    WHERE config_table = 'system_settings'

    AND config_key = p_key

    AND version_number = v_new_version;

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.rollback_system_setting(
    TEXT,
    INTEGER,
    UUID,
    TEXT
)
SET row_security = off;

-- =============================================================
-- ROLLBACK FEATURE FLAG
-- =============================================================

CREATE OR REPLACE FUNCTION public.rollback_feature_flag(

    p_hospital_id UUID,

    p_flag_key TEXT,

    p_target_version INTEGER,

    p_rolled_back_by UUID,

    p_reason TEXT DEFAULT 'manual rollback'

)

RETURNS BOOLEAN

LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_cv RECORD;

    v_new_version INTEGER;

BEGIN

    SELECT *
    INTO v_cv

    FROM public.config_versions

    WHERE config_table = 'feature_flags'

    AND (
        hospital_id = p_hospital_id
        OR (
            hospital_id IS NULL
            AND p_hospital_id IS NULL
        )
    )

    AND config_key = p_flag_key

    AND version_number = p_target_version;

    IF NOT FOUND THEN

        RAISE EXCEPTION
            'Version % not found for feature flag %',
            p_target_version,
            p_flag_key;

    END IF;

    UPDATE public.feature_flags

    SET

        is_enabled =
            (v_cv.new_value->>'is_enabled')::BOOLEAN,

        rollout_pct =
            (v_cv.new_value->>'rollout_pct')::INTEGER,

        metadata =
            COALESCE(
                v_cv.new_value->'metadata',
                '{}'::jsonb
            ),

        updated_by =
            p_rolled_back_by,

        updated_at = now()

    WHERE flag_key = p_flag_key

    AND (
        hospital_id = p_hospital_id
        OR (
            hospital_id IS NULL
            AND p_hospital_id IS NULL
        )
    );

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- =========================================================
    -- MARK NEW VERSION AS ROLLBACK
    -- =========================================================

    SELECT MAX(version_number)
    INTO v_new_version
    FROM public.config_versions
    WHERE config_table = 'feature_flags'
    AND config_key = p_flag_key
    AND (
        hospital_id = p_hospital_id
        OR (
            hospital_id IS NULL
            AND p_hospital_id IS NULL
        )
    );

    UPDATE public.config_versions
    SET
        is_rollback = true,
        rolled_back_from = v_cv.id,
        change_reason = p_reason
    WHERE config_table = 'feature_flags'
    AND config_key = p_flag_key
    AND version_number = v_new_version
    AND (
        hospital_id = p_hospital_id
        OR (
            hospital_id IS NULL
            AND p_hospital_id IS NULL
        )
    );

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.rollback_feature_flag(
    UUID,
    TEXT,
    INTEGER,
    UUID,
    TEXT
)
SET row_security = off;

-- =============================================================
-- CONFIG CHANGE HISTORY VIEW
-- =============================================================

CREATE OR REPLACE VIEW public.config_change_history AS

SELECT

    cv.id,

    cv.config_table,

    h.name AS hospital_name,

    cv.config_key,

    cv.version_number,

    cv.previous_value,

    cv.new_value,

    cv.change_reason,

    p.full_name AS changed_by_name,

    cv.is_rollback,

    cv.created_at

FROM public.config_versions cv

LEFT JOIN public.hospitals h
ON h.id = cv.hospital_id

LEFT JOIN public.profiles p
ON p.id = cv.changed_by

ORDER BY cv.created_at DESC;

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.config_versions
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.config_versions
FORCE ROW LEVEL SECURITY;

-- =============================================================
-- DROP OLD POLICIES
-- =============================================================

DROP POLICY IF EXISTS config_versions_global_admin
ON public.config_versions;

DROP POLICY IF EXISTS config_versions_hospital_admin
ON public.config_versions;

-- =============================================================
-- POLICIES
-- =============================================================

CREATE POLICY config_versions_global_admin
ON public.config_versions
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

CREATE POLICY config_versions_hospital_admin
ON public.config_versions
FOR SELECT
USING (

    hospital_id IS NOT NULL

    AND public.current_user_role(hospital_id)
        = 'hospital_admin'

);

COMMIT;