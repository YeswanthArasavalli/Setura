# SETURA — FINDING ID RECONCILIATION

**Phase 1.6 · Gate 0 deliverable**
**Date:** 2026-08-21
**Mode:** READ-ONLY. No source file, migration, Edge Function, test, configuration
file or pre-existing report was modified to produce this document. No migration was
created. No register entry was renumbered, added or removed.
**Purpose:** establish ONE canonical finding ID and severity per finding, so that
every Phase 1.6 deliverable cites an unambiguous label.

---

## 0. Why this gate exists, and what it found

Phase 1.6's governing prompt (§3A) recorded two known cross-document ID conflicts
and instructed that §3A **not** be assumed exhaustive.

It is not exhaustive. The measured result:

| Measure | §3A expectation | Measured |
| --- | --- | --- |
| P1 IDs that disagree between documents | 2 named | **10 of 13** |
| Documents on each scheme | 2 vs. 1 | **2 vs. 3** |
| P1 IDs that agree across all documents | not stated | **3** — `P1-01`, `P1-06`, `P1-09` |
| P0 IDs that disagree | 0 | **0 — confirmed** |
| NPD IDs that disagree | 0 | **0 — confirmed** |
| P2 / P3 schemes | not stated | **shared**, with 2 defects (§6) |

The divergence is confined to the **P1 namespace**. It is not random drift: it is
two internally-consistent schemes, and the split is not the one §3A described.

---

## 1. The actual structure of the divergence

Two complete, self-consistent P1 numbering schemes exist. §3A stated that
`CROSS_PHASE_AUDIT_REPORT.md` and `NEXT_PHASE_READINESS_REPORT.md` share one
scheme and `CROSS_PHASE_GAP_REGISTER.md` uses another — implying 2 documents
against 1. Measured, it is **2 against 3**.

| Document | P1 scheme | Evidence |
| --- | --- | --- |
| `CROSS_PHASE_GAP_REGISTER.md` | **Register scheme** | Defines all 13 with locations, §2 — `:88`, `:107`, `:124`, `:136`, `:150`, `:168`, `:187`, `:201`, `:217`, `:239`, `:252`, `:274`, `:292` |
| `CERTIFICATION_RECONCILIATION.md` | **Register scheme** | `:123` cites `P1-10` *and* `P1-02` as separate refund findings; `:238` `P1-08` = unreachable refund states; `:360` `P1-11` = Docker/privilege; `:366` `P1-12` = `is_primary` / `seed.sql` |
| `ARCHITECTURAL_DRIFT_REGISTER.md` | **Register scheme** | `:56` `P1-05` = WhatsApp revenue with no payment order; `:58` `P1-07` = wrong credential 403; `:60` `P1-11` = `pg_proc.proacl` unproven; `:66` `P1-10` = refund basis |
| `CROSS_PHASE_AUDIT_REPORT.md` | **Summary scheme** | Defines all 13 in §23.3, `:1756-1772` |
| `NEXT_PHASE_READINESS_REPORT.md` | **Summary scheme (P1 only)** | `:222` `P1-05`; `:247` `P1-10`; `:333` `P1-13`; `:394` `P1-01`; `:406` `P1-02`; `:431` `P1-09` |
| `CROSS_PHASE_REQUIREMENTS_MATRIX.md` | **none — cannot conflict** | Zero occurrences of `P[0-3]-NN` and zero of `NPD-N`; the matrix keys on requirement IDs (`R-05`, `N5-02`, …) only |

**`NEXT_PHASE_READINESS_REPORT.md` mixes the two schemes.** Its P1 citations follow
the Summary scheme, while its P2 citations follow the Register scheme — `:172`
`P2-12`, `:177` `P2-13`, `:321` `P2-08`, `:337` `P2-15`, `:343` `P2-06`, `:349`
`P2-07` all match `CROSS_PHASE_GAP_REGISTER.md` §3 exactly. A reader who infers the
scheme from that document's P2 citations will then misread every one of its P1
citations. This is the specific mechanism by which the conflict propagates.

---

## 2. Canonical scheme: the Register scheme

**Decision: the `CROSS_PHASE_GAP_REGISTER.md` scheme is canonical for Phase 1.6 and
forward.**

The Summary scheme is not preferred, and the reasons are stated rather than left
silent — `CROSS_PHASE_AUDIT_REPORT.md` is the largest and chronologically primary
audit document, so choosing against it requires justification:

1. **Designated function.** The Gap Register's stated purpose (`:3`) is
   "Consolidated defect and gap register". Other documents cite *it* as the system
   of record — `NEXT_PHASE_READINESS_REPORT.md:330-331` says "Recorded in
   `CROSS_PHASE_GAP_REGISTER.md` §3". No document cites §23.3 as a register.
2. **One finding per ID.** The Summary scheme merges two independent defects into
   `P1-10` ("Refund basis inconsistent across three paths; partial refunds
   over-adjust settlement", `:1769`). The Register separates them — `P1-10` refund
   basis (`:239`) and `P1-02` partial-refund settlement over-adjustment (`:107`).
   These require different repairs, different migrations and different tests; a
   merged ID cannot be tracked to closure independently, which Gate 6 requires.
3. **Evidence density.** Register entries carry file, line, call path, consequence,
   test evidence and an explicit evidence class (CONFIRMED / UNPROVEN). §23.3 is a
   one-line-per-ID summary table with no locations.
4. **Certification continuity.** `CERTIFICATION_RECONCILIATION.md` keys its
   WITHDRAWN / SUSPENDED outcomes to Register IDs (`:123`, `:199`, `:238`, `:360`).
   Prompt §8 instructs that the certification baseline be preserved unless evidence
   justifies change. Re-labelling to the Summary scheme would invalidate that
   baseline as a side effect of a clerical choice.
5. **Majority already in use.** 3 of the 5 ID-bearing documents use it.

**Counts are unchanged.** P0 = 4 · P1 = 13 · P2 = 15 · P3 = 10 · NPD = 6 · 48
entries. This gate renumbers nothing and creates no register entry. Prompt §3's
instruction not to reconcile the 5-NPD (matrix) vs. 6-NPD (register) difference is
observed: they remain different counting universes, and §1 above shows why the
matrix cannot participate in an ID conflict at all.

---

## 3. Canonical P1 crosswalk

Read this table in one direction only: **Summary ID → canonical ID.** Rows where the
two schemes assign the same number to different findings are the hazard.

| Canonical ID (Register) | Finding | Register loc. | Summary-scheme ID | Status |
| --- | --- | --- | --- | --- |
| **P1-01** | Razorpay webhook HMAC verified with `RAZORPAY_KEY_SECRET`; no `RAZORPAY_WEBHOOK_SECRET` exists | `:88` | `P1-01` (`:1760`) | **AGREE** |
| **P1-02** | Partial refunds over-adjust settlement — `confirm_refund_processed` (mig 41 body line 78) zeroes full DCE fee rows on any partial refund | `:107` | part of `P1-10` (`:1769`) | **COLLIDES** — Summary `P1-02` is the authorization finding |
| **P1-03** | `idempotent_capture_payment` (`16:421`) discards `capture_payment`'s BOOLEAN; failure reported as success | `:124` | `P1-08` (`:1767`) | **COLLIDES** |
| **P1-04** | `settlement-engine` `record_payment` returns HTTP 500 by construction | `:136` | `P1-11` (`:1770`) | **COLLIDES** |
| **P1-05** | Revenue recognised before, and independently of, collection — ledger credits fire at booking INSERT | `:150` | *no distinct Summary P1*; `:1816` uses `P1-05` loosely for the payment-order fact | **COLLIDES** |
| **P1-06** | `get_reconciliation_summary` reports three incorrect KPIs | `:168` | `P1-06` (`:1765`) | **AGREE** |
| **P1-07** | Nightly worker trigger authenticates with `SUPABASE_SERVICE_KEY.slice(-20)` vs. `CRON_SECRET` → always 403 | `:187` | `P1-03` (`:1762`) | **COLLIDES** |
| **P1-08** | `bookings.payment_status_detail` refund transitions have no writer | `:201` | *no Summary P1 ID*; narrated un-numbered at `:1817-1818` | **COLLIDES** — Summary `P1-08` is the capture-BOOLEAN finding |
| **P1-09** | `verify_jwt = true` blocks all seven machine endpoints | `:217` | `P1-09` (`:1768`) | **AGREE** |
| **P1-10** | Refund amount basis inconsistent between paths (`total_amount_snapshot` vs. `booking_fee_inr`) | `:239` | part of `P1-10` (`:1769`) | **PARTIAL** — Summary merges canonical `P1-02` into this ID |
| **P1-11** | Phase 1.5 privilege boundary UNPROVEN — requires `pg_proc.proacl` | `:252` | `P1-07` (`:1766`) | **COLLIDES** |
| **P1-12** | `is_primary` provisioning hazard causes total Edge API lockout | `:274` | part of `P1-02` (`:1761`) | **COLLIDES** |
| **P1-13** | Authorization ignores account deactivation — `has_permission()` never consults `profiles.is_active` | `:292` | part of `P1-02` (`:1761`); `P1-13` (`:1772`) states the adjacent append-only claim | **COLLIDES** |

### 3.1 The two schemes' `P1-02` and `P1-05` — the §3A conflicts, confirmed

Both §3A conflicts are confirmed exactly as described:

- **Conflict 1.** Summary `P1-02` = "Three incompatible authorization rules;
  `has_permission()` ignores `profiles.is_active`" (`CROSS_PHASE_AUDIT_REPORT.md:1761`,
  restated `:1827`, `NEXT_PHASE_READINESS_REPORT.md:406`). Register `P1-02` = partial
  refunds over-adjust settlement (`:107`). The authorization finding's canonical home
  is **`P1-12` + `P1-13`**, cross-referenced to **`NPD-04`** (`:550`).
- **Conflict 2.** Summary `P1-05` = "`create-booking` creates no payment order"
  (`:1764`, `NEXT_PHASE_READINESS_REPORT.md:222`). Register `P1-05` = revenue
  recognised before/independently of collection (`:150`). The literal payment-order
  fact is Register **`P2-10`** (`:432`). Severity treated in §4.2.

### 3.2 Summary-scheme P1s with no canonical P1 home

| Summary ID | Finding | Canonical disposition |
| --- | --- | --- |
| `P1-04` (`:1763`) | `run-cron-nightly:296` violates the "must NOT wake worker" prohibition | **`P2-09`** (`:421`) — severity resolved in §4.1 |
| `P1-05` (`:1764`) | `create-booking` creates no payment order | **`P2-10`** (`:432`) — severity **DISPUTED**, §4.2 |
| `P1-12` (`:1771`) | No evidence any alert has ever fired end to end | **No register entry exists.** → `U-01`, §5 |

### 3.3 `P1-13` — same ID, adjacent but distinct content

Register `P1-13` (`:292`) is a defect: authorization does not consult
`profiles.is_active`, and role revocation is DELETE-only. Summary `P1-13` (`:1772`,
`NEXT_PHASE_READINESS_REPORT.md:333`) is a *certification-scope* claim: the
append-only posture is asserted more broadly than the triggers enforce.

**Resolution:** canonical `P1-13` = the Register defect. The append-only over-assertion
is not a separate defect and receives no ID — it is a certification narrowing already
carried by `CROSS_PHASE_AUDIT_REPORT.md:144` ("HELD for `audit_logs`,
`financial_ledger`, `consultation_notes`, `queue_runtime_events`; asserted more
broadly than enforced"). Phase 1.6 must not double-count it as an open defect.

---

## 4. Severity disputes

### 4.1 `P2-09` — nightly wakes the worker · **RESOLVED as P2**

| | Summary scheme | Register scheme |
| --- | --- | --- |
| ID | `P1-04` (`:1763`) | `P2-09` (`:421`) |
| Severity | P1 | P2 |

**Canonical: `P2-09`, severity P2.** Reasoning against the Register's own §0
definitions: the finding's *present* runtime consequence is nil, because the
prohibited call at `run-cron-nightly/index.ts:296` is masked by the 403 that
`P1-07` describes. A finding with no current runtime effect does not meet the
Register's P1 bar ("deploy-blocking … financial incorrectness, an unauthenticated or
unreachable integration, or an unproven security boundary", `:19`). The Summary
scheme's P1 elevation is best read as pricing in the *combined* `P1-07`+`P2-09`
risk, which the canonical scheme already carries at P1 via `P1-07`.

**Binding dependency — carry into Gate 4/Gate 5:** `P2-09` must be resolved *before
or together with* `P1-07`, never after. Repairing the credential alone activates the
prohibited behaviour. `ARCHITECTURAL_DRIFT_REGISTER.md:58` reaches the same
conclusion independently (D-05): "Fixing `P1-07` before `D-05` would ship the
forbidden design." Severity P2 is a priority label, **not** permission to defer it
past `P1-07`.

### 4.2 `P2-10` — `create-booking` creates no payment order · **ID RESOLVED, SEVERITY DEFERRED**

| | Summary scheme | Register scheme |
| --- | --- | --- |
| ID | `P1-05` (`:1764`) | `P2-10` (`:432`) |
| Severity | P1 — MISSING, blocks financial completeness | P2 — atomicity gap, order creation exists separately |
| Framing | `create-booking` (688 L) has zero payment references | Two round trips; a client crash between them leaves an unpaid booking with revenue already credited |

**Canonical ID: `P2-10`. Canonical severity: DISPUTED — unresolved pending Gate 6.**

ID and severity are separable, so the ID is settled now to stop the mislabelling,
while severity is explicitly *not* settled. Per prompt §3A and Gate 6, severity here
is not an engineering call: it depends on which collection model is intended.

| Intended model | Correct severity | Consequence |
| --- | --- | --- |
| **(A)** booking creates the payment order | **P1** — a required writer is missing from the production path | `create-booking` must be changed |
| **(B)** payment order is deliberately a separate client step | **P2** — genuine atomicity/crash-window gap only | documentation and API contract must say so |
| **(C)** another workflow owns collection | **P1 for WhatsApp** — no WhatsApp flow creates an order or link at all (`:160`) | that workflow must be identified and built |

This is **RULE 6 territory**: it turns on `NPD-02` (when is revenue recognised) and on
who owns collection for WhatsApp bookings. Recorded as a blocking product decision for
Gate 6. Until it is answered, Phase 1.6 deliverables must write
`P2-10 (severity DISPUTED)` and must not assert either P1 or P2.

**Independent of that decision:** canonical `P1-05` (revenue recognised before
collection, `:150`) remains **P1**. The ledger/collection decoupling is a confirmed
financial defect under every one of models (A), (B) and (C).

---

## 5. Findings carried forward with no register entry

Summary `P1-12` — "No evidence any alert has ever fired end to end" (`:1771`) — has
no counterpart in the Gap Register. An exhaustive search of
`CROSS_PHASE_GAP_REGISTER.md` for an alert-fired entry returns nothing; the nearest
entry, `P3-01` (`:527`), is the distinct `42501` → HTTP 500 mapping defect.

It is not a confirmed defect. It is an absence of evidence, which the Register itself
classes separately (`:589`: "Nine of the twelve UNPROVEN matrix rows are unverified
claims, not defects. No certification should be granted or revoked on them in either
direction").

**Canonical: `U-01`, class UNPROVEN, no severity.** A new namespace `U-` is used
deliberately so that the register counts stated in prompt §3 — which were
independently re-summed and reconcile exactly — are not silently altered by inventing
a `P1-14`.

| Canonical ID | Item | Class | Resolves at |
| --- | --- | --- | --- |
| `U-01` | No evidence any alert has fired end to end (Summary `P1-12`, `:1771`) | UNPROVEN — verification item, not a defect | Gate 4 (scheduler → alert path) |

---

## 6. Two further defects in the P2 namespace

The P2 *scheme* is shared across all documents — every P2 ID checked
(`P2-01`…`P2-15`) denotes the same finding in `CROSS_PHASE_AUDIT_REPORT.md`,
`NEXT_PHASE_READINESS_REPORT.md` and `CROSS_PHASE_GAP_REGISTER.md`. Two defects
nonetheless attach to it.

### 6.1 `DOC-01` — `P2-09` is misdescribed in the Readiness Report

`NEXT_PHASE_READINESS_REPORT.md:329-331` states:

> "**P2-09 — a negative constraint is contradicted.** A CHECK constraint forbids a
> value that another code path can produce. Recorded in
> `CROSS_PHASE_GAP_REGISTER.md` §3."

The cited source, `CROSS_PHASE_GAP_REGISTER.md:421-430`, describes something else: a
**`ROADMAP.md` prohibition** ("Verify `run-cron-nightly` does NOT wake worker")
contradicted by `run-cron-nightly/index.ts:296`. No CHECK constraint is involved.

The description is also not a garbled account of any other register entry. The
closest candidate, `P1-08` (`:201`), is the logical inverse — a CHECK constraint that
*permits* values no writer produces, not one that forbids a value a writer produces.

Per RULE 1 this document does **not** guess which finding was intended. Recorded as
`DOC-01`: a documentation defect in the Readiness Report, to be corrected at Gate 8.
`CROSS_PHASE_AUDIT_REPORT.md:1693` lists `P2-09` under "Data integrity & schema
governance", consistent with the same misreading, so the error is present in both
Summary-scheme documents.

### 6.2 Two findings carry both a P1 and a P2 label inside one document

`CROSS_PHASE_AUDIT_REPORT.md` labels the nightly-wakes-worker finding `P1-04` at
`:1763` and `P2-09` at `:1693`. The canonical scheme resolves this to `P2-09` alone
(§4.1). The same document-internal duplication applies to `P1-05` / `P2-10`.

---

## 7. Verified identical across all documents — cite freely

| Namespace | Status | Evidence |
| --- | --- | --- |
| **P0-01 … P0-04** | **IDENTICAL** | `CROSS_PHASE_GAP_REGISTER.md:35,50,61,72` · `CROSS_PHASE_AUDIT_REPORT.md:1747-1750` · `ARCHITECTURAL_DRIFT_REGISTER.md:125-128` |
| **NPD-01 … NPD-06** | **IDENTICAL** | `CROSS_PHASE_GAP_REGISTER.md:547-552`; D-1…D-4 carry-forward mapping stated at `:554-556` |
| **P2-01 … P2-15** | **shared scheme**, 2 defects | §6 |
| **P3-01 … P3-10** | **shared scheme**, no conflict found | `CROSS_PHASE_GAP_REGISTER.md:525-536`; `P3-01`, `P3-03`, `P3-04`, `P3-07`, `P3-08`, `P3-09`, `P3-10` cited consistently in the Audit Report |
| **D-01 … D-30** | single source | `ARCHITECTURAL_DRIFT_REGISTER.md` is the only definer |

The four P0s and the six NPDs — the entire Phase 1.6 critical path — are
**unaffected** by this conflict.

---

## 8. Citation rule for all Phase 1.6 deliverables

1. Cite **content first, ID second**.
2. Use canonical (Register) IDs only. Never cite a Summary-scheme P1 ID without
   translating it through §3 first.
3. When quoting a Summary-scheme document, translate and mark it:
   `P1-11 [Summary] → P1-04 [canonical]`.
4. `P2-10` must always be written **`P2-10 (severity DISPUTED)`** until Gate 6
   resolves §4.2.
5. `U-01` carries no severity and must not be reported as a defect.
6. Verify any ID against the actual `CROSS_PHASE_GAP_REGISTER.md` line before using
   it as a label — including IDs appearing in the Phase 1.6 prompt itself.

---

## 9. What this gate did not do

- Did not renumber, add or remove any register entry. Counts stand at 48.
- Did not change any severity except to *resolve which of two existing severities
  governs* (§4.1), and explicitly declined to resolve §4.2.
- Did not modify any of the six source documents. `DOC-01` is recorded for Gate 8,
  not fixed here.
- Did not assess whether any finding is still true. Gate 0 is about labels.
  Independent re-verification of the findings is Gates 1–7.
- Did not resolve `NPD-02` or any other product decision.
