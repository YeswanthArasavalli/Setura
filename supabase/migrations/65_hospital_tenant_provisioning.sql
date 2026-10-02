-- =============================================================
-- 65_hospital_tenant_provisioning.sql
--
-- WS-ONBOARD-1 - Hospital Tenant Provisioning.
--
-- Product gap (SETURA_COMPLETE_SOFTWARE_STATE_REPORT.md sec 6.1, sec 20, sec 21):
-- a new hospital tenant could previously be created ONLY by editing the
-- migration-01 seed or running raw SQL. There was no RPC and therefore no
-- way for a global_admin to provision a tenant from the SETURA UI.
--
-- This migration adds the single canonical, atomic provisioning path:
--
--   provision_hospital(...)  -- SECURITY DEFINER RPC
--     -> verifies the actor genuinely holds global_admin (DB-layer check)
--     -> validates the required identity fields
--     -> inserts ONE hospitals row
--     -> the EXISTING trg_auto_hospital_settings AFTER-INSERT trigger
--        (migration 12) creates the hospital_settings defaults
--     -> returns the new tenant identity as JSONB
--
-- Scope (WS-ONBOARD-1 ONLY). Deliberately NOT touched here:
--   * No auth users, doctors, patients or staff are created - seeding fake
--     identities is explicitly out of scope; the onboarding UI lists "add
--     doctors and staff" as a NEXT step.
--   * No per-hospital feature_flags rows: migration 37 resolves flags via a
--     LEFT JOIN of global defaults, so a new hospital inherits them.
--   * No Razorpay / Meta credential provisioning (WS-ONBOARD-3).
--   * No hospital_settings editor (WS-ONBOARD-2) - the defaults created by
--     the existing trigger are sufficient for a working tenant.
--
-- Security posture (AGENTS.md sec 7, F16-04 standing rule):
--   * A NEW SECURITY DEFINER function gets its OWN explicit REVOKE. It is
--     locked to service_role; PUBLIC / anon / authenticated have NO EXECUTE.
--     The Edge Function is the ONLY caller (via getServiceClient), and it
--     authoritatively resolves the actor from the JWT before invoking this.
--   * search_path pinned to public; row_security off so the definer body can
--     read user_roles (RLS) and write hospitals (FORCE RLS) as owner.
--   * DB-layer authorization is defense-in-depth: even though the Edge layer
--     already requireRole(['global_admin']), the RPC independently refuses
--     any actor id that does not actually hold global_admin, raising the
--     PostgreSQL insufficient_privilege SQLSTATE 42501. Client-supplied
--     hospital identity is never trusted; tenancy is created, not read.
--
-- Concurrency / duplicate protection:
--   * hospitals.slug is UNIQUE. A pre-check gives a clean 409-style signal and
--     an EXCEPTION handler on unique_violation closes the check-insert race so
--     two concurrent provisions of the same slug can never both succeed.
--   * Request replay (same Idempotency-Key) is handled by the EXISTING
--     api_idempotency_keys registry at the Edge layer (migration 25); this RPC
--     intentionally treats a *distinct* request reusing an existing slug as a
--     duplicate collision (409), not a silent success - duplicate identity and
--     idempotent replay are separate categories by design.
-- =============================================================

CREATE OR REPLACE FUNCTION public.provision_hospital(
    p_actor_user_id UUID,
    p_name TEXT,
    p_slug TEXT,
    p_phone TEXT DEFAULT NULL,
    p_email TEXT DEFAULT NULL,
    p_country TEXT DEFAULT NULL,
    p_state TEXT DEFAULT NULL,
    p_district TEXT DEFAULT NULL,
    p_town TEXT DEFAULT NULL,
    p_address TEXT DEFAULT NULL,
    p_timezone TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name TEXT;
    v_slug TEXT;
    v_id UUID;
BEGIN

    -- -- 1. DB-layer authorization (defense-in-depth) --------------
    -- auth.uid() is NULL under the service_role JWT that reaches this RPC,
    -- so the actor identity is passed explicitly by the (JWT-authoritative)
    -- Edge layer and re-verified here against user_roles. Not a global_admin
    -- (or a NULL actor) is insufficient_privilege.
    IF p_actor_user_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.user_roles
        WHERE user_id = p_actor_user_id
          AND role = 'global_admin'
    ) THEN
        RAISE EXCEPTION 'actor is not a global_admin'
            USING ERRCODE = '42501';
    END IF;

    -- -- 2. Validate + normalize the required identity fields ------
    v_name := btrim(coalesce(p_name, ''));
    v_slug := lower(btrim(coalesce(p_slug, '')));

    IF v_name = '' THEN
        RAISE EXCEPTION 'hospital name is required'
            USING ERRCODE = '22023';
    END IF;

    IF v_slug = '' THEN
        RAISE EXCEPTION 'hospital slug is required'
            USING ERRCODE = '22023';
    END IF;

    -- slug must be a URL-safe token: lowercase alphanumerics with hyphens.
    IF v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' THEN
        RAISE EXCEPTION 'hospital slug must be lowercase alphanumeric with hyphens'
            USING ERRCODE = '22023';
    END IF;

    -- -- 3. Duplicate-identity pre-check (clean collision signal) --
    IF EXISTS (
        SELECT 1 FROM public.hospitals WHERE slug = v_slug
    ) THEN
        RAISE EXCEPTION 'a hospital with this slug already exists'
            USING ERRCODE = '23505';
    END IF;

    -- -- 4. Atomic tenant creation ---------------------------------
    -- Single INSERT; the AFTER-INSERT trigger creates hospital_settings
    -- defaults in the SAME transaction, so a tenant is never half-created.
    -- NOT NULL columns with table defaults fall back to those defaults when
    -- the caller supplies NULL (NULLIF guards empty strings too).
    BEGIN
        INSERT INTO public.hospitals (
            name,
            slug,
            phone,
            email,
            country,
            state,
            district,
            town,
            address,
            timezone,
            created_by
        )
        VALUES (
            v_name,
            v_slug,
            nullif(btrim(coalesce(p_phone, '')), ''),
            nullif(btrim(coalesce(p_email, '')), ''),
            coalesce(nullif(btrim(coalesce(p_country, '')), ''), 'India'),
            coalesce(nullif(btrim(coalesce(p_state, '')), ''), 'Andhra Pradesh'),
            nullif(btrim(coalesce(p_district, '')), ''),
            coalesce(nullif(btrim(coalesce(p_town, '')), ''), 'Narsapur'),
            nullif(btrim(coalesce(p_address, '')), ''),
            coalesce(nullif(btrim(coalesce(p_timezone, '')), ''), 'Asia/Kolkata'),
            p_actor_user_id
        )
        RETURNING id INTO v_id;
    EXCEPTION
        WHEN unique_violation THEN
            -- Closes the check-insert race for concurrent same-slug calls.
            RAISE EXCEPTION 'a hospital with this slug already exists'
                USING ERRCODE = '23505';
    END;

    RETURN jsonb_build_object(
        'ok', true,
        'reason', 'created',
        'hospital_id', v_id,
        'name', v_name,
        'slug', v_slug
    );

END;
$$;

ALTER FUNCTION public.provision_hospital(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
)
SET row_security = off;

-- -- F16-04: a NEW SECURITY DEFINER function needs its OWN explicit REVOKE --
REVOKE ALL ON FUNCTION public.provision_hospital(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.provision_hospital(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM anon;
REVOKE ALL ON FUNCTION public.provision_hospital(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.provision_hospital(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.provision_hospital(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) IS
'WS-ONBOARD-1: canonical atomic hospital tenant provisioning. service_role-only '
'(Edge Function is the sole caller). Re-verifies actor global_admin at the DB, '
'validates name/slug, inserts hospitals (existing trigger creates settings), '
'refuses duplicate slug (23505) and non-admin actors (42501). No fake identities.';

-- -- Register the audit action type for the provisioning event ----
INSERT INTO public.audit_action_types (
    action_type,
    display_name,
    default_severity,
    category,
    description
)
VALUES
(
    'hospital_provision',
    'Hospital Provision',
    'high',
    'system',
    'A new hospital tenant was provisioned by a global_admin (WS-ONBOARD-1)'
)
ON CONFLICT (action_type) DO NOTHING;
