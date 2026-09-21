-- =============================================================
-- 60_d16_refund_unification.sql
-- PART 3B / D16 (owner-finalized financial policy):
--   Q2 A refund cannot exceed what SETURA actually collected; ONE
--      canonical refund basis for every cancellation/refund path
--      (receptionist, WhatsApp, API, direct).
--   Q5 A PARTIAL refund reduces ONLY the refunded amount; it must
--      never zero the whole collection/settlement record. Refund
--      accounting is idempotent.
--   Invariant (brief S9): total_refunded <= total_collected and
--      remaining_collected = total_collected - total_refunded.
--
-- Root cause proven from source (before this migration):
--   * confirm_refund_processed (migration 41:100) set the ENTIRE
--     unsettled daily_collection_entry to platform_fee=0,
--     receptionist_fee=0, hospital_fee=0, total_amount=0 for ANY
--     refund, full or partial (P1-02 / P1-10 over-adjust).
--   * initiate_refund (migration 13:700) capped only THIS refund at
--     payment_orders.amount_inr, not the cumulative sum, so repeated
--     partial refunds could together exceed the collected amount.
--
-- The refund BASIS (booking_fee_inr == payment_orders.amount_inr once
-- create-payment-order charges the platform fee) is unified on the
-- Edge side in process-refund; the SQL cap and settlement proration
-- are fixed here.
--
-- Both functions are CREATE OR REPLACE of EXISTING signatures, so the
-- ACL/OID are preserved; migration 48's service_role-only posture is
-- restated (F16-04) and self-checked below.
-- OUT OF SCOPE: the Razorpay gateway refund call (Edge), cancel-booking
--   (already uses booking_fee_inr), calculate_refund_amount (basis is
--   already booking_fee_inr).
-- =============================================================
BEGIN;

-- -------------------------------------------------------------
-- 1. initiate_refund: cumulative over-refund guard.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.initiate_refund(
    p_booking_id UUID,
    p_refund_amount_inr NUMERIC,
    p_refund_reason TEXT,
    p_initiated_by UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order       RECORD;
    v_prior       NUMERIC(14,2);
    v_refund_id   UUID;
BEGIN

    IF p_refund_amount_inr IS NULL OR p_refund_amount_inr <= 0 THEN
        RAISE EXCEPTION 'Refund amount must be positive';
    END IF;

    SELECT *
    INTO v_order
    FROM public.payment_orders
    WHERE booking_id = p_booking_id
      -- D16 (Q5): a partially refunded order still owes the remaining
      -- collected amount, so sequential partial refunds must be
      -- initiatable; the cumulative cap below bounds them.
      AND payment_status IN ('captured', 'partially_refunded')
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No captured payment found';
    END IF;

    -- D16 (Q2 / S9): the collected amount is what SETURA took in
    -- (payment_orders.amount_inr == booking_fee_inr). Refunds are
    -- bounded by it CUMULATIVELY, not per request. Failed refunds do
    -- not consume the budget.
    SELECT COALESCE(SUM(refund_amount_inr), 0)
    INTO v_prior
    FROM public.payment_refunds
    WHERE payment_order_id = v_order.id
      AND COALESCE(refund_status::text, '') NOT IN ('failed', 'rejected');

    IF v_prior + p_refund_amount_inr > v_order.amount_inr THEN
        RAISE EXCEPTION
            'Refund exceeds collected amount (collected %, already refunded %, requested %)',
            v_order.amount_inr, v_prior, p_refund_amount_inr;
    END IF;

    INSERT INTO public.payment_refunds (
        payment_order_id,
        hospital_id,
        booking_id,
        refund_amount_inr,
        refund_reason,
        initiated_by
    )
    VALUES (
        v_order.id,
        v_order.hospital_id,
        p_booking_id,
        p_refund_amount_inr,
        p_refund_reason,
        p_initiated_by
    )
    RETURNING id
    INTO v_refund_id;

    UPDATE public.bookings
    SET
        status = 'cancelled',
        cancellation_reason = p_refund_reason,
        updated_at = now()
    WHERE id = p_booking_id;

    RETURN v_refund_id;

END;
$$;

REVOKE ALL ON FUNCTION public.initiate_refund(UUID, NUMERIC, TEXT, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.initiate_refund(UUID, NUMERIC, TEXT, UUID)
    TO service_role;

-- -------------------------------------------------------------
-- 2. confirm_refund_processed: idempotent, prorated settlement.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.confirm_refund_processed(
    p_refund_id UUID,
    p_gateway_refund_id TEXT,
    p_gateway_response JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_refund      RECORD;
    v_order       RECORD;
    v_total_ref   NUMERIC(14,2);
    v_reduce      NUMERIC(14,2);
BEGIN

    SELECT *
    INTO v_refund
    FROM public.payment_refunds
    WHERE id = p_refund_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- Idempotency guard: replays must not duplicate ledger entries
    -- or re-adjust the settlement.
    IF v_refund.refund_status = 'processed' THEN
        RETURN FALSE;
    END IF;

    UPDATE public.payment_refunds
    SET
        gateway_refund_id = p_gateway_refund_id,
        refund_status = 'processed',
        processed_at = now(),
        gateway_response = p_gateway_response,
        updated_at = now()
    WHERE id = p_refund_id;

    -- Immutable ledger entry for this refund (SETURA platform collection).
    INSERT INTO public.financial_ledger (
        hospital_id,
        booking_id,
        payment_order_id,
        refund_id,
        entry_type,
        amount_inr,
        is_credit,
        description,
        reference
    )
    VALUES (
        v_refund.hospital_id,
        v_refund.booking_id,
        v_refund.payment_order_id,
        v_refund.id,
        'refund_debit',
        v_refund.refund_amount_inr,
        false,
        'Refund processed',
        p_gateway_refund_id
    );

    -- Order status by CUMULATIVE processed refunds vs the collected
    -- amount, so the LAST partial refund of a sequence still reads
    -- 'refunded' (full) rather than staying 'partially_refunded'.
    SELECT *
    INTO v_order
    FROM public.payment_orders
    WHERE id = v_refund.payment_order_id
    FOR UPDATE;

    SELECT COALESCE(SUM(refund_amount_inr), 0)
    INTO v_total_ref
    FROM public.payment_refunds
    WHERE payment_order_id = v_refund.payment_order_id
      AND refund_status = 'processed';

    UPDATE public.payment_orders
    SET
        payment_status = (
            CASE
                WHEN v_total_ref >= v_order.amount_inr
                THEN 'refunded'
                ELSE 'partially_refunded'
            END
        )::public.payment_status,
        updated_at = now()
    WHERE id = v_refund.payment_order_id;

    -- D16 (Q5): reduce the unsettled collection entry by EXACTLY the
    -- refunded amount -- never zero the whole record for a partial
    -- refund. platform_fee and total_amount move together so
    -- valid_collection_total (07:73) is preserved; LEAST() clamps to
    -- the recorded collection so the row can never go negative or
    -- drift. Already-settled periods stay intact.
    UPDATE public.daily_collection_entries
    SET
        platform_fee  = platform_fee
            - LEAST(v_refund.refund_amount_inr, platform_fee),
        total_amount  = total_amount
            - LEAST(v_refund.refund_amount_inr, platform_fee),
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'refund_adjusted', true,
            'last_refund_id', p_refund_id,
            'total_refunded', v_total_ref,
            'remaining_collected', GREATEST(0, total_amount - LEAST(v_refund.refund_amount_inr, platform_fee)),
            'refund_adjusted_at', now()
        )
    WHERE booking_id = v_refund.booking_id
      AND is_settled = false;

    RETURN TRUE;

END;
$$;

REVOKE ALL ON FUNCTION public.confirm_refund_processed(UUID, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_refund_processed(UUID, TEXT, JSONB)
    TO service_role;

-- -------------------------------------------------------------
-- 3. SELF-VERIFICATION (non-mutating).
-- -------------------------------------------------------------
DO $$
DECLARE
    v_ok BOOLEAN;
BEGIN
    -- Confirming a nonexistent refund returns FALSE and writes nothing.
    v_ok := public.confirm_refund_processed(
        gen_random_uuid(),
        'm60probe_absent_refund',
        '{}'::jsonb
    );

    IF v_ok THEN
        RAISE EXCEPTION 'm60: confirming an absent refund must return FALSE';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.financial_ledger
        WHERE reference = 'm60probe_absent_refund'
    ) THEN
        RAISE EXCEPTION 'm60: absent-refund probe must not write the ledger';
    END IF;

    -- F16-04 privilege posture of both changed functions.
    IF has_function_privilege(
        'anon',
        'public.initiate_refund(uuid,numeric,text,uuid)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.initiate_refund(uuid,numeric,text,uuid)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'm60: initiate_refund over-granted to a client role';
    END IF;

    IF NOT has_function_privilege(
        'service_role',
        'public.initiate_refund(uuid,numeric,text,uuid)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'm60: service_role lost initiate_refund';
    END IF;

    IF has_function_privilege(
        'anon',
        'public.confirm_refund_processed(uuid,text,jsonb)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.confirm_refund_processed(uuid,text,jsonb)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'm60: confirm_refund_processed over-granted';
    END IF;

    IF NOT has_function_privilege(
        'service_role',
        'public.confirm_refund_processed(uuid,text,jsonb)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'm60: service_role lost confirm_refund_processed';
    END IF;

    RAISE NOTICE 'migration 60 verification passed';
END;
$$;

-- -------------------------------------------------------------
-- 4. Registry
-- -------------------------------------------------------------
INSERT INTO public.migration_registry (
    migration_id,
    script_filename,
    description,
    category,
    status,
    applied_at
) VALUES (
    '60_d16_refund_unification',
    '60_d16_refund_unification.sql',
    'PART 3B D16: unified refund policy. initiate_refund enforces a '
    'cumulative total_refunded <= total_collected cap; '
    'confirm_refund_processed reduces the unsettled collection entry by '
    'exactly the refunded amount (partial refunds no longer zero it) and '
    'derives order status from cumulative refunds. Grants restated per '
    'F16-04.',
    'function',
    'applied',
    now()
)
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
