import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  fetchAuditIntegrity,
  fetchAuditSearch,
  fetchDoctorOpsIntegrity,
  fetchIntegrationMatrix,
  fetchQueueIntegrity,
  fetchSettlementIntegrity,
} from "@/api/enterpriseReports";
import { listHospitalDoctors, listTodaysBookings } from "@/api/reads";
import { describeError } from "@/lib/errors";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type {
  AuditEntry,
  AuditIntegrityResponse,
  AuditSearchResponseBody,
  AuditSeverity,
  DoctorOpsIntegrityResponse,
  IntegrationMatrixResponse,
  QueueIntegrityResponse,
  SettlementIntegrityResponse,
} from "@/types/api";

/**
 * Hospital Admin Audit & Compliance Viewer (Phase 7 G-05) — a strictly
 * READ-ONLY surface over the existing `enterprise-reports` Edge Function.
 *
 * Everything here is a presentation of an actual backend response: no count
 * is recomputed, no verdict is derived and no mutation control exists. The
 * audit search loads on entry (acceptance criterion 1: the admin lands on
 * real audit rows); each integrity check is run explicitly from its own card
 * so the page issues exactly the reads the admin asked for. Independent
 * sections degrade independently (partial failure), never the whole page.
 *
 * Tenant context comes from the authenticated staff session only — never
 * from the URL — and the backend re-authorizes role + tenant server-side
 * (`requireRole([hospital_admin, global_admin])` + verified `X-Hospital-ID`)
 * and audits this very access as `compliance_check`.
 *
 * The money-sensitive `generate` report types are deliberately absent
 * (investigation §12): this viewer renders audit metadata and integrity
 * VERDICTS only.
 */

type SectionStatus = "idle" | "loading" | "success" | "error";

interface Section<T> {
  status: SectionStatus;
  data: T | null;
  error: string | null;
}

const IDLE: Section<never> = { status: "idle", data: null, error: null };
const LOADING: Section<never> = { status: "loading", data: null, error: null };

function failed(e: unknown): Section<never> {
  return { status: "error", data: null, error: describeError(e) };
}

function succeeded<T>(data: T): Section<T> {
  return { status: "success", data, error: null };
}

/** Safe display for backend values that may arrive as number or string
 *  (PostgREST serialisation), null or undefined. Never renders "undefined",
 *  "null" or "[object Object]". */
function display(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : v;
}

/** Timestamp rendering that falls back to the raw value for unparsable
 *  input instead of emitting "Invalid Date" noise. */
function displayTs(ts: string | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

/** Local-time string for a datetime-local input, browser-timezone based:
 *  the backend compares a timestamptz and the browser supplies the zone. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const SEVERITY_VARIANT: Record<
  AuditSeverity,
  "secondary" | "outline" | "warning" | "destructive"
> = {
  low: "secondary",
  medium: "outline",
  high: "warning",
  critical: "destructive",
};

/** Backend default window for `search_audit_logs` is 7 days; the picker
 *  mirrors that default openly instead of hiding it. */
const DEFAULT_FROM_DAYS = 7;

export function AdminAudit() {
  const { staff, hospitalId } = useAuth();

  // ── Audit search state ──────────────────────────────────────────────────
  const [search, setSearch] = useState<Section<AuditSearchResponseBody>>(LOADING);
  const [entityType, setEntityType] = useState("");
  const [actionType, setActionType] = useState("");
  const [correlationId, setCorrelationId] = useState("");
  const [fromTs, setFromTs] = useState(() =>
    toLocalInputValue(new Date(Date.now() - DEFAULT_FROM_DAYS * 86_400_000)),
  );
  const [toTs, setToTs] = useState(() => toLocalInputValue(new Date()));

  // ── Compliance-check states: idle until explicitly run ──────────────────
  const [auditIntegrity, setAuditIntegrity] = useState<Section<AuditIntegrityResponse>>(IDLE);
  const [settlementIntegrity, setSettlementIntegrity] =
    useState<Section<SettlementIntegrityResponse>>(IDLE);
  const [integrationMatrix, setIntegrationMatrix] = useState<Section<IntegrationMatrixResponse>>(IDLE);
  const [matrixDate, setMatrixDate] = useState(todayIso);

  // Targeted checks need a target. The pickers are filled from the tenant's
  // own RLS-readable rows (bookings / doctors); an empty directory is a
  // stated fact, not a fabricated option list.
  const [sessionOptions, setSessionOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [sessionsState, setSessionsState] = useState<"loading" | "ready" | "error">("loading");
  const [sessionId, setSessionId] = useState("");
  const [queueIntegrity, setQueueIntegrity] = useState<Section<QueueIntegrityResponse>>(IDLE);

  const [doctorOptions, setDoctorOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [doctorsState, setDoctorsState] = useState<"loading" | "ready" | "error">("loading");
  const [doctorId, setDoctorId] = useState("");
  const [doctorDate, setDoctorDate] = useState(todayIso);
  const [doctorOpsIntegrity, setDoctorOpsIntegrity] =
    useState<Section<DoctorOpsIntegrityResponse>>(IDLE);

  const activeRef = useRef(true);

  const runSearch = useCallback(async () => {
    if (!hospitalId) return;
    setSearch(LOADING);
    try {
      const data = await fetchAuditSearch(hospitalId, {
        ...(entityType.trim() ? { entityType: entityType.trim() } : {}),
        ...(actionType.trim() ? { actionType: actionType.trim() } : {}),
        ...(correlationId.trim() ? { correlationId: correlationId.trim() } : {}),
        ...(fromTs ? { fromTs: new Date(fromTs).toISOString() } : {}),
        ...(toTs ? { toTs: new Date(toTs).toISOString() } : {}),
      });
      if (activeRef.current) setSearch(succeeded(data));
    } catch (e) {
      if (activeRef.current) setSearch(failed(e));
    }
  }, [hospitalId, entityType, actionType, correlationId, fromTs, toTs]);

  // The landing search must run exactly once per mount — typing into a
  // filter must NOT re-trigger a search (that would fire an audited
  // enterprise-reports request per keystroke). The ref keeps the effect
  // hospital-scoped while runSearch itself stays fresh for the form.
  const runSearchRef = useRef(runSearch);
  runSearchRef.current = runSearch;

  useEffect(() => {
    activeRef.current = true;
    if (!hospitalId) return;
    // Landing on real rows is the point of the surface (acceptance §16.1).
    void runSearchRef.current();

    // Tenant directories for the targeted checks — RLS reads, tenant-scoped
    // by construction, exactly what the Queue Board / booking form already
    // surface to this role.
    void (async () => {
      try {
        const day = todayIso();
        const [bookings, doctors] = await Promise.all([
          listTodaysBookings(hospitalId, day),
          listHospitalDoctors(hospitalId),
        ]);
        if (!activeRef.current) return;
        const seen = new Set<string>();
        const sessions: Array<{ id: string; label: string }> = [];
        for (const b of bookings) {
          if (b.queue_session_id && !seen.has(b.queue_session_id)) {
            seen.add(b.queue_session_id);
            sessions.push({
              id: b.queue_session_id,
              label:
                b.token_number !== null
                  ? `Token ${b.token_number} · session ${b.queue_session_id.slice(0, 8)}`
                  : `Session ${b.queue_session_id.slice(0, 8)}`,
            });
          }
        }
        setSessionOptions(sessions);
        setSessionId((prev) => prev || sessions[0]?.id || "");
        setSessionsState("ready");
        setDoctorOptions(
          doctors.map((d) => ({ id: d.doctorId, label: d.label })),
        );
        setDoctorId((prev) => prev || doctors[0]?.doctorId || "");
        setDoctorsState("ready");
      } catch {
        if (activeRef.current) {
          setSessionsState("error");
          setDoctorsState("error");
        }
      }
    })();

    return () => {
      activeRef.current = false;
    };
  }, [hospitalId]);

  if (!hospitalId) {
    return (
      <p className="text-muted-foreground">
        No hospital tenant is attached to your account.
      </p>
    );
  }

  const onSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    void runSearch();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Audit &amp; Compliance</h1>
        <p className="text-sm text-muted-foreground">
          Read-only audit trail and integrity checks · {staff?.fullName} ·
          tenant <span className="font-mono">{hospitalId}</span>
        </p>
      </div>

      {/* ── Audit search ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Audit Trail Search</CardTitle>
          <CardDescription>
            Executive search over the tenant&apos;s audit log from the
            enterprise-reports read (the search itself is audited
            server-side). Every access is accountable.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={onSearchSubmit}>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Entity type</span>
              <Input
                value={entityType}
                onChange={(e) => setEntityType(e.target.value)}
                placeholder="booking"
                maxLength={64}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Action type</span>
              <Input
                value={actionType}
                onChange={(e) => setActionType(e.target.value)}
                placeholder="created"
                maxLength={64}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">Correlation id</span>
              <Input
                value={correlationId}
                onChange={(e) => setCorrelationId(e.target.value)}
                placeholder="trace correlation id"
                maxLength={128}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">From</span>
              <Input
                type="datetime-local"
                value={fromTs}
                onChange={(e) => setFromTs(e.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">To</span>
              <Input
                type="datetime-local"
                value={toTs}
                onChange={(e) => setToTs(e.target.value)}
              />
            </label>
            <div className="flex items-end gap-2">
              <Button type="submit" disabled={search.status === "loading"}>
                {search.status === "loading" ? "Searching…" : "Search"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={search.status === "loading"}
                onClick={() => {
                  setEntityType("");
                  setActionType("");
                  setCorrelationId("");
                  setFromTs(
                    toLocalInputValue(new Date(Date.now() - DEFAULT_FROM_DAYS * 86_400_000)),
                  );
                  setToTs(toLocalInputValue(new Date()));
                }}
              >
                Reset
              </Button>
            </div>
          </form>

          <SearchSection section={search} />
        </CardContent>
      </Card>

      {/* ── Tenant-wide compliance checks ───────────────────────────────── */}
      <CheckCard
        title="Audit Integrity"
        description="Referential sanity of the audit log for the last day: orphan actors and unregistered action types (verify_audit_integrity)."
        section={auditIntegrity}
        onRun={() => {
          setAuditIntegrity(LOADING);
          fetchAuditIntegrity(hospitalId)
            .then((d) => activeRef.current && setAuditIntegrity(succeeded(d)))
            .catch((e) => activeRef.current && setAuditIntegrity(failed(e)));
        }}
      >
        {(d) => (
          <>
            <Fact label="Total entries" value={display(d.result.total_entries)} />
            <Fact label="Orphan actors" value={display(d.result.orphan_actors)} />
            <Fact
              label="Registered action types"
              value={display(d.result.registered_action_types)}
            />
            <Fact
              label="Unknown action types"
              value={display(d.result.unknown_action_types)}
            />
          </>
        )}
      </CheckCard>

      <CheckCard
        title="Settlement Reconciliation Verdict"
        description="Whether every settlement total reconciles with its items (verify_settlement_integrity). This is a verdict, not a financial report."
        section={settlementIntegrity}
        onRun={() => {
          setSettlementIntegrity(LOADING);
          fetchSettlementIntegrity(hospitalId)
            .then((d) => activeRef.current && setSettlementIntegrity(succeeded(d)))
            .catch((e) => activeRef.current && setSettlementIntegrity(failed(e)));
        }}
      >
        {(d) => (
          <>
            <Fact label="Settlements checked" value={display(d.result.settlements_checked)} />
            <Fact label="Mismatches" value={display(d.result.mismatches.length)} />
            {d.result.mismatches.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Mismatched settlement ids:{" "}
                {d.result.mismatches.map((m) => m.settlement_id).join(", ")}
              </p>
            )}
          </>
        )}
      </CheckCard>

      <CheckCard
        title="Integration Matrix"
        description="Booking → collection → ledger chain for one hospital-day (verify_integration_matrix)."
        section={integrationMatrix}
        control={
          <label className="text-sm">
            <span className="mr-2 text-muted-foreground">Date</span>
            <Input
              type="date"
              value={matrixDate}
              onChange={(e) => setMatrixDate(e.target.value)}
              className="inline-block h-9 w-44"
            />
          </label>
        }
        onRun={() => {
          setIntegrationMatrix(LOADING);
          fetchIntegrationMatrix(hospitalId, matrixDate || undefined)
            .then((d) => activeRef.current && setIntegrationMatrix(succeeded(d)))
            .catch((e) => activeRef.current && setIntegrationMatrix(failed(e)));
        }}
      >
        {(d) => (
          <>
            <Fact
              label="Collections without booking"
              value={display(d.result.collections_without_booking)}
            />
            <Fact label="Ledger without source" value={display(d.result.ledger_without_source)} />
          </>
        )}
      </CheckCard>

      {/* ── Targeted checks ─────────────────────────────────────────────── */}
      <CheckCard
        title="Queue Session Integrity"
        description="Cross-hospital bookings, duplicate tokens and parallel consultations for one queue session (verify_queue_integrity)."
        section={queueIntegrity}
        control={
          sessionsState === "error" ? (
            <p role="alert" className="text-sm text-destructive">
              Today&apos;s sessions could not be listed.
            </p>
          ) : (
            <label className="text-sm">
              <span className="mr-2 text-muted-foreground">Session</span>
              <select
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                disabled={sessionsState === "loading" || sessionOptions.length === 0}
                className="h-9 w-72 rounded-md border border-input bg-background px-3 text-sm"
              >
                {sessionsState === "loading" ? (
                  <option value="">Loading…</option>
                ) : sessionOptions.length === 0 ? (
                  <option value="">No queue sessions today</option>
                ) : (
                  sessionOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))
                )}
              </select>
            </label>
          )
        }
        runDisabled={sessionId === ""}
        onRun={() => {
          setQueueIntegrity(LOADING);
          fetchQueueIntegrity(hospitalId, sessionId)
            .then((d) => activeRef.current && setQueueIntegrity(succeeded(d)))
            .catch((e) => activeRef.current && setQueueIntegrity(failed(e)));
        }}
      >
        {(d) => (
          <>
            <Fact
              label="Cross-hospital bookings"
              value={display(d.result.cross_hospital_bookings)}
            />
            <Fact label="Duplicate tokens" value={display(d.result.duplicate_tokens)} />
            <Fact
              label="Parallel consultations"
              value={display(d.result.parallel_consultations)}
            />
          </>
        )}
      </CheckCard>

      <CheckCard
        title="Doctor Operations Integrity"
        description="Timestamp ordering and completion consistency for one doctor-day (verify_doctor_operations_integrity)."
        section={doctorOpsIntegrity}
        control={
          doctorsState === "error" ? (
            <p role="alert" className="text-sm text-destructive">
              The doctor directory could not be listed.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm">
                <span className="mr-2 text-muted-foreground">Doctor</span>
                <select
                  value={doctorId}
                  onChange={(e) => setDoctorId(e.target.value)}
                  disabled={doctorsState === "loading" || doctorOptions.length === 0}
                  className="h-9 w-60 rounded-md border border-input bg-background px-3 text-sm"
                >
                  {doctorsState === "loading" ? (
                    <option value="">Loading…</option>
                  ) : doctorOptions.length === 0 ? (
                    <option value="">No doctors found</option>
                  ) : (
                    doctorOptions.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <label className="text-sm">
                <span className="mr-2 text-muted-foreground">Date</span>
                <Input
                  type="date"
                  value={doctorDate}
                  onChange={(e) => setDoctorDate(e.target.value)}
                  className="inline-block h-9 w-44"
                />
              </label>
            </div>
          )
        }
        runDisabled={doctorId === ""}
        onRun={() => {
          setDoctorOpsIntegrity(LOADING);
          fetchDoctorOpsIntegrity(hospitalId, doctorId, doctorDate || undefined)
            .then((d) => activeRef.current && setDoctorOpsIntegrity(succeeded(d)))
            .catch((e) => activeRef.current && setDoctorOpsIntegrity(failed(e)));
        }}
      >
        {(d) => (
          <>
            <Fact
              label="Timestamp order violations"
              value={display(d.result.timestamp_order_violations)}
            />
            <Fact
              label="Completed without timestamp"
              value={display(d.result.completed_without_timestamp)}
            />
          </>
        )}
      </CheckCard>
    </div>
  );
}

// ─── Audit search results ────────────────────────────────────────────────────

function SearchSection({
  section,
}: {
  section: Section<AuditSearchResponseBody>;
}) {
  if (section.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (section.status === "error") {
    // Honest failure: an error is never dressed up as “no data”.
    return (
      <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
        {section.error}
      </p>
    );
  }
  // entries is typed non-null by the RPC (COALESCE to []), but a degraded
  // payload must not crash the surface.
  const entries: AuditEntry[] = section.data?.results?.entries ?? [];
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No audit entries match this window. An empty result is not an error —
        the backend searched the last window and found nothing.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <THead>
          <TR>
            <TH>Time</TH>
            <TH>Actor</TH>
            <TH>Entity</TH>
            <TH>Action</TH>
            <TH>Severity</TH>
            <TH>Correlation</TH>
            <TH>Notes</TH>
          </TR>
        </THead>
        <TBody>
          {entries.map((a, i) => (
            <TR key={`${a.id}-${i}`}>
              <TD className="whitespace-nowrap">{displayTs(a.created_at)}</TD>
              <TD className="font-mono text-xs text-muted-foreground">
                {a.actor_user_id ? `${a.actor_user_id.slice(0, 8)}…` : "system"}
              </TD>
              <TD>
                {display(a.entity_type)}
                {a.entity_id ? (
                  <span className="ml-1 font-mono text-xs text-muted-foreground">
                    {a.entity_id.slice(0, 8)}
                  </span>
                ) : null}
              </TD>
              <TD>{display(a.action_type)}</TD>
              <TD>
                <Badge variant={SEVERITY_VARIANT[a.action_severity] ?? "secondary"}>
                  {display(a.action_severity)}
                </Badge>
              </TD>
              <TD className="font-mono text-xs text-muted-foreground">
                {/* correlationId lives in the metadata JSONB; only the known
                    string field is surfaced, never the whole object. */}
                {typeof a.metadata?.correlationId === "string"
                  ? a.metadata.correlationId
                  : "—"}
              </TD>
              <TD className="max-w-[16rem] truncate text-muted-foreground">
                {typeof a.notes === "string" && a.notes ? a.notes : "—"}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

// ─── Compliance-check card shell ─────────────────────────────────────────────

function CheckCard<T>({
  title,
  description,
  section,
  control,
  runDisabled,
  onRun,
  children,
}: {
  title: string;
  description: string;
  section: Section<T>;
  control?: ReactNode;
  runDisabled?: boolean;
  onRun: () => void;
  children: (data: T) => ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {control}
          <Button size="sm" disabled={runDisabled || section.status === "loading"} onClick={onRun}>
            {section.status === "loading" ? "Running…" : "Run check"}
          </Button>
        </div>
        {section.status === "idle" ? (
          <p className="text-sm text-muted-foreground">Not run yet.</p>
        ) : section.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Running…</p>
        ) : section.status === "error" ? (
          <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {section.error}
          </p>
        ) : (
          <div className="space-y-3">
            <VerdictBadge ok={(section.data as T & { result: { ok: boolean } }).result?.ok} />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {children(section.data as T)}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function VerdictBadge({ ok }: { ok: boolean | undefined }) {
  if (ok === undefined) return null;
  return ok ? (
    <Badge variant="success">Verdict: intact</Badge>
  ) : (
    <Badge variant="destructive">Verdict: violations found</Badge>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
