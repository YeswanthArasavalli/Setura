-- =============================================================
-- 72_ws_conf_1_cancellation_policy_configuration.sql
--
-- WS-CONF-1 - Hospital Cancellation Policy Configuration.
--
-- Product gap (established by inspecting the CURRENT source, not a stale
-- report): a hospital's cancellation / refund policy lives in the
-- per-tenant `cancellation_policies` table (migration 29). Every column is
-- operator-relevant (free-cancellation window, partial-refund window + %,
-- same-day refund %, no-show penalty, manual-full-refund allowance, notes),
-- a default row is auto-created for each tenant (trg_auto_cancellation_policy),
-- and the values are READ by the live refund engine (`calculate_refund_amount`)
-- and the WhatsApp cancellation flow. But NO authorized write path exists: the
-- only INSERT in the repository is the auto-create trigger / one-time backfill,
-- and there is no RPC, no Edge action and no UI that edits an existing row.
-- Configuring a real hospital's cancellation policy therefore today requires a
-- developer to run raw SQL or hand-edit a database row - exactly what the
-- owner-stated onboarding goal forbids ("adding a real hospital should NOT
-- require developer SQL / manually modifying database rows").
--
-- This migration closes that gap ADDITIVELY and WITHOUT inventing policy. The
-- refund tiers are the hospital operator's own business inputs; the column set,
-- defaults, CHECK constraints and version history already exist (migration 29).
-- We expose the SAME already-defined, already-consumed columns through a
-- canonical, atomic, authorized, versioned and audited write surface, exactly
-- as WS-ONBOARD-2 (migration 66) did for `hospital_settings`.
--
-- Two RPCs are added (service_role-only, called ONLY by the cancellation-policy
-- Edge Function):
--
--   1. get_cancellation_policy(...)  - read the tenant's current policy row +
--      its recent version history, for the admin form.
--
--   2. update_cancellation_policy(...)  - the single canonical, atomic,
--      authorized write path over the editable policy columns.
--
-- Existing primitives are reused exactly (AGENTS.md sec 6):
--
--   * Policy versioning: the existing trg_cancel_policy_history AFTER-UPDATE
--     trigger (migration 29) already writes an append-only
--     `cancellation_policy_history` snapshot whenever `version` changes. The
--     RPC bumps `version` on a real change and lets that EXISTING trigger record
--     history; it does NOT add a second version store or a second trigger.
--   * Audit: the existing write_audit_log path, reached through logAuditEvent
--     at the Edge layer (migration 36 / 39). This migration registers the
--     `cancellation_policy_update` audit_action_type so severity defaults land
--     correctly.
--   * Idempotency: the existing api_idempotency_keys registry (migration 25)
--     lives at the Edge layer; the RPC itself is version-guarded.
--   * Tenant isolation: existing FORCE ROW LEVEL SECURITY policies
--     (cp_read / cp_manage, migration 29) remain intact.
--
-- Security posture (AGENTS.md sec 7, F16-04 standing rule):
--   * Both new functions are SECURITY DEFINER with an explicit REVOKE from
--     PUBLIC / anon / authenticated and a GRANT to service_role only. A NEW
--     SECURITY DEFINER function needs its OWN explicit REVOKE; no prior
--     migration's default-privilege behavior is trusted.
--   * search_path pinned to public; row_security off so the definer body can
--     read user_roles under RLS and write cancellation_policies (FORCE RLS) as
--     owner. Mirrors the proven migration 66 / 71 pattern.
--   * DB-layer authorization is defense-in-depth: even though the Edge layer
--     already requireRole(['global_admin','hospital_admin']) and resolveAuth()
--     resolves the authenticated tenant, each RPC independently re-checks that
--     p_actor_user_id either holds global_admin, or holds hospital_admin scoped
--     to p_hospital_id. Any other actor or tenant mismatch is SQLSTATE 42501.
--     Client-supplied hospital identity NEVER drives tenancy.
--   * Concurrency: the target row is locked FOR UPDATE inside the RPC, and an
--     optimistic expected_version check compares the caller's version against
--     the row's current `version`. A mismatch is SQLSTATE P0001 (raise_exception
--     - deliberately NOT 40001, which PostgREST treats as retryable and would
--     turn a benign conflict into a client timeout), mapped to HTTP 409 at the
--     Edge layer.
--   * Validation: unknown / non-editable keys are 22023 (invalid_parameter_value);
--     range/shape violations raised by the existing CHECK constraints are caught
--     and translated to 22023 with a clean name. The PostgreSQL error text is
--     never leaked to the client.
--   * The cancellation_policies.id, hospital_id, version, created_at, updated_at
--     and metadata columns are system-managed and are REJECTED in the patch; the
--     RPC alone maintains `version` so the history trigger stays coherent.
--
-- Deliberately OUT of scope (would invent policy or reopen closed work):
--   * Any change to the REFUND CALCULATION semantics (calculate_refund_amount,
--     migration 29 / 60) or the NPD-01 GST ruling - we only configure the
--     existing stored inputs, never a new business rule.
--   * Any change to WS-ONBOARD-1..5, WS-SEC-1, WS-OPS-1, G-03..G-11, C2/C2b,
--     G7-13, G7-16 or migration 29 itself (historical migrations are immutable).
--   * No production/staging deployment, secrets or provider validation.
-- =============================================================

-- =============================================================
-- READ PATH: get_cancellation_policy
-- =============================================================

CREATE OR REPLACE FUNCTION public.get_cancellation_policy(
    p_actor_user_id UUID,
    p_hospital_id   UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_pol public.cancellation_policies%ROWTYPE;
BEGIN
    -- -- DB-layer authorization (defense-in-depth): actor must be global_admin
    -- OR hospital_admin of THIS hospital. auth.uid() is NULL under the
    -- service_role JWT, so the JWT-resolved actor is passed explicitly and
    -- re-verified here.
    IF p_actor_user_id IS NULL OR p_hospital_id IS NULL THEN
        RAISE EXCEPTION 'actor and hospital are required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id AND role = 'global_admin'
    ) AND NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id
          AND role = 'hospital_admin'
          AND hospital_id = p_hospital_id
    ) THEN
        RAISE EXCEPTION 'actor is not authorized to read this cancellation policy'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_pol
      FROM public.cancellation_policies
     WHERE hospital_id = p_hospital_id;
    IF NOT FOUND THEN
        -- Auto-created on tenant insert; a missing row means the tenant is
        -- unknown. Do not disclose which; the Edge layer maps P0002 to 403.
        RAISE EXCEPTION 'cancellation policy row missing'
            USING ERRCODE = 'P0002';
    END IF;

    RETURN jsonb_build_object(
        'ok',          true,
        'hospital_id', p_hospital_id,
        'version',     v_pol.version,
        'policy', jsonb_build_object(
            'id',                          v_pol.id,
            'full_refund_within_minutes',  v_pol.full_refund_within_minutes,
            'partial_refund_percentage',   v_pol.partial_refund_percentage,
            'partial_refund_within_minutes', v_pol.partial_refund_within_minutes,
            'same_day_refund_percentage',  v_pol.same_day_refund_percentage,
            'no_show_penalty_enabled',     v_pol.no_show_penalty_enabled,
            'no_show_penalty_amount_inr',  v_pol.no_show_penalty_amount_inr,
            'allow_manual_full_refund',    v_pol.allow_manual_full_refund,
            'version',                     v_pol.version,
            'effective_from',              v_pol.effective_from,
            'notes',                       v_pol.notes,
            'created_at',                  v_pol.created_at,
            'updated_at',                  v_pol.updated_at
        ),
        'history', (
            SELECT COALESCE(
                jsonb_agg(jsonb_build_object(
                    'version',    h.version,
                    'changed_by', h.changed_by,
                    'created_at', h.created_at,
                    'snapshot',   h.policy_snapshot
                ) ORDER BY h.created_at DESC),
                '[]'::jsonb
            )
            FROM (
                SELECT * FROM public.cancellation_policy_history
                 WHERE hospital_id = p_hospital_id
                 ORDER BY created_at DESC
                 LIMIT 20
            ) AS h
        )
    );
END;
$$;

ALTER FUNCTION public.get_cancellation_policy(UUID, UUID)
    SET row_security = off;

-- F16-04: a NEW SECURITY DEFINER function needs its OWN explicit REVOKE.
REVOKE ALL ON FUNCTION public.get_cancellation_policy(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_cancellation_policy(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.get_cancellation_policy(UUID, UUID) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.get_cancellation_policy(UUID, UUID) TO service_role;

COMMENT ON FUNCTION public.get_cancellation_policy(UUID, UUID) IS
'WS-CONF-1: canonical read of a tenant cancellation policy + recent version '
'history. service_role-only (Edge Function is the sole caller). Re-checks actor '
'is global_admin OR hospital_admin of the target tenant (42501). Returns JSONB.';

-- =============================================================
-- WRITE PATH: update_cancellation_policy
-- =============================================================

CREATE OR REPLACE FUNCTION public.update_cancellation_policy(
    p_actor_user_id    UUID,
    p_hospital_id      UUID,
    p_expected_version INTEGER,
    p_patch            JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_pol        public.cancellation_policies%ROWTYPE;
    v_allowed    TEXT[];
    v_key        TEXT;
    v_any_change BOOLEAN := false;
    v_full_min   INTEGER;
    v_part_pct   NUMERIC(5,2);
    v_part_min   INTEGER;
    v_same_pct   NUMERIC(5,2);
    v_ns_en      BOOLEAN;
    v_ns_amt     NUMERIC(10,2);
    v_manual     BOOLEAN;
    v_notes      TEXT;
    v_version_out INTEGER;
BEGIN
    -- -- 1. DB-layer authorization (defense-in-depth) ----------------
    IF p_actor_user_id IS NULL OR p_hospital_id IS NULL THEN
        RAISE EXCEPTION 'actor and hospital are required'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id AND role = 'global_admin'
    ) AND NOT EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = p_actor_user_id
          AND role = 'hospital_admin'
          AND hospital_id = p_hospital_id
    ) THEN
        RAISE EXCEPTION 'actor is not authorized to update this cancellation policy'
            USING ERRCODE = '42501';
    END IF;

    -- -- 2. Lock the target row FOR UPDATE ---------------------------
    SELECT * INTO v_pol
      FROM public.cancellation_policies
     WHERE hospital_id = p_hospital_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'cancellation policy row missing'
            USING ERRCODE = 'P0002';
    END IF;

    -- -- 3. Optimistic expected-version check ------------------------
    IF p_expected_version IS DISTINCT FROM v_pol.version THEN
        RAISE EXCEPTION 'policy version conflict: current %, expected %',
            v_pol.version, p_expected_version
            USING ERRCODE = 'P0001';
    END IF;

    -- -- 4. Reject unknown / system-managed keys ---------------------
    IF p_patch IS NOT NULL AND jsonb_typeof(p_patch) <> 'object' THEN
        RAISE EXCEPTION 'patch must be a JSON object'
            USING ERRCODE = '22023';
    END IF;
    v_allowed := ARRAY[
        'full_refund_within_minutes', 'partial_refund_percentage',
        'partial_refund_within_minutes', 'same_day_refund_percentage',
        'no_show_penalty_enabled', 'no_show_penalty_amount_inr',
        'allow_manual_full_refund', 'notes'
    ];
    FOR v_key IN SELECT jsonb_object_keys(COALESCE(p_patch, '{}'::jsonb))
    LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            RAISE EXCEPTION 'field "%" is not editable in cancellation policy', v_key
                USING ERRCODE = '22023';
        END IF;
    END LOOP;

    -- -- 5. Build a working copy from the current row, apply the patch
    v_full_min := v_pol.full_refund_within_minutes;
    v_part_pct := v_pol.partial_refund_percentage;
    v_part_min := v_pol.partial_refund_within_minutes;
    v_same_pct := v_pol.same_day_refund_percentage;
    v_ns_en    := v_pol.no_show_penalty_enabled;
    v_ns_amt   := v_pol.no_show_penalty_amount_inr;
    v_manual   := v_pol.allow_manual_full_refund;
    v_notes    := v_pol.notes;

    IF p_patch ? 'full_refund_within_minutes' THEN
        v_full_min := (p_patch->>'full_refund_within_minutes')::INTEGER;
        IF v_full_min < 0 THEN
            RAISE EXCEPTION 'full_refund_within_minutes must be 0 or greater'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_patch ? 'partial_refund_within_minutes' THEN
        v_part_min := (p_patch->>'partial_refund_within_minutes')::INTEGER;
        IF v_part_min < 0 THEN
            RAISE EXCEPTION 'partial_refund_within_minutes must be 0 or greater'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_patch ? 'partial_refund_percentage' THEN
        v_part_pct := (p_patch->>'partial_refund_percentage')::NUMERIC(5,2);
        IF v_part_pct < 0 OR v_part_pct > 100 THEN
            RAISE EXCEPTION 'partial_refund_percentage must be between 0 and 100'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_patch ? 'same_day_refund_percentage' THEN
        v_same_pct := (p_patch->>'same_day_refund_percentage')::NUMERIC(5,2);
        IF v_same_pct < 0 OR v_same_pct > 100 THEN
            RAISE EXCEPTION 'same_day_refund_percentage must be between 0 and 100'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_patch ? 'no_show_penalty_enabled' THEN
        v_ns_en := (p_patch->>'no_show_penalty_enabled')::BOOLEAN;
        v_any_change := true;
    END IF;
    IF p_patch ? 'no_show_penalty_amount_inr' THEN
        v_ns_amt := (p_patch->>'no_show_penalty_amount_inr')::NUMERIC(10,2);
        IF v_ns_amt < 0 THEN
            RAISE EXCEPTION 'no_show_penalty_amount_inr must be 0 or greater'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;
    IF p_patch ? 'allow_manual_full_refund' THEN
        v_manual := (p_patch->>'allow_manual_full_refund')::BOOLEAN;
        v_any_change := true;
    END IF;
    IF p_patch ? 'notes' THEN
        v_notes := NULLIF(btrim(coalesce(p_patch->>'notes', '')), '');
        IF v_notes IS NOT NULL AND char_length(v_notes) > 2000 THEN
            RAISE EXCEPTION 'notes must be 2000 characters or fewer'
                USING ERRCODE = '22023';
        END IF;
        v_any_change := true;
    END IF;

    -- Cross-tier ordering (mirrors the valid_refund_tiers CHECK, translated to
    -- a clean 22023 rather than leaking 23514).
    IF v_full_min > v_part_min THEN
        RAISE EXCEPTION 'full_refund_within_minutes must not exceed partial_refund_within_minutes'
            USING ERRCODE = '22023';
    END IF;

    -- -- 6. Apply atomically; bump version so the EXISTING history
    --        trigger (trg_cancel_policy_history) records the prior snapshot.
    IF v_any_change THEN
        BEGIN
            UPDATE public.cancellation_policies
               SET full_refund_within_minutes   = v_full_min,
                   partial_refund_percentage    = v_part_pct,
                   partial_refund_within_minutes = v_part_min,
                   same_day_refund_percentage   = v_same_pct,
                   no_show_penalty_enabled      = v_ns_en,
                   no_show_penalty_amount_inr   = v_ns_amt,
                   allow_manual_full_refund     = v_manual,
                   notes                        = v_notes,
                   version                      = v_pol.version + 1
             WHERE hospital_id = p_hospital_id;
        EXCEPTION
            WHEN check_violation THEN
                RAISE EXCEPTION 'cancellation policy value rejected by a database constraint'
                    USING ERRCODE = '22023';
            WHEN not_null_violation THEN
                RAISE EXCEPTION 'a required cancellation policy value is missing'
                    USING ERRCODE = '22023';
            WHEN numeric_value_out_of_range THEN
                RAISE EXCEPTION 'cancellation policy numeric value out of range'
                    USING ERRCODE = '22023';
            WHEN invalid_text_representation THEN
                RAISE EXCEPTION 'cancellation policy value has the wrong shape'
                    USING ERRCODE = '22023';
        END;
        v_version_out := v_pol.version + 1;
    ELSE
        v_version_out := v_pol.version;
    END IF;

    RETURN jsonb_build_object(
        'ok',          true,
        'reason',      CASE WHEN v_any_change THEN 'updated' ELSE 'noop' END,
        'hospital_id', p_hospital_id,
        'version',     v_version_out
    );
END;
$$;

ALTER FUNCTION public.update_cancellation_policy(UUID, UUID, INTEGER, JSONB)
    SET row_security = off;

-- F16-04: a NEW SECURITY DEFINER function needs its OWN explicit REVOKE.
REVOKE ALL ON FUNCTION public.update_cancellation_policy(UUID, UUID, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_cancellation_policy(UUID, UUID, INTEGER, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.update_cancellation_policy(UUID, UUID, INTEGER, JSONB) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.update_cancellation_policy(UUID, UUID, INTEGER, JSONB) TO service_role;

COMMENT ON FUNCTION public.update_cancellation_policy(UUID, UUID, INTEGER, JSONB) IS
'WS-CONF-1: canonical atomic cancellation policy write. service_role-only (Edge '
'Function is the sole caller). Re-checks actor is global_admin OR hospital_admin '
'of the tenant (42501), locks the row FOR UPDATE, applies an optimistic '
'expected_version check (P0001 on mismatch), rejects system-managed fields, and '
'bumps version so the EXISTING trg_cancel_policy_history trigger records the '
'prior snapshot. Changes no refund-calculation semantics.';

-- =============================================================
-- AUDIT ACTION TYPE REGISTRATION
-- Registers the cancellation-policy write action so logAuditEvent resolves the
-- correct default severity (AGENTS.md sec 8 / 14). Reuses the existing
-- audit_action_types table (no parallel audit primitive).
-- =============================================================

INSERT INTO public.audit_action_types (
    action_type,
    display_name,
    default_severity,
    category,
    description
)
VALUES
(
    'cancellation_policy_update',
    'Cancellation Policy Update',
    'high',
    'system',
    'A hospital cancellation / refund policy change (WS-CONF-1)'
)
ON CONFLICT (action_type) DO NOTHING;
