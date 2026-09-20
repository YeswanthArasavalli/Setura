-- STAGING-ONLY provisioning (disposable Tenant B for cross-tenant isolation proof).
-- NOT part of supabase/seed.sql; delete-safe. Mirrors the seed's auth.users/
-- auth.identities pattern (empty-string tokens, deterministic ids, idempotent).
DO $tb$
DECLARE
    v_password CONSTANT TEXT := crypt('Setura@123', '$2a$06$seturaseedbcryptsalt11');
    v_now CONSTANT TIMESTAMPTZ := '2026-01-01 00:00:00+00';
    v_hosp_b   CONSTANT UUID := '00000000-0000-4000-8000-000000000002';
    v_recep_b  CONSTANT UUID := '00000000-0000-4000-8000-0000000000c1';
BEGIN
    INSERT INTO auth.users (
        instance_id, id, aud, role, email,
        encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data,
        confirmation_token, recovery_token,
        created_at, updated_at,
        email_change_token_new, email_change
    ) VALUES (
        '00000000-0000-0000-0000-000000000000', v_recep_b,
        'authenticated', 'authenticated', 'reception-b@surya.test',
        v_password, v_now,
        '{"provider":"email","providers":["email"]}',
        jsonb_build_object('sub', v_recep_b::text),
        '', '', v_now, v_now, '', ''
    )
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO auth.identities (
        id, user_id, provider_id, identity_data,
        provider, last_sign_in_at, created_at, updated_at
    ) VALUES (
        v_recep_b, v_recep_b, 'reception-b@surya.test',
        jsonb_build_object('sub', v_recep_b::text, 'email', 'reception-b@surya.test',
                           'email_verified', true, 'phone_verified', false),
        'email', v_now, v_now, v_now
    )
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.profiles (id, full_name, normalized_phone, preferred_language, is_active)
    VALUES (v_recep_b, 'Tenant B Reception (disposable)', '9000000011', 'en', true)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO public.user_roles (id, user_id, hospital_id, role, is_primary)
    VALUES ('00000000-0000-4000-8000-0000000000c2', v_recep_b, v_hosp_b, 'receptionist', true)
    ON CONFLICT (id) DO NOTHING;
END
$tb$;
