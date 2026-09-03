-- =============================================================
-- SETURA HOSPITAL OS
-- Script 07: Settlement Engine
-- PRODUCTION SAFE VERSION
-- Run AFTER Script 06
-- =============================================================

-- =============================================================
-- ENUMS
-- =============================================================

DO $$
BEGIN
    CREATE TYPE public.settlement_status AS ENUM (
        'pending',
        'partially_paid',
        'paid',
        'overdue',
        'disputed'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================
-- DAILY COLLECTION ENTRIES
-- Immutable booking financial snapshots
-- =============================================================

CREATE TABLE IF NOT EXISTS public.daily_collection_entries (
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

    booking_source public.booking_source
        NOT NULL,

    collection_date DATE NOT NULL DEFAULT CURRENT_DATE,

    platform_fee NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (platform_fee >= 0),

    receptionist_fee NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (receptionist_fee >= 0),

    hospital_fee NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (hospital_fee >= 0),

    total_amount NUMERIC(12,2) NOT NULL DEFAULT 0
        CHECK (total_amount >= 0),

    settlement_id UUID,

    is_settled BOOLEAN NOT NULL DEFAULT false,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_collection_total
        CHECK (
            total_amount =
            (
                platform_fee
                +
                receptionist_fee
                +
                hospital_fee
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_collection_hospital_date
ON public.daily_collection_entries(
    hospital_id,
    collection_date
);

CREATE INDEX IF NOT EXISTS idx_collection_unsettled
ON public.daily_collection_entries(
    hospital_id,
    collection_date
)
WHERE is_settled = false;

CREATE INDEX IF NOT EXISTS idx_collection_settlement
ON public.daily_collection_entries(
    settlement_id
);

CREATE INDEX IF NOT EXISTS idx_collection_booking
ON public.daily_collection_entries(
    booking_id
);

-- =============================================================
-- HOSPITAL SETTLEMENTS
-- =============================================================

CREATE TABLE IF NOT EXISTS public.hospital_settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    settlement_start_date DATE NOT NULL,

    settlement_end_date DATE NOT NULL,

    total_platform_amount NUMERIC(14,2)
        NOT NULL DEFAULT 0
        CHECK (total_platform_amount >= 0),

    total_receptionist_amount NUMERIC(14,2)
        NOT NULL DEFAULT 0
        CHECK (total_receptionist_amount >= 0),

    total_bookings INTEGER NOT NULL DEFAULT 0
        CHECK (total_bookings >= 0),

    amount_paid_to_setura NUMERIC(14,2)
        NOT NULL DEFAULT 0
        CHECK (amount_paid_to_setura >= 0),

    remaining_due NUMERIC(14,2)
        NOT NULL DEFAULT 0
        CHECK (remaining_due >= 0),

    settlement_status public.settlement_status
        NOT NULL DEFAULT 'pending',

    collected_by UUID
        REFERENCES public.profiles(id),

    paid_at TIMESTAMPTZ,

    notes TEXT,

    metadata JSONB NOT NULL DEFAULT '{}'
        CHECK (
            jsonb_typeof(metadata) = 'object'
        ),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT valid_settlement_dates
        CHECK (
            settlement_end_date >= settlement_start_date
        ),

    CONSTRAINT unique_settlement_period
        UNIQUE (
            hospital_id,
            settlement_start_date,
            settlement_end_date
        )
);

CREATE INDEX IF NOT EXISTS idx_settlements_hospital_status
ON public.hospital_settlements(
    hospital_id,
    settlement_status
);

CREATE INDEX IF NOT EXISTS idx_settlements_hospital_dates
ON public.hospital_settlements(
    hospital_id,
    settlement_start_date,
    settlement_end_date
);

DROP TRIGGER IF EXISTS trg_settlements_updated_at
ON public.hospital_settlements;

CREATE TRIGGER trg_settlements_updated_at
BEFORE UPDATE ON public.hospital_settlements
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_settlements_hospital_immutable
ON public.hospital_settlements;

CREATE TRIGGER trg_settlements_hospital_immutable
BEFORE UPDATE ON public.hospital_settlements
FOR EACH ROW
EXECUTE FUNCTION public.prevent_hospital_id_update();

-- =============================================================
-- SETTLEMENT ITEMS
-- Immutable settlement line items
-- =============================================================

CREATE TABLE IF NOT EXISTS public.settlement_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    settlement_id UUID NOT NULL
        REFERENCES public.hospital_settlements(id)
        ON DELETE CASCADE,

    collection_entry_id UUID UNIQUE
        REFERENCES public.daily_collection_entries(id)
        ON DELETE RESTRICT,

    platform_fee_amount NUMERIC(12,2)
        NOT NULL CHECK (platform_fee_amount >= 0),

    receptionist_fee_amount NUMERIC(12,2)
        NOT NULL DEFAULT 0
        CHECK (receptionist_fee_amount >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_settlement_items_settlement
ON public.settlement_items(
    settlement_id
);

CREATE INDEX IF NOT EXISTS idx_settlement_items_collection
ON public.settlement_items(
    collection_entry_id
);

-- =============================================================
-- OUTSTANDING BALANCES
-- =============================================================

CREATE TABLE IF NOT EXISTS public.outstanding_balances (
    hospital_id UUID PRIMARY KEY
        REFERENCES public.hospitals(id)
        ON DELETE CASCADE,

    total_outstanding NUMERIC(14,2)
        NOT NULL DEFAULT 0
        CHECK (total_outstanding >= 0),

    last_settlement_date DATE,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================
-- AUTO CREATE COLLECTION ENTRY
-- =============================================================

CREATE OR REPLACE FUNCTION public.auto_create_collection_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

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

    RETURN NEW;

END;
$$;

ALTER FUNCTION public.auto_create_collection_entry()
SET row_security = off;

DROP TRIGGER IF EXISTS trg_auto_create_collection
ON public.bookings;

CREATE TRIGGER trg_auto_create_collection
AFTER INSERT ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.auto_create_collection_entry();

-- =============================================================
-- CREATE SETTLEMENT
-- FULLY ATOMIC
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_hospital_settlement(
    p_hospital_id UUID,
    p_start_date DATE,
    p_end_date DATE,
    p_collected_by UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_sid UUID;
    v_total_platform NUMERIC(14,2);
    v_total_receptionist NUMERIC(14,2);
    v_total_bookings INTEGER;
BEGIN

    IF p_end_date < p_start_date THEN
        RAISE EXCEPTION 'Invalid settlement date range';
    END IF;

    -- SERIALIZE settlement creation
    PERFORM pg_advisory_xact_lock(
        hashtext(
            p_hospital_id::TEXT
            || '_'
            || p_start_date::TEXT
            || '_'
            || p_end_date::TEXT
        )
    );

    IF EXISTS (
        SELECT 1
        FROM public.hospital_settlements
        WHERE hospital_id = p_hospital_id
          AND settlement_start_date = p_start_date
          AND settlement_end_date = p_end_date
    ) THEN
        RAISE EXCEPTION
            'Settlement already exists for this period';
    END IF;

    -- LOCK rows to prevent double settlement
    PERFORM 1
    FROM public.daily_collection_entries
    WHERE hospital_id = p_hospital_id
      AND collection_date BETWEEN p_start_date AND p_end_date
      AND is_settled = false
    FOR UPDATE;

    SELECT
        COALESCE(SUM(platform_fee), 0),
        COALESCE(SUM(receptionist_fee), 0),
        COUNT(*)
    INTO
        v_total_platform,
        v_total_receptionist,
        v_total_bookings
    FROM public.daily_collection_entries
    WHERE hospital_id = p_hospital_id
      AND collection_date BETWEEN p_start_date AND p_end_date
      AND is_settled = false;

    INSERT INTO public.hospital_settlements (
        hospital_id,
        settlement_start_date,
        settlement_end_date,
        total_platform_amount,
        total_receptionist_amount,
        total_bookings,
        remaining_due,
        collected_by
    )
    VALUES (
        p_hospital_id,
        p_start_date,
        p_end_date,
        v_total_platform,
        v_total_receptionist,
        v_total_bookings,
        v_total_platform,
        p_collected_by
    )
    RETURNING id INTO v_sid;

    INSERT INTO public.settlement_items (
        settlement_id,
        collection_entry_id,
        platform_fee_amount,
        receptionist_fee_amount
    )
    SELECT
        v_sid,
        id,
        platform_fee,
        receptionist_fee
    FROM public.daily_collection_entries
    WHERE hospital_id = p_hospital_id
      AND collection_date BETWEEN p_start_date AND p_end_date
      AND is_settled = false;

    UPDATE public.daily_collection_entries
    SET
        is_settled = true,
        settlement_id = v_sid
    WHERE hospital_id = p_hospital_id
      AND collection_date BETWEEN p_start_date AND p_end_date
      AND is_settled = false;

    PERFORM public.refresh_outstanding_balance(
        p_hospital_id
    );

    RETURN v_sid;

END;
$$;

ALTER FUNCTION public.create_hospital_settlement(UUID,DATE,DATE,UUID)
SET row_security = off;

-- =============================================================
-- RECORD PAYMENT
-- =============================================================

CREATE OR REPLACE FUNCTION public.record_settlement_payment(
    p_settlement_id UUID,
    p_paid_amount NUMERIC,
    p_performed_by UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_settlement RECORD;
BEGIN

    IF p_paid_amount <= 0 THEN
        RAISE EXCEPTION 'Payment amount must be positive';
    END IF;

    SELECT *
    INTO v_settlement
    FROM public.hospital_settlements
    WHERE id = p_settlement_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    IF p_paid_amount > v_settlement.remaining_due THEN
        RAISE EXCEPTION
            'Payment exceeds remaining due';
    END IF;

    UPDATE public.hospital_settlements
    SET
        amount_paid_to_setura =
            amount_paid_to_setura
            +
            p_paid_amount,

        remaining_due =
            remaining_due
            -
            p_paid_amount,

        settlement_status =
            CASE
                WHEN (
                    remaining_due - p_paid_amount
                ) <= 0
                THEN 'paid'::public.settlement_status

                ELSE 'partially_paid'::public.settlement_status
            END,

        paid_at =
            CASE
                WHEN (
                    remaining_due - p_paid_amount
                ) <= 0
                THEN now()
                ELSE paid_at
            END

    WHERE id = p_settlement_id;

    PERFORM public.refresh_outstanding_balance(
        v_settlement.hospital_id
    );

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.record_settlement_payment(UUID,NUMERIC,UUID)
SET row_security = off;

-- =============================================================
-- REFRESH OUTSTANDING BALANCE
-- =============================================================

CREATE OR REPLACE FUNCTION public.refresh_outstanding_balance(
    p_hospital_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN

    INSERT INTO public.outstanding_balances (
        hospital_id,
        total_outstanding,
        last_settlement_date
    )
    SELECT
        p_hospital_id,
        COALESCE(
            SUM(remaining_due),
            0
        ),
        MAX(settlement_end_date)
    FROM public.hospital_settlements
    WHERE hospital_id = p_hospital_id
      AND settlement_status IN (
            'pending',
            'partially_paid',
            'overdue'
      )

    ON CONFLICT (hospital_id)
    DO UPDATE
    SET
        total_outstanding =
            EXCLUDED.total_outstanding,

        last_settlement_date =
            EXCLUDED.last_settlement_date,

        updated_at = now();

    RETURN TRUE;

END;
$$;

ALTER FUNCTION public.refresh_outstanding_balance(UUID)
SET row_security = off;

-- =============================================================
-- ENABLE RLS
-- =============================================================

ALTER TABLE public.daily_collection_entries
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.hospital_settlements
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.settlement_items
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.outstanding_balances
ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.daily_collection_entries
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.hospital_settlements
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.settlement_items
FORCE ROW LEVEL SECURITY;

ALTER TABLE public.outstanding_balances
FORCE ROW LEVEL SECURITY;

-- =============================================================
-- POLICIES
-- =============================================================

DROP POLICY IF EXISTS settlement_read
ON public.hospital_settlements;

CREATE POLICY settlement_read
ON public.hospital_settlements
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

CREATE POLICY settlement_manage
ON public.hospital_settlements
FOR ALL
USING (
    public.is_global_admin()
)
WITH CHECK (
    public.is_global_admin()
);

CREATE POLICY collection_entries_read
ON public.daily_collection_entries
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        IN (
            'hospital_admin',
            'receptionist'
        )
);

CREATE POLICY outstanding_balances_read
ON public.outstanding_balances
FOR SELECT
USING (
    public.is_global_admin()
    OR public.current_user_role(hospital_id)
        = 'hospital_admin'
);

-- =============================================================
-- REALTIME
-- =============================================================

DO $$
BEGIN

    BEGIN
        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.hospital_settlements;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;

    BEGIN
        ALTER PUBLICATION supabase_realtime
        ADD TABLE public.outstanding_balances;
    EXCEPTION
        WHEN duplicate_object THEN NULL;
    END;

END $$;