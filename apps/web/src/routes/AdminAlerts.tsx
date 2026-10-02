import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  fetchActingHospitalContext,
  type ActingHospitalContext,
} from "@/api/portfolio";
import {
  acknowledgeAlert,
  escalateAlert,
  fetchAlertAnalytics,
  fetchAlertCenter,
  resolveAlert,
  suppressAlert,
} from "@/api/alertCenter";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { describeError } from "@/lib/errors";
import {
  activeUntilError,
  alertKeyError,
  alertNotesError,
  canAcknowledge,
  canEscalate,
  canResolve,
  isAlreadyAck,
  lifecycleOutcomeLabel,
  suppressReasonError,
  toIsoDateTime,
} from "@/lib/alertLifecycle";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type {
  AlertAnalyticsData,
  AlertCenterData,
  AlertEventRow,
  AlertSeverity,
} from "@/types/api";

/**
 * Alert-Center Admin Surface (Phase 7 G-10 read + G-UI lifecycle mutations) — a
 * hospital-admin / global-admin view over the EXISTING `alert-center` Edge
 * Function: its two aggregate reads (`list` and `analytics`) plus the four admin
 * lifecycle mutations the backend already implements (`acknowledge`, `resolve`,
 * `escalate`, `suppress`).
 *
 * The browser is a presentation + orchestration layer only (§16/§11). Nothing
 * here counts alerts, groups them, derives a resolution rate or reconstructs a
 * trend — every statistic is aggregated server-side (`get_alert_center` /
 * `get_alert_analytics`) and returned verbatim, and the `counts` / `summary`
 * blocks are the SERVER's tallies, never `alerts.length`. Likewise no lifecycle
 * transition is computed in the browser: each mutation is a single POST to the
 * existing function, whose SECURITY DEFINER RPCs (migration 64) own the state
 * guard, the soft `already_*` replay and the activity log.
 *
 * Server-authoritative UI (§11): after EVERY mutation attempt — success, soft
 * `already_*` replay or rejection — the page refetches the server's own read
 * (`reconcile`) and renders that. It never manufactures a local `is_resolved =
 * true` / `acknowledged_at = now()` and treats it as truth. Suppression applies
 * to an alert KEY + window (§14), never to one row's lifecycle fields.
 *
 * Authorization is NOT a client concern (§9/§20): the mutation controls render
 * only for `hospital_admin` / `global_admin` as a convenience; the Edge Function
 * re-authorizes role + tenant on every call, so a request that somehow reaches
 * it unauthorized is answered 401/403 server-side and surfaced honestly here.
 * Hiding a button is never the security boundary.
 *
 * Soft success (§12): HTTP 200 + `result.ok` with an `already_*` flag is a
 * SUCCESSFUL idempotent outcome, not an error — it shows an informational
 * message and reconciles, never a retry and never a generic error.
 *
 * Duplicate-submit protection (§13) is UI-level only: `useAsyncAction` disables
 * the control and swallows a second in-flight click. No Idempotency-Key is sent
 * (the endpoint does not read it and owns replay safety intrinsically).
 *
 * Truthfulness (§13/§18): a `0` renders as `0` (never `—`) and an absent value
 * renders as `—` (never a fabricated `0`); an HTTP failure is an error, never
 * dressed up as an empty success; a legitimately empty `alerts` array shows
 * "No alerts found." rather than invented rows.
 *
 * Bounded network (§30): exactly one read cycle per action on an explicit load
 * or Refresh and one reconcile cycle per mutation, never on a keystroke, poll or
 * interval; a StrictMode remount cannot double-fire the initial load.
 *
 * Security (§20/§29): the user JWT + session `X-Hospital-ID` header go to the
 * Edge Function; a browser can never reach the alert RPCs directly; no hospital
 * id is ever placed in a mutation body. A `global_admin` whose own account
 * carries no tenant reuses the established G-08 bounded acting-context mechanism
 * — inventing nothing, and the acting scope is disclosed rather than hidden.
 */

type SectionStatus = "idle" | "loading" | "success" | "error";

/** Roles `alert-center` admits its mutations to via `requireRole`. Rendering the
 *  controls for them is a UX convenience only — the Edge Function re-authorizes
 *  every call, so this list is NEVER the security boundary. */
const MUTATION_ROLES: readonly (string | null)[] = [
  "hospital_admin",
  "global_admin",
];

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

/**
 * Honest scalar rendering: a number stays a number (so `0` never becomes `—`),
 * NUMERIC may arrive as a string, and absence or a non-finite value renders as
 * an em dash rather than a fabricated figure. Explicit null checks only —
 * never `v || "—"` (§13/§18).
 */
function display(v: number | string | boolean | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : v;
}

// Presentation-only severity → badge colour (a real Badge variant, not a
// computed value). It never re-derives anything from the alert data.
const SEVERITY_TONE: Record<
  AlertSeverity,
  "secondary" | "warning" | "destructive"
> = {
  info: "secondary",
  warning: "warning",
  critical: "destructive",
};

/** A labelled value tile. `value` is already a display string from the caller. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
    >
      {message}
    </p>
  );
}

export function AdminAlerts() {
  const { staff, hospitalId } = useAuth();
  const isGlobalAdmin = staff?.role === "global_admin";
  // Render-convenience gate for the mutation controls ONLY (§9). The Edge
  // Function re-authorizes role + tenant on every call and remains the sole
  // security boundary; a foreign/unauthorized request surfaces as a handled
  // 401/403 rather than being prevented here.
  const canMutate = MUTATION_ROLES.includes(staff?.role ?? null);

  const [center, setCenter] = useState<Section<AlertCenterData | null>>(IDLE);
  const [analytics, setAnalytics] =
    useState<Section<AlertAnalyticsData | null>>(IDLE);

  // Optional filter / window overrides. EMPTY means "let the backend default
  // apply"; they are read at load time (never trigger a fetch on change, §30).
  const [status, setStatus] = useState("");
  const [severity, setSeverity] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const filtersRef = useRef({ status, severity, fromDate, toDate });
  filtersRef.current = { status, severity, fromDate, toDate };

  const activeRef = useRef(true);
  const didInitialLoadRef = useRef(false);

  // The bounded acting context, resolved only when the account itself has no
  // tenant (the seeded `global_admin` reality) — the established G-08
  // mechanism, reused verbatim rather than re-invented (§20).
  const [acting, setActing] = useState<ActingHospitalContext | null>(null);
  const [actingError, setActingError] = useState<string | null>(null);
  const actingAttemptedRef = useRef(false);
  const scopeHospitalId = hospitalId ?? acting?.hospitalId ?? null;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isGlobalAdmin || hospitalId || actingAttemptedRef.current) return;
    actingAttemptedRef.current = true;
    fetchActingHospitalContext()
      .then((ctx) => {
        if (!activeRef.current) return;
        if (ctx) setActing(ctx);
        else {
          setActingError(
            "No hospital exists to satisfy the required context.",
          );
        }
      })
      .catch((e) => {
        if (activeRef.current) setActingError(describeError(e));
      });
  }, [isGlobalAdmin, hospitalId]);

  const load = useCallback(async () => {
    if (!scopeHospitalId) return;
    const f = filtersRef.current;
    setCenter(LOADING);
    setAnalytics(LOADING);

    // Two independent reads → two independent outcomes, one request each, with
    // absent filters/dates OMITTED so the backend's own defaults apply (§17).
    const [rCenter, rAnalytics] = await Promise.allSettled([
      fetchAlertCenter(scopeHospitalId, {
        status: (f.status || undefined) as
          | "open"
          | "all"
          | "resolved"
          | undefined,
        severity: (f.severity || undefined) as
          | "info"
          | "warning"
          | "critical"
          | undefined,
      }),
      fetchAlertAnalytics(scopeHospitalId, {
        fromDate: f.fromDate || undefined,
        toDate: f.toDate || undefined,
      }),
    ]);

    if (!activeRef.current) return;

    setCenter(
      rCenter.status === "fulfilled"
        ? succeeded(rCenter.value.center)
        : failed(rCenter.reason),
    );
    setAnalytics(
      rAnalytics.status === "fulfilled"
        ? succeeded(rAnalytics.value.analytics)
        : failed(rAnalytics.reason),
    );
  }, [scopeHospitalId]);

  // Initial load happens once the scope is known — and, guarded by
  // didInitialLoadRef, at most once even across a StrictMode remount (§30).
  useEffect(() => {
    if (!scopeHospitalId || didInitialLoadRef.current) return;
    didInitialLoadRef.current = true;
    void load();
  }, [scopeHospitalId, load]);

  /**
   * Reconcile after a mutation (§11). This is the server-authoritative refresh:
   * it re-runs the SAME two reads the page already owns (so `counts` and the
   * analytics the lifecycle affects are recomputed by the server, not locally
   * patched) but, unlike `load`, it never drops to the LOADING blank state —
   * the current rows stay on screen until the fresh server data replaces them,
   * so an in-flight outcome message is not flashed away. On a fulfilled read the
   * section shows the NEW server state; on a failed read it shows the honest
   * error. Nothing is invented or optimistically mutated in between.
   */
  const reconcile = useCallback(async () => {
    if (!scopeHospitalId) return;
    const f = filtersRef.current;
    const [rCenter, rAnalytics] = await Promise.allSettled([
      fetchAlertCenter(scopeHospitalId, {
        status: (f.status || undefined) as
          | "open"
          | "all"
          | "resolved"
          | undefined,
        severity: (f.severity || undefined) as
          | "info"
          | "warning"
          | "critical"
          | undefined,
      }),
      fetchAlertAnalytics(scopeHospitalId, {
        fromDate: f.fromDate || undefined,
        toDate: f.toDate || undefined,
      }),
    ]);

    if (!activeRef.current) return;

    if (rCenter.status === "fulfilled") {
      setCenter(succeeded(rCenter.value.center));
    } else {
      setCenter(failed(rCenter.reason));
    }
    if (rAnalytics.status === "fulfilled") {
      setAnalytics(succeeded(rAnalytics.value.analytics));
    } else {
      setAnalytics(failed(rAnalytics.reason));
    }
  }, [scopeHospitalId]);

  if (!scopeHospitalId) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Alert Center</h1>
        {actingError ? (
          <ErrorBanner message={actingError} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Waiting for the hospital context the alert service requires on every
            request. No alerts are shown.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            Alert Center <span className="text-sm font-normal text-muted-foreground">— Read + Admin Actions</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            {staff?.fullName} · every alert row and statistic is aggregated
            server-side by the existing alert-center reads and rendered verbatim;
            nothing is counted, grouped or re-derived in the browser. Hospital
            admins and global admins may acknowledge, resolve, escalate or
            suppress through the existing alert-center function — the backend
            owns the transition, the tenant check and the audit, and the page
            always re-reads the server's authoritative state after each action.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Request context sent as the required tenant header:{" "}
            <span className="font-mono">{scopeHospitalId}</span>
            {acting
              ? " — your account has no hospital of its own, so this one is used only to satisfy the header; the alerts below are scoped to it."
              : " — taken from your session."}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={
            center.status === "loading" || analytics.status === "loading"
          }
          onClick={() => void load()}
        >
          Refresh
        </Button>
      </div>

      {/* Optional filters + window. Empty = backend default; changes take effect
          on the next explicit Refresh, never automatically (§17/§30). */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-5">
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              Alert status
            </span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-9 w-40 rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="">Default (open)</option>
              <option value="open">Open</option>
              <option value="all">All</option>
              <option value="resolved">Resolved</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              Severity
            </span>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              className="h-9 w-40 rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="">All severities</option>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              Analytics from
            </span>
            <Input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-9 w-44"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              Analytics to
            </span>
            <Input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="h-9 w-44"
            />
          </label>
          <p className="pb-2 text-xs text-muted-foreground">
            Leave a control empty to use the server default. Press Refresh to
            apply any change.
          </p>
        </CardContent>
      </Card>

      <AlertListCard
        section={center}
        hospitalId={scopeHospitalId}
        canMutate={canMutate}
        onReconcile={reconcile}
      />
      <AnalyticsCard section={analytics} />
    </div>
  );
}

// ─── A. Alert list ───────────────────────────────────────────────────────────

function AlertListCard({
  section,
  hospitalId,
  canMutate,
  onReconcile,
}: {
  section: Section<AlertCenterData | null>;
  hospitalId: string;
  canMutate: boolean;
  onReconcile: () => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>Alert Inbox</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px]">
            list
          </Badge>
        </div>
        <CardDescription>
          The alert-center snapshot with server-computed whole-tenant counts.
          {canMutate
            ? " Admin actions run the existing alert-center mutations; the page re-reads the server after each."
            : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {section.status === "idle" ? (
          <p className="text-sm text-muted-foreground">Not loaded yet.</p>
        ) : section.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading alerts…</p>
        ) : section.status === "error" ? (
          <ErrorBanner message={section.error ?? "Request failed."} />
        ) : !section.data ? (
          <p className="text-sm text-muted-foreground">
            No alert data available.
          </p>
        ) : (
          <AlertListView
            data={section.data}
            hospitalId={hospitalId}
            canMutate={canMutate}
            onReconcile={onReconcile}
          />
        )}
      </CardContent>
    </Card>
  );
}

function AlertListView({
  data,
  hospitalId,
  canMutate,
  onReconcile,
}: {
  data: AlertCenterData;
  hospitalId: string;
  canMutate: boolean;
  onReconcile: () => Promise<void>;
}) {
  const alerts = data.alerts ?? [];
  const counts = data.counts;
  return (
    <div className="space-y-5">
      {/* Server counts, never `alerts.length` (§16). */}
      <div>
        <h3 className="mb-2 text-sm font-semibold">Alert Counts (tenant-wide)</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Stat label="Open" value={display(counts.open)} />
          <Stat label="Acknowledged" value={display(counts.acknowledged)} />
          <Stat label="Escalated" value={display(counts.escalated)} />
          <Stat label="Critical open" value={display(counts.critical_open)} />
        </div>
      </div>

      {alerts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No alerts found.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Severity</TH>
                <TH>Key</TH>
                <TH>Category</TH>
                <TH>Message</TH>
                <TH>Status</TH>
                <TH>Created</TH>
                {canMutate && <TH>Actions</TH>}
              </TR>
            </THead>
            <TBody>
              {alerts.map((a) => (
                <AlertRow
                  key={a.id}
                  alert={a}
                  hospitalId={hospitalId}
                  canMutate={canMutate}
                  onReconcile={onReconcile}
                />
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/** Which inline mutation panel (if any) a row currently has open. */
type AlertPanel = null | "resolve" | "escalate" | "suppress";

function AlertRow({
  alert,
  hospitalId,
  canMutate,
  onReconcile,
}: {
  alert: AlertEventRow;
  hospitalId: string;
  canMutate: boolean;
  onReconcile: () => Promise<void>;
}) {
  const tone = SEVERITY_TONE[alert.severity] ?? "secondary";
  // A label over the server's own boolean — presentation, not a calculation.
  const state = alert.is_resolved ? "resolved" : "open";

  const [panel, setPanel] = useState<AlertPanel>(null);
  const [notes, setNotes] = useState("");
  const [supKey, setSupKey] = useState(alert.alert_key);
  const [activeUntil, setActiveUntil] = useState("");
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<string | null>(null);

  // Four independent mutation guards. Each mints a key that is deliberately NOT
  // forwarded (the endpoint does not read the header and owns replay safety
  // intrinsically) — the hook only supplies the running flag + double-submit
  // swallow + captured error (§13). One action at a time per row.
  const acknowledge = useAsyncAction(
    useCallback(
      (_key: string, id: string, tenant: string) => acknowledgeAlert(tenant, id),
      [],
    ),
  );
  const resolve = useAsyncAction(
    useCallback(
      (
        _key: string,
        id: string,
        tenant: string,
        note?: string,
      ) => resolveAlert(tenant, id, note),
      [],
    ),
  );
  const escalate = useAsyncAction(
    useCallback(
      (
        _key: string,
        id: string,
        tenant: string,
        note?: string,
      ) => escalateAlert(tenant, id, note),
      [],
    ),
  );
  const suppress = useAsyncAction(
    useCallback(
      (
        _key: string,
        tenant: string,
        alertKey: string,
        until: string,
        why?: string,
      ) =>
        suppressAlert(tenant, {
          alertKey,
          activeUntil: until,
          ...(why ? { reason: why } : {}),
        }),
      [],
    ),
  );

  // Action availability, derived ONLY from the server's own lifecycle fields
  // (D1: they are independent). A field already set would only ever return an
  // `already_*` replay, so its control is hidden — never a re-invented state
  // machine or a claim about any other field.
  const offerAck = canAcknowledge(alert);
  const offerResolve = canResolve(alert);
  const offerEscalate = canEscalate(alert);

  // Any of the four hooks in flight for this row: a deliberate guard so opening
  // or submitting one panel cannot race a second submission from the same row.
  const busy =
    acknowledge.running ||
    resolve.running ||
    escalate.running ||
    suppress.running;

  const closePanel = useCallback(() => {
    setPanel(null);
    setNotes("");
    setActiveUntil("");
    setReason("");
  }, []);

  const submitAcknowledge = useCallback(async () => {
    setOutcome(null);
    const res = await acknowledge.run(alert.id, hospitalId);
    if (res) {
      setOutcome(
        lifecycleOutcomeLabel(
          "acknowledge",
          isAlreadyAck("acknowledge", res.result),
        ),
      );
    }
    await onReconcile();
  }, [acknowledge, alert.id, hospitalId, onReconcile]);

  const submitNotes = useCallback(
    async (action: "resolve" | "escalate") => {
      if (alertNotesError(notes)) return; // defensive: button disabled
      setOutcome(null);
      const trimmed = notes.trim() ? notes : undefined;
      const hook = action === "resolve" ? resolve : escalate;
      const res = await hook.run(alert.id, hospitalId, trimmed);
      if (res) {
        setOutcome(
          lifecycleOutcomeLabel(action, isAlreadyAck(action, res.result)),
        );
      }
      closePanel();
      await onReconcile();
    },
    [notes, resolve, escalate, alert.id, hospitalId, closePanel, onReconcile],
  );

  const submitSuppress = useCallback(async () => {
    if (alertKeyError(supKey) || activeUntilError(activeUntil) || suppressReasonError(reason)) {
      return; // defensive: button disabled
    }
    setOutcome(null);
    const res = await suppress.run(
      hospitalId,
      supKey,
      toIsoDateTime(activeUntil),
      reason.trim() ? reason : undefined,
    );
    if (res) {
      setOutcome(
        `Suppression window opened for key ${supKey} until ${new Date(
          toIsoDateTime(activeUntil),
        ).toLocaleString()}.`,
      );
    }
    closePanel();
    await onReconcile();
  }, [
    supKey,
    activeUntil,
    reason,
    suppress,
    hospitalId,
    closePanel,
    onReconcile,
  ]);

  const openPanel = useCallback(
    (next: Exclude<AlertPanel, null>) => {
      setOutcome(null);
      setNotes("");
      setSupKey(alert.alert_key);
      setActiveUntil("");
      setReason("");
      setPanel(next);
    },
    [alert.alert_key],
  );

  const actionError =
    acknowledge.error ??
    resolve.error ??
    escalate.error ??
    suppress.error ??
    null;

  const span = canMutate ? 7 : 6;

  return (
    <>
      <TR>
        <TD className="align-top">
          <Badge variant={tone}>
            {alert.severity}
          </Badge>
        </TD>
        <TD className="align-top font-mono text-xs">{display(alert.alert_key)}</TD>
        <TD className="align-top">{display(alert.alert_category)}</TD>
        <TD className="align-top">{alert.message}</TD>
        <TD className="align-top space-y-1">
          <div>{state}</div>
          {/* Independent lifecycle state, read straight from the server fields
              (not a derived status). Presented so the admin sees the current
              state, never recomputed (§16). */}
          <div className="flex flex-wrap gap-1">
            {alert.acknowledged_at !== null && (
              <Badge variant="secondary" className="text-[10px]">
                acknowledged
              </Badge>
            )}
            {alert.escalated_at !== null && (
              <Badge variant="secondary" className="text-[10px]">
                escalated
              </Badge>
            )}
          </div>
        </TD>
        <TD className="align-top font-mono text-xs">{display(alert.created_at)}</TD>
        {canMutate && (
          <TD className="align-top">
            <div className="flex flex-wrap gap-1">
              {offerAck && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void submitAcknowledge()}
                  aria-label={`Acknowledge alert ${alert.alert_key}`}
                >
                  {acknowledge.running ? "Acknowledging…" : "Acknowledge"}
                </Button>
              )}
              {offerResolve && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => openPanel("resolve")}
                  aria-label={`Resolve alert ${alert.alert_key}`}
                >
                  Resolve
                </Button>
              )}
              {offerEscalate && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => openPanel("escalate")}
                  aria-label={`Escalate alert ${alert.alert_key}`}
                >
                  Escalate
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => openPanel("suppress")}
                aria-label={`Suppress alerts for key ${alert.alert_key}`}
              >
                Suppress
              </Button>
              {!offerAck && !offerResolve && !offerEscalate && (
                <span className="text-xs text-muted-foreground">
                  No lifecycle action left
                </span>
              )}
            </div>
            {outcome && (
              <p
                role="status"
                className="mt-1 rounded-md bg-muted p-2 text-xs"
              >
                {outcome}
              </p>
            )}
            {actionError && (
              <p
                role="alert"
                className="mt-1 rounded-md bg-destructive/10 p-2 text-xs text-destructive"
              >
                {describeError(actionError)}
              </p>
            )}
          </TD>
        )}
      </TR>
      {canMutate && panel !== null && (
        <TR>
          <TD colSpan={span} className="bg-muted/30">
            <div className="space-y-2 p-1">
              <p className="text-sm font-medium">
                {panel === "resolve"
                  ? "Resolve this alert"
                  : panel === "escalate"
                    ? "Escalate this alert (raises severity to critical)"
                    : "Suppress alerts for this key"}
              </p>
              <p className="text-xs text-muted-foreground">
                {panel === "suppress"
                  ? "Suppression pauses firing for the whole alert key across a window; it does not change this single row's lifecycle. Overlapping windows are not deduplicated, so submit deliberately — a rejected window is never auto-retried."
                  : "Notes are optional (max 1000 characters) and recorded on the alert activity log. The backend re-checks role, tenant and the current state before it changes anything, and this page re-reads the server afterward."}
              </p>

              {panel !== "suppress" && (
                <div className="space-y-1">
                  <Label htmlFor={`${alert.id}-notes`}>
                    Notes (optional)
                  </Label>
                  <Textarea
                    id={`${alert.id}-notes`}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Optional context for the audit record"
                    disabled={busy}
                  />
                  {notes.length > 0 && alertNotesError(notes) && (
                    <p role="alert" className="text-xs text-destructive">
                      {alertNotesError(notes)}
                    </p>
                  )}
                </div>
              )}

              {panel === "suppress" && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor={`${alert.id}-key`}>Alert key</Label>
                    <Input
                      id={`${alert.id}-key`}
                      value={supKey}
                      onChange={(e) => setSupKey(e.target.value)}
                      disabled={busy}
                      className="h-9 font-mono text-xs"
                    />
                    {alertKeyError(supKey) && (
                      <p role="alert" className="text-xs text-destructive">
                        {alertKeyError(supKey)}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${alert.id}-until`}>Suppress until</Label>
                    <Input
                      id={`${alert.id}-until`}
                      type="datetime-local"
                      value={activeUntil}
                      onChange={(e) => setActiveUntil(e.target.value)}
                      disabled={busy}
                      className="h-9"
                    />
                    {activeUntil && activeUntilError(activeUntil) && (
                      <p role="alert" className="text-xs text-destructive">
                        {activeUntilError(activeUntil)}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${alert.id}-reason`}>
                      Reason (optional)
                    </Label>
                    <Textarea
                      id={`${alert.id}-reason`}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Why is this alert key being suppressed?"
                      disabled={busy}
                    />
                    {reason.length > 0 && suppressReasonError(reason) && (
                      <p role="alert" className="text-xs text-destructive">
                        {suppressReasonError(reason)}
                      </p>
                    )}
                  </div>
                </>
              )}

              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={
                    busy ||
                    (panel === "suppress"
                      ? !!alertKeyError(supKey) ||
                        !!activeUntilError(activeUntil) ||
                        !!suppressReasonError(reason)
                      : !!alertNotesError(notes)) ||
                    (panel === "resolve"
                      ? resolve.running
                      : panel === "escalate"
                        ? escalate.running
                        : suppress.running)
                  }
                  onClick={() =>
                    void (
                      panel === "suppress"
                        ? submitSuppress()
                        : submitNotes(panel)
                    )
                  }
                >
                  {panel === "suppress"
                    ? suppress.running
                      ? "Suppressing…"
                      : "Confirm suppression"
                    : panel === "resolve"
                      ? resolve.running
                        ? "Resolving…"
                        : "Confirm resolve"
                      : escalate.running
                        ? "Escalating…"
                        : "Confirm escalate"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={closePanel}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </TD>
        </TR>
      )}
    </>
  );
}

// ─── B. Analytics ────────────────────────────────────────────────────────────

function AnalyticsCard({
  section,
}: {
  section: Section<AlertAnalyticsData | null>;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>Alert Analytics</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px]">
            analytics
          </Badge>
        </div>
        <CardDescription>
          Volume and resolution statistics computed server-side (trailing 30
          days by default).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {section.status === "idle" ? (
          <p className="text-sm text-muted-foreground">Not loaded yet.</p>
        ) : section.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading analytics…</p>
        ) : section.status === "error" ? (
          <ErrorBanner message={section.error ?? "Request failed."} />
        ) : !section.data ? (
          <p className="text-sm text-muted-foreground">
            No analytics available.
          </p>
        ) : (
          <AnalyticsView data={section.data} />
        )}
      </CardContent>
    </Card>
  );
}

function AnalyticsView({ data }: { data: AlertAnalyticsData }) {
  const byKey = data.by_alert_key ?? [];
  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-2 text-sm font-semibold">Summary</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Total" value={display(data.summary.total)} />
          <Stat label="Resolved" value={display(data.summary.resolved)} />
          <Stat
            label="Avg resolution (min)"
            value={display(data.summary.avg_resolution_minutes)}
          />
        </div>
      </div>

      {byKey.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No alerts in this window.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Alert key</TH>
                <TH>Total</TH>
                <TH>Resolved</TH>
                <TH>Avg resolution (min)</TH>
              </TR>
            </THead>
            <TBody>
              {byKey.map((k) => (
                <TR key={k.alert_key}>
                  <TD className="align-top font-mono text-xs">
                    {display(k.alert_key)}
                  </TD>
                  <TD className="align-top">{display(k.total)}</TD>
                  <TD className="align-top">{display(k.resolved)}</TD>
                  <TD className="align-top">
                    {display(k.avg_resolution_minutes)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}
