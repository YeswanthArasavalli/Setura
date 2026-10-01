import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  fetchActingHospitalContext,
  type ActingHospitalContext,
} from "@/api/portfolio";
import { fetchDailyOperations, fetchDoctorRankings } from "@/api/operations";
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
  DailyOperationsDashboard,
  DoctorRankingsData,
} from "@/types/api";

/**
 * Hospital Operations Analytics Read Surface (Phase 7 G-11) — a strictly
 * READ-ONLY hospital-admin / global-admin view over the two EXISTING
 * tenant-scoped `executive-analytics` read actions (`daily_operations` and
 * `doctor_rankings`).
 *
 * The browser is a presentation layer only (§12/§13). Nothing here counts a
 * booking, derives a rate or trend, re-sorts a ranking or computes a score —
 * every number on the page is a value the SQL layer already aggregated
 * server-side (migration 47, privilege-hardened 49) and the Edge Function
 * returned verbatim. The rankings render in the server's own order with the
 * server's own `throughput_rank` / `efficiency_rank`; the console never
 * re-ranks by a client-invented metric.
 *
 * Truthfulness (§16/§17): a real `0` renders as `0` (never `—`) and an absent
 * value renders as `—` (never a fabricated `0`); a failed read is an error,
 * never dressed up as an empty success, and an empty successful result says
 * so honestly. `display()` uses explicit null checks, never `value || "—"`.
 *
 * Date model (§14) mirrors the backend exactly: `daily_operations` takes ONE
 * optional day and `doctor_rankings` an optional from/to window. Inputs
 * default EMPTY so the RPC's own `CURRENT_DATE` / trailing-30-day defaults
 * apply — the console never substitutes the browser's local day. Changes are
 * applied only on an explicit Refresh, never per keystroke.
 *
 * Bounded network (§15): exactly one read cycle per action on an explicit
 * load, never on a keystroke, poll or interval; a manual Refresh performs one
 * bounded cycle, and a StrictMode remount cannot double-fire the initial load.
 *
 * Security (§18/§19): the user JWT + session `X-Hospital-ID` header go to the
 * Edge Function, which re-authorizes role + tenant before any service-role RPC
 * runs; a browser can never reach the analytics RPCs directly. Both actions
 * are tenant-scoped — this surface performs NO cross-hospital aggregation
 * (`GLOBAL_ACTIONS` are G-08's and are not reachable from here). A
 * `global_admin` whose own account carries no tenant reuses the established
 * G-08/G-09 bounded acting-context mechanism — invented nothing, and the
 * acting scope is disclosed rather than hidden.
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

/**
 * Honest scalar rendering: a number stays a number (so `0` never becomes
 * `—`), NUMERIC may arrive as a string, and absence or a non-finite value
 * renders as an em dash rather than a fabricated figure. Explicit null checks
 * only — never `v || "—"` (§17).
 */
function display(v: number | string | boolean | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : v;
}

/** The server's ISO weekday (1 = Monday … 7 = Sunday), labelled not recomputed. */
const WEEKDAY_LABELS = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
] as const;

function weekdayLabel(w: number): string {
  return WEEKDAY_LABELS[w - 1] ?? String(w);
}

/** A labelled value tile. `raw` values are already formatted by the caller. */
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

export function AdminOperations() {
  const { staff, hospitalId } = useAuth();
  const isGlobalAdmin = staff?.role === "global_admin";

  const [daily, setDaily] =
    useState<Section<DailyOperationsDashboard | null>>(IDLE);
  const [rankings, setRankings] =
    useState<Section<DoctorRankingsData | null>>(IDLE);

  // Optional date overrides. EMPTY means "let the backend default apply";
  // they are read at load time (never trigger a fetch on keystroke, §14/§15).
  const [dailyDate, setDailyDate] = useState("");
  const [rankFrom, setRankFrom] = useState("");
  const [rankTo, setRankTo] = useState("");
  const datesRef = useRef({ dailyDate, rankFrom, rankTo });
  datesRef.current = { dailyDate, rankFrom, rankTo };

  const activeRef = useRef(true);
  const didInitialLoadRef = useRef(false);

  // The bounded acting context, resolved only when the account itself has no
  // tenant (the seeded `global_admin` reality) — the established G-08/G-09
  // mechanism, reused verbatim rather than re-invented (§18).
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
        else setActingError("No hospital exists to satisfy the required context.");
      })
      .catch((e) => {
        if (activeRef.current) setActingError(describeError(e));
      });
  }, [isGlobalAdmin, hospitalId]);

  const load = useCallback(async () => {
    if (!scopeHospitalId) return;
    const d = datesRef.current;
    setDaily(LOADING);
    setRankings(LOADING);

    // Two independent reads → two independent outcomes, one request each,
    // with absent dates OMITTED so the backend's own defaults apply (§14).
    const [rDaily, rRankings] = await Promise.allSettled([
      fetchDailyOperations(scopeHospitalId, {
        date: d.dailyDate || undefined,
      }),
      fetchDoctorRankings(scopeHospitalId, {
        fromDate: d.rankFrom || undefined,
        toDate: d.rankTo || undefined,
      }),
    ]);

    if (!activeRef.current) return;

    setDaily(
      rDaily.status === "fulfilled"
        ? succeeded(rDaily.value.dashboard)
        : failed(rDaily.reason),
    );
    setRankings(
      rRankings.status === "fulfilled"
        ? succeeded(rRankings.value.rankings)
        : failed(rRankings.reason),
    );
  }, [scopeHospitalId]);

  // Initial load happens once the scope is known — and, guarded by
  // didInitialLoadRef, at most once even across a StrictMode remount (§15).
  useEffect(() => {
    if (!scopeHospitalId || didInitialLoadRef.current) return;
    didInitialLoadRef.current = true;
    void load();
  }, [scopeHospitalId, load]);

  if (!scopeHospitalId) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Operations Analytics</h1>
        {actingError ? (
          <ErrorBanner message={actingError} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Waiting for the hospital context the analytics service requires on
            every request. No analytics data is shown.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Operations Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Read-only view · {staff?.fullName} · every metric is aggregated
            server-side by the existing tenant-scoped executive-analytics reads
            and rendered verbatim. Nothing here is counted, ranked or re-derived
            in the browser.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Tenant-scoped to the request context sent as the required header:{" "}
            <span className="font-mono">{scopeHospitalId}</span>
            {acting
              ? " — your account has no hospital of its own, so this one is used only to satisfy the header; the figures below are scoped to it."
              : " — taken from your session."}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={
            daily.status === "loading" || rankings.status === "loading"
          }
          onClick={() => void load()}
        >
          Refresh
        </Button>
      </div>

      {/* Optional date controls. Empty = backend default; changes take effect
          on the next explicit Refresh, never automatically (§14/§15). */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-5">
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              Daily operations date
            </span>
            <Input
              type="date"
              value={dailyDate}
              onChange={(e) => setDailyDate(e.target.value)}
              className="h-9 w-44"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              Rankings from
            </span>
            <Input
              type="date"
              value={rankFrom}
              onChange={(e) => setRankFrom(e.target.value)}
              className="h-9 w-44"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              Rankings to
            </span>
            <Input
              type="date"
              value={rankTo}
              onChange={(e) => setRankTo(e.target.value)}
              className="h-9 w-44"
            />
          </label>
          <p className="pb-2 text-xs text-muted-foreground">
            Leave a date empty to use the server default. Press Refresh to
            apply any change.
          </p>
        </CardContent>
      </Card>

      <DailyOperationsCard section={daily} />
      <DoctorRankingsCard section={rankings} />
    </div>
  );
}

// ─── A. Daily operations ─────────────────────────────────────────────────────

function DailyOperationsCard({
  section,
}: {
  section: Section<DailyOperationsDashboard | null>;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>Hospital Operations</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px]">
            daily_operations
          </Badge>
        </div>
        <CardDescription>
          Hourly trend, operation rates and SLA for one hospital-day,
          aggregated server-side.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {section.status === "idle" ? (
          <p className="text-sm text-muted-foreground">Not loaded yet.</p>
        ) : section.status === "loading" ? (
          <p className="text-sm text-muted-foreground">
            Loading daily operations…
          </p>
        ) : section.status === "error" ? (
          <ErrorBanner message={section.error ?? "Request failed."} />
        ) : !section.data ? (
          <p className="text-sm text-muted-foreground">
            No daily operations data available.
          </p>
        ) : (
          <DailyOperationsView data={section.data} />
        )}
      </CardContent>
    </Card>
  );
}

function DailyOperationsView({ data }: { data: DailyOperationsDashboard }) {
  const ops = data.operations;
  const sla = data.sla;
  return (
    <div className="space-y-5">
      <div className="text-xs text-muted-foreground">
        Date: <span className="font-mono">{display(data.date)}</span>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Operations</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Total bookings" value={display(ops.total_bookings)} />
          <Stat label="Completed" value={display(ops.completed)} />
          <Stat
            label="Cancellation rate %"
            value={display(ops.cancellation_rate_pct)}
          />
          <Stat label="No-show rate %" value={display(ops.no_show_rate_pct)} />
          <Stat label="Avg wait (min)" value={display(ops.avg_wait_minutes)} />
          <Stat
            label="Avg consultation (min)"
            value={display(ops.avg_consultation_minutes)}
          />
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Hourly Trend</h3>
        {data.hourly_trend.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No bookings were created in any hour of this date.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Hour</TH>
                  <TH>Bookings</TH>
                  <TH>Completed</TH>
                </TR>
              </THead>
              <TBody>
                {data.hourly_trend.map((h) => (
                  <TR key={h.hour}>
                    <TD className="align-top font-mono text-xs">
                      {display(h.hour)}
                    </TD>
                    <TD className="align-top">{display(h.bookings)}</TD>
                    <TD className="align-top">{display(h.completed)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Doctor Throughput</h3>
        {ops.doctor_throughput === null ? (
          <p className="text-sm text-muted-foreground">
            No doctor-assigned bookings for this date.
          </p>
        ) : ops.doctor_throughput.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No doctor throughput rows for this date.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Doctor</TH>
                  <TH>Completed</TH>
                </TR>
              </THead>
              <TBody>
                {ops.doctor_throughput.map((d) => (
                  <TR key={d.doctor_id}>
                    <TD className="align-top font-mono text-xs">
                      {d.doctor_id}
                    </TD>
                    <TD className="align-top">{display(d.completed)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">SLA</h3>
        {sla === null ? (
          <p className="text-sm text-muted-foreground">
            No SLA tracking row for this date.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat label="Compliant" value={display(sla.compliant)} />
            <Stat
              label="Avg wait (min)"
              value={display(sla.avg_wait_minutes ?? null)}
            />
            <Stat
              label="Completion rate %"
              value={display(sla.completion_rate_pct ?? null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── B. Doctor rankings ──────────────────────────────────────────────────────

function DoctorRankingsCard({
  section,
}: {
  section: Section<DoctorRankingsData | null>;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>Doctor Rankings</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px]">
            doctor_rankings
          </Badge>
        </div>
        <CardDescription>
          Server-ranked comparative metrics and the utilization heatmap over the
          requested window (trailing 30 days by default).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {section.status === "idle" ? (
          <p className="text-sm text-muted-foreground">Not loaded yet.</p>
        ) : section.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading rankings…</p>
        ) : section.status === "error" ? (
          <ErrorBanner message={section.error ?? "Request failed."} />
        ) : !section.data ? (
          <p className="text-sm text-muted-foreground">
            No doctor rankings data available.
          </p>
        ) : (
          <DoctorRankingsView data={section.data} />
        )}
      </CardContent>
    </Card>
  );
}

function DoctorRankingsView({ data }: { data: DoctorRankingsData }) {
  // Rendered in the ORDER THE SERVER RETURNED IT. The `throughput_rank` /
  // `efficiency_rank` columns are SQL `RANK()` values; nothing here sorts,
  // re-ranks or scores a doctor (§13).
  return (
    <div className="space-y-5">
      <div className="text-xs text-muted-foreground">
        Window: <span className="font-mono">{display(data.from_date)}</span> →{" "}
        <span className="font-mono">{display(data.to_date)}</span>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Rankings</h3>
        {data.rankings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No ranked doctors for this window — the server returned no
            assigned bookings in the range.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Throughput rank</TH>
                  <TH>Efficiency rank</TH>
                  <TH>Doctor</TH>
                  <TH>Completed</TH>
                  <TH>Assigned</TH>
                  <TH>Avg consultation (min)</TH>
                  <TH>Load %</TH>
                </TR>
              </THead>
              <TBody>
                {data.rankings.map((r) => (
                  <TR key={r.doctor_id}>
                    <TD className="align-top font-mono text-xs">
                      {display(r.throughput_rank)}
                    </TD>
                    <TD className="align-top font-mono text-xs">
                      {display(r.efficiency_rank)}
                    </TD>
                    <TD className="align-top font-mono text-xs">
                      {r.doctor_id}
                    </TD>
                    <TD className="align-top">{display(r.completed)}</TD>
                    <TD className="align-top">{display(r.total_assigned)}</TD>
                    <TD className="align-top">
                      {display(r.avg_consultation_minutes)}
                    </TD>
                    <TD className="align-top">{display(r.load_pct)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Utilization Heatmap</h3>
        {data.utilization_heatmap.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No utilization cells for this window.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Doctor</TH>
                  <TH>Weekday</TH>
                  <TH>Completed</TH>
                </TR>
              </THead>
              <TBody>
                {data.utilization_heatmap.map((c) => (
                  <TR key={`${c.doctor_id}-${c.weekday}`}>
                    <TD className="align-top font-mono text-xs">
                      {c.doctor_id}
                    </TD>
                    <TD className="align-top">{weekdayLabel(c.weekday)}</TD>
                    <TD className="align-top">{display(c.completed)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
