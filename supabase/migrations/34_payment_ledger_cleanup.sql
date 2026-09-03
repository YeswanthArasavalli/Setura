-- =============================================================
-- SETURA HOSPITAL OS
-- Script 34: Payment Ledger Type Cleanup (v2 - Enterprise Refactor)
-- Run AFTER Script 33
-- =============================================================
-- PROBLEM: ledger_entry_type enum (Script 13) contains:
--   * hospital_fee_credit  - SETURA never credits hospitals
--   * settlement_debit     - semantics broken (Script 33 fix)
--
-- RESOLUTION:
--   * Add new enum values (PostgreSQL cannot remove existing ones)
--   * Document deprecated values with COMMENT ON TYPE
--   * Add gateway_fee_debit and gst_debit support to capture_payment()
--   * Add get_platform_revenue_breakdown() for SETURA internal reporting
--
-- v2 CRITICAL FIX (Enterprise Refactor):
--   v1 of this script defined a function also named
--   get_reconciliation_summary(p_hospital_id, p_from_date, p_to_date)
--   - but migration 13 ALREADY defines a function with that EXACT
--   name and parameter signature, returning an 8-column TABLE
--   (total_collected, platform_fee_total, receptionist_fee_total,
--   total_refunded, total_settled, net_outstanding, booking_count,
--   paid_booking_count). v1's version returned a DIFFERENT 7-column
--   shape. CREATE OR REPLACE FUNCTION cannot change a return type,
--   so deploying v1 would have thrown:
--     ERROR: cannot change return type of existing function
--
--   FIX: migration 13's get_reconciliation_summary() is left
--   completely untouched. The new gateway-fee/GST breakdown report
--   is exposed under a distinct name: get_platform_revenue_breakdown().
--
-- ACTIVE LEDGER TYPES after this script:
--   booking_fee_collected       Patient paid SETURA via Razorpay
--   platform_fee_credit         SETURA platform revenue credit
--   receptionist_incentive_credit  Receptionist WhatsApp incentive
--   refund_debit                Refund issued back to patient
--   gateway_fee_debit           Razorpay processing fee deducted
--   gst_debit                   GST liability on booking fee
--   adjustment                  Manual correction entry
--
-- DEPRECATED (do not use in new code):
--   hospital_fee_credit         SETURA does not credit hospitals
--   settlement_debit            Superseded by Script 33 model
--   (get_reconciliation_summary's `total_settled` column will read
--   as 0 going forward since no code writes settlement_debit anymore
--   - this is expected and does not need a migration patch.)
-- =============================================================

-- Transaction 1: add enum values, then COMMIT.
-- (Transaction 2 with dependent function definitions starts
--  immediately after the COMMIT above the COMMENT block.)
-- PostgreSQL allows ADD VALUE; removal is impossible without
-- recreating the type - leave deprecated values in place.
--
-- IMPORTANT: enum values added in a transaction cannot be
-- referenced by anything created in that SAME transaction.
-- plpgsql bodies tolerate this (parsed at first execution), but
-- LANGUAGE sql functions are validated at creation time and fail
-- with "unsafe use of new value of enum type" (SQLSTATE 55P04).
-- Therefore this script commits after adding the values and
-- creates the dependent functions in a second transaction.
-- ============================================================

BEGIN;

DO $$
BEGIN
    ALTER TYPE public.ledger_entry_type
        ADD VALUE IF NOT EXISTS 'gateway_fee_debit';
EXCEPTION
    WHEN duplicate_object THEN
        NULL;
END;
$$;

DO $$
BEGIN
    ALTER TYPE public.ledger_entry_type
        ADD VALUE IF NOT EXISTS 'gst_debit';
EXCEPTION
    WHEN duplicate_object THEN
        NULL;
END;
$$;

-- Commit so the new enum values are visible to the function
-- definitions in the next transaction.
COMMIT;

BEGIN;

COMMENT ON TYPE public.ledger_entry_type IS
'Financial ledger entry classifications for financial_ledger table.

ACTIVE (use in new code):
  booking_fee_collected       Patient paid booking fee to SETURA via Razorpay
  platform_fee_credit         SETURA platform fee revenue
  receptionist_incentive_credit  WhatsApp booking receptionist incentive
  refund_debit                Refund returned to patient
  gateway_fee_debit           Razorpay processing fee deducted from collection
  gst_debit                   GST liability on booking fee (SETURA tax)
  adjustment                  Manual correction / reconciliation entry

DEPRECATED (retained for data integrity, do not write new rows):
  hospital_fee_credit         SETURA does not credit hospitals - use adjustment
  settlement_debit            Model changed in Script 33';

-- ============================================================
-- ENHANCED capture_payment()
-- Original (Script 13): capture_payment(TEXT,TEXT,TEXT,JSONB)
-- New 5-arg overload adds: p_gateway_fee_inr for Razorpay's actual fee.
-- The original 4-arg signature is preserved and now delegates to the
-- 5-arg version with NULL (which falls back to a 2% estimate) - fully
-- backward compatible with existing Edge Function calls.
-- ============================================================

CREATE OR REPLACE FUNCTION public.capture_payment(
    p_gateway_order_id   TEXT,
    p_gateway_payment_id TEXT,
    p_gateway_signature  TEXT,
    p_gateway_response   JSONB,
    p_gateway_fee_inr    NUMERIC DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order       RECORD;
    v_gateway_fee NUMERIC(10,2);
    v_gst_amount  NUMERIC(10,2);
    v_gst_pct     NUMERIC(5,2);
    v_gst_on      BOOLEAN;
BEGIN
    -- Lock the order row. payment_orders already carries its own
    -- hospital_id (migration 13) - no join to bookings is needed here.
    SELECT *
      INTO v_order
      FROM public.payment_orders
     WHERE gateway_order_id = p_gateway_order_id
       AND payment_status NOT IN ('captured', 'refunded')
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- Razorpay fee: use the value the webhook gave us, or estimate 2%
    v_gateway_fee := COALESCE(
        p_gateway_fee_inr,
        ROUND(
            (v_order.amount_inr * 0.02)::NUMERIC,
            2
        )
    );

    -- GST: look up hospital's booking fee policy (Script 28), if any
    SELECT
        bfp.gst_enabled,
        bfp.gst_percentage
    INTO
        v_gst_on,
        v_gst_pct
    FROM public.booking_fee_policies bfp
    WHERE bfp.hospital_id = v_order.hospital_id
    ORDER BY bfp.created_at DESC
    LIMIT 1;

    IF FOUND AND v_gst_on THEN
        v_gst_amount := ROUND(
            (
                v_order.amount_inr
                * v_gst_pct
                / 100
            )::NUMERIC,
            2
        );
    ELSE
        v_gst_amount := 0::NUMERIC(10,2);
    END IF;

    -- Update payment order
    UPDATE public.payment_orders
       SET payment_status       = 'captured',
           gateway_payment_id   = p_gateway_payment_id,
           gateway_signature    = p_gateway_signature,
           captured_at          = now(),
           gateway_response     = p_gateway_response,
           updated_at           = now()
     WHERE id = v_order.id;

    -- Update booking
    UPDATE public.bookings
       SET payment_completed       = true,
           paid_online             = true,
           payment_reference       = p_gateway_payment_id,
           payment_status_detail   = 'payment_captured',
           gateway_fee_inr         = v_gateway_fee,
           gst_amount_inr          = v_gst_amount,
           updated_at              = now()
     WHERE id = v_order.booking_id;

    -- Ledger: booking fee collected (unchanged from migration 13)
    INSERT INTO public.financial_ledger (
        hospital_id, booking_id, payment_order_id,
        entry_type, amount_inr, is_credit,
        description, reference
    ) VALUES (
        v_order.hospital_id, v_order.booking_id, v_order.id,
        'booking_fee_collected', v_order.amount_inr, true,
        'Payment captured', p_gateway_payment_id
    );

    -- Ledger: gateway fee debit (Razorpay processing cost) - NEW
    IF v_gateway_fee > 0 THEN
        INSERT INTO public.financial_ledger (
            hospital_id, booking_id, payment_order_id,
            entry_type, amount_inr, is_credit,
            description, reference
        ) VALUES (
            v_order.hospital_id, v_order.booking_id, v_order.id,
            'gateway_fee_debit', v_gateway_fee, false,
            'Razorpay processing fee', p_gateway_payment_id
        );
    END IF;

    -- Ledger: GST debit (SETURA tax liability) - NEW
    IF v_gst_amount > 0 THEN
        INSERT INTO public.financial_ledger (
            hospital_id, booking_id, payment_order_id,
            entry_type, amount_inr, is_credit,
            description, reference
        ) VALUES (
            v_order.hospital_id, v_order.booking_id, v_order.id,
            'gst_debit', v_gst_amount, false,
            FORMAT('GST %s%% on booking fee', v_gst_pct), p_gateway_payment_id
        );
    END IF;

    RETURN TRUE;
END;
$$;

REVOKE ALL     ON FUNCTION public.capture_payment(TEXT,TEXT,TEXT,JSONB,NUMERIC) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.capture_payment(TEXT,TEXT,TEXT,JSONB,NUMERIC) TO authenticated;

-- Backward-compatible 4-arg signature: delegates to the 5-arg version
CREATE OR REPLACE FUNCTION public.capture_payment(
    p_gateway_order_id   TEXT,
    p_gateway_payment_id TEXT,
    p_gateway_signature  TEXT,
    p_gateway_response   JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.capture_payment(
        p_gateway_order_id, p_gateway_payment_id,
        p_gateway_signature, p_gateway_response, NULL
    );
$$;

REVOKE ALL     ON FUNCTION public.capture_payment(TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.capture_payment(TEXT,TEXT,TEXT,JSONB) TO authenticated;

-- ============================================================
-- get_platform_revenue_breakdown(hospital_id, from_date, to_date)
-- SETURA internal gateway-fee/GST revenue report.
--
-- NOT a replacement for migration 13's get_reconciliation_summary()
-- - that function is left untouched. This is a distinctly-named,
-- additive report focused on the gateway fee and GST entries this
-- script introduces.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_platform_revenue_breakdown(
    p_hospital_id UUID,
    p_from_date   DATE,
    p_to_date     DATE
)
RETURNS TABLE (
    total_collected      NUMERIC,
    gateway_fees         NUMERIC,
    gst_collected        NUMERIC,
    refunds_issued       NUMERIC,
    net_setura_revenue   NUMERIC,
    booking_count        INTEGER,
    paid_booking_count   INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        COALESCE(SUM(fl.amount_inr)
            FILTER (WHERE fl.entry_type = 'booking_fee_collected'
                      AND fl.is_credit  = true),           0) AS total_collected,

        COALESCE(SUM(fl.amount_inr)
            FILTER (WHERE fl.entry_type = 'gateway_fee_debit'
                      AND fl.is_credit  = false),          0) AS gateway_fees,

        COALESCE(SUM(fl.amount_inr)
            FILTER (WHERE fl.entry_type = 'gst_debit'
                      AND fl.is_credit  = false),          0) AS gst_collected,

        COALESCE(SUM(fl.amount_inr)
            FILTER (WHERE fl.entry_type = 'refund_debit'
                      AND fl.is_credit  = false),          0) AS refunds_issued,

        COALESCE(
            SUM(
                CASE
                    WHEN fl.entry_type IN (
                        'booking_fee_collected',
                        'platform_fee_credit',
                        'receptionist_incentive_credit'
                    )
                    THEN fl.amount_inr

                    WHEN fl.entry_type IN (
                        'refund_debit',
                        'gateway_fee_debit',
                        'gst_debit'
                    )
                    THEN -fl.amount_inr

                    ELSE 0
                END
            ),
            0
        ) AS net_setura_revenue,

        COUNT(DISTINCT b.id)::INTEGER                        AS booking_count,

        COUNT(DISTINCT b.id)
            FILTER (WHERE b.payment_completed = true)::INTEGER AS paid_booking_count

    FROM public.financial_ledger fl
    LEFT JOIN public.bookings b ON b.id = fl.booking_id

    WHERE fl.hospital_id      = p_hospital_id
      AND fl.created_at::DATE BETWEEN p_from_date AND p_to_date;
$$;

REVOKE ALL     ON FUNCTION public.get_platform_revenue_breakdown(UUID,DATE,DATE) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_platform_revenue_breakdown(UUID,DATE,DATE) TO authenticated;

COMMIT;
