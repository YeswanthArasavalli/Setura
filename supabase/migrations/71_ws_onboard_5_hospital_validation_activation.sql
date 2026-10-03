-- =============================================================
-- 71_ws_onboard_5_hospital_validation_activation.sql
--
-- WS-ONBOARD-5 - Hospital Configuration Validation & Activation.
--
-- Product gap (established by inspecting the CURRENT source, not a stale
-- report): the SETURA onboarding flow ends with two steps that were never
-- built. WS-ONBOARD-1 provisions a tenant (migration 65), WS-ONBOARD-2/3/4
-- configure settings / integrations / clinical data, but there is no surface
-- that (a) validates whether a hospital's configuration is complete enough to
-- go live, or (b) lets a global_admin explicitly activate it. Source facts:
--   * provision_hospital (65) does NOT set hospitals.is_active; every tenant is
--     therefore born with the column default is_active = true.
--   * hospitals.is_active is system-managed and is rejected by the
--     WS-ONBOARD-2 configuration patch allowlist (migration 66), and no other
--     surface ever flips it. Its ONLY real consumer is the operational
--     active_hospitals count (migration 47). It is NOT a booking gate - booking
--     availability is governed by doctor_schedules + feature flags + the
--     availability engine.
--   * There is no "activated" concept at all: hospitals has no activation
--     timestamp, so the operator cannot record that the go-live review happened.
--
-- This migration closes the loop ADDITIVELY and WITHOUT inventing policy:
--   1. hospitals.activated_at (nullable TIMESTAMPTZ) - records the explicit
--      activation. NULL means "never activated". Existing rows stay NULL, so
--      nothing about current behavior changes for already-seeded tenants.
--   2. validate_hospital_configuration(...) - a READ-only, service_role-only
--      SECURITY DEFINER function that returns a completeness checklist derived
--      DIRECTLY from the owner-stated configure sequence (a hospital is
--      considered activation-ready only once it has at least one active
--      department, one active doctor and one active schedule). It reports every
--      check plus an overall "ready" flag. It changes no data.
--   3. set_hospital_activation(...) - the canonical activation / de-activation
--      write. service_role-only. Re-verifies the actor is a global_admin at the
--      DB (42501). Activation REFUSES (22023) unless the validation invariant
--      passes; de-activation is unrestricted (suspending operations never needs
--      a readiness check). It flips ONLY hospitals.is_active (the pre-existing
--      operational flag) and stamps activated_at, so it adds no new runtime
--      business gate and cannot affect booking behavior.
--
-- Deliberately OUT of scope (would be an invented product decision, not a
-- stated requirement):
--   * Gating the booking / availability engine on hospitals.is_active. Nothing
--     in the runtime does that today and doing so would be a new product rule.
--   * Treating live Razorpay / Meta credentials as a blocking readiness check -
--     real credentials arrive later at pilot time, so integration presence is
--     reported INFORMATIONALLY and never blocks activation.
--
-- Security posture (AGENTS.md sec 7, F16-04 standing rule):
--   * Both NEW SECURITY DEFINER functions carry their OWN explicit REVOKE from
--     PUBLIC / anon / authenticated and GRANT EXECUTE to service_role. They are
--     reachable only through the hospital-activation Edge Function, which is the
--     sole caller via getServiceClient().
--   * search_path pinned to public; row_security off so the definer body can
--     read user_roles / departments / doctor_schedules (RLS) and write hospitals
--     (FORCE RLS) as the owner. Same pattern proven by migrations 65 / 66.
--   * Authorization is defense-in-depth: auth.uid() is NULL under the
--     service_role JWT, so the JWT-resolved actor id is passed explicitly and
--     re-verified against user_roles inside each RPC (raises 42501). A
--     client-supplied target hospital id is never trusted for WHO acts; the
--     actor's own global_admin membership is the authority, and the RPC simply
--     operates on the targeted tenant row.
--   * No secret or credential value is read, written or returned here.
--
-- Concurrency:
--   * set_hospital_activation locks the target hospitals row FOR UPDATE before
--     reading + writing it, so two concurrent activations cannot interleave with
--     a validation read.
--   * Request replay (same Idempotency-Key) is handled by the EXISTING
--     api_idempotency_keys registry at the Edge layer (migration 25). Flipping
--     is_active is additionally naturally idempotent: activating an already
--     active hospital is a no-op success ("already_active"), never an error.
--   * validate_hospital_configuration is read-only and takes no lock beyond a
--     plain snapshot; it requires no Idempotency-Key.
-- =============================================================

-- -- 1. hospitals.activated_at: the explicit go-live marker ------------------
ALTER TABLE public.hospitals
    ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;

COMMENT ON COLUMN public.hospitals.activated_at IS
'WS-ONBOARD-5: set once when a global_admin explicitly activates the tenant '
'after the configuration-validation invariant passes. NULL = never activated. '
'Additive; provisioned tenants keep the WS-ONBOARD-1 default behavior.';

-- -- 2. validate_hospital_configuration (READ-only readiness checklist) ------
CREATE OR REPLACE FUNCTION public.validate_hospital_configuration(
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
    v_settings_present  BOOLEAN := false;
    v_department_count  INTEGER := 0;
    v_doctor_count      INTEGER := 0;
    v_schedule_count    INTEGER := 0;
    v_has_department    BOOLEAN;
    v_has_doctor        BOOLEAN;
    v_has_schedule      BOOLEAN;
    v_ready             BOOLEAN;
BEGIN

    -- -- DB-layer authorization (defense-in-depth): actor must be global_admin
    IF p_actor_user_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.user_roles
        WHERE user_id = p_actor_user_id
          AND role = 'global_admin'
    ) THEN
        RAISE EXCEPTION 'actor is not a global_admin'
            USING ERRCODE = '42501';
    END IF;

    IF p_hospital_id IS NULL THEN
        RAISE EXCEPTION 'hospital id is required'
            USING ERRCODE = '22023';
    END IF;

    -- -- Target must be a live (not soft-deleted) tenant
    IF NOT EXISTS (
        SELECT 1
        FROM public.hospitals
        WHERE id = p_hospital_id
          AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'hospital not found'
            USING ERRCODE = '22023';
    END IF;

    -- -- Gather each derived completeness fact from the canonical tables
    SELECT EXISTS (
        SELECT 1 FROM public.hospital_settings WHERE hospital_id = p_hospital_id
    ) INTO v_settings_present;

    SELECT count(*) INTO v_department_count
    FROM public.departments
    WHERE hospital_id = p_hospital_id
      AND is_active = true
      AND is_deleted = false;

    SELECT count(*) INTO v_doctor_count
    FROM public.user_roles ur
    JOIN public.profiles p ON p.id = ur.user_id
    WHERE ur.hospital_id = p_hospital_id
      AND ur.role = 'doctor'
      AND p.is_active = true;

    SELECT count(*) INTO v_schedule_count
    FROM public.doctor_schedules
    WHERE hospital_id = p_hospital_id
      AND is_active = true
      AND is_deleted = false;

    v_has_department := v_department_count > 0;
    v_has_doctor     := v_doctor_count > 0;
    v_has_schedule   := v_schedule_count > 0;

    -- -- Ready is the AND of the three BLOCKING checks (settings and
    -- integration presence are informational and never gate activation).
    v_ready := v_has_department AND v_has_doctor AND v_has_schedule;

    RETURN jsonb_build_object(
        'ok', true,
        'hospital_id', p_hospital_id,
        'ready', v_ready,
        'checks', jsonb_build_array(
            jsonb_build_object(
                'key', 'settings_present',
                'label', 'Hospital settings row present',
                'passed', v_settings_present,
                'blocking', false,
                'detail', 'Auto-created by the tenant provisioning trigger'
            ),
            jsonb_build_object(
                'key', 'has_active_department',
                'label', 'At least one active department',
                'passed', v_has_department,
                'blocking', true,
                'detail', v_department_count::text || ' active department(s)'
            ),
            jsonb_build_object(
                'key', 'has_active_doctor',
                'label', 'At least one active doctor',
                'passed', v_has_doctor,
                'blocking', true,
                'detail', v_doctor_count::text || ' active doctor(s)'
            ),
            jsonb_build_object(
                'key', 'has_active_schedule',
                'label', 'At least one active doctor schedule',
                'passed', v_has_schedule,
                'blocking', true,
                'detail', v_schedule_count::text || ' active schedule(s)'
            )
        )
    );

END;
$$;

ALTER FUNCTION public.validate_hospital_configuration(UUID, UUID)
SET row_security = off;

-- -- F16-04: a NEW SECURITY DEFINER function needs its OWN explicit REVOKE --
REVOKE ALL ON FUNCTION public.validate_hospital_configuration(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_hospital_configuration(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.validate_hospital_configuration(UUID, UUID) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.validate_hospital_configuration(UUID, UUID) TO service_role;

COMMENT ON FUNCTION public.validate_hospital_configuration(UUID, UUID) IS
'WS-ONBOARD-5: read-only hospital configuration completeness checklist. '
'service_role-only (Edge Function is the sole caller). Re-verifies actor '
'global_admin (42501), then reports department/doctor/schedule/settings checks '
'and an overall ready flag derived from the onboarding configure sequence. '
'Changes no data.';

-- -- 3. set_hospital_activation (canonical activation / de-activation) -------
CREATE OR REPLACE FUNCTION public.set_hospital_activation(
    p_actor_user_id UUID,
    p_hospital_id UUID,
    p_activate BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hosp public.hospitals%ROWTYPE;
    v_validation JSONB;
    v_ready BOOLEAN;
    v_reason TEXT;
BEGIN

    -- -- DB-layer authorization (defense-in-depth): actor must be global_admin
    IF p_actor_user_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.user_roles
        WHERE user_id = p_actor_user_id
          AND role = 'global_admin'
    ) THEN
        RAISE EXCEPTION 'actor is not a global_admin'
            USING ERRCODE = '42501';
    END IF;

    IF p_hospital_id IS NULL THEN
        RAISE EXCEPTION 'hospital id is required'
            USING ERRCODE = '22023';
    END IF;

    IF p_activate IS NULL THEN
        RAISE EXCEPTION 'activation intent is required'
            USING ERRCODE = '22023';
    END IF;

    -- -- Lock the target row; refuse a missing / soft-deleted tenant
    SELECT * INTO v_hosp
    FROM public.hospitals
    WHERE id = p_hospital_id
      AND deleted_at IS NULL
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'hospital not found'
            USING ERRCODE = '22023';
    END IF;

    IF p_activate THEN
        -- -- Enforce the readiness invariant before going live
        v_validation := public.validate_hospital_configuration(
            p_actor_user_id, p_hospital_id
        );
        v_ready := (v_validation ->> 'ready')::boolean;

        IF v_ready IS NOT TRUE THEN
            RAISE EXCEPTION
                'hospital configuration is incomplete; resolve the blocking '
                'checks before activation'
                USING ERRCODE = '22023';
        END IF;

        IF v_hosp.is_active THEN
            -- -- Natural idempotency: already active, stamp only if needed
            IF v_hosp.activated_at IS NULL THEN
                UPDATE public.hospitals
                SET activated_at = now()
                WHERE id = p_hospital_id;
            END IF;
            v_reason := 'already_active';
        ELSE
            UPDATE public.hospitals
            SET is_active = true,
                activated_at = coalesce(v_hosp.activated_at, now())
            WHERE id = p_hospital_id;
            v_reason := 'activated';
        END IF;
    ELSE
        -- -- De-activation is unrestricted (suspending never needs readiness)
        UPDATE public.hospitals
        SET is_active = false
        WHERE id = p_hospital_id;
        v_reason := 'deactivated';
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'reason', v_reason,
        'hospital_id', p_hospital_id,
        'is_active', p_activate,
        'activated_at', (SELECT activated_at FROM public.hospitals WHERE id = p_hospital_id)
    );

END;
$$;

ALTER FUNCTION public.set_hospital_activation(UUID, UUID, BOOLEAN)
SET row_security = off;

-- -- F16-04: a NEW SECURITY DEFINER function needs its OWN explicit REVOKE --
REVOKE ALL ON FUNCTION public.set_hospital_activation(UUID, UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_hospital_activation(UUID, UUID, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.set_hospital_activation(UUID, UUID, BOOLEAN) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.set_hospital_activation(UUID, UUID, BOOLEAN) TO service_role;

COMMENT ON FUNCTION public.set_hospital_activation(UUID, UUID, BOOLEAN) IS
'WS-ONBOARD-5: canonical hospital activation / de-activation. service_role-only '
'(Edge Function is the sole caller). Re-verifies actor global_admin (42501). '
'Activation REFUSES (22023) unless the validation invariant passes; sets '
'is_active + activated_at. De-activation flips is_active false. Row locked '
'FOR UPDATE. Only touches the pre-existing operational is_active flag.';

-- -- Register the audit action type for the activation event -----------------
INSERT INTO public.audit_action_types (
    action_type,
    display_name,
    default_severity,
    category,
    description
)
VALUES
(
    'hospital_activation',
    'Hospital Activation',
    'high',
    'system',
    'A hospital tenant was activated or de-activated by a global_admin after '
    'the configuration-validation gate (WS-ONBOARD-5)'
)
ON CONFLICT (action_type) DO NOTHING;
