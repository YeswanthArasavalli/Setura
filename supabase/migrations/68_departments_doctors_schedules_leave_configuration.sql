-- =============================================================
-- 68_departments_doctors_schedules_leave_configuration.sql
--
-- WS-ONBOARD-4 - Doctor, Department, Schedule & Leave Configuration.
--
-- Product gap established by inspecting the real repository:
--   * Departments did not exist AT ALL. `CREATE TABLE ... departments` has
--     zero matches across migrations 01-67; the only area-of-practice carrier
--     was doctor_specializations (migration 03), which is per-doctor and is NOT
--     a hospital department entity.
--   * Doctors exist as profiles rows holding a user_roles 'doctor' row scoped
--     to a hospital (migration 01). That model is REUSED, not duplicated.
--   * Schedules (doctor_schedules) and leaves (doctor_leaves, enhanced by
--     migration 31) already exist AND are already consumed by the live
--     availability engine: is_doctor_available() (03, enhanced in place by 31)
--     reads doctor_schedules.is_active/weekday and doctor_leaves rows with
--     leave_status = 'approved'; create-booking, reschedule-booking and the
--     WhatsApp booking flow all call it. get_remaining_token_capacity
--     (migration 55) sums doctor_schedules.max_tokens.
--     => The genuine gap was NEVER the storage. It was that there was no write
--        path: `FUNCTION public.*` has ZERO matches creating or updating a
--        schedule, a leave, a specialization, or a doctor identity. All five
--        were reachable only by raw SQL.
--
-- This migration adds ONLY the missing primitives:
--   1. departments            - the missing hospital department entity
--   2. doctor_departments     - the missing doctor <-> department join
--   3. Nine service_role-only SECURITY DEFINER RPCs for the write surface
--   4. Tenant-scoped SELECT policies so the browser can READ under the
--      existing RLS pattern (reads need no new RPC - apps/web/src/api/reads.ts
--      already reads RLS-scoped tables directly from the browser)
--   5. audit_action_types registration for the new actions
--
-- Deliberately OUT of scope, and deliberately NOT surfaced as a UI control,
-- because nothing in the runtime consumes them (an admin control that stored
-- unused rows would be a fake capability):
--   * doctor_schedule_blocks (breaks / partial-time blocks) - zero consumers
--   * doctor_schedules.is_walkin_allowed and buffer_minutes - schema + seed
--     only, zero consumers
--   * doctor_leaves.auto_cancel_bookings - zero consumers
--   * doctor_availability_overrides - consumed by is_doctor_available but is a
--     per-date override concern, not the recurring schedule/leave model this
--     workstream configures
--   * doctor_specializations.consultation_fee is stored and displayed but is
--     INFORMATIONAL ONLY by the explicit domain comment in migrations 28/35;
--     the collected fee comes from booking_fee_policies / hospital_settings.
--     The UI therefore labels it as informational and does not claim it is a
--     price.
--
-- Security posture (AGENTS.md sec 7, F16-04 standing rule):
--   * Every NEW SECURITY DEFINER function carries its OWN explicit REVOKE from
--     PUBLIC / anon / authenticated and GRANT to service_role. Migration 48
--     section 2 revoked default privileges per grantor role, so a brand-new
--     function is NOT protected by any earlier migration's posture.
--   * search_path pinned to public; row_security off so the definer body can
--     write FORCE-RLS tables as the owner (the pattern proven by 65/66).
--   * DB-layer authorization is defense-in-depth. auth.uid() is NULL under the
--     service_role JWT, so the Edge layer passes the JWT-resolved actor id and
--     the RPC re-verifies it against user_roles, raising 42501. A client-
--     supplied hospital id is never trusted: every RPC re-checks that the
--     target entity actually belongs to the actor's hospital.
--   * The new TABLES also need their own explicit GRANT: migration 48 revoked
--     ALL ON TABLES from anon/authenticated by default privilege, so without
--     `GRANT SELECT ... TO authenticated` the browser RLS reads would fail at
--     the privilege layer before the policy was ever evaluated.
--
-- Concurrency / conflict contract (reuses migration 66, no new contract):
--   * departments.version is the optimistic-concurrency token; an
--     expected-version mismatch raises P0001, NOT 40001. Migration 66 records
--     why: PostgREST treats class-40 as retryable and re-issues the
--     transaction, turning a benign conflict into a client-visible timeout.
--   * The pre-existing tables (doctor_schedules / doctor_leaves / profiles)
--     carry no version column and are not given one - that would mutate a
--     closed engine's schema for a configuration nicety. They are protected by
--     SELECT ... FOR UPDATE, the Edge idempotency registry, and their own
--     EXCLUDE constraints.
--   * EXCLUDE violations surface as 23P01 (exclusion_violation). Each RPC
--     pre-checks overlap so the caller gets a deterministic message, and the
--     constraint stays as the atomic backstop against a check-insert race.
--     NOTE the exact constraint semantics being honoured:
--       no_overlapping_doctor_schedules - (doctor, hospital, weekday) with
--         is_deleted = false, IGNORING is_active; so an inactive schedule still
--         owns its time range.
--       no_overlapping_doctor_leaves - (doctor, daterange) with
--         is_deleted = false, IGNORING leave_status and IGNORING hospital; so
--         cancelling a leave must also set is_deleted = true or the date range
--         would stay reserved forever.
-- =============================================================

-- =============================================================
-- 1. DEPARTMENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    name TEXT NOT NULL,
    code TEXT NOT NULL,

    description TEXT,

    is_active BOOLEAN NOT NULL DEFAULT true,

    is_deleted BOOLEAN NOT NULL DEFAULT false,

    -- Optimistic-concurrency token for the configuration UI.
    version INTEGER NOT NULL DEFAULT 1,

    created_by UUID REFERENCES public.profiles(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_department_name
        CHECK (btrim(name) <> ''),

    CONSTRAINT valid_department_code
        CHECK (btrim(code) <> '')
);

-- Duplicate identifiers are prevented per hospital, on live rows only.
CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_hospital_code
ON public.departments (hospital_id, lower(btrim(code)))
WHERE is_deleted = false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_departments_hospital_name
ON public.departments (hospital_id, lower(btrim(name)))
WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_departments_hospital
ON public.departments (hospital_id)
WHERE is_deleted = false;

DROP TRIGGER IF EXISTS trg_departments_updated_at
ON public.departments;

CREATE TRIGGER trg_departments_updated_at
BEFORE UPDATE ON public.departments
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_departments_hospital_immutable
ON public.departments;

CREATE TRIGGER trg_departments_hospital_immutable
BEFORE UPDATE ON public.departments
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- 2. DOCTOR <-> DEPARTMENT ASSIGNMENT
-- =============================================================

CREATE TABLE IF NOT EXISTS public.doctor_departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    doctor_id UUID NOT NULL
        REFERENCES public.profiles(id)
        ON DELETE CASCADE,

    department_id UUID NOT NULL
        REFERENCES public.departments(id)
        ON DELETE CASCADE,

    assigned_by UUID REFERENCES public.profiles(id),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_doctor_department
        UNIQUE (hospital_id, doctor_id, department_id)
);

CREATE INDEX IF NOT EXISTS idx_doctor_departments_doctor
ON public.doctor_departments (doctor_id);

CREATE INDEX IF NOT EXISTS idx_doctor_departments_department
ON public.doctor_departments (department_id);

DROP TRIGGER IF EXISTS trg_doctor_departments_hospital_immutable
ON public.doctor_departments;

CREATE TRIGGER trg_doctor_departments_hospital_immutable
BEFORE UPDATE ON public.doctor_departments
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- 3. ROW LEVEL SECURITY - READ-ONLY POLICIES
--
-- There is deliberately NO INSERT/UPDATE/DELETE policy on either table. All
-- privileged writes go through the service_role-only RPCs below. A browser
-- mutation attempt is refused by the absence of a policy, independently of the
-- Edge layer's checks.
-- =============================================================

ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.departments FORCE ROW LEVEL SECURITY;

ALTER TABLE public.doctor_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctor_departments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS departments_read ON public.departments;

CREATE POLICY departments_read ON public.departments
    FOR SELECT
    TO authenticated
    USING (
        public.is_global_admin()
        OR public.user_has_hospital_access(hospital_id)
    );

DROP POLICY IF EXISTS doctor_departments_read ON public.doctor_departments;

CREATE POLICY doctor_departments_read ON public.doctor_departments
    FOR SELECT
    TO authenticated
    USING (
        public.is_global_admin()
        OR public.user_has_hospital_access(hospital_id)
    );

-- Migration 48 revoked default TABLE privileges from anon/authenticated, so a
-- new table is invisible to the browser until it is granted explicitly. SELECT
-- only - and no anon grant (this is tenant-scoped operational data).
GRANT SELECT ON public.departments TO authenticated;
GRANT SELECT ON public.doctor_departments TO authenticated;

-- =============================================================
-- 4. DEPARTMENT WRITE RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_department(
    p_actor_user_id UUID,
    p_hospital_id UUID,
    p_name TEXT,
    p_code TEXT,
    p_description TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name TEXT;
    v_code TEXT;
    v_id UUID;
BEGIN

    -- -- 1. DB-layer authorization (defense-in-depth) --------------
    IF p_actor_user_id IS NULL OR NOT EXISTS (
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

    -- -- 2. Validate + normalize ----------------------------------
    v_name := btrim(coalesce(p_name, ''));
    v_code := btrim(coalesce(p_code, ''));

    IF v_name = '' THEN
        RAISE EXCEPTION 'department name is required'
            USING ERRCODE = '22023';
    END IF;

    IF v_code = '' THEN
        RAISE EXCEPTION 'department code is required'
            USING ERRCODE = '22023';
    END IF;

    -- -- 3. Duplicate-identifier pre-check (clean 409 signal) ------
    IF EXISTS (
        SELECT 1 FROM public.departments
        WHERE hospital_id = p_hospital_id
          AND is_deleted = false
          AND (
              lower(btrim(code)) = lower(v_code)
              OR lower(btrim(name)) = lower(v_name)
          )
    ) THEN
        RAISE EXCEPTION 'a department with this code or name already exists'
            USING ERRCODE = '23505';
    END IF;

    -- -- 4. Insert -------------------------------------------------
    BEGIN
        INSERT INTO public.departments (
            hospital_id, name, code, description, created_by
        )
        VALUES (
            p_hospital_id, v_name, v_code,
            NULLIF(btrim(coalesce(p_description, '')), ''), p_actor_user_id
        )
        RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
        -- Closes the check-insert race for two concurrent creations.
        RAISE EXCEPTION 'a department with this code or name already exists'
            USING ERRCODE = '23505';
    END;

    RETURN jsonb_build_object(
        'ok', true,
        'department_id', v_id,
        'hospital_id', p_hospital_id,
        'name', v_name,
        'code', v_code,
        'is_active', true,
        'version', 1
    );
END;
$$;

ALTER FUNCTION public.create_department(UUID, UUID, TEXT, TEXT, TEXT)
    SET row_security = off;

REVOKE ALL ON FUNCTION public.create_department(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_department(UUID, UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.create_department(UUID, UUID, TEXT, TEXT, TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.create_department(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.create_department(UUID, UUID, TEXT, TEXT, TEXT) IS
'WS-ONBOARD-4: creates one department for one hospital. service_role-only. '
'Re-checks actor role+tenant (42501), validates identity fields (22023), '
'refuses a duplicate per-hospital code or name (23505).';

-- -------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_department(
    p_actor_user_id UUID,
    p_hospital_id UUID,
    p_department_id UUID,
    p_expected_version INTEGER,
    p_name TEXT DEFAULT NULL,
    p_code TEXT DEFAULT NULL,
    p_description TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.departments%ROWTYPE;
    v_name TEXT;
    v_code TEXT;
BEGIN

    IF p_actor_user_id IS NULL OR NOT EXISTS (
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

    -- Lock the target row, then re-assert tenancy from the LOCKED row rather
    -- than from the caller-supplied hospital id.
    SELECT * INTO v_row
    FROM public.departments
    WHERE id = p_department_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'department not found'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_row.hospital_id <> p_hospital_id THEN
        RAISE EXCEPTION 'department does not belong to this hospital'
            USING ERRCODE = '42501';
    END IF;

    IF v_row.is_deleted THEN
        RAISE EXCEPTION 'department is deleted'
            USING ERRCODE = '22023';
    END IF;

    -- Optimistic concurrency (migration 66 contract: P0001, never 40001).
    IF p_expected_version IS NULL OR p_expected_version <> v_row.version THEN
        RAISE EXCEPTION 'expected version mismatch'
            USING ERRCODE = 'P0001';
    END IF;

    v_name := btrim(coalesce(p_name, v_row.name));
    v_code := btrim(coalesce(p_code, v_row.code));

    IF v_name = '' OR v_code = '' THEN
        RAISE EXCEPTION 'department name and code cannot be empty'
            USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.departments
        WHERE hospital_id = p_hospital_id
          AND is_deleted = false
          AND id <> p_department_id
          AND (
              lower(btrim(code)) = lower(v_code)
              OR lower(btrim(name)) = lower(v_name)
          )
    ) THEN
        RAISE EXCEPTION 'another department already uses this code or name'
            USING ERRCODE = '23505';
    END IF;

    UPDATE public.departments
       SET name        = v_name,
           code        = v_code,
           description = CASE
               WHEN p_description IS NULL THEN description
               ELSE NULLIF(btrim(p_description), '')
           END,
           version     = version + 1
     WHERE id = p_department_id;

    RETURN jsonb_build_object(
        'ok', true,
        'department_id', p_department_id,
        'name', v_name,
        'code', v_code,
        'version', v_row.version + 1
    );
END;
$$;

ALTER FUNCTION public.update_department(UUID, UUID, UUID, INTEGER, TEXT, TEXT, TEXT)
    SET row_security = off;

REVOKE ALL ON FUNCTION public.update_department(UUID, UUID, UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_department(UUID, UUID, UUID, INTEGER, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.update_department(UUID, UUID, UUID, INTEGER, TEXT, TEXT, TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.update_department(UUID, UUID, UUID, INTEGER, TEXT, TEXT, TEXT) TO service_role;

COMMENT ON FUNCTION public.update_department(UUID, UUID, UUID, INTEGER, TEXT, TEXT, TEXT) IS
'WS-ONBOARD-4: patches a department under optimistic concurrency. '
'service_role-only. expected-version mismatch raises P0001 (HTTP 409), not '
'40001, so PostgREST never retries a benign conflict.';

-- -------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_department_status(
    p_actor_user_id UUID,
    p_hospital_id UUID,
    p_department_id UUID,
    p_expected_version INTEGER,
    p_is_active BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.departments%ROWTYPE;
BEGIN

    IF p_actor_user_id IS NULL OR NOT EXISTS (
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

    IF p_is_active IS NULL THEN
        RAISE EXCEPTION 'is_active is required'
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_row
    FROM public.departments
    WHERE id = p_department_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'department not found'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_row.hospital_id <> p_hospital_id THEN
        RAISE EXCEPTION 'department does not belong to this hospital'
            USING ERRCODE = '42501';
    END IF;

    IF v_row.is_deleted THEN
        RAISE EXCEPTION 'department is deleted'
            USING ERRCODE = '22023';
    END IF;

    IF p_expected_version IS NULL OR p_expected_version <> v_row.version THEN
        RAISE EXCEPTION 'expected version mismatch'
            USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.departments
       SET is_active = p_is_active,
           version   = version + 1
     WHERE id = p_department_id;

    RETURN jsonb_build_object(
        'ok', true,
        'department_id', p_department_id,
        'is_active', p_is_active,
        'version', v_row.version + 1
    );
END;
$$;

ALTER FUNCTION public.set_department_status(UUID, UUID, UUID, INTEGER, BOOLEAN)
    SET row_security = off;

REVOKE ALL ON FUNCTION public.set_department_status(UUID, UUID, UUID, INTEGER, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_department_status(UUID, UUID, UUID, INTEGER, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.set_department_status(UUID, UUID, UUID, INTEGER, BOOLEAN) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.set_department_status(UUID, UUID, UUID, INTEGER, BOOLEAN) TO service_role;

COMMENT ON FUNCTION public.set_department_status(UUID, UUID, UUID, INTEGER, BOOLEAN) IS
'WS-ONBOARD-4: activates or deactivates a department. service_role-only. '
'Soft deactivation only - no department row is ever destroyed.';

-- =============================================================
-- 5. DOCTOR WRITE RPCs
--
-- A doctor is NOT a new entity. It is a profiles row plus a user_roles
-- 'doctor' row scoped to a hospital (migration 01). These RPCs write that
-- existing model; no parallel doctor table is introduced and no auth identity
-- is invented here - the auth user is created by the Edge layer through the
-- existing Supabase Auth admin API and only referenced by id here.
-- =============================================================

-- Shared input guard for the department-id JSON array. SECURITY INVOKER and
-- table-free: it reads nothing, so it needs no definer rights and no RLS
-- bypass. It is still locked to service_role for the same least-privilege
-- reason as the write RPCs - PostgREST must not expose any new routine.
CREATE OR REPLACE FUNCTION public.assert_department_id_array(p_department_ids JSONB)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SET search_path = public
AS $$
BEGIN
    IF p_department_ids IS NULL OR jsonb_typeof(p_department_ids) <> 'array' THEN
        RAISE EXCEPTION 'department_ids must be a JSON array'
            USING ERRCODE = '22023';
    END IF;

    -- Validate the textual form before casting, so a malformed id is a clean
    -- 22023 rather than an opaque 22P02 invalid_text_representation.
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_department_ids) e
        WHERE e #>> '{}' IS NULL
           OR e #>> '{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) THEN
        RAISE EXCEPTION 'department ids must be UUID strings'
            USING ERRCODE = '22023';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_department_id_array(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_department_id_array(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.assert_department_id_array(JSONB) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.assert_department_id_array(JSONB) TO service_role;

COMMENT ON FUNCTION public.assert_department_id_array(JSONB) IS
'WS-ONBOARD-4: input-shape guard for a department-id JSON array. Raises '
'22023. Table-free and SECURITY INVOKER.';

CREATE OR REPLACE FUNCTION public.create_doctor(
    p_actor_user_id UUID,
    p_hospital_id UUID,
    p_auth_user_id UUID,
    p_full_name TEXT,
    p_normalized_phone TEXT DEFAULT NULL,
    p_specializations JSONB DEFAULT '[]'::jsonb,
    p_department_ids JSONB DEFAULT '[]'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name TEXT;
    v_phone TEXT;
BEGIN

    IF p_actor_user_id IS NULL OR NOT EXISTS (
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

    IF p_auth_user_id IS NULL THEN
        RAISE EXCEPTION 'doctor auth user is required'
            USING ERRCODE = '22023';
    END IF;

    v_name := btrim(coalesce(p_full_name, ''));
    IF v_name = '' THEN
        RAISE EXCEPTION 'doctor full name is required'
            USING ERRCODE = '22023';
    END IF;

    -- profiles.valid_profile_phone requires 10-15 digits or NULL. Normalize
    -- first, then validate, so the caller gets 22023 rather than an opaque
    -- 23514 check violation.
    v_phone := NULLIF(btrim(coalesce(p_normalized_phone, '')), '');
    IF v_phone IS NOT NULL THEN
        v_phone := regexp_replace(v_phone, '[^0-9]', '', 'g');
        IF v_phone !~ '^[0-9]{10,15}$' THEN
            RAISE EXCEPTION 'doctor phone must be 10-15 digits'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    IF p_specializations IS NULL OR jsonb_typeof(p_specializations) <> 'array' THEN
        RAISE EXCEPTION 'specializations must be a JSON array'
            USING ERRCODE = '22023';
    END IF;

    IF p_department_ids IS NULL OR jsonb_typeof(p_department_ids) <> 'array' THEN
        RAISE EXCEPTION 'department_ids must be a JSON array'
            USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_specializations) e
        WHERE jsonb_typeof(e) <> 'object'
           OR btrim(coalesce(e ->> 'name', '')) = ''
    ) THEN
        RAISE EXCEPTION 'each specialization must be an object with a name'
            USING ERRCODE = '22023';
    END IF;

    PERFORM public.assert_department_id_array(p_department_ids);

    -- Never duplicate an existing identity's role in the same hospital.
    IF EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_auth_user_id AND hospital_id = p_hospital_id
    ) THEN
        RAISE EXCEPTION 'this user already holds a role in this hospital'
            USING ERRCODE = '23505';
    END IF;

    -- Departments must exist, be live, and belong to THIS hospital. Cross-
    -- tenant assignment is refused here, not merely hidden by RLS.
    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(p_department_ids) t(x)
        WHERE NOT EXISTS (
            SELECT 1 FROM public.departments d
            WHERE d.id = t.x::UUID
              AND d.hospital_id = p_hospital_id
              AND d.is_deleted = false
        )
    ) THEN
        RAISE EXCEPTION 'unknown or inactive department for this hospital'
            USING ERRCODE = '22023';
    END IF;

    -- -- Atomic creation ------------------------------------------
    -- Three writes in one transaction: profile, role, specializations,
    -- assignments. Any failure rolls all of them back, so a half-created
    -- doctor is impossible. profiles.id FKs auth.users(id): a fabricated
    -- auth id fails as foreign_key_violation (23503) and is mapped to 422.
    BEGIN
        INSERT INTO public.profiles (id, full_name, normalized_phone, is_active)
        VALUES (p_auth_user_id, v_name, v_phone, true);

        INSERT INTO public.user_roles (user_id, hospital_id, role)
        VALUES (p_auth_user_id, p_hospital_id, 'doctor');
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'doctor already exists'
            USING ERRCODE = '23505';
    END;

    INSERT INTO public.doctor_specializations (
        doctor_id, hospital_id, specialization_name,
        consultation_fee, average_consultation_minutes
    )
    SELECT
        p_auth_user_id,
        p_hospital_id,
        btrim(s->>'name'),
        coalesce((s->>'consultation_fee')::NUMERIC, 0),
        coalesce((s->>'average_consultation_minutes')::INTEGER, 10)
    FROM jsonb_array_elements(p_specializations) s
    WHERE btrim(coalesce(s->>'name', '')) <> ''
    ON CONFLICT (doctor_id, hospital_id, specialization_name)
    DO UPDATE SET
        consultation_fee             = EXCLUDED.consultation_fee,
        average_consultation_minutes = EXCLUDED.average_consultation_minutes,
        is_deleted                   = false;

    INSERT INTO public.doctor_departments (
        hospital_id, doctor_id, department_id, assigned_by
    )
    SELECT p_hospital_id, p_auth_user_id, t.x::UUID, p_actor_user_id
    FROM jsonb_array_elements_text(p_department_ids) t(x)
    ON CONFLICT (hospital_id, doctor_id, department_id) DO NOTHING;

    RETURN jsonb_build_object(
        'ok', true,
        'doctor_id', p_auth_user_id,
        'hospital_id', p_hospital_id,
        'full_name', v_name,
        'normalized_phone', v_phone,
        'is_active', true,
        'department_count', jsonb_array_length(p_department_ids),
        'specialization_count', jsonb_array_length(p_specializations)
    );
END;
$$;

ALTER FUNCTION public.create_doctor(UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB)
    SET row_security = off;

REVOKE ALL ON FUNCTION public.create_doctor(UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_doctor(UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.create_doctor(UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.create_doctor(UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB) TO service_role;

COMMENT ON FUNCTION public.create_doctor(UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB) IS
'WS-ONBOARD-4: creates a doctor in the EXISTING model, a profiles row plus '
'a user_roles ''doctor'' row scoped to one hospital, together with '
'specializations and department assignments, atomically. service_role-only. '
'Never creates an auth user.';

-- -------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_doctor(
    p_actor_user_id UUID,
    p_hospital_id UUID,
    p_doctor_id UUID,
    p_full_name TEXT DEFAULT NULL,
    p_normalized_phone TEXT DEFAULT NULL,
    p_is_active BOOLEAN DEFAULT NULL,
    p_specializations JSONB DEFAULT NULL,
    p_department_ids JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile public.profiles%ROWTYPE;
    v_name TEXT;
    v_phone TEXT;
    v_deactivated_schedules INTEGER := 0;
BEGIN

    IF p_actor_user_id IS NULL OR NOT EXISTS (
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

    -- The target must genuinely be a doctor OF THIS HOSPITAL. This is the
    -- tenant check for the doctor entity, and it is evaluated in the database.
    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_doctor_id
          AND hospital_id = p_hospital_id
          AND role = 'doctor'
    ) THEN
        RAISE EXCEPTION 'doctor not found in this hospital'
            USING ERRCODE = 'P0002';
    END IF;

    SELECT * INTO v_profile FROM public.profiles
    WHERE id = p_doctor_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'doctor profile not found'
            USING ERRCODE = 'P0002';
    END IF;

    v_name := NULLIF(btrim(coalesce(p_full_name, '')), '');
    IF p_full_name IS NOT NULL AND v_name IS NULL THEN
        RAISE EXCEPTION 'doctor full name cannot be empty'
            USING ERRCODE = '22023';
    END IF;

    IF p_normalized_phone IS NOT NULL THEN
        v_phone := NULLIF(btrim(p_normalized_phone), '');
        IF v_phone IS NOT NULL THEN
            v_phone := regexp_replace(v_phone, '[^0-9]', '', 'g');
            IF v_phone !~ '^[0-9]{10,15}$' THEN
                RAISE EXCEPTION 'doctor phone must be 10-15 digits'
                    USING ERRCODE = '22023';
            END IF;
        END IF;
    END IF;

    IF p_specializations IS NOT NULL THEN
        IF jsonb_typeof(p_specializations) <> 'array' THEN
            RAISE EXCEPTION 'specializations must be a JSON array'
                USING ERRCODE = '22023';
        END IF;

        IF EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_specializations) e
            WHERE jsonb_typeof(e) <> 'object'
               OR btrim(coalesce(e ->> 'name', '')) = ''
        ) THEN
            RAISE EXCEPTION 'each specialization must be an object with a name'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    IF p_department_ids IS NOT NULL THEN
        PERFORM public.assert_department_id_array(p_department_ids);

        IF EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(p_department_ids) t(x)
            WHERE NOT EXISTS (
                SELECT 1 FROM public.departments d
                WHERE d.id = t.x::UUID
                  AND d.hospital_id = p_hospital_id
                  AND d.is_deleted = false
            )
        ) THEN
            RAISE EXCEPTION 'unknown or inactive department for this hospital'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    UPDATE public.profiles
       SET full_name        = coalesce(v_name, full_name),
           normalized_phone = CASE
               WHEN p_normalized_phone IS NULL THEN normalized_phone
               ELSE v_phone
           END,
           is_active        = coalesce(p_is_active, is_active)
     WHERE id = p_doctor_id;

    -- Deactivation is made REAL without touching is_doctor_available(): the
    -- availability engine consumes doctor_schedules.is_active, so deactivating
    -- this doctor's active schedules in the SAME transaction is what actually
    -- stops bookings. Reactivation deliberately does NOT auto-restore the
    -- previous schedule - an admin must re-confirm each working pattern.
    IF p_is_active IS FALSE THEN
        UPDATE public.doctor_schedules
           SET is_active = false
         WHERE doctor_id = p_doctor_id
           AND hospital_id = p_hospital_id
           AND is_deleted = false
           AND is_active = true;
        GET DIAGNOSTICS v_deactivated_schedules = ROW_COUNT;
    END IF;

    -- NULL = leave unchanged; a supplied array REPLACES the set (so an empty
    -- array clears it intentionally).
    IF p_specializations IS NOT NULL THEN
        DELETE FROM public.doctor_specializations
        WHERE doctor_id = p_doctor_id AND hospital_id = p_hospital_id;

        INSERT INTO public.doctor_specializations (
            doctor_id, hospital_id, specialization_name,
            consultation_fee, average_consultation_minutes
        )
        SELECT
            p_doctor_id,
            p_hospital_id,
            btrim(s->>'name'),
            coalesce((s->>'consultation_fee')::NUMERIC, 0),
            coalesce((s->>'average_consultation_minutes')::INTEGER, 10)
        FROM jsonb_array_elements(p_specializations) s
        WHERE btrim(coalesce(s->>'name', '')) <> ''
        ON CONFLICT (doctor_id, hospital_id, specialization_name)
        DO UPDATE SET
            consultation_fee             = EXCLUDED.consultation_fee,
            average_consultation_minutes = EXCLUDED.average_consultation_minutes,
            is_deleted                   = false;
    END IF;

    IF p_department_ids IS NOT NULL THEN
        DELETE FROM public.doctor_departments
        WHERE doctor_id = p_doctor_id AND hospital_id = p_hospital_id;

        INSERT INTO public.doctor_departments (
            hospital_id, doctor_id, department_id, assigned_by
        )
        SELECT p_hospital_id, p_doctor_id, t.x::UUID, p_actor_user_id
        FROM jsonb_array_elements_text(p_department_ids) t(x)
        ON CONFLICT (hospital_id, doctor_id, department_id) DO NOTHING;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'doctor_id', p_doctor_id,
        'hospital_id', p_hospital_id,
        'is_active', coalesce(p_is_active, v_profile.is_active),
        'schedules_deactivated', v_deactivated_schedules
    );
END;
$$;

ALTER FUNCTION public.update_doctor(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB, JSONB)
    SET row_security = off;

REVOKE ALL ON FUNCTION public.update_doctor(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_doctor(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.update_doctor(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB, JSONB) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.update_doctor(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB, JSONB) TO service_role;

COMMENT ON FUNCTION public.update_doctor(UUID, UUID, UUID, TEXT, TEXT, BOOLEAN, JSONB, JSONB) IS
'WS-ONBOARD-4: patches a doctor in the existing profile/role model, replacing '
'the specialization and department sets when supplied. Deactivating a doctor '
'also deactivates that doctor''s active schedules in the same transaction, '
'because doctor_schedules.is_active is what the availability engine reads.';

-- =============================================================
-- 6. SCHEDULE WRITE RPCs
--
-- doctor_schedules already exists and is already consumed by the booking
-- runtime, so there is nothing new to store. These RPCs open the write path.
-- =============================================================

CREATE OR REPLACE FUNCTION public.upsert_doctor_schedule(
    p_actor_user_id UUID,
    p_hospital_id UUID,
    p_doctor_id UUID,
    p_weekday INTEGER,
    p_start_time TIME,
    p_end_time TIME,
    p_max_tokens INTEGER DEFAULT 50,
    p_average_consultation_minutes INTEGER DEFAULT 10,
    p_is_active BOOLEAN DEFAULT true,
    -- Create/update discriminator. NULL means create. It is LAST with
    -- DEFAULT NULL because PostgreSQL requires every parameter after a
    -- defaulted one to be defaulted too, and a required parameter would make
    -- the generated client type a non-nullable string the caller would have
    -- to fake with an explicit JSON null.
    p_schedule_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.doctor_schedules%ROWTYPE;
    v_doctor_active BOOLEAN;
    v_overlap BOOLEAN;
    v_created BOOLEAN := false;
BEGIN

    IF p_actor_user_id IS NULL OR NOT EXISTS (
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

    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_doctor_id
          AND hospital_id = p_hospital_id
          AND role = 'doctor'
    ) THEN
        RAISE EXCEPTION 'doctor not found in this hospital'
            USING ERRCODE = 'P0002';
    END IF;

    -- -- Server-side invariants -----------------------------------
    IF p_weekday IS NULL OR p_weekday NOT BETWEEN 0 AND 6 THEN
        RAISE EXCEPTION 'weekday must be between 0 (Sunday) and 6 (Saturday)'
            USING ERRCODE = '22023';
    END IF;

    IF p_start_time IS NULL OR p_end_time IS NULL THEN
        RAISE EXCEPTION 'schedule start and end time are required'
            USING ERRCODE = '22023';
    END IF;

    IF p_end_time <= p_start_time THEN
        RAISE EXCEPTION 'schedule end time must be after start time'
            USING ERRCODE = '22023';
    END IF;

    IF p_max_tokens IS NULL OR p_max_tokens <= 0 THEN
        RAISE EXCEPTION 'max tokens must be a positive integer'
            USING ERRCODE = '22023';
    END IF;

    IF p_average_consultation_minutes IS NULL
       OR p_average_consultation_minutes NOT BETWEEN 1 AND 240 THEN
        RAISE EXCEPTION 'average consultation minutes must be between 1 and 240'
            USING ERRCODE = '22023';
    END IF;

    IF p_is_active IS NULL THEN
        RAISE EXCEPTION 'is_active is required'
            USING ERRCODE = '22023';
    END IF;

    -- The domain requires an inactive doctor to hold no active schedule; the
    -- availability engine would otherwise still report the doctor available.
    IF p_is_active THEN
        SELECT is_active INTO v_doctor_active FROM public.profiles
        WHERE id = p_doctor_id;
        IF coalesce(v_doctor_active, false) IS NOT TRUE THEN
            RAISE EXCEPTION 'cannot create an active schedule for an inactive doctor'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    IF p_schedule_id IS NOT NULL THEN
        SELECT * INTO v_row FROM public.doctor_schedules
        WHERE id = p_schedule_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'schedule not found'
                USING ERRCODE = 'P0002';
        END IF;

        IF v_row.hospital_id <> p_hospital_id OR v_row.doctor_id <> p_doctor_id THEN
            RAISE EXCEPTION 'schedule does not belong to this doctor and hospital'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- Overlap pre-check matching the EXCLUDE constraint exactly: same doctor,
    -- hospital and weekday, is_deleted = false, IGNORING is_active (an
    -- inactive schedule still owns its range) and excluding the row being
    -- updated. The constraint remains the atomic backstop.
    SELECT EXISTS (
        SELECT 1 FROM public.doctor_schedules s
        WHERE s.doctor_id = p_doctor_id
          AND s.hospital_id = p_hospital_id
          AND s.weekday = p_weekday
          AND s.is_deleted = false
          AND (p_schedule_id IS NULL OR s.id <> p_schedule_id)
          AND s.start_time < p_end_time
          AND s.end_time > p_start_time
    ) INTO v_overlap;

    IF v_overlap THEN
        RAISE EXCEPTION 'this schedule overlaps an existing schedule'
            USING ERRCODE = '23P01';
    END IF;

    IF v_row.id IS NULL THEN
        INSERT INTO public.doctor_schedules (
            doctor_id, hospital_id, weekday, start_time, end_time,
            max_tokens, average_consultation_minutes, is_active, created_by
        )
        VALUES (
            p_doctor_id, p_hospital_id, p_weekday, p_start_time, p_end_time,
            p_max_tokens, p_average_consultation_minutes, p_is_active, p_actor_user_id
        );
        v_created := true;
    ELSE
        UPDATE public.doctor_schedules
           SET weekday                      = p_weekday,
               start_time                   = p_start_time,
               end_time                     = p_end_time,
               max_tokens                   = p_max_tokens,
               average_consultation_minutes = p_average_consultation_minutes,
               is_active                    = p_is_active
         WHERE id = p_schedule_id;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'created', v_created,
        'doctor_id', p_doctor_id,
        'hospital_id', p_hospital_id,
        'weekday', p_weekday,
        'start_time', p_start_time,
        'end_time', p_end_time,
        'max_tokens', p_max_tokens,
        'is_active', p_is_active
    );
END;
$$;

ALTER FUNCTION public.upsert_doctor_schedule(UUID, UUID, UUID, INTEGER, TIME, TIME, INTEGER, INTEGER, BOOLEAN, UUID)
    SET row_security = off;

REVOKE ALL ON FUNCTION public.upsert_doctor_schedule(UUID, UUID, UUID, INTEGER, TIME, TIME, INTEGER, INTEGER, BOOLEAN, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_doctor_schedule(UUID, UUID, UUID, INTEGER, TIME, TIME, INTEGER, INTEGER, BOOLEAN, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_doctor_schedule(UUID, UUID, UUID, INTEGER, TIME, TIME, INTEGER, INTEGER, BOOLEAN, UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.upsert_doctor_schedule(UUID, UUID, UUID, INTEGER, TIME, TIME, INTEGER, INTEGER, BOOLEAN, UUID) TO service_role;

COMMENT ON FUNCTION public.upsert_doctor_schedule(UUID, UUID, UUID, INTEGER, TIME, TIME, INTEGER, INTEGER, BOOLEAN, UUID) IS
'WS-ONBOARD-4: creates or updates a recurring weekly schedule row. '
'service_role-only. Writes the table the availability engine already reads, '
'so a configured schedule is immediately bookable. Overlap raises 23P01.';

-- -------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_doctor_schedule(
    p_actor_user_id UUID,
    p_hospital_id UUID,
    p_schedule_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.doctor_schedules%ROWTYPE;
BEGIN

    IF p_actor_user_id IS NULL OR NOT EXISTS (
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

    SELECT * INTO v_row FROM public.doctor_schedules
    WHERE id = p_schedule_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'schedule not found'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_row.hospital_id <> p_hospital_id THEN
        RAISE EXCEPTION 'schedule does not belong to this hospital'
            USING ERRCODE = '42501';
    END IF;

    -- Soft delete: the schedule engine and historical bookings keep referring
    -- to the row, and the EXCLUDE index releases the range on is_deleted.
    UPDATE public.doctor_schedules
       SET is_deleted = true,
           is_active  = false
     WHERE id = p_schedule_id;

    RETURN jsonb_build_object(
        'ok', true,
        'schedule_id', p_schedule_id,
        'deleted', true
    );
END;
$$;

ALTER FUNCTION public.delete_doctor_schedule(UUID, UUID, UUID)
    SET row_security = off;

REVOKE ALL ON FUNCTION public.delete_doctor_schedule(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_doctor_schedule(UUID, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.delete_doctor_schedule(UUID, UUID, UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.delete_doctor_schedule(UUID, UUID, UUID) TO service_role;

COMMENT ON FUNCTION public.delete_doctor_schedule(UUID, UUID, UUID) IS
'WS-ONBOARD-4: soft-deletes a schedule. service_role-only. No schedule row is '
'ever destroyed, preserving the audit and booking history that references it.';

-- =============================================================
-- 7. LEAVE WRITE RPCs
-- =============================================================

CREATE OR REPLACE FUNCTION public.upsert_doctor_leave(
    p_actor_user_id UUID,
    p_hospital_id UUID,
    p_doctor_id UUID,
    p_leave_start_date DATE,
    p_leave_end_date DATE,
    p_leave_type TEXT DEFAULT 'other',
    p_reason TEXT DEFAULT NULL,
    p_notes TEXT DEFAULT NULL,
    -- Create/update discriminator, last for the same PostgreSQL ordering rule
    -- as the schedule parameter above.
    p_leave_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.doctor_leaves%ROWTYPE;
    v_created BOOLEAN := false;
BEGIN

    IF p_actor_user_id IS NULL OR NOT EXISTS (
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

    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_doctor_id
          AND hospital_id = p_hospital_id
          AND role = 'doctor'
    ) THEN
        RAISE EXCEPTION 'doctor not found in this hospital'
            USING ERRCODE = 'P0002';
    END IF;

    IF p_leave_start_date IS NULL OR p_leave_end_date IS NULL THEN
        RAISE EXCEPTION 'leave start and end date are required'
            USING ERRCODE = '22023';
    END IF;

    IF p_leave_end_date < p_leave_start_date THEN
        RAISE EXCEPTION 'leave end date must not precede the start date'
            USING ERRCODE = '22023';
    END IF;

    -- Enum membership checked against the catalog so a bad value is a clean
    -- 22023 instead of an opaque 22P02 cast error.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = 'doctor_leave_type'
          AND e.enumlabel = p_leave_type
    ) THEN
        RAISE EXCEPTION 'unrecognized leave type'
            USING ERRCODE = '22023';
    END IF;

    IF p_leave_id IS NOT NULL THEN
        SELECT * INTO v_row FROM public.doctor_leaves
        WHERE id = p_leave_id
        FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'leave not found'
                USING ERRCODE = 'P0002';
        END IF;

        IF v_row.hospital_id <> p_hospital_id OR v_row.doctor_id <> p_doctor_id THEN
            RAISE EXCEPTION 'leave does not belong to this doctor and hospital'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- no_overlapping_doctor_leaves is (doctor_id, daterange) with
    -- is_deleted = false only - it ignores hospital AND status. Pre-check on
    -- exactly those terms so the caller gets a deterministic conflict rather
    -- than a surprise exclusion violation.
    IF EXISTS (
        SELECT 1 FROM public.doctor_leaves l
        WHERE l.doctor_id = p_doctor_id
          AND l.is_deleted = false
          AND (p_leave_id IS NULL OR l.id <> p_leave_id)
          AND l.leave_start_date <= p_leave_end_date
          AND l.leave_end_date >= p_leave_start_date
    ) THEN
        RAISE EXCEPTION 'this leave overlaps an existing leave for this doctor'
            USING ERRCODE = '23P01';
    END IF;

    IF v_row.id IS NULL THEN
        -- Admin-created leave is APPROVED on creation: is_doctor_available()
        -- only honours leave_status = 'approved', so a 'pending' row would be
        -- stored but ignored - a fake capability. The hospital admin creating
        -- it IS the approver.
        INSERT INTO public.doctor_leaves (
            doctor_id, hospital_id, leave_start_date, leave_end_date,
            reason, approved_by, leave_type, leave_status, approved_at, notes
        )
        VALUES (
            p_doctor_id, p_hospital_id, p_leave_start_date, p_leave_end_date,
            NULLIF(btrim(coalesce(p_reason, '')), ''), p_actor_user_id,
            p_leave_type::public.doctor_leave_type, 'approved', now(),
            NULLIF(btrim(coalesce(p_notes, '')), '')
        );
        v_created := true;
    ELSE
        UPDATE public.doctor_leaves
           SET leave_start_date = p_leave_start_date,
               leave_end_date   = p_leave_end_date,
               leave_type       = p_leave_type::public.doctor_leave_type,
               reason           = coalesce(NULLIF(btrim(coalesce(p_reason, '')), ''), reason),
               notes            = coalesce(NULLIF(btrim(coalesce(p_notes, '')), ''), notes)
         WHERE id = p_leave_id;
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'created', v_created,
        'doctor_id', p_doctor_id,
        'hospital_id', p_hospital_id,
        'start_date', p_leave_start_date,
        'end_date', p_leave_end_date,
        'leave_type', p_leave_type,
        'leave_status', 'approved'
    );
END;
$$;

ALTER FUNCTION public.upsert_doctor_leave(UUID, UUID, UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID)
    SET row_security = off;

REVOKE ALL ON FUNCTION public.upsert_doctor_leave(UUID, UUID, UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_doctor_leave(UUID, UUID, UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_doctor_leave(UUID, UUID, UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.upsert_doctor_leave(UUID, UUID, UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID) TO service_role;

COMMENT ON FUNCTION public.upsert_doctor_leave(UUID, UUID, UUID, DATE, DATE, TEXT, TEXT, TEXT, UUID) IS
'WS-ONBOARD-4: creates or updates a doctor leave, approved on creation so the '
'availability engine honours it immediately. service_role-only. Overlap '
'raises 23P01 against the same terms as the EXCLUDE constraint.';

-- -------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cancel_doctor_leave(
    p_actor_user_id UUID,
    p_hospital_id UUID,
    p_leave_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.doctor_leaves%ROWTYPE;
BEGIN

    IF p_actor_user_id IS NULL OR NOT EXISTS (
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

    SELECT * INTO v_row FROM public.doctor_leaves
    WHERE id = p_leave_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'leave not found'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_row.hospital_id <> p_hospital_id THEN
        RAISE EXCEPTION 'leave does not belong to this hospital'
            USING ERRCODE = '42501';
    END IF;

    -- is_deleted MUST be released as well as the status: the leave EXCLUDE
    -- constraint filters on is_deleted = false only, so a cancelled-but-live
    -- row would keep the dates blocked and prevent any future leave.
    UPDATE public.doctor_leaves
       SET leave_status = 'cancelled',
           is_deleted   = true
     WHERE id = p_leave_id;

    RETURN jsonb_build_object(
        'ok', true,
        'leave_id', p_leave_id,
        'leave_status', 'cancelled'
    );
END;
$$;

ALTER FUNCTION public.cancel_doctor_leave(UUID, UUID, UUID)
    SET row_security = off;

REVOKE ALL ON FUNCTION public.cancel_doctor_leave(UUID, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_doctor_leave(UUID, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_doctor_leave(UUID, UUID, UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.cancel_doctor_leave(UUID, UUID, UUID) TO service_role;

COMMENT ON FUNCTION public.cancel_doctor_leave(UUID, UUID, UUID) IS
'WS-ONBOARD-4: cancels a leave and releases its date range. service_role-only.';

-- =============================================================
-- 8. AUDIT ACTION TYPE REGISTRATION
--
-- Category 'configuration' is permitted by the CHECK in migration 36.
-- Naming follows the existing {entity}_{past-participle} convention
-- (integration_config_update, hospital_configuration_update,
-- alert_acknowledge).
-- =============================================================

INSERT INTO public.audit_action_types (
    action_type, display_name, default_severity, category, description
)
VALUES
(
    'department_create',
    'Department Create',
    'medium',
    'configuration',
    'A hospital department was created (WS-ONBOARD-4)'
),
(
    'department_update',
    'Department Update',
    'medium',
    'configuration',
    'A hospital department was edited (WS-ONBOARD-4)'
),
(
    'department_status_change',
    'Department Status Change',
    'medium',
    'configuration',
    'A hospital department was activated or deactivated (WS-ONBOARD-4)'
),
(
    'doctor_create',
    'Doctor Create',
    'high',
    'configuration',
    'A doctor identity was provisioned into a hospital (WS-ONBOARD-4)'
),
(
    'doctor_update',
    'Doctor Update',
    'medium',
    'configuration',
    'A doctor profile or specialization set was edited (WS-ONBOARD-4)'
),
(
    'doctor_status_change',
    'Doctor Status Change',
    'high',
    'configuration',
    'A doctor was activated or deactivated; deactivation also deactivates '
    'that doctor''s active schedules (WS-ONBOARD-4)'
),
(
    'doctor_department_assignment',
    'Doctor Department Assignment',
    'medium',
    'configuration',
    'A doctor''s department set was assigned or replaced (WS-ONBOARD-4)'
),
(
    'doctor_schedule_create',
    'Doctor Schedule Create',
    'medium',
    'configuration',
    'A recurring weekly schedule was created and is immediately usable by the '
    'availability engine (WS-ONBOARD-4)'
),
(
    'doctor_schedule_update',
    'Doctor Schedule Update',
    'medium',
    'configuration',
    'A recurring weekly schedule was edited (WS-ONBOARD-4)'
),
(
    'doctor_schedule_delete',
    'Doctor Schedule Delete',
    'high',
    'configuration',
    'A recurring weekly schedule was soft-deleted (WS-ONBOARD-4)'
),
(
    'doctor_leave_create',
    'Doctor Leave Create',
    'medium',
    'configuration',
    'An approved doctor leave was created; the availability engine honours it '
    'from creation (WS-ONBOARD-4)'
),
(
    'doctor_leave_update',
    'Doctor Leave Update',
    'medium',
    'configuration',
    'A doctor leave window was edited (WS-ONBOARD-4)'
),
(
    'doctor_leave_cancel',
    'Doctor Leave Cancel',
    'medium',
    'configuration',
    'A doctor leave was cancelled and its date range released '
    '(WS-ONBOARD-4)'
)
ON CONFLICT (action_type) DO NOTHING;
