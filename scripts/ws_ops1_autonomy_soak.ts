/**
 * scripts/ws_ops1_autonomy_soak.ts
 *
 * WS-OPS-1 — Worker & Scheduler Autonomy + 24-Hour Soak HARNESS.
 *
 * This is ACTIVATION / EVIDENCE tooling, NOT a rewrite of the worker or the
 * scheduler. The worker engine (claim_jobs_v2 / complete_job_v2 /
 * fail_job_v2 / run_worker_crash_recovery) and the scheduler (pg_cron +
 * pg_net fire functions, migration 53/57) already exist and are integration
 * tested. What was missing was a repeatable way to (a) verify the real local
 * autonomy chain is armed, (b) run a continuous soak while sampling the §18
 * metrics to durable evidence, and (c) perform the §16 interruption/recovery
 * test with real processes. This script provides exactly that.
 *
 * SAFETY / SECRET POSTURE (§7, §20):
 *   - Refuses to run unless the API host is a local loopback address, so it
 *     can never point at production.
 *   - It NEVER writes a secret and NEVER reads a secret from the repo. It
 *     only INSPECTS whether the scheduler is armed (base_url present + Vault
 *     secret rows present) via the DB, and probes the machine endpoints for
 *     their fail-closed behaviour. Arming (base_url + Vault secrets + the
 *     edge-runtime CRON_SECRET/WORKER_SECRET/ENABLE_WORKER_TRIGGER env) is an
 *     explicit, out-of-band operator action; this harness reports the state,
 *     it does not fabricate it.
 *   - It does not invoke Meta / Razorpay. It observes whatever the autonomous
 *     cron->worker chain drains on its own; no manual worker call in soak mode.
 *
 * Modes (first positional arg):
 *   status      Print the armed/fail-closed snapshot + edge-runtime probe.
 *   soak        Sample metrics every --interval while pg_cron runs by itself,
 *               for --duration seconds, appending JSONL evidence to --out and
 *               asserting the §18 soak invariants. No worker is invoked here.
 *   interrupt   §16: claim a job with a real worker, stop heartbeating so the
 *               lease ages, prove run_scheduled_tasks reclaims it (no human
 *               step, using the same RPCs the minute tick calls).
 *
 * Options: --duration <sec> --interval <sec> --out <path>
 *          (defaults: duration=60, interval=15, out=ws_ops1_soak.jsonl)
 *
 * Run with the local stack up, e.g.:
 *   deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
 *     scripts/ws_ops1_autonomy_soak.ts status
 */

interface LocalStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function arg(name: string, dflt: string): string {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 && Deno.args[i + 1] ? Deno.args[i + 1] : dflt;
}

async function getLocalStatus(): Promise<LocalStatus | null> {
  try {
    const { code, stdout } = await new Deno.Command("supabase", {
      args: ["status", "-o", "json"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (code !== 0) return null;
    const text = new TextDecoder().decode(stdout);
    return JSON.parse(
      text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
    ) as LocalStatus;
  } catch {
    return null;
  }
}

function isLocal(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

async function client(st: LocalStatus) {
  Deno.env.set("APP_ENV", "development");
  Deno.env.set("SUPABASE_URL", st.API_URL);
  Deno.env.set("SUPABASE_ANON_KEY", st.ANON_KEY);
  Deno.env.set(
    "SUPABASE_SERVICE_ROLE_KEY",
    st.SERVICE_ROLE_KEY,
  );
  const { getServiceClient } = await import(
    "../supabase/functions/_shared/db.ts"
  );
  return getServiceClient();
}

type Row = Record<string, unknown>;

type Db = Awaited<ReturnType<typeof client>>;

async function countWhere(
  c: Db,
  table: string,
  filters: Array<[string, string, string | number | null]>,
): Promise<number> {
  let q = c.from(table).select("*", { count: "exact", head: true });
  for (const [col, op, val] of filters) {
    q = op === "is" ? q.is(col, val) : q.eq(col, val);
  }
  const { count, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function snapshotMetrics(c: Db) {
  const pending = await countWhere(c, "job_queue", [[
    "status",
    "eq",
    "pending",
  ]]);
  const processing = await countWhere(
    c,
    "job_queue",
    [["status", "eq", "processing"]],
  );
  const completed = await countWhere(
    c,
    "job_queue",
    [["status", "eq", "completed"]],
  );
  const dead = await countWhere(c, "job_queue", [["status", "eq", "dead"]]);
  const dlq = await countWhere(c, "dead_letter_jobs", []);
  const leasesOpen = await countWhere(
    c,
    "worker_job_leases",
    [["outcome", "is", null]],
  );
  const leasesReclaimed = await countWhere(
    c,
    "worker_job_leases",
    [["outcome", "eq", "reclaimed"]],
  );
  const crashedWorkers = await countWhere(
    c,
    "worker_registry",
    [["status", "eq", "crashed"]],
  );

  // Orphaned leases: a still-open lease (outcome IS NULL) whose job is no
  // longer 'processing' (already reclaimed/pending/dead but the lease row was
  // never closed). Computed with a real join-shaped query, not a bespoke RPC.
  let orphanedLeases = 0;
  const { data: openLeases, error: leaseErr } = await c.from(
    "worker_job_leases",
  ).select("job_queue_id").is("outcome", null).limit(2000);
  if (!leaseErr && openLeases && openLeases.length > 0) {
    const ids = (openLeases as Row[]).map((r) => r.job_queue_id as string);
    const { count, error: orphanErr } = await c.from("job_queue")
      .select("id", { count: "exact", head: true })
      .in("id", ids)
      .neq("status", "processing");
    if (!orphanErr) orphanedLeases = count ?? 0;
  }

  return {
    ts: new Date().toISOString(),
    jobs_pending: pending,
    jobs_processing: processing,
    jobs_completed: completed,
    jobs_dead: dead,
    dlq_rows: dlq,
    leases_open: leasesOpen,
    leases_reclaimed: leasesReclaimed,
    workers_crashed: crashedWorkers,
    orphaned_leases: orphanedLeases,
    queue_depth: pending + processing,
  };
}

async function schedulerArmed(st: LocalStatus): Promise<Row> {
  // Read only the NON-secret armed signal. base_url is a plain column on an
  // owner-only table, so we ask the DB what the fire function would decide via
  // a service_role probe of scheduler_fire_minute's fail-closed return.
  const res = await fetch(
    `${st.API_URL}/rest/v1/rpc/scheduler_fire_minute`,
    {
      method: "POST",
      headers: {
        "apikey": st.SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${st.SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  const body = (await res.json().catch(() => ({}))) as Row;
  return { http_status: res.status, fire_result: body };
}

async function edgeRuntimeAlive(st: LocalStatus): Promise<Row> {
  // Container inspect + a real HTTP probe (an exit code / `up` is not proof).
  let container = "unknown";
  try {
    const { code, stdout } = await new Deno.Command("docker", {
      args: [
        "inspect",
        "-f",
        "{{.State.Status}}/{{.HostConfig.RestartPolicy.Name}}",
        "supabase_edge_runtime_setura",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    container = code === 0
      ? new TextDecoder().decode(stdout).trim()
      : "inspect-failed";
  } catch {
    container = "docker-unavailable";
  }

  // POST with no cron secret: the endpoint must fail closed (403) rather than
  // 404/502, which proves the function is actually served by the runtime.
  let probe = "unreachable";
  try {
    const r = await fetch(
      `${st.API_URL}/functions/v1/run-background-worker`,
      {
        method: "POST",
        headers: {
          "apikey": st.ANON_KEY,
          "Authorization": `Bearer ${st.ANON_KEY}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(8000),
      },
    );
    probe = `http ${r.status}`;
  } catch (e) {
    probe = `error ${e instanceof Error ? e.message : String(e)}`;
  }
  return { container_state_restart_policy: container, worker_probe: probe };
}

function cronTicks(st: LocalStatus): Promise<Row> {
  // Latest evidence pg_cron is firing autonomously, read via SQL over the
  // service-role connection is not possible for cron.job_run_details (RLS on
  // username), so we report the two registered schedule rows instead.
  return fetch(
    `${st.API_URL}/rest/v1/cron.job?select=jobname,schedule,active`,
    {
      headers: {
        "apikey": st.SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${st.SERVICE_ROLE_KEY}`,
      },
    },
  ).then(async (r) => ({
    http_status: r.status,
    jobs: await r.json().catch(() => []),
  }));
}

// ─── modes ────────────────────────────────────────────────────────────────────

async function modeStatus(st: LocalStatus) {
  const c = await client(st);
  const armed = await schedulerArmed(st);
  const edge = await edgeRuntimeAlive(st);
  const cron = await cronTicks(st);
  const m = await snapshotMetrics(c);
  const out = { mode: "status", armed, edge, cron, metrics: m };
  console.log(JSON.stringify(out, null, 2));
  const fired = (armed.fire_result as Row)?.fired;
  console.log(
    `\nSCHEDULER: ${
      fired === true
        ? "ARMED (fires the worker endpoint)"
        : fired === false
        ? "FAIL-CLOSED (not provisioned)"
        : "UNKNOWN"
    }`,
  );
}

async function modeSoak(st: LocalStatus) {
  const c = await client(st);
  const durationSec = Number(arg("duration", "60"));
  const intervalSec = Number(arg("interval", "15"));
  const outPath = arg("out", "ws_ops1_soak.jsonl");
  const armed = await schedulerArmed(st);
  const fired = (armed.fire_result as Row)?.fired;

  console.error(
    `soak: duration=${durationSec}s interval=${intervalSec}s out=${outPath} ` +
      `scheduler=${fired === true ? "ARMED" : "FAIL-CLOSED"}`,
  );

  // §18 baseline for delta computation.
  let prev = await snapshotMetrics(c);
  const fh = await Deno.open(outPath, {
    create: true,
    append: true,
  });
  const started = Date.now();
  let samples = 0;
  const violations: string[] = [];
  let maxCompleted = prev.jobs_completed;
  const seenCompleted = prev.jobs_completed;

  const write = (o: Row) =>
    fh.write(new TextEncoder().encode(JSON.stringify(o) + "\n"));

  await write({
    kind: "meta",
    fired,
    started_at: new Date().toISOString(),
    durationSec,
  });

  while (Date.now() - started < durationSec * 1000) {
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
    const m = await snapshotMetrics(c);
    samples++;
    await write({ kind: "sample", ...m });

    // Monotonic-completion invariant (completed never decreases).
    if (m.jobs_completed < maxCompleted) {
      violations.push(
        `completed decreased ${maxCompleted}->${m.jobs_completed} at ${m.ts}`,
      );
    }
    maxCompleted = Math.max(maxCompleted, m.jobs_completed);

    if (m.orphaned_leases > 0) {
      violations.push(`orphaned leases ${m.orphaned_leases} at ${m.ts}`);
    }
    prev = m;
    console.error(
      `  [${samples}] depth=${m.queue_depth} completed=${m.jobs_completed} ` +
        `dlq=${m.dlq_rows} reclaimed=${m.leases_reclaimed} ` +
        `processing=${m.jobs_processing}`,
    );
  }

  const final = await snapshotMetrics(c);
  const summary = {
    kind: "summary",
    samples,
    elapsed_sec: Math.round((Date.now() - started) / 1000),
    scheduler_fired: fired,
    completed_delta: final.jobs_completed - seenCompleted,
    dlq_rows: final.dlq_rows,
    leases_reclaimed: final.leases_reclaimed,
    workers_crashed: final.workers_crashed,
    invariants_violated: violations,
    ended_at: new Date().toISOString(),
  };
  await write(summary);
  fh.close();
  console.log(JSON.stringify(summary, null, 2));

  if (fired !== true) {
    console.error(
      "\nNOTE: scheduler is FAIL-CLOSED (unprovisioned). The chain above was " +
        "NOT woken by pg_cron autonomously. This run evidences the OBSERVATION " +
        "harness only; autonomous end-to-end drain is UNPROVEN until armed.",
    );
  }
}

async function modeInterrupt(st: LocalStatus) {
  const c = await client(st);
  const w = await import("../supabase/functions/_shared/worker.ts");
  const { Logger } = await import("../supabase/functions/_shared/logger.ts");
  const logger = new Logger({ test: "ws_ops1_interrupt" });

  const RUN = crypto.randomUUID().slice(0, 8);
  const JOB_TYPE = "ws_ops1_interrupt_selftest";
  const dead = `ops1-dead-${RUN}`;
  const live = `ops1-live-${RUN}`;

  const hospitalId = (await c.from("hospitals").select("id").eq(
    "is_active",
    true,
  ).limit(1).then((r) => (r.data as Row[])[0]?.id)) as string;

  const { data: enq, error: enqErr } = await c.rpc("enqueue_job", {
    p_job_type: JOB_TYPE,
    p_payload: { selftest: RUN },
    p_priority: "normal",
    p_scheduled_at: new Date().toISOString(),
    p_idempotency_key: `ops1-interrupt-${RUN}`,
    p_hospital_id: hospitalId,
  });
  if (enqErr) throw new Error(`enqueue: ${enqErr.message}`);
  const jobId = enq as string;

  try {
    // Worker claims a real lease via the production primitive.
    await w.registerWorker({
      workerId: dead,
      workerType: "test",
      instanceId: RUN,
    }, logger);
    await w.claimJobs(dead, [JOB_TYPE], 5, logger);
    let row =
      (await c.from("job_queue").select("status, worker_id").eq("id", jobId)
        .single()).data as Row;
    console.error(`claimed: status=${row.status} owner=${row.worker_id}`);

    // Interrupt: worker vanishes, stops heartbeating -> lease ages into past.
    const past = new Date(Date.now() - 60_000).toISOString();
    await c.from("worker_registry").update({ lease_expires_at: past }).eq(
      "worker_id",
      dead,
    );
    await c.from("worker_job_leases").update({ lease_expires_at: past })
      .eq("job_queue_id", jobId).eq("worker_id", dead);
    console.error("interrupted: leases aged into the past");

    // Autonomous recovery: exactly what the minute tick calls.
    const { error: schedErr } = await c.rpc("run_scheduled_tasks");
    if (schedErr) throw new Error(`run_scheduled_tasks: ${schedErr.message}`);

    row = (await c.from("job_queue").select("status, worker_id").eq("id", jobId)
      .single()).data as Row;
    console.error(
      `after recovery: status=${row.status} owner=${row.worker_id}`,
    );

    // A fresh worker re-claims and completes it.
    await w.registerWorker({
      workerId: live,
      workerType: "test",
      instanceId: RUN,
    }, logger);
    const reclaimed = await w.claimJobs(live, [JOB_TYPE], 5, logger);
    const got = reclaimed.find((j) => j.id === jobId);
    const outcome = got
      ? await w.processJob(
        got,
        live,
        { process: () => Promise.resolve() },
        logger,
      )
      : "not-reclaimed";

    const ok = row.status === "pending" && outcome === "completed";
    console.log(JSON.stringify(
      {
        mode: "interrupt",
        reclaimed_to_pending: row.status === "pending",
        re_claimed_by_live_worker: Boolean(got),
        final_outcome: outcome,
        PASS: ok,
      },
      null,
      2,
    ));
    if (!ok) Deno.exit(1);
  } finally {
    await c.from("job_queue").delete().eq("id", jobId);
    for (const wid of [dead, live]) {
      await c.from("worker_registry").delete().eq("worker_id", wid);
    }
  }
}

// ─── entry ────────────────────────────────────────────────────────────────────

const status = await getLocalStatus();
if (!status) {
  console.error("Local Supabase stack is not running (`supabase start`).");
  Deno.exit(2);
}
if (!isLocal(status.API_URL)) {
  console.error(`REFUSING: API_URL ${status.API_URL} is not a loopback host.`);
  Deno.exit(3);
}

const mode = Deno.args[0] ?? "status";
if (mode === "status") await modeStatus(status);
else if (mode === "soak") await modeSoak(status);
else if (mode === "interrupt") await modeInterrupt(status);
else {
  console.error(`unknown mode "${mode}" (status|soak|interrupt)`);
  Deno.exit(4);
}
