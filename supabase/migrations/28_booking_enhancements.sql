-- =============================================================
-- SETURA HOSPITAL OS
-- Script 28: Booking Enhancements + Booking Fee Policy
-- Run AFTER Script 27
-- =============================================================
-- PURPOSE:
--   Part A - Adds missing business-model columns to bookings:
--     booking_fee_inr, consultation_fee_inr, paid_online,
--     payment_status_detail, gst_amount_inr, gateway_fee_inr
--   Part B - Creates booking_fee_policies per hospital with
--     full fee, GST, and refund window configuration.
-- =============================================================
-- CRITICAL: SETURA only collects booking_fee_inr.
--           consultation_fee_inr is INFORMATIONAL ONLY.
-- =============================================================

BEGIN;

-- ============================================================
-- PART A: bookings TABLE ENHANCEMENTS
-- ============================================================

-- Amount SETURA collects from patient online
ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS booking_fee_inr NUMERIC(10,2)
        NOT NULL DEFAULT 0 CHECK (booking_fee_inr >= 0);

COMMENT ON COLUMN public.bookings.booking_fee_inr IS
'The fee SETURA charges the patient and collects via Razorpay.
 This is the ONLY money SETURA receives for this booking.';

-- What patient pays the hospital directly (display only)
ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS consultation_fee_inr NUMERIC(10,2)
        CHECK (consultation_fee_inr IS NULL OR consultation_fee_inr >= 0);

COMMENT ON COLUMN public.bookings.consultation_fee_inr IS
'INFORMATIONAL ONLY. Patient pays this directly to the hospital.
 SETURA never collects or processes this amount.';

-- Explicit online payment flag
ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS paid_online BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.bookings.paid_online IS
'TRUE when patient paid SETURA online via Razorpay.
 Distinct from payment_completed which may include walkin/manual.';

-- Granular payment lifecycle status
ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS payment_status_detail TEXT
        CHECK (payment_status_detail IS NULL OR payment_status_detail IN (
            'not_applicable',
            'awaiting_payment',
            'payment_initiated',
            'payment_captured',
            'payment_failed',
            'refund_initiated',
            'refund_processed',
            'refund_failed'
        ));

-- GST collected by SETURA on booking fee
ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS gst_amount_inr NUMERIC(10,2)
        NOT NULL DEFAULT 0 CHECK (gst_amount_inr >= 0);

-- Razorpay processing fee (for internal reconciliation)
ALTER TABLE public.bookings
    ADD COLUMN IF NOT EXISTS gateway_fee_inr NUMERIC(10,2)
        NOT NULL DEFAULT 0 CHECK (gateway_fee_inr >= 0);

-- Backfill paid_online from existing payment_completed
UPDATE public.bookings
   SET paid_online = payment_completed
 WHERE paid_online IS DISTINCT FROM payment_completed;

-- Backfill booking_fee_inr from fee snapshots for existing paid rows
UPDATE public.bookings
   SET booking_fee_inr = COALESCE(
       platform_fee_snapshot,
       0
   )
 WHERE booking_fee_inr = 0
   AND payment_completed = true;

-- Backfill payment_status_detail
UPDATE public.bookings
   SET payment_status_detail = CASE
       WHEN booking_source IN ('walkin','manual_free') THEN 'not_applicable'
       WHEN payment_completed = true                   THEN 'payment_captured'
       ELSE                                                 'awaiting_payment'
   END
 WHERE payment_status_detail IS NULL;

-- ============================================================
-- PART B: booking_fee_policies TABLE
-- One row per hospital; auto-created on hospital insert
-- ============================================================

CREATE TABLE IF NOT EXISTS public.booking_fee_policies (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL UNIQUE
        REFERENCES public.hospitals(id) ON DELETE CASCADE,

    -- Per-source booking fees (SETURA revenue only)
    booking_fee_online      NUMERIC(10,2) NOT NULL DEFAULT 20
        CHECK (booking_fee_online     >= 0),
    booking_fee_whatsapp    NUMERIC(10,2) NOT NULL DEFAULT 10
        CHECK (booking_fee_whatsapp   >= 0),
    booking_fee_walkin      NUMERIC(10,2) NOT NULL DEFAULT 0
        CHECK (booking_fee_walkin     >= 0),
    booking_fee_enabled     BOOLEAN       NOT NULL DEFAULT true,

    -- GST on SETURA's booking fee
    gst_enabled             BOOLEAN       NOT NULL DEFAULT false,
    gst_percentage          NUMERIC(5,2)  NOT NULL DEFAULT 18.00
        CHECK (gst_percentage BETWEEN 0 AND 100),

    -- Refund configuration
    refund_window_minutes   INTEGER       NOT NULL DEFAULT 1440
        CHECK (refund_window_minutes >= 0),
    refund_on_cancellation  BOOLEAN       NOT NULL DEFAULT true,

    -- Consultation fee for display to patient
    -- SETURA NEVER COLLECTS THIS
    default_consultation_fee_inr NUMERIC(10,2)
        CHECK (default_consultation_fee_inr IS NULL
            OR default_consultation_fee_inr >= 0),
    collect_consultation_at_hospital BOOLEAN NOT NULL DEFAULT true,

    -- Razorpay gateway fee passthrough (optional display)
    include_gateway_fee       BOOLEAN       NOT NULL DEFAULT false,
    gateway_fee_percentage    NUMERIC(5,3)  NOT NULL DEFAULT 2.000
        CHECK (gateway_fee_percentage BETWEEN 0 AND 10),

    metadata    JSONB NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(metadata) = 'object'),

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NOTE: no separate index needed on hospital_id - the UNIQUE
-- constraint above already creates a unique btree index covering it.

DROP TRIGGER IF EXISTS trg_booking_fee_policies_updated_at
    ON public.booking_fee_policies;
CREATE TRIGGER trg_booking_fee_policies_updated_at
    BEFORE UPDATE ON public.booking_fee_policies
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- AUTO-CREATE BOOKING FEE POLICY ON HOSPITAL INSERT
-- ============================================================

CREATE OR REPLACE FUNCTION public.auto_create_booking_fee_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.booking_fee_policies (hospital_id)
    VALUES (NEW.id)
    ON CONFLICT (hospital_id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_booking_fee_policy ON public.hospitals;
CREATE TRIGGER trg_auto_booking_fee_policy
    AFTER INSERT ON public.hospitals
    FOR EACH ROW EXECUTE FUNCTION public.auto_create_booking_fee_policy();

-- Backfill for existing hospitals using current hospital_settings values
INSERT INTO public.booking_fee_policies (
    hospital_id,
    booking_fee_online,
    booking_fee_whatsapp
)
SELECT
    h.id,
    COALESCE(hs.platform_fee_online,    20),
    COALESCE(hs.platform_fee_whatsapp,  10)
FROM  public.hospitals        h
LEFT JOIN public.hospital_settings hs ON hs.hospital_id = h.id
WHERE h.deleted_at IS NULL
ON CONFLICT (hospital_id) DO NOTHING;

-- ============================================================
-- get_booking_fee(hospital_id, booking_source)
-- Returns the full fee breakdown for a booking
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_booking_fee(
    p_hospital_id    UUID,
    p_booking_source public.booking_source
)
RETURNS TABLE (
    booking_fee   NUMERIC(10,2),
    gst_amount    NUMERIC(10,2),
    total_fee     NUMERIC(10,2),
    consultation_fee             NUMERIC(10,2),
    collect_consultation_at_hospital BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH base AS (
        SELECT
            CASE
                WHEN NOT bfp.booking_fee_enabled    THEN 0
                WHEN p_booking_source = 'online'    THEN bfp.booking_fee_online
                WHEN p_booking_source = 'manual_whatsapp' THEN bfp.booking_fee_whatsapp
                WHEN p_booking_source = 'walkin'    THEN bfp.booking_fee_walkin
                ELSE 0
            END::NUMERIC(10,2)  AS base_fee,
            bfp.gst_enabled,
            bfp.gst_percentage,
            bfp.default_consultation_fee_inr,
            bfp.collect_consultation_at_hospital
        FROM public.booking_fee_policies bfp
        WHERE bfp.hospital_id = p_hospital_id
        LIMIT 1
    )
    SELECT
        b.base_fee,
        CASE WHEN b.gst_enabled
             THEN ROUND(b.base_fee * b.gst_percentage / 100, 2)
             ELSE 0
        END::NUMERIC(10,2),
        b.base_fee
            + CASE WHEN b.gst_enabled
                   THEN ROUND(b.base_fee * b.gst_percentage / 100, 2)
                   ELSE 0
              END,
        b.default_consultation_fee_inr,
        b.collect_consultation_at_hospital
    FROM base b;
$$;

REVOKE ALL     ON FUNCTION public.get_booking_fee(UUID, public.booking_source) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_booking_fee(UUID, public.booking_source) TO authenticated;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE public.booking_fee_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_fee_policies FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bfp_read   ON public.booking_fee_policies;
CREATE POLICY        bfp_read
    ON public.booking_fee_policies FOR SELECT
    USING (
        public.is_global_admin()
        OR public.user_has_hospital_access(hospital_id)
    );

DROP POLICY IF EXISTS bfp_manage ON public.booking_fee_policies;
CREATE POLICY        bfp_manage
    ON public.booking_fee_policies FOR ALL
    USING (
        public.is_global_admin()
        OR public.current_user_role(hospital_id) = 'hospital_admin'
    )
    WITH CHECK (
        public.is_global_admin()
        OR public.current_user_role(hospital_id) = 'hospital_admin'
    );

COMMIT;
