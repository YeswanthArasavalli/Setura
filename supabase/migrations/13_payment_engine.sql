-- =============================================================
-- SETURA HOSPITAL OS
-- Script 13: Payment Engine
-- FINAL PRODUCTION SAFE VERSION
-- =============================================================

BEGIN;

-- =============================================================
-- ENUMS
-- =============================================================

DO $$ BEGIN
    CREATE TYPE public.payment_status AS ENUM (
        'initiated',
        'pending',
        'authorized',
        'captured',
        'failed',
        'refunded',
        'partially_refunded',
        'disputed',
        'expired'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE public.payment_gateway AS ENUM (
        'razorpay',
        'manual',
        'free'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE public.refund_status AS ENUM (
        'pending',
        'processing',
        'processed',
        'failed',
        'cancelled'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE public.ledger_entry_type AS ENUM (
        'booking_fee_collected',
        'platform_fee_credit',
        'receptionist_incentive_credit',
        'hospital_fee_credit',
        'refund_debit',
        'settlement_debit',
        'adjustment'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================
-- PAYMENT ORDERS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.payment_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    booking_id UUID UNIQUE
        REFERENCES public.bookings(id)
        ON DELETE SET NULL,

    patient_id UUID
        REFERENCES public.patients(id)
        ON DELETE SET NULL,

    gateway public.payment_gateway
        NOT NULL DEFAULT 'razorpay',

    gateway_order_id TEXT UNIQUE,

    gateway_payment_id TEXT UNIQUE,

    gateway_signature TEXT,

    amount_inr NUMERIC(10,2)
        NOT NULL
        CHECK (amount_inr >= 0),

    amount_paise INTEGER
        GENERATED ALWAYS AS (
            ROUND(amount_inr * 100)::INTEGER
        ) STORED,

    currency TEXT NOT NULL DEFAULT 'INR',

    payment_status public.payment_status
        NOT NULL DEFAULT 'initiated',

    initiated_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    authorized_at TIMESTAMPTZ,

    captured_at TIMESTAMPTZ,

    failed_at TIMESTAMPTZ,

    expired_at TIMESTAMPTZ,

    gateway_response JSONB
        NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(gateway_response) = 'object'),

    failure_reason TEXT,

    failure_code TEXT,

    idempotency_key TEXT UNIQUE,

    is_deleted BOOLEAN NOT NULL DEFAULT false,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_booking
ON public.payment_orders(booking_id);

CREATE INDEX IF NOT EXISTS idx_payment_orders_gateway_order
ON public.payment_orders(gateway_order_id);

CREATE INDEX IF NOT EXISTS idx_payment_orders_status
ON public.payment_orders(payment_status, hospital_id);

CREATE INDEX IF NOT EXISTS idx_payment_orders_hospital_date
ON public.payment_orders(hospital_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_payment_orders_updated_at
ON public.payment_orders;

CREATE TRIGGER trg_payment_orders_updated_at
BEFORE UPDATE
ON public.payment_orders
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_payment_orders_immutable
BEFORE UPDATE
ON public.payment_orders
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- PAYMENT ATTEMPTS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.payment_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    payment_order_id UUID NOT NULL
        REFERENCES public.payment_orders(id)
        ON DELETE CASCADE,

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    attempt_number INTEGER NOT NULL DEFAULT 1
        CHECK (attempt_number > 0),

    gateway public.payment_gateway
        NOT NULL DEFAULT 'razorpay',

    gateway_payment_id TEXT,

    amount_inr NUMERIC(10,2)
        NOT NULL
        CHECK (amount_inr >= 0),

    payment_status public.payment_status
        NOT NULL DEFAULT 'pending',

    payment_method TEXT,

    payment_method_detail JSONB
        NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(payment_method_detail) = 'object'),

    error_code TEXT,

    error_description TEXT,

    error_source TEXT,

    error_step TEXT,

    error_reason TEXT,

    gateway_response JSONB
        NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(gateway_response) = 'object'),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_order
ON public.payment_attempts(payment_order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_hospital
ON public.payment_attempts(hospital_id, created_at DESC);

-- =============================================================
-- PAYMENT REFUNDS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.payment_refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    payment_order_id UUID NOT NULL
        REFERENCES public.payment_orders(id)
        ON DELETE CASCADE,

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    booking_id UUID
        REFERENCES public.bookings(id)
        ON DELETE SET NULL,

    gateway_refund_id TEXT UNIQUE,

    refund_amount_inr NUMERIC(10,2)
        NOT NULL
        CHECK (refund_amount_inr > 0),

    refund_status public.refund_status
        NOT NULL DEFAULT 'pending',

    refund_reason TEXT NOT NULL,

    initiated_by UUID
        REFERENCES public.profiles(id)
        ON DELETE SET NULL,

    initiated_at TIMESTAMPTZ
        NOT NULL DEFAULT now(),

    processed_at TIMESTAMPTZ,

    failed_at TIMESTAMPTZ,

    gateway_response JSONB
        NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(gateway_response) = 'object'),

    notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refunds_order
ON public.payment_refunds(payment_order_id);

CREATE INDEX IF NOT EXISTS idx_refunds_status
ON public.payment_refunds(refund_status, hospital_id)
WHERE refund_status IN ('pending', 'processing');

DROP TRIGGER IF EXISTS trg_refunds_updated_at
ON public.payment_refunds;

CREATE TRIGGER trg_refunds_updated_at
BEFORE UPDATE
ON public.payment_refunds
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_refunds_immutable
BEFORE UPDATE
ON public.payment_refunds
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- PAYMENT EVENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.payment_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    event_id TEXT UNIQUE NOT NULL,

    event_type TEXT NOT NULL,

    gateway_entity_id TEXT,

    processed BOOLEAN NOT NULL DEFAULT false,

    processed_at TIMESTAMPTZ,

    processing_error TEXT,

    raw_payload JSONB NOT NULL
        CHECK (
            jsonb_typeof(raw_payload)
            IN ('object', 'array')
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_events_unprocessed
ON public.payment_events(processed, created_at)
WHERE processed = false;

-- =============================================================
-- FINANCIAL LEDGER
-- =============================================================

CREATE TABLE IF NOT EXISTS public.financial_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    booking_id UUID
        REFERENCES public.bookings(id)
        ON DELETE SET NULL,

    payment_order_id UUID
        REFERENCES public.payment_orders(id)
        ON DELETE SET NULL,

    refund_id UUID
        REFERENCES public.payment_refunds(id)
        ON DELETE SET NULL,

    settlement_id UUID
        REFERENCES public.hospital_settlements(id)
        ON DELETE SET NULL,

    entry_type public.ledger_entry_type NOT NULL,

    amount_inr NUMERIC(10,2)
        NOT NULL
        CHECK (amount_inr >= 0),

    is_credit BOOLEAN NOT NULL,

    description TEXT NOT NULL,

    reference TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_hospital_date
ON public.financial_ledger(hospital_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ledger_booking
ON public.financial_ledger(booking_id);

CREATE INDEX IF NOT EXISTS idx_ledger_settlement
ON public.financial_ledger(settlement_id);

-- =============================================================
-- IMMUTABLE LEDGER PROTECTION
-- =============================================================

CREATE OR REPLACE FUNCTION public.prevent_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
    'financial_ledger is immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_no_update
ON public.financial_ledger;

CREATE TRIGGER trg_ledger_no_update
BEFORE UPDATE
ON public.financial_ledger
FOR EACH ROW
EXECUTE FUNCTION public.prevent_ledger_mutation();

DROP TRIGGER IF EXISTS trg_ledger_no_delete
ON public.financial_ledger;

CREATE TRIGGER trg_ledger_no_delete
BEFORE DELETE
ON public.financial_ledger
FOR EACH ROW
EXECUTE FUNCTION public.prevent_ledger_mutation();

-- =============================================================
-- BOOKING LEDGER WRITER
-- =============================================================

CREATE OR REPLACE FUNCTION public.write_booking_ledger_entries()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    IF COALESCE(NEW.total_amount_snapshot, 0) <= 0 THEN
        RETURN NEW;
    END IF;

    IF COALESCE(NEW.platform_fee_snapshot, 0) > 0 THEN

        INSERT INTO public.financial_ledger (
            hospital_id,
            booking_id,
            entry_type,
            amount_inr,
            is_credit,
            description,
            reference
        )
        VALUES (
            NEW.hospital_id,
            NEW.id,
            'platform_fee_credit',
            NEW.platform_fee_snapshot,
            true,
            'Platform fee',
            NEW.booking_reference
        );

    END IF;

    IF COALESCE(NEW.receptionist_fee_snapshot, 0) > 0 THEN

        INSERT INTO public.financial_ledger (
            hospital_id,
            booking_id,
            entry_type,
            amount_inr,
            is_credit,
            description,
            reference
        )
        VALUES (
            NEW.hospital_id,
            NEW.id,
            'receptionist_incentive_credit',
            NEW.receptionist_fee_snapshot,
            true,
            'Receptionist incentive',
            NEW.booking_reference
        );

    END IF;

    RETURN NEW;

END;
$$;

ALTER FUNCTION public.write_booking_ledger_entries()
SET row_security = off;

DROP TRIGGER IF EXISTS trg_booking_ledger
ON public.bookings;

CREATE TRIGGER trg_booking_ledger
AFTER INSERT
ON public.bookings
FOR EACH ROW
WHEN (
    COALESCE(NEW.total_amount_snapshot, 0) > 0
)
EXECUTE FUNCTION public.write_booking_ledger_entries();

-- =============================================================
-- RECONCILIATION SUMMARY
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_reconciliation_summary(
    p_hospital_id UUID,
    p_from_date DATE,
    p_to_date DATE
)
RETURNS TABLE (
    total_collected NUMERIC,
    platform_fee_total NUMERIC,
    receptionist_fee_total NUMERIC,
    total_refunded NUMERIC,
    total_settled NUMERIC,
    net_outstanding NUMERIC,
    booking_count INTEGER,
    paid_booking_count INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT

        COALESCE(
            SUM(fl.amount_inr)
            FILTER (
                WHERE fl.entry_type = 'booking_fee_collected'
                AND fl.is_credit
            ),
            0
        ),

        COALESCE(
            SUM(fl.amount_inr)
            FILTER (
                WHERE fl.entry_type = 'platform_fee_credit'
                AND fl.is_credit
            ),
            0
        ),

        COALESCE(
            SUM(fl.amount_inr)
            FILTER (
                WHERE fl.entry_type = 'receptionist_incentive_credit'
                AND fl.is_credit
            ),
            0
        ),

        COALESCE(
            SUM(fl.amount_inr)
            FILTER (
                WHERE fl.entry_type = 'refund_debit'
                AND NOT fl.is_credit
            ),
            0
        ),

        COALESCE(
            SUM(fl.amount_inr)
            FILTER (
                WHERE fl.entry_type = 'settlement_debit'
                AND NOT fl.is_credit
            ),
            0
        ),

        COALESCE(
            SUM(
                CASE
                    WHEN fl.is_credit
                    THEN fl.amount_inr
                    ELSE -fl.amount_inr
                END
            ),
            0
        ),

        COUNT(DISTINCT b.id)::INTEGER,

        COUNT(DISTINCT b.id)
        FILTER (
            WHERE b.payment_completed = true
        )::INTEGER

    FROM public.financial_ledger fl
    LEFT JOIN public.bookings b
        ON b.id = fl.booking_id

    WHERE fl.hospital_id = p_hospital_id
      AND fl.created_at::date
          BETWEEN p_from_date AND p_to_date;
$$;

ALTER FUNCTION public.get_reconciliation_summary(UUID,DATE,DATE)
SET row_security = off;

-- =============================================================
-- SAFE PAYMENT CAPTURE
-- =============================================================

CREATE OR REPLACE FUNCTION public.capture_payment(
    p_gateway_order_id TEXT,
    p_gateway_payment_id TEXT,
    p_gateway_signature TEXT,
    p_gateway_response JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order RECORD;
BEGIN

    SELECT *
    INTO v_order
    FROM public.payment_orders
    WHERE gateway_order_id = p_gateway_order_id
      AND payment_status NOT IN (
            'captured',
            'refunded'
      )
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    UPDATE public.payment_orders
    SET
        payment_status = 'captured',
        gateway_payment_id = p_gateway_payment_id,
        gateway_signature = p_gateway_signature,
        captured_at = now(),
        gateway_response = p_gateway_response,
        updated_at = now()
    WHERE id = v_order.id;

    UPDATE public.bookings
    SET
        payment_completed = true,
        payment_reference = p_gateway_payment_id,
        updated_at = now()
    WHERE id = v_order.booking_id;

    INSERT INTO public.financial_ledger (
        hospital_id,
        booking_id,
        payment_order_id,
        entry_type,
        amount_inr,
        is_credit,
        description,
        reference
    )
    VALUES (
        v_order.hospital_id,
        v_order.booking_id,
        v_order.id,
        'booking_fee_collected',
        v_order.amount_inr,
        true,
        'Payment captured',
        p_gateway_payment_id
    );

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.capture_payment(TEXT,TEXT,TEXT,JSONB)
SET row_security = off;

-- =============================================================
-- INITIATE REFUND
-- =============================================================

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
    v_order RECORD;
    v_refund_id UUID;
BEGIN

    SELECT *
    INTO v_order
    FROM public.payment_orders
    WHERE booking_id = p_booking_id
      AND payment_status = 'captured'
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
        'No captured payment found';
    END IF;

    IF p_refund_amount_inr > v_order.amount_inr THEN
        RAISE EXCEPTION
        'Refund amount exceeds payment';
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

ALTER FUNCTION public.initiate_refund(UUID,NUMERIC,TEXT,UUID)
SET row_security = off;

-- =============================================================
-- CONFIRM REFUND
-- =============================================================

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
    v_refund RECORD;
BEGIN

    SELECT *
    INTO v_refund
    FROM public.payment_refunds
    WHERE id = p_refund_id
    FOR UPDATE;

    IF NOT FOUND THEN
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

    UPDATE public.payment_orders
    SET
        payment_status =
            CASE
                WHEN v_refund.refund_amount_inr = amount_inr
                THEN 'refunded'
                ELSE 'partially_refunded'
            END,
        updated_at = now()
    WHERE id = v_refund.payment_order_id;

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

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.confirm_refund_processed(UUID,TEXT,JSONB)
SET row_security = off;

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.payment_orders
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.payment_orders
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.payment_attempts
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.payment_attempts
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.payment_refunds
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.payment_refunds
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.payment_events
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.payment_events
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.financial_ledger
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.financial_ledger
FORCE ROW LEVEL SECURITY;

-- =============================================================
-- POLICIES
-- =============================================================

DROP POLICY IF EXISTS payment_orders_read
ON public.payment_orders;

CREATE POLICY payment_orders_read
ON public.payment_orders
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        IN (
            'hospital_admin',
            'receptionist'
        )
);

DROP POLICY IF EXISTS payment_orders_manage
ON public.payment_orders;

CREATE POLICY payment_orders_manage
ON public.payment_orders
FOR ALL
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
)
WITH CHECK (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

DROP POLICY IF EXISTS payment_attempts_read
ON public.payment_attempts;

CREATE POLICY payment_attempts_read
ON public.payment_attempts
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        IN (
            'hospital_admin',
            'receptionist'
        )
);

DROP POLICY IF EXISTS payment_refunds_read
ON public.payment_refunds;

CREATE POLICY payment_refunds_read
ON public.payment_refunds
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

DROP POLICY IF EXISTS payment_refunds_manage
ON public.payment_refunds;

CREATE POLICY payment_refunds_manage
ON public.payment_refunds
FOR ALL
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
)
WITH CHECK (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

DROP POLICY IF EXISTS payment_events_admin
ON public.payment_events;

CREATE POLICY payment_events_admin
ON public.payment_events
FOR ALL
USING (
    public.is_global_admin()
);

DROP POLICY IF EXISTS ledger_read
ON public.financial_ledger;

CREATE POLICY ledger_read
ON public.financial_ledger
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

DROP POLICY IF EXISTS ledger_no_direct_insert
ON public.financial_ledger;

CREATE POLICY ledger_no_direct_insert
ON public.financial_ledger
FOR INSERT
WITH CHECK (false);

COMMIT;