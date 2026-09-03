# SETURA — Codex OPERATING CONTRACT

This file defines **how to work** in this repository: what is non-negotiable,
how to navigate, how to minimize context, and what evidence a claim requires.
It is deliberately NOT a project encyclopedia. Detailed current-state evidence
lives in the documents listed in §13 — consult those only when the active task
actually needs their evidence.

---

## 1. IDENTITY AND NON-NEGOTIABLES

SETURA is a production-grade, multi-tenant SaaS hospital operating system for
real hospitals, clinics, doctors, receptionists, finance teams, hospital
administrators and executives. It is NOT a portfolio project, prototype, CRUD
demo, toy application or academic exercise.

Evaluate every engineering decision against: security, multi-tenancy, data
integrity, financial correctness, operational resilience, auditability,
concurrency safety, observability, maintainability, performance, commercial
scalability, backward compatibility.

Core principles: SQL-first business logic; DB-enforced tenancy; auditable
mutations; boundary idempotency; server-side authorization; shared runtime
primitives; real integration testing; operational recovery.

Extend the established architecture. Do NOT build a parallel system when an
existing platform primitive already owns the responsibility.

---

## 2. STACK AND COMMAND AUTHORITY

Supabase · PostgreSQL · Supabase Edge Functions · Deno · TypeScript · Supabase
Auth · PostgreSQL RLS · PostgreSQL RPCs · Supabase Realtime · background job
queue · WhatsApp / Meta Cloud API · Razorpay.

Repository areas: `supabase/migrations/`, `supabase/functions/`,
`supabase/functions/_shared/`, `tests/`, `scripts/`, `.github/workflows/`,
`GRAPH_REPORT.md`, `graphify-out/`, and root-level phase/audit/completion
reports and gap registers.

Command authority is `deno.json` and `.github/workflows/ci.yml`. There is no
`package.json`, `Makefile` or `justfile`. `deno.json` defines exactly 10 tasks:

| Task | Safety class |
| --- | --- |
| `validate:migrations` | read-only |
| `fmt:check` | read-only (`deno fmt --check`) |
| `lint` | read-only |
| `check` | read-only |
| `test` | read-only (unit) |
| `test:integration` | read-only, requires a running local stack |
| `gen:types:check` | read-only verification |
| `fmt` | REWRITES files — do not run casually |
| `gen:types` | REWRITES `database.generated.ts` — not casually |
| `db:reset` | DESTRUCTIVE — never without explicit authorization |

Do not run a file-rewriting or destructive task unless the active task
explicitly authorizes it.

---

## 3. CONTEXT AND TOKEN DISCIPLINE

**MINIMUM NECESSARY CONTEXT > MAXIMUM REPOSITORY CONTEXT.**

This is a production constraint, not a style preference: the whole context is
re-sent on every API call, so a wasteful read is charged once per *remaining*
call, and a zero-yield retry pays full context for no information.

Identify the single active phase/step first, then read only that step's
specification section, the exact files it requires, and the exact prior
evidence needed for continuity.

DO NOT automatically: read all migrations, all Edge Functions or all tests;
recursively dump the repository; blindly grep the whole repository; read a
whole directory when one dependency path matters; reread large audit reports;
rediscover architecture already established by Graphify; or scan every SQL file
before knowing which objects are relevant.

Use line ranges and exact search patterns. If five facts are needed from a
500-line file, retrieve five facts. Never reread a document already inspected
in the current task. Once a fact is verified in the current task, reuse and
cite it; reverify only targeted, and only when the source may have changed.
Batch independent read-only checks into a single call. Glob patterns recurse:
a root `*.md` glob descends into `.qoder/repowiki/` (~145 generated files)
rather than the root documents — enumerate exact filenames instead.

Scope by unit of work:

- one Edge Function → that function plus its relevant shared dependencies
- one SQL RPC → the RPC plus its callers, tables, triggers, grants and the
  tests that actually depend on it
- one migration → that migration plus the historical migrations that define or
  modify the same object, not all migrations
- a cross-cutting primitive → trace its dependency path before opening
  unrelated components

Expand scope only when evidence requires it. "Inspect the repository" is not
permission to dump the repository into context.

**Failed commands.** Classify the failure as environment, permission, tooling
or product, then act on the class: do NOT repeat an identical failing command.
Try at most one materially different permitted method if justified; otherwise
record BLOCKED with the classification and continue per the specification.
Retry loops are the single most expensive failure mode available.

**Output.** Gather evidence → build the result → write the report once → run
one targeted verification. No incremental large-report rewrites.

Before any read, ask which step needs it and whether a targeted search would
do. Before any second identical failing command, stop.

---

## 4. GRAPHIFY — NAVIGATION LAYER

Graphify is this repository's local structural index (`GRAPH_REPORT.md`,
`graphify-out/`). It supplies dependency relationships, callers/callees,
communities, hubs, highly connected nodes, import cycles, weakly connected
nodes, inferred relationships and structural context.

**Use Graphify first (expected) when** the task concerns existing
architecture: locating an implementation, finding callers/callees, tracing a
dependency path, or identifying which SQL objects and tests depend on a
component. Preferred flow:

`AGENTS.md` → Graphify report/subgraph → relevant phase/audit report section →
dependency path → actual source → SQL/runtime → tests

**Graphify is not required for** governance/prose questions, work whose files
the active specification already names, or a single already-identified file.
Do not query it ceremonially, and do not reread `GRAPH_REPORT.md` or
`graphify-out/` repeatedly within a task.

**If Graphify is unavailable, stale or does not answer the question:** do not
retry it and do not rebuild it as a side quest. Fall back to targeted search
scoped by §3, and record the limitation in the output.

Division of labour — never collapse these levels:

- Graphify answers "where should I look?"
- Source answers "what does it actually do?"
- Database/runtime answers "what does it actually do right now?"
- Tests answer "what behavior has actually been proven?"

**Graphify safety.** A Graphify result alone is never proof of a defect. Do NOT
modify code merely because Graphify reports an isolated node, low cohesion, an
import cycle, an inferred relationship, a God Node or a weakly connected
component. These are investigation signals only: a highly connected
DB/auth/audit/response module may be expected, an isolated type may be
legitimate, a trigger function may have no TypeScript caller, and an inferred
database relationship may not represent runtime behavior. Inspect the actual
implementation before acting.

NEVER modify `GRAPH_REPORT.md` or `graphify-out/` to make the graph look
cleaner. If Graphify reveals a genuine source problem, fix the source.

---

## 5. SOURCE OF TRUTH AND EVIDENCE

Truth hierarchy, highest first:

1. Actual current source code and SQL migrations
2. Actual database/runtime state
3. Integration tests actually executed against the real stack
4. Unit tests actually executed
5. Configuration files
6. Phase completion reports
7. Cross-phase audit reports
8. Graphify reports
9. Documentation/comments

A completion report claiming implementation does not prove it works. A
Graphify relationship does not prove runtime behavior. A test existing does not
prove it proves the requirement. A declared test count is not a passed test
count. A local runtime result is not production verification.

Always distinguish, and never silently convert one into another: IMPLEMENTED ·
STATICALLY VERIFIED · UNIT VERIFIED · INTEGRATION VERIFIED · RUNTIME VERIFIED ·
PRODUCTION VERIFIED · UNPROVEN · BLOCKED · FAIL.

**Certification vocabulary:** PASS · FAIL · BLOCKED · UNPROVEN · NOT
APPLICABLE. Never claim "production ready", "fully implemented", "certified",
"verified", "secure" or "works" without evidence matching the claim. Use
CERTIFIED only when the defined certification gates genuinely passed.

Worked examples: a static function inventory does not prove execution; a
declared integration test count does not prove tests passed; a local test does
not prove production behavior; an HTTP 401 does not by itself prove
application-level privilege denial (require the specific SQLSTATE such as
42501, since a 401 can be a JWT-layer rejection that never reached the
database — see F16-05); Docker unavailable → report BLOCKED; secrets
unavailable → report machine-endpoint execution BLOCKED; no scheduler → report
MISSING / DESIGN DECISION, not "inactive".

**A self-report is also a claim and needs the same discipline.** When
summarizing what changed in a file, a migration, or a gate, verify the
summary against the actual diff before presenting it — "kept X" or "this is
new" are claims that require the same evidence standard as any other
certification statement, not an exemption from it.

---

## 6. ESTABLISHED ARCHITECTURE — DO NOT DUPLICATE

These are platform primitives. Extend them; do not recreate them unless the
active task explicitly authorizes architectural redesign: booking state
machine · atomic token engine · queue runtime · queue control/runtime events ·
doctor clinical workflow · background worker · job queue · idempotency system ·
payment engine · refund engine · settlement engine · WhatsApp messaging engine ·
WhatsApp conversational engine · audit system · RLS/tenant isolation ·
subscription/usage system · retention/cleanup system · analytics/rollups ·
enterprise reporting · command-center infrastructure.

Established shared helpers: `getServiceClient()`, `resolveAuth()`,
`requireRole()`, `logAuditEvent()`, `successResponse()`,
`handleErrorResponse()`, `handleCors()`, `formatE164()`, request logger,
metrics, tracing, validation, idempotency utilities, error hierarchy.

Before implementing new business logic: locate the existing owner, inspect its
callers/dependencies, determine whether an existing RPC/helper/state machine
already owns the invariant, and reuse it if possible.

Preferred shape: Edge Function → authentication/authorization → validation →
orchestration → existing SQL RPC / shared primitive → database invariant.

Avoid: Edge Function → duplicated business rules → multiple direct writes →
race-prone application logic — unless there is a documented architectural
reason.

---

## 7. SECURITY, TENANCY AND AUTHORIZATION

**Multi-tenancy is non-negotiable.** Every hospital-scoped operation must
preserve tenant isolation. Never trust a client-supplied hospital ID. Verify as
appropriate: authenticated actor, hospital membership, role, target entity
hospital, RLS, service-role boundaries, RPC tenant checks. Defense in depth is
intentional — do NOT remove DB checks because the Edge Function already checks
the hospital, do NOT weaken RLS to make tests easier, and do NOT bypass tenant
isolation for convenience. Any cross-hospital operation requires an explicit
architectural reason and authorization.

**Authentication and authorization are separate.** Use the established
`resolveAuth()`, `requireRole()`, permission model, RLS and RPC privilege
model. Do NOT invent another authorization system. Before changing
permissions, inspect the role hierarchy, permission model, RLS policies, RPC
grants, privilege tests and relevant security migrations. An Edge Function
being protected does NOT make its database RPC safe to expose — maintain least
privilege at both boundaries.

**Secrets.** Never hardcode or commit service-role keys, Meta tokens, Razorpay
secrets, cron secrets, worker secrets, JWT secrets, API secrets or production
credentials. Never commit `.env`; `.env.example` holds placeholders only. Do
not log service-role keys, tokens, passwords, API secrets, webhook secrets or
unnecessary patient PII.

**Injection.** Use parameterized SQL/RPCs. Never interpolate untrusted values
into SQL or PostgREST filters.

Preserve at all times: webhook authenticity verification, HMAC verification,
least privilege, RLS, audit immutability, tenant isolation.

**Database privilege safety.** SETURA uses SECURITY DEFINER functions and
service-role execution; treat privilege changes as security-sensitive. When
creating or changing a SECURITY DEFINER function, explicitly inspect and
control EXECUTE grants for PUBLIC, `anon`, `authenticated`, `service_role`, and
owner/grantor behavior. Do NOT assume a previous migration's default-privilege
behavior applies to a new or resignatured function — it demonstrably does not
here (F16-04, §13): **a new or resignatured SECURITY DEFINER function needs its
own explicit REVOKE.** Any change to `EXECUTE` privileges requires explicit
security consideration. After privilege changes, verify the actual catalog ACL
(`pg_proc.proacl`, `has_function_privilege()`) rather than trusting migration
text; do not claim privilege safety from source inspection alone when catalog
verification is required.

---

## 8. CORRECTNESS INVARIANTS

**State machines.** Existing state machines are canonical; do not create
competing ones. For booking, queue and doctor workflows, reuse canonical
transitions and preserve terminal states, concurrency protections, idempotency,
audit events and downstream notifications. If a new state or transition is
genuinely required: identify the canonical state owner, inspect all consumers,
modify the canonical state machine, update all dependent behavior, then add
tests covering concurrency, tenant isolation, idempotency and audit behavior.
Never implement a local state shortcut inside one Edge Function.

**Idempotency.** Assume retries and duplicate requests. Mutations must use the
established idempotency mechanisms where required, preserving idempotency keys,
unique constraints, webhook deduplication, job deduplication, notification
deduplication and replay safety. A retry must never create a duplicate booking,
payment, ledger entry, refund, notification, queue event or audit event.

**Concurrency.** Assume concurrent execution. When changing race-sensitive
code, test simultaneous requests, duplicate requests, retry after partial
failure, competing transitions, lease expiry, worker recovery,
skip/call/restore races and payment/refund races. Prefer database atomicity and
locking. Never fix a race with arbitrary sleeps or delays.

**Financial integrity.** High-integrity domains: payment orders, payment
attempts, payment ledger, refunds, daily collection entries, settlements,
outstanding balances, subscription billing, fees. Never manually mutate
immutable financial records — use canonical RPCs and workflows. Every financial
modification must consider idempotency, replay, ledger correctness, refund
synchronization, settlement effects, audit trail and concurrency. Never
hand-edit a ledger row to "fix" a discrepancy.

**Auditability.** Important mutations must be auditable through the established
audit system; do not create a competing one. Preserve relevant hospital, actor,
entity, action, severity, old state, new state and trace/correlation context.
Do not weaken audit immutability for test cleanup or convenience — if cleanup
conflicts with immutable audit history, preserve the history.

---

## 9. BACKGROUND WORKER AND SCHEDULER

The worker architecture is established: `job_queue`, `claim_jobs_v2`, worker
leases, worker registry, heartbeat, retry handling, dead-letter handling, job
processors. Do NOT create a second worker mechanism.

Distinguish ENQUEUED → CLAIMED → PROCESSING → COMPLETED / FAILED /
DEAD-LETTERED. Enqueueing is not execution; runtime evidence is required to
claim a job executed.

Do not assume scheduled functionality is operational because a cron Edge
Function, SQL function, cron secret, job type or documentation exists. To claim
scheduling works, verify: (1) a scheduler exists, (2) it invokes the correct
target, (3) authentication works, (4) execution occurs at the intended
frequency, (5) downstream job execution occurs, (6) retry/failure behavior
works.

Do NOT silently select a scheduler architecture during audit or
implementation work. Scheduler design is a product/architecture decision
(NPD-05, §13).

---

## 10. WHATSAPP

WhatsApp architecture is established. Preserve: Meta webhook HMAC
verification, inbound deduplication, conversation state, deterministic intent
routing, booking/queue/reschedule/cancellation flows, handoff, outbound job
queue, delivery/read reconciliation, retry/exhaustion handling.

Do not introduce LLM intent routing unless explicitly requested. Do not
duplicate booking/queue/doctor business logic inside WhatsApp — reuse canonical
platform primitives. Use existing phone normalization (`formatE164()`); do not
introduce hardcoded country prefixes.

---

## 11. MIGRATIONS

Applied migrations are historical artifacts — NEVER casually edit one. Prefer
an additive migration for schema changes.

Before creating a migration, inspect: current schema, relevant migration
history, constraints, triggers, RLS, grants, existing functions, duplicate
definitions — and determine whether a migration is actually necessary.

Avoid destructive DDL unless explicitly authorized. After migration changes,
verify as appropriate: fresh database reset, migration validation, type
generation/check, unit tests, integration tests, runtime behavior — subject to
the §2 safety classes (`db:reset` is destructive; `fmt` and `gen:types` rewrite
files).

---

## 12. TESTING STANDARD

Prefer real-stack integration tests for database/runtime behavior. Use unit
tests for pure logic, plus integration, concurrency, privilege,
tenant-isolation, idempotency, replay and failure/recovery tests against the
real local Supabase stack.

When a test fails: determine whether the implementation or the test is wrong,
identify root cause, fix the real issue, rerun the relevant test, then rerun
regression coverage.

NEVER delete a failing test, skip a test without justification, weaken
assertions to get green, or replace integration behavior with mocks merely to
avoid runtime work.

A passing test must actually prove the intended behavior. Reading a test's
assertions to judge whether it proves what it claims is part of this standard,
not optional extra diligence (see F16-05/F16-06, §13).

---

## 13. CURRENT STATE — POINTERS, NOT EVIDENCE

The snapshot below is the working baseline established by Phase 1.6
verification (Gates 0–3, 3R). Do NOT re-investigate these facts every session,
and do NOT treat them as permanently true — later work may have changed them.

Detailed evidence lives in: `PHASE_1.6_SPEC.md`,
`PHASE_1.6_GATE_3R_SPEC.md`, `PHASE_1.6_GATE_3R_REPORT.md`,
`PHASE_1.6_FINDINGS_LOG.md`, `PHASE_1.6_RUNTIME_TEST_REPORT.md`,
`FINDING_ID_RECONCILIATION.md`, `PRIVILEGE_RUNTIME_VERIFICATION.md`,
`CROSS_PHASE_GAP_REGISTER.md`, `CROSS_PHASE_REQUIREMENTS_MATRIX.md`,
`CROSS_PHASE_AUDIT_REPORT.md`, `NEXT_PHASE_READINESS_REPORT.md`, and the phase
completion reports. **Use these files for detailed evidence; do not load them
unless the active task requires their evidence** — and then read only the
relevant section.

**Gate 3 status.** Historical Gate 3 is FROZEN at PARTIALLY COMPLETE — NOT
CERTIFIED (`PHASE_1.6_RUNTIME_TEST_REPORT.md`) — four of its nine step
definitions were lost to a context compaction and are recorded UNRECOVERABLE,
not reconstructed. It cannot be reopened or retroactively certified. Remaining
runtime/integration verification continues in **Gate 3R**
(`PHASE_1.6_GATE_3R_SPEC.md`), a separate successor gate with its own 1–7 step
numbering unrelated to Gate 3's 0–8. Check `PHASE_1.6_GATE_3R_SPEC.md`'s
execution-state field before assuming Phase 1.6 runtime verification is
complete.

**Repository.** The working tree is NOT a Git repository (no `.git`, confirmed
by two independent methods including a control probe). Therefore: claim no
tracked/untracked status, claim no commit history, and treat CI reachability as
provably unmeasurable from this tree, not merely unknown. Verify file changes
by direct inspection or timestamps, never by `git diff`/`git status`.

**Baseline commands (last full run).** `validate:migrations` passes with 0
errors and 4 pre-existing `[duplicate-objects]` warnings — do not re-report
them as new defects. `fmt:check` fails on exactly 8 root markdown files, all
Phase 1.6 audit/reconciliation documents, zero source files — cosmetic only, do
not fix unasked.

**Scheduler.** None exists — stronger than "not activated": `pg_cron` is
available but not installed (`installed_version` NULL), there is zero `pg_net`
HTTP scheduling invocation in the migrations, and no external scheduler
configuration exists anywhere in the repository.

**Background worker.** Local runtime showed 157 pending jobs and zero claimed
jobs, worker IDs, lease timestamps, worker registry rows, heartbeat rows,
worker lease rows or dead-letter rows. Known regression: `claim_jobs_v2`
(`19_background_worker_engine.sql`) does not populate
`job_queue.lease_expires_at` the way the older `claim_jobs` (migration 06) did.
Recovery logic depends on that column, so crash recovery cannot currently
reclaim v2-claimed jobs. Do not assume crash recovery is operational.

**Local environment secrets.** No local `.env` exists — only `.env.example`.
The Edge Runtime container has none of `CRON_SECRET`, `WORKER_SECRET`,
`RAZORPAY_KEY_SECRET`, `META_APP_SECRET`, `ENABLE_WORKER_TRIGGER`,
`WORKER_LEASE_SECS`. If a task genuinely requires local machine-endpoint
execution: use clearly-fake local-only values, never production secrets, never
commit them, and report the environment change (§15).

**Edge Runtime.** Its Docker container has `RestartPolicy=no`, unlike every
other Supabase service (`unless-stopped`), so it does not self-heal after a
Docker daemon restart. This has already produced a false positive where
`supabase start` exited 0 while Edge Runtime stayed down. When a test needs
Edge Functions, verify Edge Runtime is actually running — an exit code is not
sufficient.

**Privileges (Gate 2, P1-11).** Local verification established the
SETURA-owned privilege boundary at catalog and runtime: of 479 public routines,
213 are SETURA-owned (4 RLS-helper with full EXECUTE by design; 179 locked
B/C/D-category with `anon`/`authenticated` EXECUTE confirmed absent in
`pg_proc.proacl` and at runtime via SQLSTATE 42501; 10 trigger-only,
structurally non-callable via PostgREST; 9 locked plus 3 deliberately-open
SECURITY INVOKER helpers — `normalize_phone_number`, `compute_health_score`,
`get_partition_name`), and 266 are extension-owned stock Supabase posture, not
assessed. Live public RLS policy count: **139** (measured Gate 1, confirmed
by citation in Gate 2's deliverable). Production privilege state remains
UNPROVEN — no deployment exists. Do not convert local verification into a
production certification claim.

**F16-04 mechanism.** Migration 48 §2's fail-closed guarantee does not hold:
the PUBLIC grant is never revoked (only named-role grants are), and the
`supabase_admin` grantor rows were silently skipped when the migration ran as
`postgres`. Migration 49's four functions are safe only by accident — each is a
`CREATE OR REPLACE` of a pre-existing signature, preserving the prior ACL. See
§7 for the resulting obligation.

**Known open findings.** All severities are PROPOSED; final assignment is a
Gate 8 action. Verify current state before changing any of them — do not
silently treat them as fixed.

| ID | What | Note |
| --- | --- | --- |
| P0-01 | `claim_jobs_v2` doesn't set `lease_expires_at` | crash recovery can't reclaim v2-claimed jobs |
| P0-02 | no scheduler exists | design decision (NPD-05), not a config fix |
| P0-03 | `ENABLE_WORKER_TRIGGER=false` in `.env.example` | documented default deploys a non-processing system |
| P0-04 | `booking_fee_inr` has no runtime writer | one-time backfill (migration 28) only |
| F16-01 | Edge Runtime `RestartPolicy=no` | environment/tooling, not product code |
| F16-04 | migration 48's default-privilege fail-closed doesn't hold | new/changed SECURITY DEFINER functions need explicit REVOKE |
| F16-05 | `privilege_isolation.test.ts` can accept a JWT-failure 401 as privilege-denial proof on the authenticated half | test-quality gap; boundary itself separately proven by Gate 2's catalog census, so this doesn't reopen P1-11 |
| F16-06 | Category B denial coverage ~7 of 145 routines (~5%); overall locked-routine coverage ~22% | test-coverage gap |
| F16-07 | a test comment says "193 RLS policies"; 193 is the SECURITY DEFINER routine count | corrected: live count is 139 (see Privileges above), not unmeasured — comment still needs fixing in source, not fixed here |
| GOV-01 | Gate 3 was executed against a 9-step spec that existed only in conversation; 4 step definitions were lost to compaction | governance/process, not a product defect — see the persistence rule below |

---

## 14. FINDING-ID AND REPORT DISCIPLINE

`CROSS_PHASE_GAP_REGISTER.md` is the canonical finding-ID numbering. Do NOT mix
in IDs from `CROSS_PHASE_AUDIT_REPORT.md` or
`NEXT_PHASE_READINESS_REPORT.md` without checking the reconciliation — those
two use different internal numbering and collide with the Gap Register on 10 of
13 P1 IDs. For example, their "P1-02" is the Gap Register's P1-12/P1-13
(authorization inconsistency), not the Gap Register's actual P1-02
(partial-refund settlement over-adjustment).

Consult `FINDING_ID_RECONCILIATION.md` before citing a P1/P2 finding from
memory. If two reports appear to describe the same issue under different IDs,
state the crosswalk explicitly. Never silently merge findings.

`F16-NN`, `GOV-NN` and `OBS-N` (Phase 1.6 working findings, governance
findings, and non-finding observations respectively) are not register IDs.
Register allocation is a Gate 8 action, because the register's ID prefix is
itself a severity assignment — do not create `P1-14` or similar to shortcut
this.

Reports are context, not absolute truth. Use them to avoid rediscovering
history, but current source/runtime outranks them. If a report conflicts with
current source or runtime, report the conflict explicitly and do not silently
rewrite history — corrections to a historical report are recorded in a
governance document that cites the exact file and line, never by editing the
historical file itself. When a report says IMPLEMENTED, verify the
implementation if the current task depends on it. When it says VERIFIED,
determine what level of verification was actually performed.

---

## 15. CHANGE, PHASE, AUDIT AND ENVIRONMENT DISCIPLINE

**Smallest correct change.** Do NOT refactor unrelated code, rename stable
APIs without need, rewrite stable SQL, redesign a tested subsystem, replace
existing architecture because another pattern looks cleaner, add unnecessary
frameworks or dependencies, modify unrelated migrations, or clean up unrelated
Graphify findings. Every change must be tied to a requirement, defect, security
issue, correctness issue, performance requirement, operational requirement or
compatibility requirement.

**Before modifying anything,** determine: what owns this behavior; whether an
existing primitive already solves it; who calls it and what it calls; which SQL
objects and which tests depend on it; and whether it affects tenant isolation,
authorization, idempotency, concurrency, auditability, worker execution,
scheduling, WhatsApp, financial correctness or backward compatibility. Use
Graphify (§4) for the dependency questions.

**Phase and gate work — the persistence rule.** No phase or gate step may
exist only in conversation. Before any measurement or implementation for a
step begins, that step's full definition is written to a repository file —
not held in a scratch buffer, a plan, or a tool result. This is not a style
preference: Phase 1.6's Gate 3 lost four of nine step definitions to a single
context compaction because they were never persisted (GOV-01, §13), and the
gate had to be frozen NOT CERTIFIED as a direct result. If a gate's scope
changes mid-execution, update the specification file before the changed work
proceeds, and record the change as a change. Read the phase specification and
the relevant prior completion report section, check relevant cross-phase
audit/gap information, locate the implementation via Graphify, inspect actual
source, implement only the approved scope, preserve previously certified
behavior, add/modify tests, run the certification gates, write a completion
report, and explicitly list remaining gaps. Do NOT silently expand the phase.
An unrelated issue discovered en route gets classified and recorded — fix it
only if it blocks current-task correctness, current-task security, current
certification or data integrity.

**Audit work.** Do NOT immediately modify source. Define audit scope, navigate
with Graphify, inspect actual source and SQL, inspect runtime/database state
when available, inspect relevant tests, compare against requirements, reproduce
findings where possible, classify findings — and only then recommend
remediation. Never downgrade a finding because it is inconvenient, never
upgrade one without evidence, and never assume a mechanism is wired merely
because the code exists.

**Ambiguity.** Do not guess on architecture-critical decisions. If work
depends on an unresolved product or architecture choice, STOP that portion and
state what is known, what is uncertain, why it matters, the available options
and their consequences. Ask when the decision materially affects architecture,
security, tenancy, financial correctness, data integrity or production
operation. Do not ask unnecessary questions when the established architecture
already determines the correct implementation.

**Authorization scope.** The active phase/task specification controls scope,
but it MUST NOT override these fundamental constraints unless explicitly
authorized: security, tenant isolation, audit immutability, financial
integrity, concurrency safety, idempotency, source-of-truth discipline,
evidence/certification discipline, the no-secret-commitment rule, the
persistence rule above. A phase may authorize a migration, reset, environment
setup or architectural change — if it does not explicitly authorize such an
action, it is not authorized.

**Environment actions** (`supabase start`, `docker start`, `supabase db
reset`, creating a local `.env`, starting/stopping services, local database
probes) are not source changes and must not be reported as such. When
performing one, report what was done, why, whether it changed persistent
repository state, whether it is reproducible, and whether it affects
certification. Never create or expose real credentials.

---

## 16. SESSION DISCIPLINE AND HANDOFF

Use one session per unit of work rather than carrying a saturated context
across boundaries:

- **Session A — specification/review:** read the active spec section, plan,
  identify the exact files and evidence needed. No implementation.
- **Session B — execution:** implement the approved scope, run targeted
  verification.
- **Session C — reconciliation:** write the completion report, reconcile
  findings, list remaining gaps.

At a phase or gate boundary, write a compact handoff artifact and start fresh.
The handoff contains only: the active phase/step and its status; what was
actually done; commands run with their exact results; evidence category per
claim (§5); files changed; findings opened, closed or reclassified with their
canonical IDs (§14); blocked items with their failure classification (§3); and
the exact next step. It does not restate architecture, re-quote reports or
re-explain history already recorded elsewhere. This artifact is itself subject
to the persistence rule (§15) — write it to a file, not just to the reply.

---

## 17. OUTPUT FORMAT

End engineering work with:

**What changed** — exact files/components. **Why** — architectural reason.
**Database changes** — migrations, RPCs, tables, constraints, RLS, grants.
**Tests** — exact commands and exact results. **Runtime verification** — what
actually executed. **Security** — tenant/auth/RLS/privilege implications.
**Remaining issues** — explicit list of blocked, unproven, deferred, known
defects, product decisions. **Certification** — PASS / FAIL / BLOCKED /
UNPROVEN, using CERTIFIED only when the defined gates genuinely passed.

Before presenting a "what changed" summary for any file, verify each claimed
line (kept, dropped, added, reworded) against the actual before/after content
— see §5's note on self-reports.

---

## 18. GOLDEN RULE

DO NOT HALLUCINATE. DO NOT ASSUME. DO NOT MASK A FAILURE. DO NOT WEAKEN A
TEST. DO NOT CLAIM A TEST RAN WHEN IT DID NOT. DO NOT CLAIM RUNTIME
VERIFICATION WITHOUT RUNTIME EVIDENCE. DO NOT CLAIM PRODUCTION VERIFICATION
FROM LOCAL RESULTS. DO NOT CLAIM A SCHEDULER EXISTS WITHOUT AN ACTUAL
SCHEDULER. DO NOT CLAIM A WORKER EXECUTED BECAUSE A JOB WAS ENQUEUED. DO NOT
TRUST GRAPH RELATIONSHIPS AS PROOF. DO NOT REDESIGN STABLE ARCHITECTURE
WITHOUT EVIDENCE. DO NOT FIX UNRELATED PROBLEMS JUST BECAUSE YOU FOUND THEM.
DO NOT LET A GATE STEP EXIST ONLY IN CONVERSATION.

Graphify navigates. Source determines implementation. Database/runtime
determines actual behavior. Tests prove behavior. Reports preserve historical
context. Evidence determines certification. Ask when a genuine product or
architecture decision blocks the work.

The objective is not maximum code output. The objective is a correct, secure,
auditable, resilient, commercially deployable hospital operating system.