-- =============================================================
-- 70_ws_sec_1_doctor_schedule_leave_direct_write_hardening.sql
--
-- WS-SEC-1 - Legacy Doctor Schedule & Leave direct-write security
-- hardening. Additive. Migrations 68 (WS-ONBOARD-4) and 69 are committed
-- in supabase/migrations/MANIFEST.sha256 and already applied, so they are
-- historical artifacts and are NOT edited here.
--
-- The gap (measured against the LIVE catalog, not inferred from source):
--   * doctor_schedules carried `doctor_sched_manage`  FOR ALL TO public.
--   * doctor_leaves      carried `doctor_leaves_manage` FOR ALL TO public.
--   * information_schema.role_table_grants showed BOTH `anon` and
--     `authenticated` holding INSERT / UPDATE / DELETE / TRUNCATE /
--     REFERENCES / TRIGGER on BOTH tables.
--   Together these opened a second, audit-bypassing write path: a browser
--   caller holding a hospital_admin / doctor JWT could INSERT / UPDATE /
--   DELETE doctor_schedules / doctor_leaves rows straight through PostgREST,
--   sidestepping the clinical-configuration Edge Function's
--   resolveAuth / requireRole / tenant validation / idempotency / SECURITY
--   DEFINER RPC path that WS-ONBOARD-4 made canonical.
--
-- Target posture (WS-SEC-1 sec 5):
--   Browser roles (anon, authenticated, and every JWT role):
--     SELECT -> unchanged, governed by the pre-existing *_read policies.
--     INSERT / UPDATE / DELETE -> refused at BOTH boundaries:
--       (1) table-privilege layer (grant revoked -> SQLSTATE 42501), and
--       (2) RLS layer (no INSERT/UPDATE/DELETE policy exists -> deny-by-default).
--   Privileged application path (unchanged, must keep working):
--     clinical-configuration Edge Function -> service_role -> SECURITY
--     DEFINER RPC (upsert_doctor_schedule / delete_doctor_schedule /
--     upsert_doctor_leave / cancel_doctor_leave). These RPCs already carry
--     `SET row_security = off` and `GRANT EXECUTE ... TO service_role` only,
--     so removing browser direct-write privileges does not affect them.
--
-- This migration changes NO business logic, NO data, NO table/column
-- definition, NO SELECT/read policy and NO RPC. It only removes the legacy
-- browser-write bypass: drop the two FOR ALL policies and revoke the two
-- browser roles' mutation grants, explicitly re-asserting SELECT-only and
-- preserving service_role's full access.
--
-- F16-04 standing rule (AGENTS.md sec 7): no SECURITY DEFINER function is
-- created or resignatured here, so no function REVOKE/GRANT boundary is
-- re-asserted. Table-grant changes are verified afterwards against the live
-- pg_class ACL / information_schema, not against this text.
-- =============================================================

SET search_path = public;

-- -------------------------------------------------------------
-- 1. Remove the legacy browser-write policies.
--
-- The SELECT/read policies (doctor_sched_read / doctor_leaves_read) are
-- deliberately LEFT IN PLACE - legitimate browser reads through the existing
-- tenant RLS model must keep working.
-- -------------------------------------------------------------

DROP POLICY IF EXISTS doctor_sched_manage ON public.doctor_schedules;
DROP POLICY IF EXISTS doctor_leaves_manage ON public.doctor_leaves;

-- -------------------------------------------------------------
-- 2. Revoke direct mutation privileges from the browser roles.
--
-- `anon` and `authenticated` lose INSERT / UPDATE / DELETE (the WS-SEC-1
-- objective) plus TRUNCATE / REFERENCES / TRIGGER, which are equally
-- mutation-capable and have no browser use case on these tables.
--
-- The revoke targets PUBLIC as well so the boundary does not depend on how
-- the original grant was worded; it is a no-op for any role that never held
-- the privilege.
-- -------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON public.doctor_schedules FROM PUBLIC, anon, authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON public.doctor_leaves FROM PUBLIC, anon, authenticated;

-- -------------------------------------------------------------
-- 3. Re-assert the intended privilege boundary explicitly.
--
-- Browser roles: SELECT only. service_role: full access (it is BYPASSRLS and
-- is the only role the canonical RPC path executes as). Being explicit here
-- means the resulting ACL is defined by this migration rather than inherited
-- from the migration-03 defaults.
-- -------------------------------------------------------------

GRANT SELECT ON public.doctor_schedules TO anon, authenticated;
GRANT SELECT ON public.doctor_leaves    TO anon, authenticated;

GRANT ALL ON public.doctor_schedules TO service_role;
GRANT ALL ON public.doctor_leaves    TO service_role;

-- -------------------------------------------------------------
-- 4. Keep RLS enforced for every non-owner role (already ENABLE + FORCE from
--    migration 03; re-asserted so the hardened posture is stated here and is
--    not silently dependent on prior migrations).
-- -------------------------------------------------------------

ALTER TABLE public.doctor_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctor_schedules FORCE  ROW LEVEL SECURITY;

ALTER TABLE public.doctor_leaves ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctor_leaves FORCE  ROW LEVEL SECURITY;
