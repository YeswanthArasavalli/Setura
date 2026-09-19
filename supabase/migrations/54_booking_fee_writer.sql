-- =============================================================
-- MIGRATION 54: PHASE 3 - FINANCIAL CORRECTNESS (P0-04 / B2)
-- =============================================================
--
-- FINDING (P0-04, roadmap B2 "Refunds compute INR 0 for every
-- booking created after migration 28"):
--
--   `bookings.booking_fee_inr` (NUMERIC(10,2) NOT NULL DEFAULT 0,
--   added by migration 28) is the value SETURA collects via
--   Razorpay and the basis every refund path uses:
--     * calculate_refund_amount (migration 29:201) ->
--         v_paid := COALESCE(v_booking.booking_fee_inr, 0)
--     * cancel-booking Edge Function -> Number(b.booking_fee_inr ?? 0)
--     * whatsapp_cancel_flow -> Number(booking.booking_fee_inr ?? 0)
--
--   The ONLY writer of the column in migrations 01-53 is migration
--   28's one-time backfill. `create_booking` (migration 39, the
--   current definition) persists platform_fee_snapshot /
--   receptionist_fee_snapshot / hospital_fee_snapshot /
--   total_amount_snapshot but NEVER booking_fee_inr. Because the
--   column is NOT NULL DEFAULT 0, every booking created at runtime
--   after migration 28 silently stores INR 0, so two of the three
--   refund paths always refund INR 0 regardless of what the patient
--   paid.
--
-- FIX (smallest correct change, no architecture redesign):
--
--   `create_booking` is the single canonical writer for every
--   fee-paying booking creation path (create-booking REST,
--   idempotent_create_booking, reschedule-booking and the WhatsApp
--   conversation engine all call it and pass the platform fee).
--   Persist booking_fee_inr there from the platform fee, matching
--   the column's own declared semantics and migration 28's backfill
--   formula exactly:
--     migration 28:  booking_fee_inr = COALESCE(platform_fee_snapshot, 0)
--     column comment: "The fee SETURA charges the patient and collects
--       via Razorpay. This is the ONLY money SETURA receives."
--   So booking_fee_inr := COALESCE(p_platform_fee, 0) - the same value
--   the INSERT already stores in platform_fee_snapshot.
--
--   Consultation/hospital/receptionist money is deliberately NOT put
--   in booking_fee_inr: refunds apply ONLY to booking_fee_inr and
--   "SETURA never processes consultation fee refunds" (migration 29
--   header). Emergency walk-in inserts (insert_emergency_patient,
--   migration 46) collect no fee and correctly keep booking_fee_inr 0.
--
-- DATA REPAIR:
--
--   A deterministic backfill repairs bookings created after
--   migration 28 that have booking_fee_inr = 0 but a positive
--   platform_fee_snapshot (the money that was actually collected).
--   Idempotent and non-destructive: it only fills the column from an
--   already-persisted authoritative snapshot and never overwrites a
--   non-zero value.
--
-- SECURITY (CLAUDE.md section 7 / F16-04):
--   create_booking is SECURITY DEFINER and Category B
--   (docs/security/RPC_PRIVILEGE_CLASSIFICATION.tsv -> service_role
--   only). CREATE OR REPLACE preserves the prior ACL, but per the
--   standing F16-04 obligation a resignatured SECURITY DEFINER
--   function restates its own explicit REVOKE/GRANT; the migration
--   39/48 pattern (REVOKE FROM PUBLIC + anon + authenticated, GRANT
--   TO service_role, OWNER postgres) is reused verbatim and verified
--   against pg_proc.proacl in the self-check below.
--
-- OUT OF SCOPE (needs the recorded NPD-02 revenue-recognition ruling,
--   NOT decided here): the create-payment-order Edge Function charges
--   total_amount_snapshot while the cancellation/refund basis is
--   booking_fee_inr (platform fee). That basis inconsistency (P1-10)
--   is a revenue-model decision and is left untouched; this migration
--   only makes booking_fee_inr reflect the value it is defined to
--   hold. See the Phase 3 report.
-- =============================================================

BEGIN;

-- =============================================================
-- 1. create_booking: persist booking_fee_inr (platform fee)
-- =============================================================
-- Body is byte-for-byte migration 39's create_booking with the single
-- addition of booking_fee_inr to the INSERT column/value lists. The
-- signature and parameter order are unchanged, so every positional
-- caller (idempotent_create_booking, the Edge Functions) is unaffected.

CREATE OR REPLACE FUNCTION public.create_booking(
    p_hospital_id UUID,
    p_queue_session_id UUID DEFAULT NULL,
    p_patient_id UUID DEFAULT NULL,
    p_patient_name TEXT DEFAULT NULL,
    p_patient_phone TEXT DEFAULT NULL,
    p_patient_age INTEGER DEFAULT NULL,
    p_patient_gender TEXT DEFAULT NULL,
    p_village TEXT DEFAULT NULL,
    p_blood_group TEXT DEFAULT NULL,
    p_has_diabetes BOOLEAN DEFAULT false,
    p_has_bp BOOLEAN DEFAULT false,
    p_booking_source public.booking_source DEFAULT NULL,
    p_doctor_id UUID DEFAULT NULL,
    p_booked_by UUID DEFAULT NULL,
    p_appointment_date DATE DEFAULT NULL,
    p_platform_fee NUMERIC DEFAULT NULL,
    p_receptionist_fee NUMERIC DEFAULT NULL,
    p_hospital_fee NUMERIC DEFAULT NULL,
    p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TABLE (
    booking_id UUID,
    token_number INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_booking_id UUID;
    v_token INTEGER;
    v_total NUMERIC;
BEGIN

    SELECT b.id, b.token_number
    INTO v_booking_id, v_token
    FROM public.bookings b
    WHERE b.idempotency_key = p_idempotency_key;

    IF FOUND THEN
        RETURN QUERY
        SELECT v_booking_id, v_token;
        RETURN;
    END IF;

    v_token :=
        public.generate_next_token(
            p_hospital_id,
            p_appointment_date
        );

    v_total :=
        COALESCE(p_platform_fee, 0)
        + COALESCE(p_receptionist_fee, 0)
        + COALESCE(p_hospital_fee, 0);

    INSERT INTO public.bookings (
        hospital_id,
        queue_session_id,
        patient_id,
        patient_name,
        patient_phone,
        patient_age,
        patient_gender,
        village,
        blood_group,
        has_diabetes,
        has_bp,
        token_number,
        booking_source,
        assigned_doctor_id,
        booked_by,
        appointment_date,
        platform_fee_snapshot,
        booking_fee_inr,
        receptionist_fee_snapshot,
        hospital_fee_snapshot,
        total_amount_snapshot,
        idempotency_key
    )
    VALUES (
        p_hospital_id,
        p_queue_session_id,
        p_patient_id,
        p_patient_name,
        p_patient_phone,
        p_patient_age,
        p_patient_gender,
        p_village,
        p_blood_group,
        COALESCE(p_has_diabetes, false),
        COALESCE(p_has_bp, false),
        v_token,
        p_booking_source,
        p_doctor_id,
        p_booked_by,
        p_appointment_date,
        COALESCE(p_platform_fee, 0),
        COALESCE(p_platform_fee, 0),
        COALESCE(p_receptionist_fee, 0),
        COALESCE(p_hospital_fee, 0),
        v_total,
        p_idempotency_key
    )
    RETURNING id
    INTO v_booking_id;

    UPDATE public.patients
    SET
        total_visits = total_visits + 1,
        last_visit_date = p_appointment_date
    WHERE id = p_patient_id;

    RETURN QUERY
    SELECT v_booking_id, v_token;

END;
$$;

ALTER FUNCTION public.create_booking(
UUID,UUID,UUID,TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,
BOOLEAN,BOOLEAN,public.booking_source,UUID,UUID,DATE,
NUMERIC,NUMERIC,NUMERIC,TEXT
)
    OWNER TO postgres;

-- =============================================================
-- 2. F16-04: restate the Category B privilege boundary explicitly
-- =============================================================

REVOKE ALL ON FUNCTION public.create_booking(
UUID,UUID,UUID,TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,
BOOLEAN,BOOLEAN,public.booking_source,UUID,UUID,DATE,
NUMERIC,NUMERIC,NUMERIC,TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_booking(
UUID,UUID,UUID,TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,
BOOLEAN,BOOLEAN,public.booking_source,UUID,UUID,DATE,
NUMERIC,NUMERIC,NUMERIC,TEXT
) TO service_role;

-- =============================================================
-- 3. DATA REPAIR: backfill booking_fee_inr for affected bookings
-- =============================================================
-- Repairs bookings created after migration 28 whose booking_fee_inr
-- is still the DEFAULT 0 but whose platform_fee_snapshot recorded the
-- real money collected. Deterministic and idempotent: rows already
-- carrying a non-zero booking_fee_inr are never touched, so re-running
-- the statement is a no-op and this cannot clobber migration 28's
-- original backfill.

UPDATE public.bookings
   SET booking_fee_inr = COALESCE(platform_fee_snapshot, 0)
 WHERE booking_fee_inr = 0
   AND COALESCE(platform_fee_snapshot, 0) > 0;

-- =============================================================
-- 4. SELF-VERIFICATION (fail closed)
-- =============================================================

DO $$
DECLARE
    v_sig text := 'create_booking(uuid,uuid,uuid,text,text,integer,text,text,text,'
                  || 'boolean,boolean,public.booking_source,uuid,uuid,date,numeric,'
                  || 'numeric,numeric,text)';
    v_oid regprocedure;
    v_prosrc text;
    v_owner  text;
BEGIN
    -- 4.1 The function still exists with the unchanged signature.
    SELECT p.oid::regprocedure, p.prosrc, pg_get_userbyid(p.proowner)
      INTO v_oid, v_prosrc, v_owner
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'create_booking';

    IF v_oid IS NULL THEN
        RAISE EXCEPTION 'migration 54 verification failed: create_booking missing';
    END IF;

    -- 4.2 It is still SECURITY DEFINER and owned by postgres.
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'create_booking'
          AND p.prosecdef
    ) THEN
        RAISE EXCEPTION 'migration 54 verification failed: create_booking is not SECURITY DEFINER';
    END IF;

    IF v_owner <> 'postgres' THEN
        RAISE EXCEPTION 'migration 54 verification failed: create_booking owner is %', v_owner;
    END IF;

    -- 4.3 The writer now persists booking_fee_inr.
    IF v_prosrc NOT LIKE '%booking_fee_inr%' THEN
        RAISE EXCEPTION 'migration 54 verification failed: create_booking does not write booking_fee_inr';
    END IF;

    -- 4.4 Privilege boundary is service_role-only at the catalog level.
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'migration 54 verification failed: service_role lacks EXECUTE';
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'migration 54 verification failed: anon retains EXECUTE';
    END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'migration 54 verification failed: authenticated retains EXECUTE';
    END IF;

    RAISE NOTICE 'migration 54 verification passed';
END $$;

-- =============================================================
-- 5. REGISTRY
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
    '54_booking_fee_writer',
    '54_booking_fee_writer.sql',
    'Phase 3 (P0-04 / B2): create_booking now persists booking_fee_inr '
    'from the platform fee (COALESCE(p_platform_fee, 0)) so the refund '
    'basis is no longer silently 0 for bookings created after migration '
    '28; deterministic idempotent backfill repairs existing zero-valued '
    'rows from platform_fee_snapshot; body otherwise identical to '
    'migration 39 (signature/parameter order unchanged); SECURITY '
    'DEFINER create_booking restated service_role-only per F16-04 and '
    'verified against pg_proc; does NOT decide NPD-02 (the '
    'create-payment-order total_amount_snapshot vs booking_fee_inr basis '
    'inconsistency is left as a recorded product ruling)',
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
