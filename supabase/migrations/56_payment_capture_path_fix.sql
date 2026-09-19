-- =============================================================
-- 56_payment_capture_path_fix.sql
-- Phase 4 E1: the payment verification path (both verify-payment
-- webhook and frontend legs funnel through
-- idempotent_capture_payment) was found BROKEN at runtime by the
-- hospital_core_journey suite. Three defects, one migration:
--
-- FINDING F4-01 (P0, capture always errors):
--   Migration 34 added capture_payment(...,NUMERIC DEFAULT NULL)
--   alongside the preserved 4-arg overload. In PostgreSQL a 4-arg
--   call then matches BOTH candidates with identical best score ->
--   "function public.capture_payment(text,text,text,jsonb) is not
--   unique" is raised for EVERY call. idempotent_capture_payment's
--   PERFORM is such a call, so no payment could ever be captured.
--   FIX: name the 5-arg overload explicitly (NULL fee -> the same
--   2% estimate the 4-arg wrapper supplied).
--
-- FINDING F4-02 (failure handler itself faults):
--   fail_webhook_event assigns an uncast CASE ('failed'/'received')
--   to the webhook_processing_status enum column; the CASE resolves
--   to text at runtime -> SQLSTATE 42804. The exception handler of
--   idempotent_capture_payment therefore aborted the WHOLE RPC
--   instead of returning success=false.
--   FIX: cast the CASE result to public.webhook_processing_status.
--
-- FINDING F4-03 (silent success on failed capture):
--   idempotent_capture_payment used PERFORM, discarding
--   capture_payment's BOOLEAN return. An unknown or already
--   captured order reported success=true.
--   FIX: capture the result; a FALSE capture now fails the webhook
--   event (retryable) and returns success=false.
--
-- SECURITY (F16-04): both functions are CREATE OR REPLACE of
--   existing signatures (OID and ACL preserved), but grants are
--   restated explicitly: no PUBLIC/anon/authenticated EXECUTE,
--   service_role only.
-- OUT OF SCOPE: dropping the deprecated 4-arg capture_payment
--   overload, ledger/enum changes, verify-payment edge code
--   (unchanged contracts).
-- =============================================================
BEGIN;

-- -------------------------------------------------------------
-- 1. fail_webhook_event: enum-safe CASE
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fail_webhook_event(
    p_event_id UUID,
    p_error TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    UPDATE public.webhook_events
    SET

        processing_status = CASE
            WHEN processing_attempt >= 5
            THEN 'failed'::public.webhook_processing_status
            ELSE 'received'::public.webhook_processing_status
        END,

        processing_error = LEFT(p_error, 5000),

        updated_at = now()

    WHERE id = p_event_id;

    RETURN FOUND;

END;
$$;

REVOKE ALL ON FUNCTION public.fail_webhook_event(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_webhook_event(UUID, TEXT)
    TO service_role;

-- -------------------------------------------------------------
-- 2. idempotent_capture_payment: unambiguous 5-arg call,
--    honest success reporting, working failure path
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.idempotent_capture_payment(
    p_provider_event_id     TEXT,
    p_payload_hash          TEXT,
    p_raw_payload           JSONB,
    p_gateway_order_id      TEXT,
    p_gateway_payment_id    TEXT,
    p_gateway_signature     TEXT
)
RETURNS TABLE (
    success BOOLEAN,
    was_duplicate BOOLEAN,
    message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE

    v_is_new BOOLEAN;

    v_event_id UUID;

    v_captured BOOLEAN;

BEGIN

    -- =========================================================
    -- IDEMPOTENCY GATE
    -- =========================================================

    SELECT
        r.is_new,
        r.event_id
    INTO
        v_is_new,
        v_event_id

    FROM public.register_webhook_event_v2(
        'razorpay',
        p_provider_event_id,
        'payment.captured',
        p_payload_hash,
        p_raw_payload
    ) r;

    IF NOT v_is_new THEN

        RETURN QUERY
        SELECT
            false,
            true,
            'Duplicate webhook already processed';

        RETURN;

    END IF;

    -- =========================================================
    -- PROCESSING CLAIM
    -- =========================================================

    UPDATE public.webhook_events
    SET
        processing_status = 'processing',
        processing_started_at = now(),
        updated_at = now()
    WHERE id = v_event_id;

    -- =========================================================
    -- CAPTURE
    -- The 5-arg overload is named explicitly: the 4-arg call
    -- became ambiguous when migration 34 added the DEFAULT
    -- (F4-01). NULL keeps the 2% gateway-fee estimate.
    -- =========================================================

    BEGIN

        SELECT public.capture_payment(
            p_gateway_order_id,
            p_gateway_payment_id,
            p_gateway_signature,
            p_raw_payload,
            NULL
        ) INTO v_captured;

        IF v_captured IS NULL OR NOT v_captured THEN

            -- Unknown order / already captured / refunded: not a
            -- gateway error, but never a success either (F4-03).
            PERFORM public.fail_webhook_event(
                v_event_id,
                'payment order not found or not capturable'
            );

            RETURN QUERY
            SELECT
                false,
                false,
                'Payment capture failed: order not capturable';

            RETURN;

        END IF;

        PERFORM public.complete_webhook_event(
            v_event_id
        );

        RETURN QUERY
        SELECT
            true,
            false,
            'Payment captured successfully';

    EXCEPTION
        WHEN OTHERS THEN

            PERFORM public.fail_webhook_event(
                v_event_id,
                SQLERRM
            );

            RETURN QUERY
            SELECT
                false,
                false,
                'Payment capture failed: ' || SQLERRM;

    END;

END;
$$;

REVOKE ALL ON FUNCTION public.idempotent_capture_payment(
    TEXT, TEXT, JSONB, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.idempotent_capture_payment(
    TEXT, TEXT, JSONB, TEXT, TEXT, TEXT
) TO service_role;

-- -------------------------------------------------------------
-- 3. SELF-VERIFICATION (no ledger rows are written: every probe
--    uses an order id that does not exist)
-- -------------------------------------------------------------
DO $$
DECLARE
    v_out RECORD;
    v_event UUID;
    v_status TEXT;
BEGIN

    -- F4-01/F4-03: unknown order must now return success=false
    -- WITHOUT raising (previously: ambiguous-function 42725 ->
    -- broken handler -> 42804 aborting the whole RPC).
    SELECT * INTO v_out
    FROM public.idempotent_capture_payment(
        'm56probe_evt', 'm56probe_hash', '{}'::jsonb,
        'm56probe_order', 'm56probe_pay', 'm56probe_sig'
    );

    IF v_out.success THEN
        RAISE EXCEPTION 'm56: unknown order must not report success';
    END IF;

    IF v_out.was_duplicate THEN
        RAISE EXCEPTION 'm56: fresh event must not be a duplicate';
    END IF;

    -- Replay of the same provider event: dedup gate intact.
    SELECT * INTO v_out
    FROM public.idempotent_capture_payment(
        'm56probe_evt', 'm56probe_hash', '{}'::jsonb,
        'm56probe_order', 'm56probe_pay', 'm56probe_sig'
    );

    IF NOT v_out.was_duplicate THEN
        RAISE EXCEPTION 'm56: replay must report was_duplicate';
    END IF;

    -- F4-02: fail_webhook_event writes the enum without 42804.
    SELECT id INTO v_event
    FROM public.webhook_events
    WHERE provider_event_id = 'm56probe_evt'
      AND provider = 'razorpay'
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_event IS NULL THEN
        RAISE EXCEPTION 'm56: probe webhook event missing';
    END IF;

    IF NOT public.fail_webhook_event(v_event, 'm56 self-check') THEN
        RAISE EXCEPTION 'm56: fail_webhook_event updated nothing';
    END IF;

    SELECT processing_status::text INTO v_status
    FROM public.webhook_events
    WHERE id = v_event;

    IF v_status NOT IN ('received', 'failed') THEN
        RAISE EXCEPTION 'm56: unexpected status %', v_status;
    END IF;

    -- Ledger permanence untouched by the probes.
    IF EXISTS (
        SELECT 1 FROM public.financial_ledger
        WHERE reference = 'm56probe_pay'
    ) THEN
        RAISE EXCEPTION 'm56: probe must not write the ledger';
    END IF;

    -- Clean the probe rows (webhook_events allows DELETE).
    DELETE FROM public.webhook_events
    WHERE provider_event_id = 'm56probe_evt'
      AND provider = 'razorpay';

    -- F16-04: privilege posture of both changed functions.
    IF has_function_privilege(
        'anon', 'public.fail_webhook_event(uuid,text)', 'EXECUTE'
    ) OR has_function_privilege(
        'authenticated', 'public.fail_webhook_event(uuid,text)', 'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'm56: fail_webhook_event over-granted';
    END IF;

    IF NOT has_function_privilege(
        'service_role',
        'public.fail_webhook_event(uuid,text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'm56: service_role lost fail_webhook_event';
    END IF;

    IF has_function_privilege(
        'anon',
        'public.idempotent_capture_payment(text,text,jsonb,text,text,text)',
        'EXECUTE'
    ) OR has_function_privilege(
        'authenticated',
        'public.idempotent_capture_payment(text,text,jsonb,text,text,text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'm56: idempotent_capture_payment over-granted';
    END IF;

    IF NOT has_function_privilege(
        'service_role',
        'public.idempotent_capture_payment(text,text,jsonb,text,text,text)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'm56: service_role lost idempotent_capture_payment';
    END IF;

    RAISE NOTICE 'migration 56 verification passed';

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
    '56_payment_capture_path_fix',
    '56_payment_capture_path_fix.sql',
    'Phase 4 (E1): repair the payment capture path - explicit 5-arg '
    'capture_payment call removes the migration 34 overload ambiguity '
    '(F4-01), fail_webhook_event CASE is enum-cast (F4-02), and '
    'idempotent_capture_payment reports success=false for '
    'non-capturable orders instead of swallowing the result (F4-03). '
    'Grants restated per F16-04.',
    'function',
    'applied',
    now()
)
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
