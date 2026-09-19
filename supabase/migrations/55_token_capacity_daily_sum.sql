-- =============================================================
-- MIGRATION 55: PHASE 4 - E1 GATE (daily token-capacity drift)
-- =============================================================
--
-- FINDING (Phase 4 roadmap item "Fix the extended-hours/daily-cap
-- drift in get_remaining_token_capacity"):
--
--   get_remaining_token_capacity (migration 03:447, the definition
--   still live in the catalog) resolves the doctor's daily token cap
--   with `ORDER BY start_time LIMIT 1` over doctor_schedules. For a
--   doctor with MULTIPLE active shifts on the same weekday
--   (extended-hours clinic - the seed doctor has two: 09:00-13:00
--   and 17:00-21:00, 25 tokens each) only the FIRST shift's
--   max_tokens is treated as the daily capacity, while the booked
--   count is taken across the WHOLE day. Consequence: the function
--   reports "queue full" (0 remaining) after 25 of the actually
--   available 50 day-slots are booked - a 50% silent capacity cut
--   for every extended-hours doctor, enforced at the create-booking
--   Edge Function gate.
--
-- FIX (smallest correct change):
--
--   Daily capacity = SUM(max_tokens) over the doctor's ACTIVE,
--   non-deleted schedule rows for the appointment weekday. Single-
--   shift doctors are unaffected (SUM of one row = that row). Zero
--   remaining when the doctor has no active schedule that weekday
--   (unchanged). Booked-count semantics, exclusions
--   ('cancelled', 'no_show'), is_deleted filter, STABLE/SECURITY
--   DEFINER status, signature and parameter order are all preserved
--   exactly, so every positional caller (create-booking Edge
--   Function) is unaffected.
--
-- SECURITY (CLAUDE.md section 7 / F16-04):
--   This is a new CREATE OR REPLACE of a SECURITY DEFINER function.
--   Per the standing F16-04 obligation the migration restates its
--   own explicit REVOKE/GRANT, matching the CURRENT live catalog
--   ACL measured before this migration ({postgres=X/postgres,
--   service_role=X/postgres} - locked down by migration 48):
--   owner postgres, service_role EXECUTE, anon/authenticated have
--   NO EXECUTE. The self-check below verifies that boundary against
--   pg_proc rather than trusting this text.
-- =============================================================

BEGIN;

-- =============================================================
-- 1. get_remaining_token_capacity: daily cap = SUM over shifts
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_remaining_token_capacity(
    p_doctor_id UUID,
    p_hospital_id UUID,
    p_date DATE
)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_max_tokens INTEGER;
    v_booked INTEGER;
BEGIN

    SELECT SUM(ds.max_tokens)
    INTO v_max_tokens
    FROM public.doctor_schedules ds
    WHERE ds.doctor_id = p_doctor_id
      AND ds.hospital_id = p_hospital_id
      AND ds.weekday =
            EXTRACT(DOW FROM p_date)::INTEGER
      AND ds.is_active = true
      AND ds.is_deleted = false;

    IF v_max_tokens IS NULL THEN
        RETURN 0;
    END IF;

    SELECT COUNT(*)
    INTO v_booked
    FROM public.bookings
    WHERE assigned_doctor_id = p_doctor_id
      AND hospital_id = p_hospital_id
      AND appointment_date = p_date
      AND status NOT IN (
            'cancelled',
            'no_show'
      )
      AND is_deleted = false;

    RETURN GREATEST(
        v_max_tokens - v_booked,
        0
    );

END;
$$;

ALTER FUNCTION public.get_remaining_token_capacity(UUID,UUID,DATE)
SET row_security = off;

-- =============================================================
-- 2. F16-04: restate the privilege boundary explicitly
-- =============================================================

REVOKE ALL ON FUNCTION public.get_remaining_token_capacity(UUID,UUID,DATE)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_remaining_token_capacity(UUID,UUID,DATE)
TO service_role;

ALTER FUNCTION public.get_remaining_token_capacity(UUID,UUID,DATE)
    OWNER TO postgres;

-- =============================================================
-- 3. SELF-VERIFICATION (fail closed)
-- =============================================================

DO $$
DECLARE
    v_oid regprocedure;
    v_owner text;
    v_seed_remaining INTEGER;
BEGIN
    SELECT p.oid::regprocedure, pg_get_userbyid(p.proowner)
      INTO v_oid, v_owner
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'get_remaining_token_capacity';

    IF v_oid IS NULL THEN
        RAISE EXCEPTION 'migration 55 verification failed: function missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'get_remaining_token_capacity'
          AND p.prosecdef
    ) THEN
        RAISE EXCEPTION 'migration 55 verification failed: not SECURITY DEFINER';
    END IF;

    IF v_owner <> 'postgres' THEN
        RAISE EXCEPTION 'migration 55 verification failed: owner is %', v_owner;
    END IF;

    -- Privilege boundary at the catalog level (live ACL).
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'migration 55 verification failed: service_role lacks EXECUTE';
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'migration 55 verification failed: anon retains EXECUTE';
    END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'migration 55 verification failed: authenticated retains EXECUTE';
    END IF;

    -- Behavioral smoke against the seed hospital: the seed doctor has
    -- two active 25-token shifts Mon-Sat, so on any such weekday the
    -- remaining capacity must exceed the old first-shift-only cap of
    -- 25 (i.e. the SUM semantics is live even with zero bookings on
    -- the probe date). A far-future deterministic weekday (2030-06-03,
    -- a Monday) carries no bookings, so remaining must equal 50.
    SELECT public.get_remaining_token_capacity(
        '00000000-0000-4000-8000-0000000000a3'::uuid,
        '00000000-0000-4000-8000-000000000001'::uuid,
        DATE '2030-06-03'
    ) INTO v_seed_remaining;

    IF v_seed_remaining <> 50 THEN
        RAISE EXCEPTION 'migration 55 verification failed: two-shift weekday remaining is %, expected 50 (SUM of both shifts)', v_seed_remaining;
    END IF;

    RAISE NOTICE 'migration 55 verification passed';
END $$;

-- =============================================================
-- 4. REGISTRY
-- =============================================================

INSERT INTO public.migration_registry (
    migration_id,
    script_filename,
    description,
    category,
    status,
    applied_at
)
VALUES (
    '55_token_capacity_daily_sum',
    '55_token_capacity_daily_sum.sql',
    'Phase 4 (E1 roadmap): get_remaining_token_capacity now sums '
    'max_tokens across ALL active doctor_schedules rows for the '
    'appointment weekday instead of taking the first shift only '
    '(LIMIT 1), so extended-hours doctors no longer lose half their '
    'daily capacity at the create-booking gate; booked-count '
    'semantics, exclusions, signature and STABLE SECURITY DEFINER '
    'status unchanged; privilege boundary restated explicitly per '
    'F16-04 (postgres-owned, service_role-only EXECUTE) and '
    'self-verified against pg_proc',
    'function',
    'applied',
    now()
)
ON CONFLICT (migration_id) DO UPDATE
SET description = EXCLUDED.description,
    category = EXCLUDED.category,
    status = EXCLUDED.status,
    applied_at = EXCLUDED.applied_at;

COMMIT;
