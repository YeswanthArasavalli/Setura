-- =============================================================
-- 66_hospital_configuration_write_surfaces.sql
--
-- WS-ONBOARD-2 - Hospital Configuration Write Surfaces.
--
-- Product gap (WS-ONBOARD-1 report sec 12, spec sec 3): after a hospital
-- tenant is provisioned, an operator currently has NO way to configure
-- its operational settings from the SETURA UI. The tenant is created
-- with defaults via the existing trg_auto_hospital_settings trigger
-- (migration 12); nothing in the repository offers an authorized write
-- path over the readable columns, so an operator has to edit SQL or a
-- migration directly. This migration adds a canonical, atomic and
-- versioned write path so the eventual onboarding flow becomes:
--
--   Create Hospital  ->  Configure Hospital  ->  Configure Integrations
--   ->  Add Staff / Doctors / Schedules  ->  Ready for operation
--
-- and configuring a hospital requires no SQL, no source edits and no
-- environment-variable changes.
--
-- Two RPCs are added:
--
--   1. get_hospital_configuration(...)  - read the composed snapshot the
--      admin form edits: identity + settings + current config_versions
--      row + effective feature flags.
--
--   2. update_hospital_configuration(...)  - the single canonical,
--      atomic, authorized write path over BOTH hospitals and
--      hospital_settings plus the feature-flag hospital overrides.
--
-- Existing primitives are reused exactly (AGENTS.md sec 6, WS-ONBOARD-1
-- precedent):
--
--   * Configuration versioning: the existing trg_hospital_settings_version
--     AFTER-UPDATE trigger (migration 18) already writes append-only
--     config_versions rows on every UPDATE of hospital_settings. This
--     migration does NOT add a second version store, a second trigger, or
--     a second rollback path. The RPC sets hospital_settings.updated_by
--     (the existing column added by migration 18) so the version row
--     records the real actor even though the caller is service_role.
--   * Feature-flag versioning: the existing trg_feature_flags_version
--     trigger (migration 18) fires when an override row's value changes.
--   * Feature-flag resolution: the existing get_hospital_feature_flags
--     RPC (migration 37) resolves global default + per-hospital override.
--   * Audit: the existing write_audit_log path (migration 39). This
--     migration registers two audit_action_types rows (the TS
--     AuditActionType union already declared them; DB registration was
--     missing), so severity defaults land correctly.
--   * Idempotency: the existing api_idempotency_keys registry (migration
--     25) lives at the Edge layer; the RPC itself is idempotent-safe.
--
-- Scope (WS-ONBOARD-2 ONLY). Deliberately NOT touched here:
--
--   * No Razorpay / Meta credential columns (whatsapp_number,
--     meta_phone_number_id, meta_waba_id, razorpay_key_id,
--     payment_enabled). WS-ONBOARD-3 owns them, per spec sec 4.
--   * No tenant creation (WS-ONBOARD-1 owns that).
--   * No doctors / staff / schedules / subscriptions / payments.
--   * No new versioning or rollback machinery, no parallel audit table,
--     no competing idempotency system.
--   * The hospitals.slug, hospitals.id, hospitals.created_by,
--     hospitals.deleted_at, hospitals.is_active and
--     hospitals.subscription_active columns are system-managed and are
--     REJECTED in the patch (spec sec 8, system-managed fields).
--   * hospital_settings.collect_consultation_at_hospital is a business-
--     model invariant (always TRUE in the SETURA model, migration 35);
--     exposing it as editable would invent financial policy, so it is
--     rejected in the patch.
--   * hospital_settings.booking_fee_amount is kept automatically in sync
--     with platform_fee_online (migration 35 comment: "Synced
--     automatically"); if the caller edits platform_fee_online the RPC
--     writes both, and if the caller edits booking_fee_amount alone the
--     RPC refuses so the alias can never silently diverge.
--
-- Security posture (AGENTS.md sec 7, F16-04 standing rule):
--   * Both new functions are SECURITY DEFINER with an explicit
--     REVOKE from PUBLIC / anon / authenticated and a GRANT to
--     service_role only. A NEW SECURITY DEFINER function needs its OWN
--     explicit REVOKE; no prior migration's default is trusted.
--   * search_path pinned to public; row_security off so the definer body
--     can read user_roles under RLS and write hospitals /
--     hospital_settings / feature_flags as owner. This mirrors the
--     existing version_hospital_settings() trigger body (migration 18).
--   * DB-layer authorization is defense-in-depth: even though the Edge
--     layer already requireRole(['global_admin','hospital_admin']) and
--     resolveAuth() reads the X-Hospital-ID from the authenticated
--     context, the RPC independently re-checks that p_actor_user_id
--     either holds global_admin, or holds hospital_admin scoped to
--     p_hospital_id. Any other actor or tenant mismatch is SQLSTATE
--     42501. Client-supplied hospital identity NEVER drives tenancy.
--   * Concurrency: hospitals and hospital_settings rows are locked
--     FOR UPDATE inside the RPC, and an optimistic expected_version
--     check compares the caller's version against the current
--     MAX(config_versions.version_number) for
--     ('hospital_settings', hospital_id, 'settings'). A mismatch is
--     SQLSTATE P0001 (raise_exception), which the Edge layer maps
--     to HTTP 409 CONFLICT so the UI re-fetches. We deliberately do
--     NOT use 40001 (serialization_failure): PostgREST treats
--     class-40 codes as retryable and repeatedly re-issues the
--     transaction, which turns a benign expected-version conflict
--     into a client-visible timeout.
--   * Validation: unknown keys are 22023 (invalid_parameter_value);
--     range/shape violations raised by the existing CHECK constraints
--     are caught and translated to 22023 with a clean name. The
--     PostgreSQL error text is never leaked to the client.
--   * Tenant isolation: the RPC only ever touches the target hospital's
--     rows; there is no cross-hospital write in this migration, so no
--     RLS weakening is required. Existing FORCE ROW LEVEL SECURITY
--     remains intact; the definer body runs as owner with row_security
--     off (the same pattern every existing SECURITY DEFINER trigger
--     uses).
-- =============================================================

-- =============================================================
-- READ PATH: get_hospital_configuration
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_hospital_configuration(
    p_actor_user_id UUID,
    p_hospital_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hosp public.hospitals%ROWTYPE;
    v_set  public.hospital_settings%ROWTYPE;
    v_ver  INTEGER;
BEGIN
    IF p_actor_user_id IS NULL OR p_hospital_id IS NULL THEN
        RAISE EXCEPTION 'actor and hospital are required'
            USING ERRCODE = '42501';
    END IF;

    -- Actor must be global_admin OR hospital_admin of THIS hospital.
    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id AND role = 'global_admin'
    ) AND NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id
          AND role = 'hospital_admin'
          AND hospital_id = p_hospital_id
    ) THEN
        RAISE EXCEPTION 'actor is not authorized to read this hospital configuration'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_hosp
      FROM public.hospitals
     WHERE id = p_hospital_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'hospital not found'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT * INTO v_set
      FROM public.hospital_settings
     WHERE hospital_id = p_hospital_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'hospital settings row missing'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT COALESCE(MAX(version_number), 0)
      INTO v_ver
      FROM public.config_versions
     WHERE config_table = 'hospital_settings'
       AND hospital_id  = p_hospital_id
       AND config_key   = 'settings';

    RETURN jsonb_build_object(
        'ok',      true,
        'version', v_ver,
        'hospital', jsonb_build_object(
            'id',                       v_hosp.id,
            'slug',                     v_hosp.slug,
            'name',                     v_hosp.name,
            'name_te',                  v_hosp.name_te,
            'phone',                    v_hosp.phone,
            'email',                    v_hosp.email,
            'country',                  v_hosp.country,
            'state',                    v_hosp.state,
            'district',                 v_hosp.district,
            'town',                     v_hosp.town,
            'address',                  v_hosp.address,
            'timezone',                 v_hosp.timezone,
            'online_booking_enabled',   v_hosp.online_booking_enabled,
            'max_advance_booking_days', v_hosp.max_advance_booking_days
        ),
        'settings', jsonb_build_object(
            'display_name',                     v_set.display_name,
            'logo_url',                         v_set.logo_url,
            'platform_fee_online',              v_set.platform_fee_online,
            'platform_fee_whatsapp',            v_set.platform_fee_whatsapp,
            'receptionist_fee',                 v_set.receptionist_fee,
            'booking_fee_amount',               v_set.booking_fee_amount,
            'online_booking_fee_enabled',       v_set.online_booking_fee_enabled,
            'default_consultation_fee_inr',     v_set.default_consultation_fee_inr,
            'collect_consultation_at_hospital', v_set.collect_consultation_at_hospital,
            'gst_enabled',                      v_set.gst_enabled,
            'gst_percentage',                   v_set.gst_percentage,
            'gst_registration_number',          v_set.gst_registration_number,
            'max_tokens_per_day',               v_set.max_tokens_per_day,
            'allow_walkin_tokens',              v_set.allow_walkin_tokens,
            'allow_online_booking',             v_set.allow_online_booking,
            'allow_carry_forward',              v_set.allow_carry_forward,
            'queue_display_enabled',            v_set.queue_display_enabled,
            'send_whatsapp_confirmation',       v_set.send_whatsapp_confirmation,
            'send_whatsapp_reminder',           v_set.send_whatsapp_reminder,
            'send_feedback_request',            v_set.send_feedback_request,
            'reminder_before_minutes',          v_set.reminder_before_minutes,
            'preferred_language',               v_set.preferred_language,
            'timezone',                         v_set.timezone,
            'metadata',                         v_set.metadata,
            'updated_at',                       v_set.updated_at,
            'updated_by',                       v_set.updated_by
        ),
        'feature_flags', (
            SELECT COALESCE(
                jsonb_agg(jsonb_build_object(
                    'flag_key',     f.flag_key,
                    'display_name', f.display_name,
                    'description',  f.description,
                    'is_enabled',   f.is_enabled,
                    'is_override',  f.is_override
                ) ORDER BY f.flag_key),
                '[]'::jsonb
            )
            FROM public.get_hospital_feature_flags(p_hospital_id) AS f
        )
    );
END;
$$;

ALTER FUNCTION public.get_hospital_configuration(UUID, UUID)
    SET row_security = off;

-- F16-04: a NEW SECURITY DEFINER function needs its OWN explicit REVOKE.
REVOKE ALL ON FUNCTION public.get_hospital_configuration(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_hospital_configuration(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.get_hospital_configuration(UUID, UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_hospital_configuration(UUID, UUID) TO service_role;

COMMENT ON FUNCTION public.get_hospital_configuration(UUID, UUID) IS
'WS-ONBOARD-2: canonical composed read of hospitals + hospital_settings + the '
'current hospital_settings config_versions row + the effective feature flags. '
'service_role-only (Edge Function is the sole caller). Re-checks actor is '
'global_admin OR hospital_admin of the target tenant. Returns JSONB.';

-- =============================================================
-- WRITE PATH: update_hospital_configuration
-- =============================================================

CREATE OR REPLACE FUNCTION public.update_hospital_configuration(
    p_actor_user_id     UUID,
    p_hospital_id       UUID,
    p_expected_version  INTEGER,
    p_hospital_patch    JSONB,
    p_settings_patch    JSONB,
    p_feature_overrides JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hosp         public.hospitals%ROWTYPE;
    v_set          public.hospital_settings%ROWTYPE;
    v_current_ver  INTEGER;
    v_new_ver      INTEGER;
    v_allowed      TEXT[];
    v_key          TEXT;
    v_value        TEXT;
    v_any_change   BOOLEAN := false;
    v_override     JSONB;
    v_flag_key     TEXT;
    v_flag_enabled BOOLEAN;
BEGIN
    -- -- 1. DB-layer authorization (defense-in-depth) --------------
    -- auth.uid() is NULL under the service_role JWT that reaches this
    -- RPC, so the actor identity is passed explicitly by the
    -- (JWT-authoritative) Edge layer and re-verified here.
    IF p_actor_user_id IS NULL OR p_hospital_id IS NULL THEN
        RAISE EXCEPTION 'actor and hospital are required'
            USING ERRCODE = '42501';
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
        RAISE EXCEPTION 'actor is not authorized to update this hospital configuration'
            USING ERRCODE = '42501';
    END IF;

    -- -- 2. Lock target rows FOR UPDATE -----------------------------
    -- Same transaction, deterministic concurrency: any second caller
    -- either blocks here or sees the fresh version after this RPC
    -- commits.
    SELECT * INTO v_hosp
      FROM public.hospitals
     WHERE id = p_hospital_id
       AND deleted_at IS NULL
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'hospital not found'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT * INTO v_set
      FROM public.hospital_settings
     WHERE hospital_id = p_hospital_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'hospital settings row missing'
            USING ERRCODE = 'P0002';
    END IF;

    -- -- 3. Optimistic concurrency check ----------------------------
    SELECT COALESCE(MAX(version_number), 0)
      INTO v_current_ver
      FROM public.config_versions
     WHERE config_table = 'hospital_settings'
       AND hospital_id  = p_hospital_id
       AND config_key   = 'settings';

    IF p_expected_version IS DISTINCT FROM v_current_ver THEN
        RAISE EXCEPTION 'configuration version conflict: current %, expected %',
            v_current_ver, p_expected_version
            USING ERRCODE = 'P0001';
    END IF;

    -- -- 4. Reject system-managed / out-of-scope keys ---------------
    -- Unknown keys OR explicitly-forbidden keys are invalid_parameter.
    v_allowed := ARRAY[
        'name', 'name_te', 'phone', 'email',
        'country', 'state', 'district', 'town', 'address', 'timezone',
        'online_booking_enabled', 'max_advance_booking_days'
    ];
    IF p_hospital_patch IS NOT NULL AND jsonb_typeof(p_hospital_patch) <> 'object' THEN
        RAISE EXCEPTION 'hospital patch must be a JSON object'
            USING ERRCODE = '22023';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(COALESCE(p_hospital_patch, '{}'::jsonb))
    LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            RAISE EXCEPTION 'field "%" is not editable in hospital configuration', v_key
                USING ERRCODE = '22023';
        END IF;
    END LOOP;

    v_allowed := ARRAY[
        'display_name', 'logo_url',
        'platform_fee_online', 'platform_fee_whatsapp', 'receptionist_fee',
        'online_booking_fee_enabled',
        'default_consultation_fee_inr',
        'gst_enabled', 'gst_percentage', 'gst_registration_number',
        'max_tokens_per_day',
        'allow_walkin_tokens', 'allow_online_booking', 'allow_carry_forward',
        'queue_display_enabled',
        'send_whatsapp_confirmation', 'send_whatsapp_reminder',
        'send_feedback_request', 'reminder_before_minutes',
        'preferred_language', 'timezone', 'metadata'
    ];
    IF p_settings_patch IS NOT NULL AND jsonb_typeof(p_settings_patch) <> 'object' THEN
        RAISE EXCEPTION 'settings patch must be a JSON object'
            USING ERRCODE = '22023';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(COALESCE(p_settings_patch, '{}'::jsonb))
    LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            RAISE EXCEPTION 'field "%" is not editable in hospital configuration', v_key
                USING ERRCODE = '22023';
        END IF;
    END LOOP;

    -- Reject a lone booking_fee_amount edit: it is the alias maintained
    -- by this RPC from platform_fee_online (migration 35). A caller
    -- supplying booking_fee_amount without platform_fee_online would
    -- silently diverge the alias.
    IF p_settings_patch ? 'booking_fee_amount'
       AND NOT p_settings_patch ? 'platform_fee_online' THEN
        RAISE EXCEPTION 'booking_fee_amount is derived from platform_fee_online'
            USING ERRCODE = '22023';
    END IF;

    -- -- 5. Apply the hospital patch --------------------------------
    IF p_hospital_patch ? 'name' THEN
        v_hosp.name := btrim(coalesce(p_hospital_patch->>'name', ''));
        IF char_length(v_hosp.name) < 2 OR char_length(v_hosp.name) > 200 THEN
            RAISE EXCEPTION 'hospital name must be 2..200 characters'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_hospital_patch ? 'name_te' THEN
        v_hosp.name_te := NULLIF(btrim(coalesce(p_hospital_patch->>'name_te', '')), '');
        IF v_hosp.name_te IS NOT NULL AND char_length(v_hosp.name_te) > 200 THEN
            RAISE EXCEPTION 'name_te must be 200 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_hospital_patch ? 'phone' THEN
        v_hosp.phone := NULLIF(btrim(coalesce(p_hospital_patch->>'phone', '')), '');
        IF v_hosp.phone IS NOT NULL AND char_length(v_hosp.phone) > 20 THEN
            RAISE EXCEPTION 'phone must be 20 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_hospital_patch ? 'email' THEN
        v_hosp.email := NULLIF(btrim(coalesce(p_hospital_patch->>'email', '')), '');
        IF v_hosp.email IS NOT NULL THEN
            IF char_length(v_hosp.email) > 254 THEN
                RAISE EXCEPTION 'email must be 254 characters or fewer'
                    USING ERRCODE = '22023';
            END IF;
            IF v_hosp.email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
                RAISE EXCEPTION 'email is not valid'
                    USING ERRCODE = '22023';
            END IF;
        END IF;
        v_any_change := true;
    END IF;
    IF p_hospital_patch ? 'country' THEN
        v_hosp.country := NULLIF(btrim(coalesce(p_hospital_patch->>'country', '')), '');
        IF v_hosp.country IS NULL THEN
            RAISE EXCEPTION 'country is required (NOT NULL)'
                USING ERRCODE = '22023';
        END IF;
        IF char_length(v_hosp.country) > 120 THEN
            RAISE EXCEPTION 'country must be 120 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_hospital_patch ? 'state' THEN
        v_hosp.state := NULLIF(btrim(coalesce(p_hospital_patch->>'state', '')), '');
        IF v_hosp.state IS NULL THEN
            RAISE EXCEPTION 'state is required (NOT NULL)'
                USING ERRCODE = '22023';
        END IF;
        IF char_length(v_hosp.state) > 120 THEN
            RAISE EXCEPTION 'state must be 120 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_hospital_patch ? 'district' THEN
        v_hosp.district := NULLIF(btrim(coalesce(p_hospital_patch->>'district', '')), '');
        IF v_hosp.district IS NOT NULL AND char_length(v_hosp.district) > 120 THEN
            RAISE EXCEPTION 'district must be 120 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_hospital_patch ? 'town' THEN
        v_hosp.town := NULLIF(btrim(coalesce(p_hospital_patch->>'town', '')), '');
        IF v_hosp.town IS NULL THEN
            RAISE EXCEPTION 'town is required (NOT NULL)'
                USING ERRCODE = '22023';
        END IF;
        IF char_length(v_hosp.town) > 120 THEN
            RAISE EXCEPTION 'town must be 120 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_hospital_patch ? 'address' THEN
        v_hosp.address := NULLIF(btrim(coalesce(p_hospital_patch->>'address', '')), '');
        IF v_hosp.address IS NOT NULL AND char_length(v_hosp.address) > 500 THEN
            RAISE EXCEPTION 'address must be 500 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_hospital_patch ? 'timezone' THEN
        v_hosp.timezone := NULLIF(btrim(coalesce(p_hospital_patch->>'timezone', '')), '');
        IF v_hosp.timezone IS NULL THEN
            RAISE EXCEPTION 'timezone is required (NOT NULL)'
                USING ERRCODE = '22023';
        END IF;
        IF char_length(v_hosp.timezone) > 64 THEN
            RAISE EXCEPTION 'timezone must be 64 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_hospital_patch ? 'online_booking_enabled' THEN
        v_hosp.online_booking_enabled := (p_hospital_patch->>'online_booking_enabled')::BOOLEAN;
        v_any_change := true;
    END IF;
    IF p_hospital_patch ? 'max_advance_booking_days' THEN
        v_hosp.max_advance_booking_days := (p_hospital_patch->>'max_advance_booking_days')::INTEGER;
        v_any_change := true;
    END IF;

    -- -- 6. Apply the settings patch --------------------------------
    IF p_settings_patch ? 'display_name' THEN
        v_set.display_name := NULLIF(btrim(coalesce(p_settings_patch->>'display_name', '')), '');
        IF v_set.display_name IS NOT NULL AND char_length(v_set.display_name) > 200 THEN
            RAISE EXCEPTION 'display_name must be 200 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'logo_url' THEN
        v_set.logo_url := NULLIF(btrim(coalesce(p_settings_patch->>'logo_url', '')), '');
        IF v_set.logo_url IS NOT NULL AND char_length(v_set.logo_url) > 500 THEN
            RAISE EXCEPTION 'logo_url must be 500 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'platform_fee_online' THEN
        v_set.platform_fee_online := (p_settings_patch->>'platform_fee_online')::NUMERIC(10,2);
        -- Keep the alias in sync (migration 35 comment).
        v_set.booking_fee_amount  := v_set.platform_fee_online;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'platform_fee_whatsapp' THEN
        v_set.platform_fee_whatsapp := (p_settings_patch->>'platform_fee_whatsapp')::NUMERIC(10,2);
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'receptionist_fee' THEN
        v_set.receptionist_fee := (p_settings_patch->>'receptionist_fee')::NUMERIC(10,2);
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'online_booking_fee_enabled' THEN
        v_set.online_booking_fee_enabled := (p_settings_patch->>'online_booking_fee_enabled')::BOOLEAN;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'default_consultation_fee_inr' THEN
        v_set.default_consultation_fee_inr :=
            CASE WHEN p_settings_patch->>'default_consultation_fee_inr' IS NULL
                      OR p_settings_patch->>'default_consultation_fee_inr' = ''
                 THEN NULL
                 ELSE (p_settings_patch->>'default_consultation_fee_inr')::NUMERIC(10,2)
            END;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'gst_enabled' THEN
        v_set.gst_enabled := (p_settings_patch->>'gst_enabled')::BOOLEAN;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'gst_percentage' THEN
        v_set.gst_percentage := (p_settings_patch->>'gst_percentage')::NUMERIC(5,2);
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'gst_registration_number' THEN
        v_set.gst_registration_number :=
            NULLIF(btrim(coalesce(p_settings_patch->>'gst_registration_number', '')), '');
        IF v_set.gst_registration_number IS NOT NULL
           AND char_length(v_set.gst_registration_number) > 32 THEN
            RAISE EXCEPTION 'gst_registration_number must be 32 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'max_tokens_per_day' THEN
        v_set.max_tokens_per_day := (p_settings_patch->>'max_tokens_per_day')::INTEGER;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'allow_walkin_tokens' THEN
        v_set.allow_walkin_tokens := (p_settings_patch->>'allow_walkin_tokens')::BOOLEAN;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'allow_online_booking' THEN
        v_set.allow_online_booking := (p_settings_patch->>'allow_online_booking')::BOOLEAN;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'allow_carry_forward' THEN
        v_set.allow_carry_forward := (p_settings_patch->>'allow_carry_forward')::BOOLEAN;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'queue_display_enabled' THEN
        v_set.queue_display_enabled := (p_settings_patch->>'queue_display_enabled')::BOOLEAN;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'send_whatsapp_confirmation' THEN
        v_set.send_whatsapp_confirmation := (p_settings_patch->>'send_whatsapp_confirmation')::BOOLEAN;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'send_whatsapp_reminder' THEN
        v_set.send_whatsapp_reminder := (p_settings_patch->>'send_whatsapp_reminder')::BOOLEAN;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'send_feedback_request' THEN
        v_set.send_feedback_request := (p_settings_patch->>'send_feedback_request')::BOOLEAN;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'reminder_before_minutes' THEN
        v_set.reminder_before_minutes := (p_settings_patch->>'reminder_before_minutes')::INTEGER;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'preferred_language' THEN
        v_set.preferred_language := btrim(coalesce(p_settings_patch->>'preferred_language', ''));
        IF char_length(v_set.preferred_language) < 2 OR char_length(v_set.preferred_language) > 10 THEN
            RAISE EXCEPTION 'preferred_language must be 2..10 characters'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'timezone' THEN
        v_set.timezone := NULLIF(btrim(coalesce(p_settings_patch->>'timezone', '')), '');
        IF v_set.timezone IS NULL THEN
            RAISE EXCEPTION 'settings.timezone is required (NOT NULL)'
                USING ERRCODE = '22023';
        END IF;
        IF char_length(v_set.timezone) > 64 THEN
            RAISE EXCEPTION 'settings.timezone must be 64 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_settings_patch ? 'metadata' THEN
        IF jsonb_typeof(p_settings_patch->'metadata') <> 'object' THEN
            RAISE EXCEPTION 'metadata must be a JSON object'
                USING ERRCODE = '22023';
        END IF;
        v_set.metadata := p_settings_patch->'metadata';
        v_any_change := true;
    END IF;

    -- -- 7. Persist hospitals (no trigger-side version; hospitals is
    --        identity/configuration, audit covers it). ----------------
    IF v_any_change THEN
        BEGIN
            UPDATE public.hospitals
               SET name                     = v_hosp.name,
                   name_te                  = v_hosp.name_te,
                   phone                    = v_hosp.phone,
                   email                    = v_hosp.email,
                   country                  = v_hosp.country,
                   state                    = v_hosp.state,
                   district                 = v_hosp.district,
                   town                     = v_hosp.town,
                   address                  = v_hosp.address,
                   timezone                 = v_hosp.timezone,
                   online_booking_enabled   = v_hosp.online_booking_enabled,
                   max_advance_booking_days = v_hosp.max_advance_booking_days
             WHERE id = p_hospital_id;

            UPDATE public.hospital_settings
               SET display_name               = v_set.display_name,
                   logo_url                   = v_set.logo_url,
                   platform_fee_online        = v_set.platform_fee_online,
                   platform_fee_whatsapp      = v_set.platform_fee_whatsapp,
                   receptionist_fee           = v_set.receptionist_fee,
                   booking_fee_amount         = v_set.booking_fee_amount,
                   online_booking_fee_enabled = v_set.online_booking_fee_enabled,
                   default_consultation_fee_inr = v_set.default_consultation_fee_inr,
                   gst_enabled                = v_set.gst_enabled,
                   gst_percentage             = v_set.gst_percentage,
                   gst_registration_number    = v_set.gst_registration_number,
                   max_tokens_per_day         = v_set.max_tokens_per_day,
                   allow_walkin_tokens        = v_set.allow_walkin_tokens,
                   allow_online_booking       = v_set.allow_online_booking,
                   allow_carry_forward        = v_set.allow_carry_forward,
                   queue_display_enabled      = v_set.queue_display_enabled,
                   send_whatsapp_confirmation = v_set.send_whatsapp_confirmation,
                   send_whatsapp_reminder     = v_set.send_whatsapp_reminder,
                   send_feedback_request      = v_set.send_feedback_request,
                   reminder_before_minutes    = v_set.reminder_before_minutes,
                   preferred_language         = v_set.preferred_language,
                   timezone                   = v_set.timezone,
                   metadata                   = v_set.metadata,
                   updated_by                 = p_actor_user_id
             WHERE hospital_id = p_hospital_id;
            -- The existing AFTER-UPDATE trigger
            -- trg_hospital_settings_version (migration 18) inserts the
            -- config_versions row here. We do NOT insert a version
            -- manually; that would duplicate the versioning primitive.
        EXCEPTION
            WHEN check_violation THEN
                RAISE EXCEPTION 'configuration value rejected by a database constraint'
                    USING ERRCODE = '22023';
            WHEN not_null_violation THEN
                RAISE EXCEPTION 'a required configuration value is missing'
                    USING ERRCODE = '22023';
            WHEN numeric_value_out_of_range THEN
                RAISE EXCEPTION 'configuration numeric value out of range'
                    USING ERRCODE = '22023';
            WHEN invalid_text_representation THEN
                RAISE EXCEPTION 'configuration value has the wrong shape'
                    USING ERRCODE = '22023';
        END;
    END IF;

    -- -- 8. Feature-flag hospital overrides (existing table + versioning
    --        trigger). Array of { flag_key, is_enabled }. -----------------
    IF p_feature_overrides IS NOT NULL THEN
        IF jsonb_typeof(p_feature_overrides) <> 'array' THEN
            RAISE EXCEPTION 'feature overrides must be a JSON array'
                USING ERRCODE = '22023';
        END IF;

        FOR v_override IN SELECT * FROM jsonb_array_elements(p_feature_overrides)
        LOOP
            IF jsonb_typeof(v_override) <> 'object'
               OR NOT (v_override ? 'flag_key')
               OR NOT (v_override ? 'is_enabled') THEN
                RAISE EXCEPTION 'each feature override needs flag_key and is_enabled'
                    USING ERRCODE = '22023';
            END IF;

            v_flag_key     := btrim(coalesce(v_override->>'flag_key', ''));
            v_flag_enabled := (v_override->>'is_enabled')::BOOLEAN;

            IF v_flag_key = '' OR char_length(v_flag_key) > 128 THEN
                RAISE EXCEPTION 'flag_key must be 1..128 characters'
                    USING ERRCODE = '22023';
            END IF;

            INSERT INTO public.feature_flags (
                hospital_id, flag_key, is_enabled, updated_by, updated_at
            )
            VALUES (
                p_hospital_id, v_flag_key, v_flag_enabled, p_actor_user_id, now()
            )
            ON CONFLICT (hospital_id, flag_key) WHERE hospital_id IS NOT NULL
            DO UPDATE
               SET is_enabled  = EXCLUDED.is_enabled,
                   updated_by  = EXCLUDED.updated_by,
                   updated_at  = EXCLUDED.updated_at;
        END LOOP;
    END IF;

    -- -- 9. Compute the new version for the caller (existing trigger
    --        wrote the row; we re-read to stay honest). -----------------
    IF v_any_change THEN
        SELECT COALESCE(MAX(version_number), 0)
          INTO v_new_ver
          FROM public.config_versions
         WHERE config_table = 'hospital_settings'
           AND hospital_id  = p_hospital_id
           AND config_key   = 'settings';
    ELSE
        v_new_ver := v_current_ver;
    END IF;

    RETURN jsonb_build_object(
        'ok',          true,
        'reason',      CASE WHEN v_any_change THEN 'updated' ELSE 'noop' END,
        'hospital_id', p_hospital_id,
        'version',     v_new_ver
    );
END;
$$;

ALTER FUNCTION public.update_hospital_configuration(UUID, UUID, INTEGER, JSONB, JSONB, JSONB)
    SET row_security = off;

-- F16-04: a NEW SECURITY DEFINER function needs its OWN explicit REVOKE.
REVOKE ALL ON FUNCTION public.update_hospital_configuration(UUID, UUID, INTEGER, JSONB, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_hospital_configuration(UUID, UUID, INTEGER, JSONB, JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.update_hospital_configuration(UUID, UUID, INTEGER, JSONB, JSONB, JSONB) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.update_hospital_configuration(UUID, UUID, INTEGER, JSONB, JSONB, JSONB) TO service_role;

COMMENT ON FUNCTION public.update_hospital_configuration(UUID, UUID, INTEGER, JSONB, JSONB, JSONB) IS
'WS-ONBOARD-2: canonical atomic hospital configuration write. service_role-only '
'(Edge Function is the sole caller). Re-checks actor is global_admin OR '
'hospital_admin of the tenant, locks the hospitals + hospital_settings rows '
'FOR UPDATE, applies an optimistic expected_version check (SQLSTATE P0001 on '
'mismatch), rejects system-managed fields, and lets the EXISTING '
'trg_hospital_settings_version trigger record the version row. Also upserts '
'tenant-scoped feature_flags overrides.';

-- =============================================================
-- AUDIT ACTION TYPE REGISTRATION
-- The TS AuditActionType union (supabase/functions/_shared/audit.ts) has
-- declared these two action types for a long time; DB registration was
-- missing, so severity defaulted to 'low' rather than a real policy.
-- Registering them here lets logAuditEvent resolve the correct default
-- severity, and satisfies WS-ONBOARD-2 spec sec 11.
-- =============================================================

INSERT INTO public.audit_action_types (
    action_type,
    display_name,
    default_severity,
    category,
    description
)
VALUES
(
    'hospital_setting_update',
    'Hospital Setting Update',
    'high',
    'system',
    'A hospital operational / configuration change (WS-ONBOARD-2)'
),
(
    'feature_flag_update',
    'Feature Flag Update',
    'medium',
    'system',
    'A tenant-scoped feature-flag override change (WS-ONBOARD-2)'
)
ON CONFLICT (action_type) DO NOTHING;
