-- =============================================================
-- SETURA — Phase 0 deterministic seed
-- Applied automatically by `supabase start` / `supabase db reset`
-- (configured in config.toml under [db.seed]).
--
-- Guarantees:
--   * DETERMINISTIC — fixed UUIDs, fixed passwords, no random().
--     Same result on every run.
--   * IDEMPOTENT    — every INSERT uses ON CONFLICT DO NOTHING /
--     DO UPDATE on natural keys. Safe to re-run any number of times.
--
-- Implementation note:
--   The Supabase CLI sends seed files as statement batches and does
--   not support explicit BEGIN/COMMIT inside seeds. The whole seed
--   is therefore wrapped in a single DO block: one statement, fully
--   transactional, immune to batch-splitting side effects.
--
-- Seeded entities:
--   * 1 hospital          (Surya Hospital, Narsapur)
--   * 1 doctor            (dr@surya.test / Setura@123)
--   * 1 receptionist      (reception@surya.test / Setura@123)
--   * 1 hospital admin    (admin@surya.test / Setura@123)
--   * 1 global admin      (root@setura.test / Setura@123)
--   * hospital settings, working hours, doctor schedules,
--     booking fee policy, queue configuration, feature flags
--
-- Fixed identifiers (never change these):
--   HOSPITAL_ID     = 00000000-0000-4000-8000-000000000001
--   GLOBAL_ADMIN_ID = 00000000-0000-4000-8000-0000000000a1
--   HOSP_ADMIN_ID   = 00000000-0000-4000-8000-0000000000a2
--   DOCTOR_ID       = 00000000-0000-4000-8000-0000000000a3
--   RECEPTIONIST_ID = 00000000-0000-4000-8000-0000000000a4
--
-- All seed accounts share password: Setura@123
-- =============================================================

DO $seed$
DECLARE
    -- Deterministic bcrypt hash of 'Setura@123' (fixed salt →
    -- identical hash on every run; never uses gen_salt()).
    v_password CONSTANT TEXT :=
        crypt('Setura@123', '$2a$06$seturaseedbcryptsalt11');

    v_now CONSTANT TIMESTAMPTZ := '2026-01-01 00:00:00+00';

    v_hospital     CONSTANT UUID := '00000000-0000-4000-8000-000000000001';
    v_global_admin CONSTANT UUID := '00000000-0000-4000-8000-0000000000a1';
    v_hosp_admin   CONSTANT UUID := '00000000-0000-4000-8000-0000000000a2';
    v_doctor       CONSTANT UUID := '00000000-0000-4000-8000-0000000000a3';
    v_receptionist CONSTANT UUID := '00000000-0000-4000-8000-0000000000a4';

    v_weekday INTEGER;
BEGIN

    -- ─── 1. AUTH USERS ─────────────────────────────────────────
    INSERT INTO auth.users (
        instance_id, id, aud, role, email,
        encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data,
        confirmation_token, recovery_token,
        created_at, updated_at,
        email_change_token_new, email_change
    ) VALUES
    ('00000000-0000-0000-0000-000000000000', v_global_admin,
     'authenticated', 'authenticated', 'root@setura.test',
     v_password, v_now,
     '{"provider":"email","providers":["email"]}',
     jsonb_build_object('sub', v_global_admin::text),
     '', '', v_now, v_now, '', ''),
    ('00000000-0000-0000-0000-000000000000', v_hosp_admin,
     'authenticated', 'authenticated', 'admin@surya.test',
     v_password, v_now,
     '{"provider":"email","providers":["email"]}',
     jsonb_build_object('sub', v_hosp_admin::text),
     '', '', v_now, v_now, '', ''),
    ('00000000-0000-0000-0000-000000000000', v_doctor,
     'authenticated', 'authenticated', 'dr@surya.test',
     v_password, v_now,
     '{"provider":"email","providers":["email"]}',
     jsonb_build_object('sub', v_doctor::text),
     '', '', v_now, v_now, '', ''),
    ('00000000-0000-0000-0000-000000000000', v_receptionist,
     'authenticated', 'authenticated', 'reception@surya.test',
     v_password, v_now,
     '{"provider":"email","providers":["email"]}',
     jsonb_build_object('sub', v_receptionist::text),
     '', '', v_now, v_now, '', '')
    ON CONFLICT (id) DO NOTHING;

    -- ─── 1b. AUTH IDENTITIES ───────────────────────────────────
    -- Hosted GoTrue (v2.197+) resolves password logins through
    -- auth.identities; users inserted directly into auth.users
    -- without a matching identity row cause a 500 on login.
    -- id = user_id keeps the rows deterministic; ON CONFLICT keeps
    -- the seed idempotent.
    INSERT INTO auth.identities (
        id, user_id, provider_id, identity_data,
        provider, last_sign_in_at, created_at, updated_at
    ) VALUES
    (v_global_admin, v_global_admin, 'root@setura.test',
     jsonb_build_object('sub', v_global_admin::text, 'email', 'root@setura.test',
                        'email_verified', true, 'phone_verified', false),
     'email', v_now, v_now, v_now),
    (v_hosp_admin, v_hosp_admin, 'admin@surya.test',
     jsonb_build_object('sub', v_hosp_admin::text, 'email', 'admin@surya.test',
                        'email_verified', true, 'phone_verified', false),
     'email', v_now, v_now, v_now),
    (v_doctor, v_doctor, 'dr@surya.test',
     jsonb_build_object('sub', v_doctor::text, 'email', 'dr@surya.test',
                        'email_verified', true, 'phone_verified', false),
     'email', v_now, v_now, v_now),
    (v_receptionist, v_receptionist, 'reception@surya.test',
     jsonb_build_object('sub', v_receptionist::text, 'email', 'reception@surya.test',
                        'email_verified', true, 'phone_verified', false),
     'email', v_now, v_now, v_now)
    ON CONFLICT (id) DO NOTHING;

    -- ─── 2. PROFILES ───────────────────────────────────────────
    INSERT INTO public.profiles (
        id, full_name, normalized_phone, preferred_language, is_active
    ) VALUES
    (v_global_admin,  'Setura Root Admin',    '9000000001', 'en', true),
    (v_hosp_admin,    'Surya Hospital Admin', '9000000002', 'te', true),
    (v_doctor,        'Dr. Anitha Rao',       '9000000003', 'te', true),
    (v_receptionist,  'Ravi Kumar',           '9000000004', 'te', true)
    ON CONFLICT (id) DO NOTHING;

    -- ─── 3. HOSPITAL ───────────────────────────────────────────
    -- Migration 01 already creates the 5 baseline Narsapur
    -- hospitals with these SAME fixed UUIDs. This upsert
    -- converges the pilot hospital (Surya) to its full seed
    -- attributes; it never creates a duplicate row.
    -- AFTER INSERT triggers auto-create hospital_settings and
    -- booking_fee_policies rows when the row is new.
    INSERT INTO public.hospitals (
        id, name, name_te, slug, phone, email,
        country, state, district, town, address, timezone,
        is_active, subscription_active, online_booking_enabled,
        max_advance_booking_days, created_at, updated_at
    ) VALUES (
        v_hospital,
        'Surya Hospital',
        -- Telugu: సూర్య హాస్పిటల్ — stored as Postgres unicode
        -- escapes so this file stays pure ASCII (immune to
        -- code-page corruption when the CLI reads it on Windows).
        E'\u0C38\u0C42\u0C30\u0C4D\u0C2F \u0C39\u0C3E\u0C38\u0C4D\u0C2A\u0C3F\u0C1F\u0C32\u0C4D',
        'surya-hospital',
        '9000000002',
        'admin@surya.test',
        'India', 'Andhra Pradesh', 'West Godavari', 'Narsapur',
        'Main Road, Narsapur, West Godavari',
        'Asia/Kolkata',
        true, true, true, 7,
        v_now, v_now
    )
    ON CONFLICT (id) DO UPDATE SET
        name                     = EXCLUDED.name,
        name_te                  = EXCLUDED.name_te,
        slug                     = EXCLUDED.slug,
        phone                    = EXCLUDED.phone,
        email                    = EXCLUDED.email,
        country                  = EXCLUDED.country,
        state                    = EXCLUDED.state,
        district                 = EXCLUDED.district,
        town                     = EXCLUDED.town,
        address                  = EXCLUDED.address,
        timezone                 = EXCLUDED.timezone,
        is_active                = EXCLUDED.is_active,
        subscription_active      = EXCLUDED.subscription_active,
        online_booking_enabled   = EXCLUDED.online_booking_enabled,
        max_advance_booking_days = EXCLUDED.max_advance_booking_days;

    -- ─── 4. USER ROLES ─────────────────────────────────────────
    INSERT INTO public.user_roles (id, user_id, hospital_id, role, is_primary)
    VALUES
    ('00000000-0000-4000-8000-0000000000b1',
     v_global_admin, NULL, 'global_admin', true),
    ('00000000-0000-4000-8000-0000000000b2',
     v_hosp_admin, v_hospital, 'hospital_admin', true),
    ('00000000-0000-4000-8000-0000000000b3',
     v_doctor, v_hospital, 'doctor', true),
    ('00000000-0000-4000-8000-0000000000b4',
     v_receptionist, v_hospital, 'receptionist', true)
    ON CONFLICT (id) DO NOTHING;

    -- ─── 5. DOCTOR SPECIALIZATION ──────────────────────────────
    INSERT INTO public.doctor_specializations (
        id, doctor_id, hospital_id, specialization_name,
        consultation_fee, average_consultation_minutes,
        created_at, updated_at
    ) VALUES (
        '00000000-0000-4000-8000-0000000000c1',
        v_doctor, v_hospital, 'General Medicine',
        300.00, 10,
        v_now, v_now
    )
    ON CONFLICT (id) DO NOTHING;

    -- ─── 6. WORKING HOURS (hospital level) ─────────────────────
    -- Monday (1) – Saturday (6) 09:00–21:00, Sunday closed.
    -- Natural unique on (hospital_id, weekday) → full convergence.
    FOR v_weekday IN 0..6 LOOP
        INSERT INTO public.hospital_working_hours (
            hospital_id, weekday, open_time, close_time, is_open,
            created_at, updated_at
        ) VALUES (
            v_hospital, v_weekday,
            '09:00',
            CASE WHEN v_weekday = 0 THEN '13:00'::TIME ELSE '21:00'::TIME END,
            v_weekday <> 0,
            v_now, v_now
        )
        ON CONFLICT (hospital_id, weekday) DO UPDATE SET
            open_time  = EXCLUDED.open_time,
            close_time = EXCLUDED.close_time,
            is_open    = EXCLUDED.is_open;
    END LOOP;

    -- ─── 7. DOCTOR SCHEDULES (doctor working hours) ────────────
    -- Monday (1) – Saturday (6):
    --   morning 09:00–13:00 and evening 17:00–21:00.
    -- Fixed PKs make re-runs a no-op (ON CONFLICT DO NOTHING).
    FOR v_weekday IN 1..6 LOOP
        INSERT INTO public.doctor_schedules (
            id, doctor_id, hospital_id, weekday,
            start_time, end_time, max_tokens,
            average_consultation_minutes, buffer_minutes,
            is_active, is_walkin_allowed, created_by,
            created_at, updated_at
        ) VALUES
        (
            ('00000000-0000-4000-8000-0000000001'
                || to_hex(v_weekday * 2 - 1) || '0')::UUID,
            v_doctor, v_hospital, v_weekday,
            '09:00', '13:00', 25, 10, 2, true, true,
            v_hosp_admin, v_now, v_now
        ),
        (
            ('00000000-0000-4000-8000-0000000001'
                || to_hex(v_weekday * 2) || '0')::UUID,
            v_doctor, v_hospital, v_weekday,
            '17:00', '21:00', 25, 10, 2, true, true,
            v_hosp_admin, v_now, v_now
        )
        ON CONFLICT (id) DO NOTHING;
    END LOOP;

    -- ─── 8. HOSPITAL SETTINGS ──────────────────────────────────
    -- The auto-create trigger only exists from migration 12, so
    -- baseline hospitals (created in migration 01) have no row.
    -- Ensure it exists, then converge to known seed values.
    INSERT INTO public.hospital_settings (hospital_id)
    VALUES (v_hospital)
    ON CONFLICT (hospital_id) DO NOTHING;

    UPDATE public.hospital_settings
    SET
        display_name                = 'Surya Hospital',
        whatsapp_number             = '919000000002',
        platform_fee_online         = 20,
        platform_fee_whatsapp       = 10,
        receptionist_fee            = 5,
        online_booking_fee_enabled  = true,
        max_tokens_per_day          = 100,
        allow_walkin_tokens         = true,
        allow_online_booking        = true,
        allow_carry_forward         = true,
        queue_display_enabled       = true,
        send_whatsapp_confirmation  = true,
        send_whatsapp_reminder      = true,
        send_feedback_request       = false,
        reminder_before_minutes     = 30,
        payment_enabled             = false,
        preferred_language          = 'te',
        timezone                    = 'Asia/Kolkata'
    WHERE hospital_id = v_hospital;

    -- ─── 9. BOOKING FEE POLICY ─────────────────────────────
    -- Same situation as hospital_settings: ensure + converge.
    INSERT INTO public.booking_fee_policies (hospital_id)
    VALUES (v_hospital)
    ON CONFLICT (hospital_id) DO NOTHING;

    UPDATE public.booking_fee_policies
    SET
        booking_fee_online               = 20,
        booking_fee_whatsapp             = 10,
        booking_fee_walkin               = 0,
        booking_fee_enabled              = true,
        gst_enabled                      = false,
        gst_percentage                   = 18.00,
        refund_window_minutes            = 1440,
        refund_on_cancellation           = true,
        default_consultation_fee_inr     = 300.00,
        collect_consultation_at_hospital = true,
        include_gateway_fee              = false,
        gateway_fee_percentage           = 2.000
    WHERE hospital_id = v_hospital;

    -- ─── 10. QUEUE CONFIGURATION ───────────────────────────────
    INSERT INTO public.queue_configs (
        id, hospital_id, doctor_id, config_key, config_value,
        description, created_at, updated_at
    ) VALUES
    ('00000000-0000-4000-8000-000000000201',
     v_hospital, NULL,
     'token_prefix', '"S"',
     'Prefix printed on tokens',
     v_now, v_now),
    ('00000000-0000-4000-8000-000000000202',
     v_hospital, NULL,
     'queue_display',
     '{"show_patient_name": false, "show_village": true, "refresh_seconds": 10}',
     'Queue display screen behavior',
     v_now, v_now),
    ('00000000-0000-4000-8000-000000000203',
     v_hospital, NULL,
     'call_window_minutes', '5',
     'Minutes a called token stays in called state before auto-skip',
     v_now, v_now)
    ON CONFLICT (id) DO NOTHING;

    -- ─── 11. HOSPITAL-LEVEL FEATURE FLAGS ──────────────────────
    INSERT INTO public.feature_flags (
        id, hospital_id, flag_key, is_enabled
    ) VALUES
    ('00000000-0000-4000-8000-000000000301',
     v_hospital, 'online_payment', true),
    ('00000000-0000-4000-8000-000000000302',
     v_hospital, 'queue_display_screen', true),
    ('00000000-0000-4000-8000-000000000303',
     v_hospital, 'carry_forward_auto', true)
    ON CONFLICT (id) DO NOTHING;

    -- ─── 12. PLATFORM SYSTEM SETTINGS ─────────────────────────
    -- Default country code for E.164 phone normalization. Hospitals
    -- can override via hospital_settings.metadata.country_code.
    INSERT INTO public.system_settings (key, value, description)
    VALUES (
        'default_country_code',
        '"91"',
        'Default country code applied when normalizing phone numbers to E.164'
    )
    ON CONFLICT (key) DO NOTHING;

    RAISE NOTICE
        'SETURA seed applied: 1 hospital, 1 doctor, 1 receptionist, 1 hospital admin, 1 global admin';

END;
$seed$;
