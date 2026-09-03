-- =============================================================
-- 44_queue_runtime_flag.sql
--
-- Phase 1.2 - global feature flag for proactive queue WhatsApp
-- notifications (position updates, pause/resume, skip/restore).
--
-- Enabled by default so live hospitals get queue intelligence
-- immediately; a hospital can opt out without a deploy by
-- disabling the flag.
-- =============================================================

INSERT INTO public.feature_flags (
    hospital_id,
    flag_key,
    is_enabled,
    metadata
)
VALUES (
    NULL,
    'whatsapp_queue_updates',
    TRUE,
    '{"display_name":"WhatsApp Queue Updates","description":"Proactive queue WhatsApp notifications: position updates, pause/resume, skip and restore."}'::JSONB
)
ON CONFLICT DO NOTHING;
