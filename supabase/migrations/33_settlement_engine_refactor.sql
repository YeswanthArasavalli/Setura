-- =============================================================
-- SETURA HOSPITAL OS
-- Script 33: Settlement Engine Refactor (Business Model Fix)
-- Run AFTER Script 32
-- =============================================================
-- PROBLEM: Migration 07 assumed:
--     Patient -> pays hospital -> hospital pays SETURA platform fee
--
-- REALITY (SETURA model):
--     Patient -> pays SETURA via Razorpay (booking_fee only)
--     Patient -> pays hospital directly (consultation fee)
--
-- CONSEQUENCE:
--     hospital_settlements.amount_paid_to_setura is semantically
--     wrong - SETURA already HAS the money via Razorpay capture.
--     There is no "hospital paying SETURA" flow for online bookings.
--
-- RESOLUTION: Option B - Convert to Platform Revenue Summaries.
--     * daily_collection_entries -> add setura_revenue generated column
--     * hospital_settlements     -> add settlement_type column
--     * create_hospital_settlement() -> deprecated with NOTICE
--     * record_settlement_payment()  -> deprecated with NOTICE (no-op)
--     * NEW: create_platform_revenue_summary() - correct replacement
--
-- BACKWARD COMPATIBILITY:
--     All existing tables and columns are preserved.
--     unique_settlement_period constraint is extended to include
--     settlement_type to allow both legacy and new rows per period.
-- =============================================================

BEGIN;

-- ============================================================
-- STEP 1: Clarify daily_collection_entries semantics
-- ============================================================

COMMENT ON COLUMN public.daily_collection_entries.hospital_fee IS
'INFORMATIONAL ONLY. SETURA never collects this amount.
Patients pay consultation fees directly to the hospital.
This column reflects what the doctor charges - not SETURA revenue.';

-- Add setura_revenue as a generated column (platform_fee + receptionist_fee)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'daily_collection_entries'
          AND column_name = 'setura_revenue'
    ) THEN

        ALTER TABLE public.daily_collection_entries
        ADD COLUMN setura_revenue NUMERIC(12,2)
        GENERATED ALWAYS AS (
            COALESCE(platform_fee, 0)
          + COALESCE(receptionist_fee, 0)
        ) STORED;

    END IF;
END;
$$;

COMMENT ON COLUMN public.daily_collection_entries.setura_revenue IS
'SETURA actual revenue for this booking: platform_fee + receptionist_fee.
This is what SETURA receives via Razorpay. hospital_fee is excluded.';

-- ============================================================
-- STEP 2: Add settlement_type to hospital_settlements
-- ============================================================

ALTER TABLE public.hospital_settlements
    ADD COLUMN IF NOT EXISTS settlement_type TEXT
        NOT NULL DEFAULT 'platform_revenue_summary'
        CHECK (settlement_type IN (
            'platform_revenue_summary',
            'legacy_hospital_settlement'
        ));

COMMENT ON TABLE public.hospital_settlements IS
'REPURPOSED in Script 33. Was designed for hospital-to-SETURA payment tracking.
Now stores SETURA platform revenue summaries per hospital per billing period.
amount_paid_to_setura = total SETURA revenue already captured via Razorpay.
remaining_due = always 0 in the online payment model.';

COMMENT ON COLUMN public.hospital_settlements.amount_paid_to_setura IS
'REPURPOSED: Total SETURA revenue already captured via Razorpay for this period.
This is NOT money the hospital owes SETURA - SETURA already has it.';

COMMENT ON COLUMN public.hospital_settlements.remaining_due IS
'Always 0 in the SETURA online payment model (money captured at booking time).
Retained for schema compatibility.';

-- Extend unique constraint to include settlement_type
-- (allows a new platform_revenue_summary alongside any legacy row)
ALTER TABLE public.hospital_settlements
    DROP CONSTRAINT IF EXISTS unique_settlement_period;

ALTER TABLE public.hospital_settlements
    ADD CONSTRAINT unique_settlement_period
        UNIQUE (hospital_id, settlement_start_date, settlement_end_date, settlement_type);

COMMENT ON TABLE public.outstanding_balances IS
'REPURPOSED in Script 33. No longer tracks money hospitals owe SETURA.
Now tracks hospital booking periods that have not yet been summarised.
total_outstanding = SETURA revenue from unsummarised collection entries.';

-- ============================================================
-- STEP 3: Deprecate create_hospital_settlement()
-- Retained for backward compatibility; emits NOTICE on every call
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_hospital_settlement(
    p_hospital_id UUID,
    p_start_date  DATE,
    p_end_date    DATE,
    p_collected_by UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_sid UUID;
BEGIN
    RAISE NOTICE
        'DEPRECATED: create_hospital_settlement() has been repurposed. '
        'Use create_platform_revenue_summary() for new code. '
        'This function now delegates to the replacement implementation.';

    -- Delegate to the new function
    SELECT public.create_platform_revenue_summary(
        p_hospital_id, p_start_date, p_end_date, p_collected_by
    ) INTO v_sid;

    RETURN v_sid;
END;
$$;

-- ============================================================
-- STEP 4: Deprecate record_settlement_payment()
-- In the online-payment model this function is a no-op
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_settlement_payment(
    p_settlement_id UUID,
    p_paid_amount   NUMERIC,
    p_performed_by  UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RAISE NOTICE
        'DEPRECATED: record_settlement_payment() is a no-op in the SETURA model. '
        'SETURA collects booking fees directly via Razorpay at the time of booking. '
        'There is no hospital-to-SETURA payment flow for online bookings.';
    RETURN FALSE;
END;
$$;

-- ============================================================
-- STEP 5: create_platform_revenue_summary()
-- Correct replacement - closes a billing period, marks
-- collection entries as settled, records SETURA's revenue.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_platform_revenue_summary(
    p_hospital_id  UUID,
    p_start_date   DATE,
    p_end_date     DATE,
    p_performed_by UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_sid              UUID;
    v_platform_total   NUMERIC(14,2);
    v_receptionist_total NUMERIC(14,2);
    v_setura_total     NUMERIC(14,2);
    v_booking_count    INTEGER;
BEGIN
    IF p_end_date < p_start_date THEN
        RAISE EXCEPTION 'Invalid date range: start_date must be <= end_date';
    END IF;

    -- Advisory lock per hospital+period to prevent concurrent duplicates
    PERFORM pg_advisory_xact_lock(
        hashtextextended(
            'rev_summary_' ||
            p_hospital_id::TEXT ||
            p_start_date::TEXT ||
            p_end_date::TEXT,
            0
        )
    );

    IF EXISTS (
        SELECT 1 FROM public.hospital_settlements
         WHERE hospital_id           = p_hospital_id
           AND settlement_start_date = p_start_date
           AND settlement_end_date   = p_end_date
           AND settlement_type       = 'platform_revenue_summary'
    ) THEN
        RAISE EXCEPTION 'Platform revenue summary already exists for this period';
    END IF;

    -- Lock rows to prevent concurrent modification
    PERFORM 1
      FROM public.daily_collection_entries
     WHERE hospital_id    = p_hospital_id
       AND collection_date BETWEEN p_start_date AND p_end_date
       AND is_settled      = false
    FOR UPDATE;

    -- Aggregate
    SELECT
        COALESCE(SUM(platform_fee),    0),
        COALESCE(SUM(receptionist_fee),0),
        COALESCE(SUM(setura_revenue),  0),
        COUNT(*)::INTEGER
    INTO v_platform_total, v_receptionist_total, v_setura_total, v_booking_count
      FROM public.daily_collection_entries
     WHERE hospital_id    = p_hospital_id
       AND collection_date BETWEEN p_start_date AND p_end_date
       AND is_settled      = false;

    IF v_booking_count = 0 THEN
        RAISE EXCEPTION
            'No unsettled collection entries found for this period';
    END IF;

    -- Insert summary
    INSERT INTO public.hospital_settlements (
        hospital_id,
        settlement_start_date,
        settlement_end_date,
        total_platform_amount,
        total_receptionist_amount,
        total_bookings,
        amount_paid_to_setura,   -- Already received via Razorpay
        remaining_due,           -- Always 0 in online model
        settlement_status,       -- 'paid' because SETURA already has the money
        paid_at,
        collected_by,
        settlement_type,
        notes
    )
    VALUES (
        p_hospital_id,
        p_start_date,
        p_end_date,
        v_platform_total,
        v_receptionist_total,
        v_booking_count,
        v_setura_total,
        0::NUMERIC(14,2),
        'paid',
        now(),
        p_performed_by,
        'platform_revenue_summary',
        FORMAT(
            'SETURA revenue summary %s - %s. '
            'Captured via Razorpay: Rs %s (platform Rs %s + receptionist Rs %s).',
            p_start_date, p_end_date,
            v_setura_total, v_platform_total, v_receptionist_total
        )
    )
    RETURNING id INTO v_sid;

    -- Link collection entries -> settlement
    INSERT INTO public.settlement_items (
        settlement_id,
        collection_entry_id,
        platform_fee_amount,
        receptionist_fee_amount
    )
    SELECT v_sid, id, platform_fee, receptionist_fee
      FROM public.daily_collection_entries
     WHERE hospital_id    = p_hospital_id
       AND collection_date BETWEEN p_start_date AND p_end_date
       AND is_settled      = false;

    -- Mark entries as settled
    UPDATE public.daily_collection_entries
       SET is_settled    = true,
           settlement_id = v_sid
     WHERE hospital_id    = p_hospital_id
       AND collection_date BETWEEN p_start_date AND p_end_date
       AND is_settled      = false;

    -- Refresh outstanding balance view
    PERFORM public.refresh_outstanding_balance(p_hospital_id);

    RETURN v_sid;
END;
$$;
REVOKE ALL     ON FUNCTION public.create_platform_revenue_summary(UUID, DATE, DATE, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_platform_revenue_summary(UUID, DATE, DATE, UUID) TO authenticated;

COMMIT;
