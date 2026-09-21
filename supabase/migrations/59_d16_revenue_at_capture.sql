-- =============================================================
-- 59_d16_revenue_at_capture.sql
-- PART 3B / D16 (owner-finalized financial policy):
--   Q1 SETURA collects ONLY the booking/platform fee.
--   Q3 SETURA revenue is recognized when the payment is CAPTURED,
--      not when the booking row is created.
--   Q4 An UNPAID (or WhatsApp) booking must not create collected
--      SETURA revenue or a settlement/collection amount.
--
-- Root cause proven from source (before this migration):
--   * trg_booking_ledger (migration 13:479, AFTER INSERT WHEN
--     total_amount_snapshot > 0) wrote 'platform_fee_credit' and
--     'receptionist_incentive_credit' the moment a booking row was
--     inserted, regardless of any payment -> revenue recognised at
--     INSERT and double-counted against capture_payment's
--     'booking_fee_collected' (migration 34:204).
--   * trg_auto_create_collection (migration 07:306, AFTER INSERT, NO
--     WHEN clause) created a daily_collection_entries row carrying the
--     FULL total_amount_snapshot for every booking, paid or not ->
--     settlement input existed before capture (NPD-02 / P1-10).
--
-- Remediation (ADDITIVE -- no applied migration is edited):
--   1. write_booking_ledger_entries(): no-op. Booking-row creation is
--      no longer a revenue event. SETURA cash revenue is recognised
--      ONLY by capture_payment via 'booking_fee_collected'. The two
--      INSERT-time entry types are therefore no longer emitted; the
--      reconciliation fields that summed them (platform_fee_total /
--      receptionist_fee_total, migration 13) now read 0 and
--      total_collected (booking_fee_collected) is the authoritative
--      SETURA revenue. No test asserted the deprecated fields.
--   2. auto_create_collection_entry(): the collection row is created
--      with ZERO amounts unless NEW.payment_completed is already true.
--      Row-per-booking (operational) is preserved; the D-3 counting
--      rule (migration 49: non-zero total_amount only) then excludes
--      every unpaid booking from "payments". This is the operational
--      booking state kept SEPARATE from the financial collection state.
--   3. capture_payment(5-arg): on successful capture, the booking's
--      daily_collection_entries row is UPSERTed to the amount SETURA
--      actually collected (v_order.amount_inr, which create-payment-order
--      now sets to booking_fee_inr), with receptionist_fee/hospital_fee
--      = 0 because SETURA never collects them (Q1). valid_collection_total
--      (07:73) still holds: total = platform + 0 + 0.
--
-- The Razorpay CHARGE basis (order amount = booking_fee_inr, not
-- total_amount_snapshot) is an Edge Function change in create-payment-order;
-- this migration makes the SQL side consistent with it.
--
-- SECURITY (F16-04): every function here is a CREATE OR REPLACE of an
--   EXISTING signature, so the OID and ACL are preserved by PostgreSQL.
--   The service_role-only posture established by migration 48 is restated
--   explicitly anyway, and a self-check asserts it below. No new routine
--   name/arity is introduced; the trigger functions keep RETURNS TRIGGER
--   and SET search_path = public.
-- OUT OF SCOPE: refund unification and partial-refund settlement
--   (migration 60), the deprecated 4-arg capture_payment overload, and any
--   drop of the INSERT-time triggers (they are gated, not removed).
-- =============================================================
BEGIN;

-- -------------------------------------------------------------
-- 1. Booking INSERT is no longer a revenue event.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.write_booking_ledger_entries()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- D16 (Q3): revenue recognition moved to capture_payment.
    -- Creating a booking must never write a ledger credit, because a
    -- booking row is not evidence that SETURA collected money.
    -- 'booking_fee_collected', written by capture_payment at
    -- successful capture, is the sole SETURA cash-revenue ledger entry.
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.write_booking_ledger_entries() IS
'D16: intentionally a no-op. Booking-row creation no longer recognises '
'REVENUE; capture_payment writes booking_fee_collected instead. Kept as a '
'SECURITY DEFINER trigger function so trg_booking_ledger stays installed '
'(operational booking behaviour unchanged).';

-- -------------------------------------------------------------
-- 2. Collection/settlement entry carries money only when paid.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auto_create_collection_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- D16 (Q4): an unpaid booking is a real operational booking but is
    -- NOT collected revenue. Create the (unique per booking) collection
    -- row with zero amounts; capture_payment populates it on success.
    -- A booking inserted already-paid keeps its full split (fixture /
    -- offline-recognition path).
    IF COALESCE(NEW.payment_completed, false) THEN
        INSERT INTO public.daily_collection_entries (
            hospital_id,
            booking_id,
            patient_id,
            booking_source,
            collection_date,
            platform_fee,
            receptionist_fee,
            hospital_fee,
            total_amount
        )
        VALUES (
            NEW.hospital_id,
            NEW.id,
            NEW.patient_id,
            NEW.booking_source,
            NEW.appointment_date,
            NEW.platform_fee_snapshot,
            NEW.receptionist_fee_snapshot,
            NEW.hospital_fee_snapshot,
            NEW.total_amount_snapshot
        )
        ON CONFLICT (booking_id)
        DO NOTHING;
    ELSE
        INSERT INTO public.daily_collection_entries (
            hospital_id,
            booking_id,
            patient_id,
            booking_source,
            collection_date,
            platform_fee,
            receptionist_fee,
            hospital_fee,
            total_amount
        )
        VALUES (
            NEW.hospital_id,
            NEW.id,
            NEW.patient_id,
            NEW.booking_source,
            NEW.appointment_date,
            0,
            0,
            0,
            0
        )
        ON CONFLICT (booking_id)
        DO NOTHING;
    END IF;

    RETURN NEW;

END;
$$;

COMMENT ON FUNCTION public.auto_create_collection_entry() IS
'D16 (Q4): creates the per-booking collection row with the fee split only '
'when the booking is already payment_completed; otherwise a zero-value '
'placeholder. The collected amount is settled at capture_payment.';

-- -------------------------------------------------------------
-- 3. capture_payment: recognise the collected amount at capture.
--    Full current definition (migration 34) restated, plus the
--    collection-row UPSERT. The 4-arg delegator (migration 34)
--    and migration 56's explicit 5-arg call are unaffected.
-- -------------------------------------------------------------
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

    -- GST: look up hospital's booking fee policy (Script 28), if any.
    -- Computed on v_order.amount_inr, which create-payment-order now
    -- sets to booking_fee_inr, so GST applies to SETURA's platform fee
    -- only and never to the hospital consultation amount (D16 Q6).
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

    -- Ledger: SETURA collected revenue (recognition point per Q3).
    INSERT INTO public.financial_ledger (
        hospital_id, booking_id, payment_order_id,
        entry_type, amount_inr, is_credit,
        description, reference
    ) VALUES (
        v_order.hospital_id, v_order.booking_id, v_order.id,
        'booking_fee_collected', v_order.amount_inr, true,
        'Payment captured', p_gateway_payment_id
    );

    -- Ledger: gateway fee debit (Razorpay processing cost, absorbed by
    -- SETURA per D16 Q7) - recorded separately from platform revenue.
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

    -- Ledger: GST debit (SETURA tax liability on its platform fee) -
    -- recorded separately from platform revenue and refunds (D16 Q6).
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

    -- D16 (Q3/Q4): the collection/settlement record is created ONLY now,
    -- from the amount SETURA actually collected. receptionist_fee and
    -- hospital_fee are 0 because SETURA never collects them (Q1); the
    -- generated column setura_revenue (migration 33) therefore equals
    -- platform_fee. valid_collection_total (07:73) holds:
    --   total_amount = platform_fee + 0 + 0.
    INSERT INTO public.daily_collection_entries (
        hospital_id,
        booking_id,
        patient_id,
        booking_source,
        collection_date,
        platform_fee,
        receptionist_fee,
        hospital_fee,
        total_amount
    )
    SELECT
        b.hospital_id,
        b.id,
        b.patient_id,
        b.booking_source,
        b.appointment_date,
        v_order.amount_inr,
        0,
        0,
        v_order.amount_inr
    FROM public.bookings b
    WHERE b.id = v_order.booking_id
    ON CONFLICT (booking_id) DO UPDATE
       SET platform_fee     = EXCLUDED.platform_fee,
           receptionist_fee = 0,
           hospital_fee     = 0,
           total_amount     = EXCLUDED.total_amount,
           metadata         = COALESCE(
               daily_collection_entries.metadata, '{}'::jsonb
           ) || jsonb_build_object(
               'payment_captured', true,
               'captured_at', now()
           );

    RETURN TRUE;
END;
$$;

-- F16-04: restatement of the migration-48 service_role-only posture
-- (CREATE OR REPLACE already preserved the ACL; this documents intent).
REVOKE ALL ON FUNCTION public.capture_payment(TEXT,TEXT,TEXT,JSONB,NUMERIC)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_payment(TEXT,TEXT,TEXT,JSONB,NUMERIC)
    TO service_role;

REVOKE ALL ON FUNCTION public.capture_payment(TEXT,TEXT,TEXT,JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_payment(TEXT,TEXT,TEXT,JSONB)
    TO service_role;

-- -------------------------------------------------------------
-- 4. SELF-VERIFICATION (non-mutating: probe uses an order id that
--    does not exist, so no ledger / collection row is written).
-- -------------------------------------------------------------
DO $$
DECLARE
    v_captured BOOLEAN;
BEGIN
    -- A nonexistent order returns FALSE and writes nothing.
    v_captured := public.capture_payment(
        'm59probe_absent_order',
        'm59probe_absent_payment',
        'm59probe_sig',
        '{}'::jsonb,
        NULL
    );

    IF v_captured THEN
        RAISE EXCEPTION 'm59: capture of an absent order must return FALSE';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.financial_ledger
        WHERE reference = 'm59probe_absent_payment'
    ) THEN
        RAISE EXCEPTION 'm59: absent-order probe must not write the ledger';
    END IF;

    -- F16-04: privilege posture of the changed capture overload.
    IF has_function_privilege(
        'anon',
        'public.capture_payment(text,text,text,jsonb,numeric)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.capture_payment(text,text,text,jsonb,numeric)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'm59: capture_payment/5 over-granted to a client role';
    END IF;

    IF NOT has_function_privilege(
        'service_role',
        'public.capture_payment(text,text,text,jsonb,numeric)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'm59: service_role lost capture_payment/5';
    END IF;

    -- The INSERT-time trigger functions remain installed (gated, not
    -- dropped), so operational booking behaviour is unchanged.
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'auto_create_collection_entry'
    ) THEN
        RAISE EXCEPTION 'm59: auto_create_collection_entry missing';
    END IF;

    RAISE NOTICE 'migration 59 verification passed';
END;
$$;

-- -------------------------------------------------------------
-- 5. Registry
-- -------------------------------------------------------------
INSERT INTO public.migration_registry (
    migration_id,
    script_filename,
    description,
    category,
    status,
    applied_at
) VALUES (
    '59_d16_revenue_at_capture',
    '59_d16_revenue_at_capture.sql',
    'PART 3B D16: recognise SETURA revenue only at payment capture. '
    'write_booking_ledger_entries is a no-op (booking INSERT is not a '
    'revenue event); auto_create_collection_entry writes a zero-value '
    'collection row unless the booking is already paid; capture_payment '
    'upserts the collection row to the actually-collected platform fee. '
    'Grants restated per F16-04.',
    'function',
    'applied',
    now()
)
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
