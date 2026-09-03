-- =============================================================
-- SETURA HOSPITAL OS
-- Script 29: Cancellation Policy Engine
-- Run AFTER Script 28
-- =============================================================
-- PURPOSE: Per-hospital configurable refund tiers.
--   - Free cancellation within N minutes -> 100% refund of booking_fee
--   - Partial refund up to M minutes
--   - Same-day cancellation -> configurable %
--   - No refund beyond window
--   - No-show penalty flag
-- NOTE: Refunds apply ONLY to booking_fee_inr.
--       SETURA never processes consultation fee refunds.
-- =============================================================

BEGIN;

-- ============================================================
-- CANCELLATION POLICIES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cancellation_policies (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL UNIQUE
        REFERENCES public.hospitals(id) ON DELETE CASCADE,

    -- Tier 1: full refund window
    full_refund_within_minutes      INTEGER NOT NULL DEFAULT 30
        CHECK (full_refund_within_minutes >= 0),

    -- Tier 2: partial refund window
    partial_refund_percentage       NUMERIC(5,2) NOT NULL DEFAULT 50.00
        CHECK (partial_refund_percentage BETWEEN 0 AND 100),
    partial_refund_within_minutes   INTEGER NOT NULL DEFAULT 1440
        CHECK (partial_refund_within_minutes >= 0),

    -- Same-day cancellation (overrides tiers if appointment is today)
    same_day_refund_percentage      NUMERIC(5,2) NOT NULL DEFAULT 0
        CHECK (same_day_refund_percentage BETWEEN 0 AND 100),

    -- No-show penalty (deducted from any future refund)
    no_show_penalty_enabled         BOOLEAN      NOT NULL DEFAULT false,
    no_show_penalty_amount_inr      NUMERIC(10,2) NOT NULL DEFAULT 0
        CHECK (no_show_penalty_amount_inr >= 0),

    -- Allow hospital_admin to grant a manual full refund
    allow_manual_full_refund        BOOLEAN      NOT NULL DEFAULT true,

    -- Policy versioning for audit trail
    version         INTEGER      NOT NULL DEFAULT 1 CHECK (version > 0),
    effective_from  DATE         NOT NULL DEFAULT CURRENT_DATE,
    notes           TEXT,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(metadata) = 'object'),

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_refund_tiers
        CHECK (full_refund_within_minutes <= partial_refund_within_minutes)
);

CREATE INDEX IF NOT EXISTS idx_cancellation_policies_hospital
    ON public.cancellation_policies (hospital_id);

DROP TRIGGER IF EXISTS trg_cancellation_policies_updated_at
    ON public.cancellation_policies;
CREATE TRIGGER trg_cancellation_policies_updated_at
    BEFORE UPDATE ON public.cancellation_policies
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- POLICY VERSION HISTORY
-- ============================================================

CREATE TABLE IF NOT EXISTS public.cancellation_policy_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id     UUID NOT NULL
        REFERENCES public.hospitals(id) ON DELETE CASCADE,
    version         INTEGER NOT NULL,
    policy_snapshot JSONB   NOT NULL
        CHECK (jsonb_typeof(policy_snapshot) = 'object'),
    changed_by      UUID
        REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cancel_policy_history
    ON public.cancellation_policy_history (hospital_id, created_at DESC);

-- Capture old version before each UPDATE
CREATE OR REPLACE FUNCTION public.capture_cancellation_policy_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    INSERT INTO public.cancellation_policy_history (
        hospital_id,
        version,
        policy_snapshot,
        changed_by
    )
    VALUES (
        OLD.hospital_id,
        OLD.version,
        to_jsonb(OLD),
        auth.uid()
    );

    RETURN NEW;

END;
$$;

DROP TRIGGER IF EXISTS trg_cancel_policy_history ON public.cancellation_policies;
CREATE TRIGGER trg_cancel_policy_history
    AFTER UPDATE ON public.cancellation_policies
    FOR EACH ROW
    WHEN (OLD.version IS DISTINCT FROM NEW.version)
    EXECUTE FUNCTION public.capture_cancellation_policy_history();

-- ============================================================
-- AUTO-CREATE DEFAULT POLICY ON HOSPITAL INSERT
-- ============================================================

CREATE OR REPLACE FUNCTION public.auto_create_cancellation_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.cancellation_policies (hospital_id)
    VALUES (NEW.id)
    ON CONFLICT (hospital_id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_cancellation_policy ON public.hospitals;
CREATE TRIGGER trg_auto_cancellation_policy
    AFTER INSERT ON public.hospitals
    FOR EACH ROW EXECUTE FUNCTION public.auto_create_cancellation_policy();

-- Backfill existing hospitals
INSERT INTO public.cancellation_policies (hospital_id)
SELECT id FROM public.hospitals WHERE deleted_at IS NULL
ON CONFLICT (hospital_id) DO NOTHING;

-- ============================================================
-- calculate_refund_amount(booking_id, cancellation_time)
-- Returns the refund amount SETURA owes the patient
-- ============================================================

CREATE OR REPLACE FUNCTION public.calculate_refund_amount(
    p_booking_id        UUID,
    p_cancellation_time TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (
    refund_amount      NUMERIC(10,2),
    refund_percentage  NUMERIC(5,2),
    refund_reason      TEXT,
    is_eligible        BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_booking RECORD;
    v_policy  RECORD;
    v_minutes NUMERIC;
    v_paid    NUMERIC(10,2);
BEGIN
    -- Load booking
    SELECT b.*
    INTO v_booking
    FROM public.bookings b
    WHERE b.id = p_booking_id
    AND b.is_deleted = false
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 0::NUMERIC(10,2), 0::NUMERIC(5,2),
                            'Booking not found'::TEXT, false;
        RETURN;
    END IF;

    IF NOT v_booking.payment_completed THEN
        RETURN QUERY SELECT 0::NUMERIC(10,2), 0::NUMERIC(5,2),
                            'No payment on record'::TEXT, false;
        RETURN;
    END IF;

    v_paid := COALESCE(v_booking.booking_fee_inr, 0);

    -- Load policy
    SELECT * INTO v_policy
      FROM public.cancellation_policies
     WHERE hospital_id = v_booking.hospital_id
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN QUERY SELECT v_paid, 100::NUMERIC(5,2),
                            'No policy defined - full refund'::TEXT, true;
        RETURN;
    END IF;

    -- Minutes since booking was created
    v_minutes := EXTRACT(EPOCH FROM ((v_booking.appointment_date::timestamp) - p_cancellation_time)) / 60;

    IF v_minutes < 0 THEN
        RETURN QUERY
        SELECT
            0::NUMERIC(10,2),
            0::NUMERIC(5,2),
            'Appointment already passed'::TEXT,
            false;
        RETURN;
    END IF;


    -- Same-day rule (appointment is today)

    IF v_booking.appointment_date = p_cancellation_time::DATE THEN
        RETURN QUERY
        SELECT
            ROUND(
                v_paid * v_policy.same_day_refund_percentage / 100,
                2
            )::NUMERIC(10,2),
            v_policy.same_day_refund_percentage,
            FORMAT(
                'Same-day cancellation: %s%% refund',
                v_policy.same_day_refund_percentage
            )::TEXT,
            true;

        RETURN;
    END IF;

    -- Tier 1: full refund
    IF v_minutes <= v_policy.full_refund_within_minutes THEN
        RETURN QUERY
        SELECT v_paid, 100::NUMERIC(5,2),
               FORMAT('Cancelled within %s min: full refund',
                      v_policy.full_refund_within_minutes)::TEXT,
               true;
        RETURN;
    END IF;

    -- Tier 2: partial refund
    IF v_minutes <= v_policy.partial_refund_within_minutes THEN
        RETURN QUERY
        SELECT ROUND(v_paid * v_policy.partial_refund_percentage / 100, 2)::NUMERIC(10,2),
               v_policy.partial_refund_percentage,
               FORMAT('Cancelled within %s min: %s%% refund',
                      v_policy.partial_refund_within_minutes,
                      v_policy.partial_refund_percentage)::TEXT,
               true;
        RETURN;
    END IF;

    
    -- Beyond all windows: no refund
    RETURN QUERY
    SELECT 0::NUMERIC(10,2), 0::NUMERIC(5,2),
           'Cancellation window expired: no refund'::TEXT, false;
END;
$$;

REVOKE ALL     ON FUNCTION public.calculate_refund_amount(UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.calculate_refund_amount(UUID, TIMESTAMPTZ) TO authenticated;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE public.cancellation_policies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cancellation_policies        FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.cancellation_policy_history  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cancellation_policy_history  FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cp_read   ON public.cancellation_policies;
CREATE POLICY        cp_read
    ON public.cancellation_policies FOR SELECT
    USING (
        public.is_global_admin()
        OR public.user_has_hospital_access(hospital_id)
    );

DROP POLICY IF EXISTS cp_manage ON public.cancellation_policies;
CREATE POLICY        cp_manage
    ON public.cancellation_policies FOR ALL
    USING      (public.is_global_admin() OR public.current_user_role(hospital_id) = 'hospital_admin')
    WITH CHECK (public.is_global_admin() OR public.current_user_role(hospital_id) = 'hospital_admin');

DROP POLICY IF EXISTS cph_read  ON public.cancellation_policy_history;
CREATE POLICY        cph_read
    ON public.cancellation_policy_history FOR SELECT
    USING (
        public.is_global_admin()
        OR public.current_user_role(hospital_id) = 'hospital_admin'
    );

COMMIT;
