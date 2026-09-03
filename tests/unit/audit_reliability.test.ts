/**
 * tests/unit/audit_reliability.test.ts
 *
 * Governance rule under test: an audit event must never silently
 * disappear.
 *
 * Two defects are locked down here:
 *
 *   1. `audit_logs.entity_id` and `audit_logs.actor_user_id` are UUID
 *      columns. Call sites used to pass a report type, a check name,
 *      the literal `"system"`, or `String(x ?? "")`. Each of those
 *      fails the UUID cast, which rejected the whole INSERT.
 *   2. supabase-js `rpc()` resolves with `{ data, error }` instead of
 *      throwing, and the old implementation discarded the result. A
 *      rejected write produced no log line and no metric.
 *
 * `logAuditEvent` must therefore: relocate a non-UUID reference into
 * `newData` so the row still lands, warn about it, count it, and report
 * a failed write instead of swallowing it.
 *
 * Run: deno task test
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// `_shared/audit.ts` imports `_shared/db.ts`, which imports
// `_shared/env.ts`, which throws at module initialization when the
// Supabase variables are absent. Set them before the dynamic import;
// a static import would hoist above these calls.
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");
Deno.env.set("SUPABASE_ANON_KEY", "unit-test-anon-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "unit-test-service-role-key");
Deno.env.set("APP_ENV", "test");

const { isUuid, logAuditEvent } = await import(
  "../../supabase/functions/_shared/audit.ts"
);

const { Logger } = await import("../../supabase/functions/_shared/logger.ts");
const { createMetrics } = await import(
  "../../supabase/functions/_shared/metrics.ts"
);

const REAL_UUID = "3f1a6c58-9d2b-4e77-8a10-5c6b7d8e9f01";

/** Captures log calls instead of writing them to stdout. */
class CapturingLogger extends Logger {
  readonly warns: Array<{ msg: string; extra: unknown }> = [];
  readonly errors: Array<{ msg: string; err: unknown }> = [];

  override warn(msg: string, extra?: unknown): void {
    this.warns.push({ msg, extra });
  }

  override error(msg: string, err?: unknown): void {
    this.errors.push({ msg, err });
  }
}

function harness() {
  const logger = new CapturingLogger({});
  const metrics = createMetrics("audit-unit-test", REAL_UUID);
  return { logger, metrics };
}

/** Metric names recorded by a collector, ignoring values. */
function metricNames(metrics: ReturnType<typeof createMetrics>): string[] {
  return metrics.getAll().map((m) => m.name);
}

// ── isUuid ───────────────────────────────────────────────────────────────────

Deno.test("isUuid accepts canonical 8-4-4-4-12 hex", () => {
  assert(isUuid(REAL_UUID));
  assert(isUuid("00000000-0000-0000-0000-000000000000"));
  assert(isUuid("3F1A6C58-9D2B-4E77-8A10-5C6B7D8E9F01"), "case-insensitive");
});

Deno.test("isUuid rejects every real offending value", () => {
  // Exactly the values that used to be passed as entity_id / actor.
  const offenders = [
    "", // String(outcome.suppression_id ?? "")
    "system", // actorUserId for cron and worker writes
    "daily_hospital", // enterprise-reports body.reportType
    "integration_matrix", // enterprise-reports checkName
    "wamid.HBgMOTE5OTk5OTAwMDAx", // Meta message id
    "undefined",
    "null",
  ];

  for (const value of offenders) {
    assertEquals(
      isUuid(value),
      false,
      `${JSON.stringify(value)} is not a UUID`,
    );
  }
});

Deno.test("isUuid rejects near-miss shapes and non-strings", () => {
  assertEquals(isUuid(REAL_UUID.replace(/-/g, "")), false, "unhyphenated");
  assertEquals(isUuid(`${REAL_UUID}0`), false, "too long");
  assertEquals(isUuid(REAL_UUID.slice(0, -1)), false, "too short");
  assertEquals(isUuid(` ${REAL_UUID} `), false, "padded");
  assertEquals(
    isUuid("3f1a6c58-9d2b-4e77-8a10-5c6b7d8e9g01"),
    false,
    "non-hex",
  );
  assertEquals(isUuid(null), false);
  assertEquals(isUuid(undefined), false);
  assertEquals(isUuid(12345), false);
  assertEquals(isUuid({}), false);
});

// ── Coercion of non-UUID references ──────────────────────────────────────────
//
// The RPC itself cannot run here: unit tests carry no --allow-net, so
// the call fails and the outcome is `ok: false`. The coercion happens
// before the call, so its observable effects (warning + metric) are
// still asserted, and they are what proves the UUID column is never
// handed a non-UUID.

Deno.test("logAuditEvent coerces a non-UUID entityId and warns", async () => {
  const { logger, metrics } = harness();

  await logAuditEvent(
    {
      hospitalId: REAL_UUID,
      actorUserId: REAL_UUID,
      entityType: "executive_report",
      entityId: "daily_hospital",
      actionType: "executive_report",
    },
    logger,
    metrics,
  );

  assertEquals(logger.warns.length, 1);
  assertEquals(
    logger.warns[0].msg,
    "Audit entityId is not a UUID; recorded as entityRef",
  );
  assertEquals(
    (logger.warns[0].extra as { entityRef: string }).entityRef,
    "daily_hospital",
  );
  assert(
    metricNames(metrics).includes("audit.entity_id_coerced"),
    "coercion must be counted",
  );
});

Deno.test("logAuditEvent coerces the literal 'system' actor and warns", async () => {
  const { logger, metrics } = harness();

  await logAuditEvent(
    {
      hospitalId: REAL_UUID,
      actorUserId: "system",
      entityType: "whatsapp_message",
      entityId: REAL_UUID,
      actionType: "whatsapp_send",
    },
    logger,
    metrics,
  );

  assertEquals(logger.warns.length, 1);
  assertEquals(
    logger.warns[0].msg,
    "Audit actorUserId is not a UUID; recorded as actorRef",
  );
  assertEquals(
    (logger.warns[0].extra as { actorRef: string }).actorRef,
    "system",
  );
  assert(metricNames(metrics).includes("audit.actor_id_coerced"));
});

Deno.test("logAuditEvent coerces an empty-string entityId", async () => {
  // The alert-center defect: String(outcome.suppression_id ?? "").
  const { logger, metrics } = harness();

  await logAuditEvent(
    {
      hospitalId: REAL_UUID,
      actorUserId: REAL_UUID,
      entityType: "alert_suppression",
      entityId: "",
      actionType: "alert_center",
    },
    logger,
    metrics,
  );

  assertEquals(logger.warns.length, 1);
  assert(metricNames(metrics).includes("audit.entity_id_coerced"));
});

Deno.test("logAuditEvent does not warn or coerce for valid UUIDs", async () => {
  const { logger, metrics } = harness();

  await logAuditEvent(
    {
      hospitalId: REAL_UUID,
      actorUserId: REAL_UUID,
      entityType: "booking",
      entityId: REAL_UUID,
      actionType: "booking_create",
    },
    logger,
    metrics,
  );

  assertEquals(logger.warns.length, 0, "a valid UUID must pass through");

  const names = metricNames(metrics);
  assertEquals(names.includes("audit.entity_id_coerced"), false);
  assertEquals(names.includes("audit.actor_id_coerced"), false);
});

Deno.test("logAuditEvent leaves an absent entityId alone", async () => {
  const { logger, metrics } = harness();

  await logAuditEvent(
    {
      hospitalId: REAL_UUID,
      actorUserId: REAL_UUID,
      entityType: "compliance_check",
      actionType: "compliance_check",
    },
    logger,
    metrics,
  );

  assertEquals(logger.warns.length, 0);
  assertEquals(
    metricNames(metrics).includes("audit.entity_id_coerced"),
    false,
    "omitted is not the same as invalid",
  );
});

// ── Failures are reported, never swallowed ───────────────────────────────────

Deno.test("logAuditEvent reports a failed write instead of discarding it", async () => {
  const { logger, metrics } = harness();

  const outcome = await logAuditEvent(
    {
      hospitalId: REAL_UUID,
      actorUserId: REAL_UUID,
      entityType: "booking",
      entityId: REAL_UUID,
      actionType: "booking_create",
    },
    logger,
    metrics,
  );

  // No --allow-net, so the RPC cannot succeed. The point is that the
  // failure surfaces: an outcome, a log line and a metric.
  assertEquals(outcome.ok, false);
  assertNotEquals(logger.errors.length, 0, "a failure must be logged");
  assert(
    metricNames(metrics).includes("audit.write_failed"),
    "a failure must be counted",
  );
});

Deno.test("logAuditEvent never throws, whatever the input", async () => {
  const { logger, metrics } = harness();

  // Deliberately hostile: no hospital, non-UUID actor, non-UUID entity.
  const outcome = await logAuditEvent(
    {
      hospitalId: null,
      actorUserId: "system",
      entityType: "worker",
      entityId: "wamid.HBgMOTE5OTk5OTAwMDAx",
      actionType: "worker_crash_recovery",
      severity: "critical",
      oldData: null,
      newData: null,
      notes: "unit test",
    },
    logger,
    metrics,
  );

  assertEquals(typeof outcome.ok, "boolean");
  assertEquals(logger.warns.length, 2, "both references must be reported");
});
