import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  fetchActingHospitalContext,
  fetchCrossHospitalBenchmarks,
  fetchGlobalPortfolio,
  type ActingHospitalContext,
} from "@/api/portfolio";
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
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type {
  CrossHospitalBenchmarkRow,
  CrossHospitalBenchmarks,
  PortfolioDashboard,
  PortfolioHospitalRow,
} from "@/types/api";

/**
 * Global Admin Portfolio Dashboard (Phase 7 G-08) — a strictly READ-ONLY,
 * `global_admin`-only surface over the two EXISTING tenant-free
 * `executive-analytics` global actions.
 *
 * Nothing is computed here. Every number on the page is a value the server
 * already aggregated: `total_hospitals` / `active_hospitals`, the per-hospital
 * booking, revenue, outstanding, SLA and active-session figures, and the
 * cross-hospital benchmark columns all come straight from
 * `get_portfolio_dashboard` / `get_cross_hospital_benchmarks`. The console makes
 * exactly ONE request per action per explicit load — never a per-hospital fan-out
 * — because the cross-tenant aggregation is the RPC's job, not the browser's.
 *
 * Truthful states (§12/§13): `0` renders as `0`, an absent value renders as `—`,
 * an empty hospital list says so rather than showing fabricated zeroes, and a
 * failed read is shown as an error, never disguised as an empty portfolio.
 *
 * Security (§14): the user JWT + the session's `X-Hospital-ID` header go to the
 * Edge Function, which re-authorizes `global_admin` server-side before any RPC
 * runs. This page is reached only through a `global_admin` route guard, and that
 * guard is a UX boundary — the backend remains the authority. No service-role
 * key, no secret and no second auth path exists here.
 */

type SectionStatus = "loading" | "success" | "error";

interface Section<T> {
  status: SectionStatus;
  data: T | null;
  error: string | null;
}

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
 * an em dash rather than a fabricated figure.
 */
function display(v: number | string | boolean | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : v;
}

const SLA_LABEL: Record<string, string> = {
  healthy: "healthy",
  breached: "breached",
  no_data: "no data",
};

export function AdminPortfolio() {
  const { staff, hospitalId } = useAuth();
  const isGlobalAdmin = staff?.role === "global_admin";

  const [portfolio, setPortfolio] =
    useState<Section<PortfolioDashboard | null>>(LOADING);
  const [benchmarks, setBenchmarks] =
    useState<Section<CrossHospitalBenchmarks | null>>(LOADING);
  const activeRef = useRef(true);

  // The contract-required acting context, resolved only when the account
  // itself has no tenant (see `fetchActingHospitalContext`).
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

  // ONE bounded context read, at most once per mount — never a retry loop,
  // never a poll. It exists only to satisfy the header the current contract
  // requires; the portfolio data itself is cross-hospital.
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
    setPortfolio(LOADING);
    setBenchmarks(LOADING);

    // Two independent global reads → two independent outcomes, in a single
    // round: one request per action, never a loop over hospitals.
    const [rPortfolio, rBenchmarks] = await Promise.allSettled([
      fetchGlobalPortfolio(scopeHospitalId),
      fetchCrossHospitalBenchmarks(scopeHospitalId),
    ]);

    if (!activeRef.current) return;

    if (rPortfolio.status === "fulfilled") {
      setPortfolio(succeeded(rPortfolio.value.portfolio));
    } else {
      setPortfolio(failed(rPortfolio.reason));
    }

    if (rBenchmarks.status === "fulfilled") {
      setBenchmarks(succeeded(rBenchmarks.value.benchmarks));
    } else {
      setBenchmarks(failed(rBenchmarks.reason));
    }
  }, [scopeHospitalId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!scopeHospitalId) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Global Portfolio</h1>
        {actingError ? (
          // Honest failure: the required context could not be resolved.
          <p
            role="alert"
            className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
          >
            {actingError}
          </p>
        ) : (
          /* Truthful contract state (spec §5): the current `executive-analytics`
             contract requires `X-Hospital-ID` even for these tenant-free global
             actions, so the surface waits on a resolvable context. Nothing is
             fabricated around that here — a backend contract change is outside
             G-08's frontend-only boundary. */
          <p className="text-sm text-muted-foreground">
            Waiting for the hospital context the analytics service requires on
            every request — even for these cross-hospital views. No portfolio
            data is shown.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Global Portfolio</h1>
          <p className="text-sm text-muted-foreground">
            Read-only cross-hospital view · {staff?.fullName} · aggregated
            server-side by the existing executive-analytics global actions
            (portfolio and benchmarks). Nothing on this page is computed in the
            browser.
          </p>
          {/* Disclose the acting context rather than hide it: the header is a
              contract requirement, not a data filter, and the tables below are
              cross-hospital regardless of which id satisfies it. */}
          <p className="mt-1 text-xs text-muted-foreground">
            Request context sent as the required tenant header:{" "}
            <span className="font-mono">{scopeHospitalId}</span>
            {acting
              ? " — your account has no hospital of its own, so this one is used only to satisfy the header; the figures below are cross-hospital, not scoped to it."
              : " — taken from your session."}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={
            portfolio.status === "loading" || benchmarks.status === "loading"
          }
          onClick={() => void load()}
        >
          Refresh
        </Button>
      </div>

      <PortfolioCard section={portfolio} />
      <BenchmarksCard section={benchmarks} />
    </div>
  );
}

// ─── Portfolio overview ──────────────────────────────────────────────────────

function PortfolioCard({
  section,
}: {
  section: Section<PortfolioDashboard | null>;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>Portfolio Overview</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px]">
            portfolio
          </Badge>
        </div>
        <CardDescription>
          Every hospital in the platform for the reported date, with the
          server&rsquo;s own totals.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {section.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading portfolio…</p>
        ) : section.status === "error" ? (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
          >
            {section.error}
          </p>
        ) : !section.data ? (
          <p className="text-sm text-muted-foreground">
            No portfolio data available.
          </p>
        ) : (
          <PortfolioView portfolio={section.data} />
        )}
      </CardContent>
    </Card>
  );
}

function PortfolioView({ portfolio }: { portfolio: PortfolioDashboard }) {
  const rows = portfolio.hospitals ?? [];
  return (
    <div className="space-y-4">
      {/* The two counts are distinct server aggregates: total hospitals in the
          portfolio versus hospitals flagged active. Neither is derived here. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Reported date" value={display(portfolio.date)} />
        <Stat
          label="Total hospitals"
          value={display(portfolio.total_hospitals)}
        />
        <Stat
          label="Active hospitals"
          value={display(portfolio.active_hospitals)}
        />
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No portfolio data available.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Hospital</TH>
                <TH>Active</TH>
                <TH>Bookings today</TH>
                <TH>Revenue today</TH>
                <TH>Outstanding balance</TH>
                <TH>SLA status</TH>
                <TH>Active sessions</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r: PortfolioHospitalRow) => (
                <TR key={r.hospital_id}>
                  <TD className="align-top">
                    <div className="font-medium">{display(r.name)}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {display(r.slug)}
                    </div>
                  </TD>
                  <TD className="align-top">{display(r.is_active)}</TD>
                  <TD className="align-top">{display(r.bookings_today)}</TD>
                  <TD className="align-top">{display(r.revenue_today)}</TD>
                  <TD className="align-top">
                    {display(r.outstanding_balance)}
                  </TD>
                  <TD className="align-top">
                    {r.sla_status ? SLA_LABEL[r.sla_status] ?? r.sla_status : "—"}
                  </TD>
                  <TD className="align-top">{display(r.active_sessions)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}

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

// ─── Cross-hospital benchmarks ───────────────────────────────────────────────

function BenchmarksCard({
  section,
}: {
  section: Section<CrossHospitalBenchmarks | null>;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>Cross-Hospital Benchmarks</CardTitle>
          <Badge variant="outline" className="font-mono text-[10px]">
            benchmarks
          </Badge>
        </div>
        <CardDescription>
          Per-hospital operational measures over the window the server chose.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {section.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading benchmarks…</p>
        ) : section.status === "error" ? (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
          >
            {section.error}
          </p>
        ) : !section.data ? (
          <p className="text-sm text-muted-foreground">
            No benchmark data available.
          </p>
        ) : (
          <BenchmarksView benchmarks={section.data} />
        )}
      </CardContent>
    </Card>
  );
}

function BenchmarksView({
  benchmarks,
}: {
  benchmarks: CrossHospitalBenchmarks;
}) {
  const rows = benchmarks.benchmarks ?? [];
  return (
    <div className="space-y-4">
      <div className="text-xs text-muted-foreground">
        Window: <span className="font-mono">{display(benchmarks.from_date)}</span>{" "}
        → <span className="font-mono">{display(benchmarks.to_date)}</span>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No benchmark data available.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Hospital</TH>
                <TH>Bookings</TH>
                <TH>Completed</TH>
                <TH>Avg wait (min)</TH>
                <TH>Avg consultation (min)</TH>
                <TH>Efficiency %</TH>
                <TH>Revenue (INR)</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((r: CrossHospitalBenchmarkRow) => (
                <TR key={r.hospital_id}>
                  <TD className="align-top font-medium">{display(r.name)}</TD>
                  <TD className="align-top">{display(r.bookings)}</TD>
                  <TD className="align-top">{display(r.completed)}</TD>
                  <TD className="align-top">{display(r.avg_wait_minutes)}</TD>
                  <TD className="align-top">
                    {display(r.avg_consultation_minutes)}
                  </TD>
                  <TD className="align-top">{display(r.efficiency_pct)}</TD>
                  <TD className="align-top">{display(r.revenue_inr)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}
