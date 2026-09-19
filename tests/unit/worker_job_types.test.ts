/**
 * tests/unit/worker_job_types.test.ts
 *
 * P0-B regression guard — the worker's claimable job-type set and
 * its handler set must stay one coherent pair.
 *
 * The defect this locks down: `create_partition` was declared in
 * run-background-worker's JOB_TYPES (so claim_jobs_v2 could hand it
 * to the worker) but had no switch-case handler — a claimed job fell
 * to `default` and threw "Unsupported job type", burning retries into
 * the dead-letter path for a job the system can never execute. There
 * is also no producer, and the partition_config parents are still
 * plain tables, so no handler could succeed today.
 *
 * Resolution chosen (roadmap Phase 0, "or stop enqueueing the job
 * type"): `create_partition` is removed from the claimable set.
 * Runtime partitioning is a deliberate maintenance-window conversion,
 * not an orphan job type.
 *
 * These tests parse the worker source statically:
 *   1. every declared JOB_TYPES entry has a handler case;
 *   2. `create_partition` is neither claimable nor handled;
 *   3. the five legitimate job types remain claimable and handled.
 *
 * Run: deno task test   (requires --allow-read; the task grants it)
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// Fixed-length permission-free read: assert() fails loudly if the
// worker source ever moves.
const WORKER_SOURCE_URL = new URL(
  "../../supabase/functions/run-background-worker/index.ts",
  import.meta.url,
);
let WORKER_SOURCE: string;
try {
  WORKER_SOURCE = await Deno.readTextFile(WORKER_SOURCE_URL);
} catch (err) {
  throw new Error(
    `cannot read worker source at ${WORKER_SOURCE_URL}: ${err}`,
  );
}

/** Line comments stripped, so prose inside the arrays is not parsed. */
function withoutLineComments(source: string): string {
  return source.replace(/\/\/[^\n]*/g, "");
}

/** Names from the `const JOB_TYPES = [...]` declaration. */
function declaredJobTypes(source: string): string[] {
  const match = withoutLineComments(source).match(
    /const JOB_TYPES = \[([\s\S]*?)\];/,
  );
  assert(match, "JOB_TYPES declaration not found in worker source");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Names from `case "...":` clauses (job-type identifiers only). */
function handledJobTypes(source: string): string[] {
  return [...source.matchAll(/case "([a-z0-9_]+)":/g)].map((m) => m[1]);
}

const LEGITIMATE_TYPES = [
  "send_whatsapp_message",
  "process_incoming_whatsapp",
  "send_notification",
  "refresh_analytics",
  "compute_sla",
];

Deno.test("p0b: every claimable job type has a handler case", () => {
  const declared = declaredJobTypes(WORKER_SOURCE);
  const handled = handledJobTypes(WORKER_SOURCE);

  const unhandled = declared.filter((t) => !handled.includes(t));
  assertEquals(
    unhandled,
    [],
    `claimable types without a handler (orphan-claim risk): ${
      unhandled.join(", ")
    }`,
  );
});

Deno.test("p0b: create_partition is neither claimable nor handled", () => {
  const declared = declaredJobTypes(WORKER_SOURCE);
  const handled = handledJobTypes(WORKER_SOURCE);

  assert(
    !declared.includes("create_partition"),
    "create_partition must not be in the claimable JOB_TYPES set",
  );
  assert(
    !handled.includes("create_partition"),
    "create_partition must not gain a handler without the parents " +
      "being converted to partitioned tables first",
  );
});

Deno.test("p0b: the five legitimate job types stay claimable and handled", () => {
  const declared = declaredJobTypes(WORKER_SOURCE);
  const handled = handledJobTypes(WORKER_SOURCE);

  for (const t of LEGITIMATE_TYPES) {
    assert(declared.includes(t), `${t} must remain claimable`);
    assert(handled.includes(t), `${t} must remain handled`);
  }
  assertEquals(
    [...declared].sort(),
    [...LEGITIMATE_TYPES].sort(),
    "the claimable set must be exactly the five supported types",
  );
});

Deno.test("p0b: default branch still rejects unknown types loudly", () => {
  assertStringIncludes(
    WORKER_SOURCE,
    "Unsupported job type",
    "the dispatch default branch must keep failing unknown types",
  );
});
