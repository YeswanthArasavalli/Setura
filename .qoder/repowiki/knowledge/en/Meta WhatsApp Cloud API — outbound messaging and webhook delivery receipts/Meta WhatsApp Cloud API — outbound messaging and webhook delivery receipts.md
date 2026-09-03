---
kind: external_dependency
name: Meta WhatsApp Cloud API — outbound messaging and webhook delivery receipts
slug: meta-whatsapp-cloud-api
category: external_dependency
category_hints:
  - vendor_identity
  - auth_protocol
scope:
  - "**"
source_files:
  - .env.example
  - supabase/functions/send-whatsapp-message/index.ts
  - supabase/functions/process-whatsapp-webhook/index.ts
---

Outbound WhatsApp messages are sent via Meta's Cloud API using credentials from
environment variables: `META_ACCESS_TOKEN`, `META_APP_SECRET`,
`META_WEBHOOK_VERIFY_TOKEN`, `META_PHONE_NUMBER_ID`, and `META_API_VERSION`.
Outgoing requests authenticate with the access token; incoming webhooks are
verified via HMAC-SHA256 using the app secret and constant-time comparison.
Permanent failure codes (131047, 131051, 131052, 131053, 131056) and transient
errors (429, 5xx) drive retry/backoff or DLQ routing. As of Phase 0, post-send
DB updates and webhook status-to-row reconciliation are still gaps to be filled
in Phase 1.
