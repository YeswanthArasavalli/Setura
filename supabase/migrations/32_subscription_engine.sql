-- =============================================================
-- SETURA HOSPITAL OS
-- Script 32: Subscription Engine
-- Run AFTER Script 31
-- =============================================================
-- PURPOSE: SaaS subscription lifecycle management.
--   - Global plan catalogue (starter / professional / enterprise)
--   - Per-hospital subscription with limits (max_doctors etc.)
--   - Immutable billing history
--   - Auto-trial on hospital creation
--   - is_subscription_active() gate for feature access
-- =============================================================

BEGIN;

-- ============================================================
-- ENUMS
-- ============================================================

DO $$ BEGIN
    CREATE TYPE public.subscription_status AS ENUM (
        'trial', 'active', 'suspended', 'cancelled', 'expired', 'past_due'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE public.billing_cycle AS ENUM (
        'monthly', 'quarterly', 'annual'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- SUBSCRIPTION PLANS  (global, set by SETURA platform team)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.subscription_plans (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    plan_name TEXT NOT NULL UNIQUE
        CHECK (
            plan_name = lower(trim(plan_name))
        ),
    display_name TEXT NOT NULL,
    description  TEXT,

    -- Hard limits
    max_doctors               INTEGER NOT NULL DEFAULT 1  CHECK (max_doctors > 0),
    max_receptionists         INTEGER NOT NULL DEFAULT 2  CHECK (max_receptionists > 0),
    max_bookings_per_month    INTEGER          CHECK (max_bookings_per_month IS NULL OR max_bookings_per_month > 0),
    max_patients              INTEGER          CHECK (max_patients            IS NULL OR max_patients            > 0),

    -- Feature flags
    whatsapp_enabled          BOOLEAN NOT NULL DEFAULT true,
    analytics_enabled         BOOLEAN NOT NULL DEFAULT true,
    multi_doctor_enabled      BOOLEAN NOT NULL DEFAULT false,
    custom_branding_enabled   BOOLEAN NOT NULL DEFAULT false,
    api_access_enabled        BOOLEAN NOT NULL DEFAULT false,

    -- Pricing in INR
    price_monthly_inr   NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price_monthly_inr   >= 0),
    price_quarterly_inr NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price_quarterly_inr >= 0),
    price_annual_inr    NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price_annual_inr    >= 0),

    -- Trial
    trial_days  INTEGER NOT NULL DEFAULT 30 CHECK (trial_days >= 0),

    is_active   BOOLEAN NOT NULL DEFAULT true,
    sort_order  INTEGER NOT NULL DEFAULT 0,

    metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_plans_active
    ON public.subscription_plans (is_active, sort_order);

DROP TRIGGER IF EXISTS trg_subscription_plans_updated_at ON public.subscription_plans;
CREATE TRIGGER trg_subscription_plans_updated_at
    BEFORE UPDATE ON public.subscription_plans
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Seed default plans
INSERT INTO public.subscription_plans (
    plan_name, display_name, description,
    max_doctors, max_receptionists, max_bookings_per_month,
    price_monthly_inr, price_annual_inr, trial_days,
    multi_doctor_enabled, analytics_enabled, sort_order
) VALUES
    ('trial',        'Free Trial',    'Full-access 30-day trial.',                 1,  2, 100,   0,      0,     30, false, true, 0),
    ('starter',      'Starter',       'Single-doctor clinic. Small practice.',      1,  2, 200,   999,    9999,  30, false, true, 1),
    ('professional', 'Professional',  'Up to 3 doctors with advanced analytics.',   3,  5, 500,   1999,   19999, 14, true,  true, 2),
    ('enterprise',   'Enterprise',    'Unlimited scale, custom branding, API.',     50, 20, NULL,  4999,   49999, 7,  true,  true, 3)
ON CONFLICT (plan_name) DO NOTHING;

-- ============================================================
-- HOSPITAL SUBSCRIPTIONS  (one active subscription per hospital)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.hospital_subscriptions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    hospital_id UUID NOT NULL UNIQUE
        REFERENCES public.hospitals(id) ON DELETE CASCADE,

    plan_id     UUID NOT NULL
        REFERENCES public.subscription_plans(id) ON DELETE RESTRICT,

    -- Snapshot at time of subscription (plan name may change)
    plan_name            TEXT NOT NULL,
    subscription_status  public.subscription_status NOT NULL DEFAULT 'trial',
    billing_cycle        public.billing_cycle        NOT NULL DEFAULT 'monthly',

    -- Key dates
    trial_starts_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    subscription_starts_at  TIMESTAMPTZ,
    expires_at              TIMESTAMPTZ,
    cancelled_at            TIMESTAMPTZ,

    -- Billing
    billing_status  TEXT NOT NULL DEFAULT 'pending'
        CHECK (billing_status IN (
            'pending','active','overdue','failed','cancelled','waived'
        )),
    last_invoice_date   DATE,
    next_invoice_date   DATE,
    current_period_start DATE,
    current_period_end   DATE,

    -- Razorpay
    razorpay_subscription_id TEXT UNIQUE,
    razorpay_customer_id     TEXT,

    -- Snapshotted limits
    max_doctors            INTEGER NOT NULL DEFAULT 1,
    max_receptionists      INTEGER NOT NULL DEFAULT 2,
    max_bookings_per_month INTEGER,

    -- Live usage counters (updated by triggers / cron)

    current_month_bookings INTEGER NOT NULL DEFAULT 0
        CHECK (current_month_bookings >= 0),

    current_doctor_count INTEGER NOT NULL DEFAULT 0
        CHECK (current_doctor_count >= 0),

    current_receptionist_count INTEGER NOT NULL DEFAULT 0
        CHECK (current_receptionist_count >= 0),

    notes    TEXT,
    metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.hospital_subscriptions
DROP CONSTRAINT IF EXISTS chk_subscription_period_dates;

ALTER TABLE public.hospital_subscriptions
DROP CONSTRAINT IF EXISTS chk_subscription_period_dates;

ALTER TABLE public.hospital_subscriptions
ADD CONSTRAINT chk_subscription_period_dates
CHECK (
    current_period_start IS NULL
    OR current_period_end IS NULL
    OR current_period_end >= current_period_start
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
    ON public.hospital_subscriptions (subscription_status, expires_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_expiring
    ON public.hospital_subscriptions (expires_at)
    WHERE subscription_status IN ('active', 'trial');
CREATE INDEX IF NOT EXISTS idx_subscriptions_razorpay
    ON public.hospital_subscriptions (razorpay_subscription_id)
    WHERE razorpay_subscription_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON public.hospital_subscriptions;
CREATE TRIGGER trg_subscriptions_updated_at
    BEFORE UPDATE ON public.hospital_subscriptions
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- BILLING HISTORY  (immutable ledger)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.subscription_billing_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id     UUID NOT NULL REFERENCES public.hospitals(id) ON DELETE CASCADE,
    subscription_id UUID NOT NULL REFERENCES public.hospital_subscriptions(id) ON DELETE CASCADE,

    event_type TEXT NOT NULL
        CHECK (event_type IN (
            'invoice_created','invoice_paid','invoice_failed',
            'subscription_activated','subscription_renewed',
            'subscription_cancelled','subscription_suspended',
            'trial_started','trial_ended','plan_changed',
            'discount_applied','refund_issued'
        )),

    amount_inr           NUMERIC(10,2) NOT NULL DEFAULT 0,
    billing_period_start DATE,
    billing_period_end   DATE,
    gateway_invoice_id   TEXT,
    gateway_response     JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(gateway_response) = 'object'),
    notes                TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_history_hospital
    ON public.subscription_billing_history (hospital_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_history_sub
    ON public.subscription_billing_history (subscription_id, created_at DESC);

-- Immutability
-- NOTE: migration 10's prevent_audit_log_modification() hard-codes the
-- message "audit_logs are immutable" - reusing it here would raise a
-- confusing error naming the wrong table. A generic, reusable trigger
-- function is defined instead, parameterized via TG_TABLE_NAME.
CREATE OR REPLACE FUNCTION public.prevent_immutable_row_modification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable and cannot be updated or deleted',
        TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS trg_billing_history_immutable ON public.subscription_billing_history;
CREATE TRIGGER trg_billing_history_immutable
    BEFORE UPDATE OR DELETE ON public.subscription_billing_history
    FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_row_modification();

-- ============================================================
-- AUTO-CREATE TRIAL SUBSCRIPTION ON HOSPITAL INSERT
-- ============================================================

CREATE OR REPLACE FUNCTION public.auto_create_trial_subscription()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_plan RECORD;
BEGIN
    SELECT * INTO v_plan
      FROM public.subscription_plans
     WHERE plan_name = 'trial' AND is_active = true
     LIMIT 1;

    IF NOT FOUND THEN RETURN NEW; END IF;

    INSERT INTO public.hospital_subscriptions (
        hospital_id, plan_id, plan_name,
        subscription_status, billing_status,
        trial_starts_at, expires_at,
        max_doctors, max_receptionists,  max_bookings_per_month
    )
    VALUES (
        NEW.id, v_plan.id, v_plan.plan_name,
        'trial', 'active',
        now(),
        now() + (v_plan.trial_days || ' days')::INTERVAL,
        v_plan.max_doctors, v_plan.max_receptionists, v_plan.max_bookings_per_month
    )
    ON CONFLICT (hospital_id) DO NOTHING;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_trial_subscription ON public.hospitals;
CREATE TRIGGER trg_auto_trial_subscription
    AFTER INSERT ON public.hospitals
    FOR EACH ROW EXECUTE FUNCTION public.auto_create_trial_subscription();

-- Backfill existing hospitals
INSERT INTO public.hospital_subscriptions (
    hospital_id, plan_id, plan_name,
    subscription_status, billing_status,
    trial_starts_at, expires_at,
    max_doctors, max_receptionists, max_bookings_per_month
)
SELECT h.id, sp.id, sp.plan_name,
       'trial', 'active', now(),
        now() + (sp.trial_days || ' days')::INTERVAL, 
        sp.max_doctors, sp.max_receptionists, sp.max_bookings_per_month
  FROM public.hospitals          h
  JOIN public.subscription_plans sp ON sp.plan_name = 'trial'
 WHERE h.deleted_at IS NULL
ON CONFLICT (hospital_id) DO NOTHING;

-- ============================================================
-- is_subscription_active(hospital_id)
-- Gate check for all feature endpoints
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_subscription_active(p_hospital_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.hospital_subscriptions
         WHERE hospital_id        = p_hospital_id
           AND subscription_status IN ('active', 'trial')
           AND (expires_at IS NULL OR expires_at > now())
    );
$$;
REVOKE ALL     ON FUNCTION public.is_subscription_active(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_subscription_active(UUID) TO authenticated;

-- ============================================================
-- get_subscription_limits(hospital_id)
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_subscription_limits(p_hospital_id UUID)
RETURNS TABLE (
    max_doctors               INTEGER,
    max_receptionists         INTEGER,
    max_bookings_per_month    INTEGER,
    current_doctor_count      INTEGER,
    current_receptionist_count INTEGER,
    current_month_bookings    INTEGER,
    subscription_status       TEXT,
    plan_name                 TEXT,
    expires_at                TIMESTAMPTZ,
    is_active                 BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        hs.max_doctors,
        hs.max_receptionists,
        hs.max_bookings_per_month,
        hs.current_doctor_count,
        hs.current_receptionist_count,
        hs.current_month_bookings,
        hs.subscription_status::TEXT,
        hs.plan_name,
        hs.expires_at,
        (
            hs.subscription_status IN ('active','trial')
            AND (hs.expires_at IS NULL OR hs.expires_at > now())
        )
    FROM public.hospital_subscriptions hs
    WHERE hs.hospital_id = p_hospital_id
    LIMIT 1;
$$;
REVOKE ALL     ON FUNCTION public.get_subscription_limits(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_subscription_limits(UUID) TO authenticated;

-- ============================================================
-- change_subscription_plan()
-- ============================================================

CREATE OR REPLACE FUNCTION public.change_subscription_plan(
    p_hospital_id   UUID,
    p_new_plan_name TEXT,
    p_billing_cycle public.billing_cycle,
    p_performed_by  UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_plan    RECORD;
    v_sub     RECORD;
    v_hist_id UUID;
    v_expires TIMESTAMPTZ;
BEGIN
    SELECT * INTO v_plan FROM public.subscription_plans
     WHERE plan_name = p_new_plan_name AND is_active = true;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Plan not found: %', p_new_plan_name;
    END IF;

    SELECT * INTO v_sub FROM public.hospital_subscriptions
     WHERE hospital_id = p_hospital_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No subscription found for hospital';
    END IF;

    -- Prevent downgrade below current usage

    IF v_sub.current_doctor_count > v_plan.max_doctors THEN
        RAISE EXCEPTION
            'Cannot change plan. Current doctor count (%) exceeds new plan limit (%)',
            v_sub.current_doctor_count,
            v_plan.max_doctors;
    END IF;

    IF v_sub.current_receptionist_count > v_plan.max_receptionists THEN
        RAISE EXCEPTION
            'Cannot change plan. Current receptionist count (%) exceeds new plan limit (%)',
            v_sub.current_receptionist_count,
            v_plan.max_receptionists;
    END IF;

    IF v_plan.max_bookings_per_month IS NOT NULL
    AND v_sub.current_month_bookings > v_plan.max_bookings_per_month THEN
        RAISE EXCEPTION
            'Cannot change plan. Current monthly bookings (%) exceed new plan limit (%)',
            v_sub.current_month_bookings,
            v_plan.max_bookings_per_month;
    END IF;

    v_expires := CASE p_billing_cycle
        WHEN 'monthly'   THEN now() + INTERVAL '1 month'
        WHEN 'quarterly' THEN now() + INTERVAL '3 months'
        WHEN 'annual'    THEN now() + INTERVAL '1 year'
    END;

    UPDATE public.hospital_subscriptions
       SET plan_id               = v_plan.id,
           plan_name             = v_plan.plan_name,
           subscription_status   = 'active',
           billing_cycle         = p_billing_cycle,
           billing_status        = 'active',
           subscription_starts_at = COALESCE(subscription_starts_at, now()),
           max_doctors           = v_plan.max_doctors,
           max_receptionists     = v_plan.max_receptionists,
           max_bookings_per_month = v_plan.max_bookings_per_month,
           expires_at            = v_expires,
           current_period_start  = CURRENT_DATE,
           current_period_end    = v_expires::DATE,
           updated_at            = now()
     WHERE hospital_id = p_hospital_id;

    INSERT INTO public.subscription_billing_history (
        hospital_id, subscription_id, event_type, amount_inr,
        billing_period_start, billing_period_end, notes
    )
    VALUES (
        p_hospital_id, v_sub.id, 'plan_changed',
        CASE p_billing_cycle
            WHEN 'monthly'   THEN v_plan.price_monthly_inr
            WHEN 'quarterly' THEN v_plan.price_quarterly_inr
            WHEN 'annual'    THEN v_plan.price_annual_inr
        END,
        CURRENT_DATE, v_expires::DATE,
        FORMAT('Changed from %s -> %s by %s',
               v_sub.plan_name, p_new_plan_name, p_performed_by)
    )
    RETURNING id INTO v_hist_id;

    RETURN v_hist_id;
END;
$$;

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE public.subscription_plans             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_plans             FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.hospital_subscriptions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hospital_subscriptions         FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.subscription_billing_history   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_billing_history   FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sp_read   ON public.subscription_plans;
CREATE POLICY        sp_read    ON public.subscription_plans FOR SELECT
    USING (is_active = true OR public.is_global_admin());
DROP POLICY IF EXISTS sp_manage ON public.subscription_plans;
CREATE POLICY        sp_manage  ON public.subscription_plans FOR ALL
    USING      (public.is_global_admin())
    WITH CHECK (public.is_global_admin());

DROP POLICY IF EXISTS hs_read   ON public.hospital_subscriptions;
CREATE POLICY        hs_read    ON public.hospital_subscriptions FOR SELECT
    USING (
        public.is_global_admin()
        OR public.current_user_role(hospital_id) = 'hospital_admin'
    );
DROP POLICY IF EXISTS hs_manage ON public.hospital_subscriptions;
CREATE POLICY        hs_manage  ON public.hospital_subscriptions FOR ALL
    USING      (public.is_global_admin())
    WITH CHECK (public.is_global_admin());

DROP POLICY IF EXISTS sbh_read  ON public.subscription_billing_history;
CREATE POLICY        sbh_read   ON public.subscription_billing_history FOR SELECT
    USING (
        public.is_global_admin()
        OR public.current_user_role(hospital_id) = 'hospital_admin'
    );

COMMIT;
