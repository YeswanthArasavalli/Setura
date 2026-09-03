---
kind: external_dependency
name: Razorpay — payment order creation, verification, and refunds
slug: razorpay
category: external_dependency
category_hints:
  - vendor_identity
  - auth_protocol
scope:
  - "**"
source_files:
  - .env.example
  - supabase/functions/create-payment-order/index.ts
  - supabase/functions/process-refund/index.ts
  - supabase/functions/verify-payment/index.ts
---

Payments flow through Razorpay using `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`
from `.env.example`. The codebase creates orders, verifies payments, and
initiates refunds via the Razorpay API. Refund handling currently calls the
refund endpoint but does not update `bookings.payment_status_detail` to reflect
`refund_processed`/`refund_failed`, nor does it emit matching `refund_debit`
entries into the financial ledger — these are identified as Phase 1.2 gaps.
Webhook handling for payment events exists; refund-status webhooks are not yet
wired.
