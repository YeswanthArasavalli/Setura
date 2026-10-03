-- =============================================================
-- 67_integration_configuration.sql
--
-- WS-ONBOARD-3 - Integration Configuration & Secure Credential
-- Management.
--
-- Product gap (WS-ONBOARD-2 report sec 4 / migration 66 header): after
-- a hospital tenant is created and its operational settings configured,
-- an operator still has NO authorized application surface to configure
-- the tenant's external integrations (Razorpay, Meta / WhatsApp). The
-- credential columns themselves already exist on hospital_settings
-- (whatsapp_number, meta_phone_number_id, meta_waba_id,
-- razorpay_key_id, payment_enabled - migration 12) but nothing reads or
-- writes them through the SETURA UI, so integrating a hospital required
-- a manual SQL edit and every provider SECRET required a manual
-- environment-variable edit plus a redeploy.
--
-- This migration makes ordinary integration onboarding configuration,
-- not development:
--
--   Configure Integrations  ->  Validate / Test Connection
--   ->  Securely store credential / configuration
--   ->  Runtime consumes configuration
--
-- with NO SQL edit, NO source-code edit, NO manual env-var edit and NO
-- credential ever exposed to the browser.
--
-- -- Business / security architecture DECISIONS, resolved from REPO
--    EVIDENCE (spec sec 6 / sec 41), NOT invented here --------------
--
--   1. Razorpay is PLATFORM-GLOBAL. create-payment-order and
--      process-refund read Env.RAZORPAY_KEY_ID / Env.RAZORPAY_KEY_SECRET
--      (a single SETURA merchant account) and only
--      hospital_settings.razorpay_key_id / payment_enabled are
--      per-hospital. SETURA collects ONLY the booking/platform fee; the
--      hospital collects its consultation fee directly. This workstream
--      therefore does NOT introduce per-hospital Razorpay merchant
--      secrets - that would silently convert a documented platform
--      business model into a different one. The per-hospital Razorpay
--      surface is the PUBLIC key-id + enable/disable + lifecycle status;
--      the SECRET is platform-global and lives in Supabase Vault.
--
--   2. Meta / WhatsApp ACCESS TOKEN is PLATFORM-GLOBAL today
--      (send-whatsapp-message uses Env.META_ACCESS_TOKEN and only
--      meta_phone_number_id with a global fallback is per-tenant). This
--      workstream therefore does NOT duplicate the global token into a
--      per-hospital secret. The per-hospital surface is the PUBLIC
--      identifiers (phone-number id, WABA id, WhatsApp number) +
--      enable/disable + lifecycle status; the ACCESS TOKEN is
--      platform-global and lives in Supabase Vault.
--
--   3. SECRET STORAGE reuses the EXISTING secure facility. Supabase
--      Vault is already installed and already used by the Phase 2
--      scheduler (migrations 53 / 57 read vault.decrypted_secrets). No
--      new "encrypted" column with a hard-coded key is created (spec
--      sec 4 / sec 10 forbid exactly that). The provider secret is
--      stored in Vault under a stable opaque NAME; only that NAME
--      (secret_ref) and a boolean presence marker are kept in the
--      public schema. The plaintext never touches a frontend-readable
--      column, an API response, an audit payload, a log line or an
--      error body.
--
-- -- Primitives REUSED, not duplicated (AGENTS.md sec 6) -----------
--
--   * Tenant identity: hospitals / hospital_settings rows and the
--     existing RLS helpers is_global_admin(),
--     user_has_hospital_access(), current_user_role().
--   * Runtime projection: the EXISTING hospital_settings columns the
--     payment / WhatsApp engines already read, so runtime consumes the
--     new configuration WITHOUT any engine rewrite (spec sec 27 / 28).
--   * Audit: the existing write_audit_log path (migration 39). This
--     migration registers the new audit_action_types rows.
--   * Idempotency: api_idempotency_keys (migration 25) lives at the
--     Edge layer; the RPCs below are individually version-safe.
--   * Vault: the existing supabase_vault extension
--     (vault.create_secret / vault.update_secret /
--     vault.decrypted_secrets).
--
-- -- Security posture (AGENTS.md sec 7, F16-04 standing rule) ------
--
--   * Every new function is SECURITY DEFINER with search_path pinned to
--     public and its OWN explicit REVOKE from PUBLIC / anon /
--     authenticated plus a GRANT to service_role only. No prior
--     migration's default-privilege behaviour is trusted for a new
--     SECURITY DEFINER function. resolve_integration_secret and
--     set_integration_secret additionally re-check the caller is a
--     global_admin (set_integration_secret) and are the ONLY paths to
--     Vault material; neither ever returns a secret through the public
--     read RPC.
--   * DB-layer authorization is defense-in-depth: even though the Edge
--     layer already requireRole(['global_admin','hospital_admin']) and
--     resolveAuth() resolves the authenticated tenant, every per-tenant
--     RPC independently re-checks that p_actor_user_id either holds
--     global_admin, or holds hospital_admin scoped to p_hospital_id.
--     Any other actor / tenant mismatch is SQLSTATE 42501. A
--     client-supplied hospital id NEVER drives tenancy.
--   * Concurrency: the integration_config row is locked FOR UPDATE and
--     an optimistic expected_version check compares the caller's
--     version against the stored version. A mismatch is SQLSTATE P0001
--     (raise_exception), which the Edge layer maps to HTTP 409. P0001
--     is used deliberately, not 40001, for the documented PostgREST
--     class-40 retry reason (see migration 66 header).
--   * Tenant isolation: integration_config is FORCE ROW LEVEL
--     SECURITY. service_role owns every write through the RPC; a
--     hospital member may read ONLY their own tenant's safe metadata;
--     there is no anon access and no authenticated direct write.
--     platform_integration_secret is service_role-only readable - its
--     presence marker is exposed to the UI solely through the read RPC.
--   * Validation: unknown keys and shape/range violations are 22023; a
--     missing target hospital / settings row is P0002; PostgreSQL error
--     text is never leaked to the caller.
-- =============================================================

BEGIN;

-- =============================================================
-- 1. PER-HOSPITAL INTEGRATION CONFIGURATION (safe metadata only)
-- =============================================================
-- Holds ONLY frontend-safe integration metadata: the public provider
-- identifier, the enable/disable flag, the lifecycle status, test /
-- rotation bookkeeping and a stable OPAQUE secret NAME reference. It
-- NEVER holds a credential value.

CREATE TABLE IF NOT EXISTS public.integration_config (
    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    provider TEXT NOT NULL
        CHECK (provider IN ('razorpay', 'meta_whatsapp')),

    -- Public identifiers (safe to expose to the authorized tenant UI).
    -- razorpay: public key id. meta_whatsapp: phone-number id.
    public_identifier TEXT
        CHECK (public_identifier IS NULL
               OR char_length(public_identifier) <= 200),

    -- meta_whatsapp only.
    waba_id TEXT
        CHECK (waba_id IS NULL OR char_length(waba_id) <= 200),

    contact_number TEXT
        CHECK (contact_number IS NULL
               OR char_length(contact_number) <= 32),

    enabled BOOLEAN NOT NULL DEFAULT false,

    status TEXT NOT NULL DEFAULT 'unconfigured'
        CHECK (status IN ('unconfigured', 'configured', 'disabled')),

    -- Stable opaque Vault secret NAME. Never the secret itself, and
    -- never returned by the public read RPC.
    secret_ref TEXT
        CHECK (secret_ref IS NULL OR char_length(secret_ref) <= 200),

    last_tested_at TIMESTAMPTZ,

    last_test_status TEXT,

    last_rotated_at TIMESTAMPTZ,

    version INTEGER NOT NULL DEFAULT 1
        CHECK (version >= 1),

    updated_by UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (hospital_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_integration_config_hospital
    ON public.integration_config (hospital_id);

-- updated_at bookkeeping via the EXISTING set_updated_at() trigger.
DROP TRIGGER IF EXISTS trg_integration_config_updated_at
    ON public.integration_config;

CREATE TRIGGER trg_integration_config_updated_at
BEFORE UPDATE ON public.integration_config
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.integration_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_config FORCE ROW LEVEL SECURITY;

-- service_role owns every write (the RPCs are the sole writers).
DROP POLICY IF EXISTS integration_config_service_role
    ON public.integration_config;

CREATE POLICY integration_config_service_role
    ON public.integration_config
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- A hospital member may read ONLY their own tenant's safe metadata.
-- There is deliberately NO authenticated INSERT / UPDATE / DELETE
-- policy: writes happen only through the service-role RPC.
DROP POLICY IF EXISTS integration_config_member_read
    ON public.integration_config;

CREATE POLICY integration_config_member_read
    ON public.integration_config
    FOR SELECT
    TO authenticated
    USING (
        public.is_global_admin()
        OR public.user_has_hospital_access(hospital_id)
    );

COMMENT ON TABLE public.integration_config IS
'WS-ONBOARD-3: per-hospital integration lifecycle + public identifiers. '
'Holds NO credential value. FORCE RLS; service-role RPC is the sole writer.';

-- =============================================================
-- 2. PLATFORM-GLOBAL SECRET PRESENCE MARKER (never the secret)
-- =============================================================
-- The provider secrets are platform-global (see header decision 1/2).
-- This singleton table records, per provider, ONLY that a Vault secret
-- exists under a stable NAME and when it was last rotated. The
-- encrypted value lives in Supabase Vault, never here.

CREATE TABLE IF NOT EXISTS public.platform_integration_secret (
    provider TEXT PRIMARY KEY
        CHECK (provider IN ('razorpay', 'meta_whatsapp')),

    -- Stable opaque Vault secret NAME.
    secret_name TEXT NOT NULL,

    secret_present BOOLEAN NOT NULL DEFAULT false,

    last_rotated_at TIMESTAMPTZ,

    updated_by UUID,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_integration_secret
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_integration_secret
    FORCE ROW LEVEL SECURITY;

-- service_role-only. The presence marker reaches the UI solely through
-- the read RPC; the browser never queries this table directly.
DROP POLICY IF EXISTS platform_integration_secret_service_role
    ON public.platform_integration_secret;

CREATE POLICY platform_integration_secret_service_role
    ON public.platform_integration_secret
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

INSERT INTO public.platform_integration_secret (provider, secret_name)
VALUES
    ('razorpay', 'setura_razorpay_key_secret'),
    ('meta_whatsapp', 'setura_meta_access_token')
ON CONFLICT (provider) DO NOTHING;

COMMENT ON TABLE public.platform_integration_secret IS
'WS-ONBOARD-3: platform-global provider secret PRESENCE marker + Vault '
'NAME. Never stores a credential value. service-role-only readable.';


-- =============================================================
-- 3. READ PATH: get_integration_configuration
-- =============================================================
-- Returns ONLY sanitized, frontend-safe configuration. Never a secret
-- and never even the internal secret_ref name.

CREATE OR REPLACE FUNCTION public.get_integration_configuration(
    p_actor_user_id UUID,
    p_hospital_id   UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_exists BOOLEAN;
BEGIN
    IF p_actor_user_id IS NULL OR p_hospital_id IS NULL THEN
        RAISE EXCEPTION 'actor and hospital are required'
            USING ERRCODE = '42501';
    END IF;

    -- global_admin OR hospital_admin of THIS hospital.
    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id AND role = 'global_admin'
    ) AND NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id
          AND role = 'hospital_admin'
          AND hospital_id = p_hospital_id
    ) THEN
        RAISE EXCEPTION 'actor is not authorized to read this integration configuration'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.hospitals WHERE id = p_hospital_id) THEN
        RAISE EXCEPTION 'hospital not found'
            USING ERRCODE = 'P0002';
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'hospital_id', p_hospital_id,
        'integrations', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'provider',         ic.provider,
                'public_identifier', ic.public_identifier,
                'waba_id',          ic.waba_id,
                'contact_number',   ic.contact_number,
                'enabled',          ic.enabled,
                'status',           ic.status,
                'last_tested_at',   ic.last_tested_at,
                'last_test_status', ic.last_test_status,
                'last_rotated_at',  ic.last_rotated_at,
                'version',          ic.version
            ) ORDER BY ic.provider)
            FROM public.integration_config ic
            WHERE ic.hospital_id = p_hospital_id
        ), '[]'::jsonb),
        'platform_secrets', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'provider',        ps.provider,
                'secret_present',  ps.secret_present,
                'last_rotated_at', ps.last_rotated_at
            ) ORDER BY ps.provider)
            FROM public.platform_integration_secret ps
        ), '[]'::jsonb)
    );
END;
$$;

ALTER FUNCTION public.get_integration_configuration(UUID, UUID)
    SET row_security = off;

-- F16-04: a NEW SECURITY DEFINER function needs its OWN explicit REVOKE.
REVOKE ALL ON FUNCTION public.get_integration_configuration(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_integration_configuration(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.get_integration_configuration(UUID, UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_integration_configuration(UUID, UUID) TO service_role;

COMMENT ON FUNCTION public.get_integration_configuration(UUID, UUID) IS
'WS-ONBOARD-3: sanitized integration read (per-hospital metadata + platform '
'secret presence). service_role-only. Re-checks actor is global_admin OR '
'hospital_admin of the tenant. Returns NO secret and NO secret_ref.';

-- =============================================================
-- 4. WRITE PATH: update_integration_configuration
-- =============================================================
-- Writes per-hospital SAFE metadata only, and projects the public
-- identifiers + enable flag onto the EXISTING hospital_settings columns
-- the payment / WhatsApp engines already read, so runtime consumes the
-- configuration with no engine rewrite (spec sec 27 / 28). The
-- credential is NOT handled here.

CREATE OR REPLACE FUNCTION public.update_integration_configuration(
    p_actor_user_id     UUID,
    p_hospital_id       UUID,
    p_provider          TEXT,
    p_expected_version  INTEGER,
    p_patch             JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cur        public.integration_config%ROWTYPE;
    v_has_cur    BOOLEAN := false;
    v_current_ver INTEGER;
    v_allowed    TEXT[];
    v_key        TEXT;
    v_identifier TEXT;
    v_waba       TEXT;
    v_contact    TEXT;
    v_enabled    BOOLEAN;
    v_new_ver    INTEGER;
    v_status     TEXT;
BEGIN
    -- -- 1. DB-layer authorization (defense-in-depth) --------------
    IF p_actor_user_id IS NULL OR p_hospital_id IS NULL THEN
        RAISE EXCEPTION 'actor and hospital are required'
            USING ERRCODE = '42501';
    END IF;

    IF p_provider NOT IN ('razorpay', 'meta_whatsapp') THEN
        RAISE EXCEPTION 'provider must be razorpay or meta_whatsapp'
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id AND role = 'global_admin'
    ) AND NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id
          AND role = 'hospital_admin'
          AND hospital_id = p_hospital_id
    ) THEN
        RAISE EXCEPTION 'actor is not authorized to update this integration configuration'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.hospitals
        WHERE id = p_hospital_id AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'hospital not found'
            USING ERRCODE = 'P0002';
    END IF;

    -- -- 2. Lock the existing row FOR UPDATE (or establish version 0) --
    IF p_patch IS NOT NULL AND jsonb_typeof(p_patch) <> 'object' THEN
        RAISE EXCEPTION 'patch must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_cur
      FROM public.integration_config
     WHERE hospital_id = p_hospital_id
       AND provider     = p_provider
     FOR UPDATE;
    v_has_cur := FOUND;

    -- PL/pgSQL scans an IF condition up to its THEN keyword, so the
    -- current version is resolved BEFORE the comparison rather than via
    -- an inline CASE (whose own THEN would confuse the condition scan).
    IF v_has_cur THEN
        v_current_ver := v_cur.version;
    ELSE
        v_current_ver := 0;
    END IF;

    IF p_expected_version IS NULL
       OR p_expected_version <> v_current_ver THEN
        RAISE EXCEPTION 'integration configuration version conflict: current %, expected %',
            v_current_ver,
            p_expected_version
            USING ERRCODE = 'P0001';
    END IF;

    -- -- 3. Allowlist (secret / rotation / status keys are NOT here) --
    v_allowed := ARRAY[
        'public_identifier', 'waba_id', 'contact_number', 'enabled'
    ];
    FOR v_key IN SELECT jsonb_object_keys(COALESCE(p_patch, '{}'::jsonb))
    LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            RAISE EXCEPTION 'field "%" is not editable in integration configuration', v_key
                USING ERRCODE = '22023';
        END IF;
    END LOOP;

    v_identifier := COALESCE(v_cur.public_identifier, NULL);
    v_waba       := COALESCE(v_cur.waba_id, NULL);
    v_contact    := COALESCE(v_cur.contact_number, NULL);
    v_enabled    := COALESCE(v_cur.enabled, false);
    IF v_has_cur THEN
        v_identifier := v_cur.public_identifier;
        v_waba       := v_cur.waba_id;
        v_contact    := v_cur.contact_number;
        v_enabled    := v_cur.enabled;
    END IF;

    IF p_patch ? 'public_identifier' THEN
        v_identifier := NULLIF(btrim(coalesce(p_patch->>'public_identifier', '')), '');
        IF v_identifier IS NOT NULL AND char_length(v_identifier) > 200 THEN
            RAISE EXCEPTION 'public_identifier must be 200 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
    END IF;
    IF p_patch ? 'waba_id' THEN
        IF p_provider <> 'meta_whatsapp' THEN
            RAISE EXCEPTION 'waba_id applies only to meta_whatsapp'
                USING ERRCODE = '22023';
        END IF;
        v_waba := NULLIF(btrim(coalesce(p_patch->>'waba_id', '')), '');
        IF v_waba IS NOT NULL AND char_length(v_waba) > 200 THEN
            RAISE EXCEPTION 'waba_id must be 200 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
    END IF;
    IF p_patch ? 'contact_number' THEN
        IF p_provider <> 'meta_whatsapp' THEN
            RAISE EXCEPTION 'contact_number applies only to meta_whatsapp'
                USING ERRCODE = '22023';
        END IF;
        v_contact := NULLIF(btrim(coalesce(p_patch->>'contact_number', '')), '');
        IF v_contact IS NOT NULL AND char_length(v_contact) > 32 THEN
            RAISE EXCEPTION 'contact_number must be 32 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
    END IF;
    IF p_patch ? 'enabled' THEN
        v_enabled := (p_patch->>'enabled')::BOOLEAN;
    END IF;

    -- -- 4. Derive lifecycle status (configuration, NOT activation) --
    IF NOT v_enabled THEN
        v_status := 'disabled';
    ELSIF v_identifier IS NOT NULL THEN
        v_status := 'configured';
    ELSE
        v_status := 'unconfigured';
    END IF;

    IF v_has_cur THEN
        v_new_ver := v_cur.version + 1;
    ELSE
        v_new_ver := 1;
    END IF;

    -- -- 5. Upsert safe metadata (secret_ref preserved untouched) ----
    INSERT INTO public.integration_config (
        hospital_id, provider, public_identifier, waba_id, contact_number,
        enabled, status, secret_ref, last_tested_at, last_test_status,
        last_rotated_at, version, updated_by, created_at, updated_at
    )
    VALUES (
        p_hospital_id, p_provider, v_identifier, v_waba, v_contact,
        v_enabled, v_status, v_cur.secret_ref, v_cur.last_tested_at,
        v_cur.last_test_status, v_cur.last_rotated_at, v_new_ver,
        p_actor_user_id, now(), now()
    )
    ON CONFLICT (hospital_id, provider) DO UPDATE SET
        public_identifier = EXCLUDED.public_identifier,
        waba_id           = EXCLUDED.waba_id,
        contact_number    = EXCLUDED.contact_number,
        enabled           = EXCLUDED.enabled,
        status            = EXCLUDED.status,
        version           = EXCLUDED.version,
        updated_by        = EXCLUDED.updated_by,
        updated_at        = now();

    -- -- 6. Project onto the EXISTING runtime columns (engine reads
    --        these unchanged; the settings row always exists for a live
    --        hospital via trg_auto_hospital_settings). -----------------
    IF EXISTS (SELECT 1 FROM public.hospital_settings WHERE hospital_id = p_hospital_id) THEN
        IF p_provider = 'razorpay' THEN
            UPDATE public.hospital_settings
               SET razorpay_key_id = v_identifier,
                   payment_enabled = v_enabled,
                   updated_by      = p_actor_user_id
             WHERE hospital_id = p_hospital_id;
        ELSE
            UPDATE public.hospital_settings
               SET meta_phone_number_id = v_identifier,
                   meta_waba_id         = v_waba,
                   whatsapp_number      = v_contact,
                   updated_by           = p_actor_user_id
             WHERE hospital_id = p_hospital_id;
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'ok',          true,
        'reason',      'updated',
        'hospital_id', p_hospital_id,
        'provider',    p_provider,
        'version',     v_new_ver,
        'status',      v_status
    );
END;
$$;

ALTER FUNCTION public.update_integration_configuration(UUID, UUID, TEXT, INTEGER, JSONB)
    SET row_security = off;

REVOKE ALL ON FUNCTION public.update_integration_configuration(UUID, UUID, TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_integration_configuration(UUID, UUID, TEXT, INTEGER, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.update_integration_configuration(UUID, UUID, TEXT, INTEGER, JSONB) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.update_integration_configuration(UUID, UUID, TEXT, INTEGER, JSONB) TO service_role;

COMMENT ON FUNCTION public.update_integration_configuration(UUID, UUID, TEXT, INTEGER, JSONB) IS
'WS-ONBOARD-3: atomic per-hospital integration metadata write. service_role-only. '
'Re-checks actor role+tenant, locks the row FOR UPDATE, optimistic expected_version '
'(P0001 on mismatch), allowlists public identifiers + enabled (rejects any secret '
'key), derives status, and projects identifiers onto the existing hospital_settings '
'runtime columns. Never writes a credential.';


-- =============================================================
-- 5. SECRET WRITE PATH: set_integration_secret (global_admin only)
-- =============================================================
-- The provider secret is PLATFORM-GLOBAL (header decision 1/2). Only a
-- global_admin may set / rotate it. The value is written straight into
-- Supabase Vault under the stable NAME held in platform_integration_
-- secret.secret_name; the plaintext is NEVER stored in a public column.
-- The function argument is the only place the plaintext exists in SQL,
-- and it is consumed inline by vault.create_secret / vault.update_secret
-- and never returned, logged, or audited.

CREATE OR REPLACE FUNCTION public.set_integration_secret(
    p_actor_user_id UUID,
    p_provider      TEXT,
    p_secret        TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name   TEXT;
    v_id     UUID;
    v_len    INTEGER;
BEGIN
    IF p_actor_user_id IS NULL THEN
        RAISE EXCEPTION 'actor is required'
            USING ERRCODE = '42501';
    END IF;

    -- Platform-global credential: global_admin ONLY.
    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id AND role = 'global_admin'
    ) THEN
        RAISE EXCEPTION 'only a global admin may rotate a platform integration secret'
            USING ERRCODE = '42501';
    END IF;

    IF p_provider NOT IN ('razorpay', 'meta_whatsapp') THEN
        RAISE EXCEPTION 'provider must be razorpay or meta_whatsapp'
            USING ERRCODE = '22023';
    END IF;

    v_len := char_length(coalesce(p_secret, ''));
    IF v_len = 0 OR v_len > 1024 THEN
        -- Do not echo the value; only its presence / length bound.
        RAISE EXCEPTION 'secret must be present and at most 1024 characters'
            USING ERRCODE = '22023';
    END IF;

    SELECT secret_name INTO v_name
      FROM public.platform_integration_secret
     WHERE provider = p_provider;
    IF v_name IS NULL THEN
        RAISE EXCEPTION 'platform secret name not registered for provider'
            USING ERRCODE = 'P0002';
    END IF;

    -- Upsert into Vault by stable NAME (opaque reference only).
    SELECT id INTO v_id
      FROM vault.secrets
     WHERE name = v_name
     LIMIT 1;

    IF v_id IS NULL THEN
        PERFORM vault.create_secret(p_secret, v_name);
    ELSE
        PERFORM vault.update_secret(v_id, p_secret, v_name);
    END IF;

    UPDATE public.platform_integration_secret
       SET secret_present  = true,
           last_rotated_at = now(),
           updated_by      = p_actor_user_id,
           updated_at      = now()
     WHERE provider = p_provider;

    RETURN jsonb_build_object(
        'ok',             true,
        'provider',       p_provider,
        'secret_present', true,
        'last_rotated_at', now()
    );
END;
$$;

ALTER FUNCTION public.set_integration_secret(UUID, TEXT, TEXT)
    SET row_security = off;

REVOKE ALL ON FUNCTION public.set_integration_secret(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_integration_secret(UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.set_integration_secret(UUID, TEXT, TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.set_integration_secret(UUID, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.set_integration_secret(UUID, TEXT, TEXT) IS
'WS-ONBOARD-3: platform-global provider credential store / rotate into Supabase '
'Vault. global_admin-only. The plaintext is consumed inline by vault.create_secret '
'/ vault.update_secret and is NEVER persisted in a public column or returned.';

-- =============================================================
-- 6. SECRET READ PATH (trusted runtime only): resolve_integration_secret
-- =============================================================
-- The ONLY path to Vault material. service_role-only, never exposed to
-- the browser or the frontend transport. The Edge / worker runtime calls
-- this to obtain the platform credential; when it is absent the runtime
-- falls back to the existing environment variable, so behavior is
-- unchanged for an un-provisioned host (spec sec 27 / 28 / 32).

CREATE OR REPLACE FUNCTION public.resolve_integration_secret(
    p_provider TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name TEXT;
    v_val  TEXT;
BEGIN
    IF p_provider NOT IN ('razorpay', 'meta_whatsapp') THEN
        RETURN NULL;
    END IF;

    SELECT secret_name INTO v_name
      FROM public.platform_integration_secret
     WHERE provider = p_provider;
    IF v_name IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT decrypted_secret INTO v_val
      FROM vault.decrypted_secrets
     WHERE name = v_name
     LIMIT 1;

    RETURN v_val;  -- NULL means "not configured in Vault".
END;
$$;

ALTER FUNCTION public.resolve_integration_secret(TEXT)
    SET row_security = off;

REVOKE ALL ON FUNCTION public.resolve_integration_secret(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_integration_secret(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_integration_secret(TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.resolve_integration_secret(TEXT) TO service_role;

COMMENT ON FUNCTION public.resolve_integration_secret(TEXT) IS
'WS-ONBOARD-3: trusted-runtime Vault read of a platform-global provider '
'credential. service_role-only (never a frontend path). Returns NULL when '
'un-provisioned so the runtime falls back to its environment variable.';

-- =============================================================
-- 7. TEST-RESULT BOOKKEEPING: record_integration_test_result
-- =============================================================
-- Stores a SANITIZED connection-test outcome (never a credential, never
-- a raw provider response). Does NOT bump the config version: a test is
-- an observation, not a configuration mutation, so it must not disturb
-- concurrent editors' expected_version.

CREATE OR REPLACE FUNCTION public.record_integration_test_result(
    p_actor_user_id UUID,
    p_hospital_id   UUID,
    p_provider      TEXT,
    p_test_status   TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_rows INTEGER;
BEGIN
    IF p_actor_user_id IS NULL OR p_hospital_id IS NULL THEN
        RAISE EXCEPTION 'actor and hospital are required'
            USING ERRCODE = '42501';
    END IF;

    IF p_test_status NOT IN (
        'CONNECTED', 'INVALID_CREDENTIAL', 'UNAUTHORIZED',
        'PROVIDER_UNAVAILABLE', 'CONFIGURATION_INVALID'
    ) THEN
        RAISE EXCEPTION 'unrecognized test status'
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id AND role = 'global_admin'
    ) AND NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id
          AND role = 'hospital_admin'
          AND hospital_id = p_hospital_id
    ) THEN
        RAISE EXCEPTION 'actor is not authorized for this hospital'
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.integration_config
       SET last_tested_at   = now(),
           last_test_status = p_test_status
     WHERE hospital_id = p_hospital_id
       AND provider     = p_provider;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    RETURN jsonb_build_object(
        'ok',         true,
        'recorded',   v_rows > 0,
        'provider',   p_provider,
        'test_status', p_test_status
    );
END;
$$;

ALTER FUNCTION public.record_integration_test_result(UUID, UUID, TEXT, TEXT)
    SET row_security = off;

REVOKE ALL ON FUNCTION public.record_integration_test_result(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_integration_test_result(UUID, UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.record_integration_test_result(UUID, UUID, TEXT, TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.record_integration_test_result(UUID, UUID, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.record_integration_test_result(UUID, UUID, TEXT, TEXT) IS
'WS-ONBOARD-3: stores a sanitized connection-test outcome on the integration '
'row. service_role-only. Re-checks actor role+tenant. Never a credential; never '
'bumps the config version.';

-- =============================================================
-- 8. AUDIT ACTION TYPE REGISTRATION
-- =============================================================

INSERT INTO public.audit_action_types (
    action_type, display_name, default_severity, category, description
)
VALUES
(
    'integration_config_update',
    'Integration Configuration Update',
    'high',
    'system',
    'A hospital integration metadata change (WS-ONBOARD-3)'
),
(
    'integration_enabled',
    'Integration Enabled',
    'medium',
    'system',
    'A hospital integration was enabled (WS-ONBOARD-3)'
),
(
    'integration_disabled',
    'Integration Disabled',
    'medium',
    'system',
    'A hospital integration was disabled (WS-ONBOARD-3)'
),
(
    'integration_connection_tested',
    'Integration Connection Tested',
    'low',
    'system',
    'A sanitized integration connection test result was recorded (WS-ONBOARD-3)'
),
(
    'integration_secret_rotated',
    'Integration Secret Rotated',
    'critical',
    'system',
    'A platform-global integration credential was stored/rotated; the value is '
    'never recorded (WS-ONBOARD-3)'
)
ON CONFLICT (action_type) DO NOTHING;

COMMIT;
