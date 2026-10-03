import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  fetchActingHospitalContext,
  type ActingHospitalContext,
} from "@/api/portfolio";
import {
  listHospitalsForActivation,
  setHospitalActivation,
  validateHospitalConfiguration,
} from "@/api/activation";
import { useAsyncAction } from "@/hooks/useAsyncAction";
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
import type {
  HospitalActivationRow,
  HospitalConfigCheck,
  HospitalValidationResult,
} from "@/types/api";

/**
 * WS-ONBOARD-5 — Hospital Configuration Validation & Activation (global_admin
 * only). This is the closing step of the SETURA onboarding flow: after a
 * tenant has been created (WS-ONBOARD-1) and configured (settings,
 * integrations, clinical), a global_admin reviews its completeness against the
 * readiness invariant and, only once the server says it is ready, activates it.
 *
 * The frontend owns NOTHING of the decision. It lists live tenants under RLS
 * (a read), asks the `hospital-activation` Edge Function to run the
 * `validate_hospital_configuration` checklist, and posts an activate /
 * deactivate intent behind the `set_hospital_activation` RPC. The backend
 * resolves the actor, requires `global_admin`, re-checks the role in the RPC,
 * enforces the readiness invariant (an incomplete tenant is refused, 22023),
 * and writes only the pre-existing operational `hospitals.is_active` flag. This
 * page never touches a privileged key, never writes SQL, and never decides
 * tenancy — the `global_admin` route guard is a UX boundary; the Edge Function
 * and the service-role RPC are the security and correctness authority (§14).
 *
 * Idempotency & double-submit: each activation is one stable `useAsyncAction`
 * key reused across retries and the button is disabled in flight; the backend's
 * EXISTING `api_idempotency_keys` registry plus the RPC's natural idempotency
 * (activating an already-active tenant is a no-op success) is what actually
 * keeps a replay from duplicating the effect. Validation is a read and takes no
 * key.
 *
 * Truthful outcomes (§18): the checklist and readiness are exactly what the
 * server computed; a refusal renders the client-safe message via
 * `describeError` and is never dressed as a success; an activation shows the
 * server-returned state, not an optimistic guess.
 */

interface ValidationState {
  loading: boolean;
  result: HospitalValidationResult | null;
  error: string | null;
}

export function HospitalActivation() {
  const { staff, hospitalId } = useAuth();
  const isGlobalAdmin = staff?.role === "global_admin";

  const [hospitals, setHospitals] = useState<HospitalActivationRow[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [validation, setValidation] = useState<ValidationState>({
    loading: false,
    result: null,
    error: null,
  });
  const [feedback, setFeedback] = useState<string | null>(null);

  const activeRef = useRef(true);
  const actingAttemptedRef = useRef(false);

  // Bounded acting context, reused from the established G-08/WS-ONBOARD-1
  // pattern ONLY to satisfy the shared `callFunction` transport header. The
  // activation endpoint ignores this value — the TARGET tenant comes from the
  // body and authorization comes from the resolved JWT actor, never this header.
  const [acting, setActing] = useState<ActingHospitalContext | null>(null);
  const [actingError, setActingError] = useState<string | null>(null);
  const scopeHospitalId = hospitalId ?? acting?.hospitalId ?? null;

  const activate = useAsyncAction<
    [acting: string, target: string, doActivate: boolean],
    Awaited<ReturnType<typeof setHospitalActivation>>
  >(
    useCallback(
      (key, actingId, target, doActivate) =>
        setHospitalActivation(actingId, key, target, doActivate),
      [],
    ),
  );

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  // Resolve the transport-only acting context for a global_admin whose own
  // account carries no hospital.
  useEffect(() => {
    if (!isGlobalAdmin || hospitalId || actingAttemptedRef.current) return;
    actingAttemptedRef.current = true;
    fetchActingHospitalContext()
      .then((ctx) => {
        if (!activeRef.current) return;
        if (ctx) setActing(ctx);
        else setActingError("No hospital exists yet to satisfy the transport.");
      })
      .catch((e) => {
        if (activeRef.current) setActingError(describeError(e));
      });
  }, [isGlobalAdmin, hospitalId]);

  const reloadList = useCallback(() => {
    setListLoading(true);
    setListError(null);
    listHospitalsForActivation()
      .then((rows) => {
        if (!activeRef.current) return;
        setHospitals(rows);
      })
      .catch((e) => {
        if (activeRef.current) setListError(describeError(e));
      })
      .finally(() => {
        if (activeRef.current) setListLoading(false);
      });
  }, []);

  useEffect(() => {
    if (isGlobalAdmin) reloadList();
  }, [isGlobalAdmin, reloadList]);

  // When the selected tenant changes, drop the previous validation + feedback.
  useEffect(() => {
    setValidation({ loading: false, result: null, error: null });
    setFeedback(null);
    activate.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const selected = useMemo(
    () => hospitals.find((h) => h.id === selectedId) ?? null,
    [hospitals, selectedId],
  );

  const runValidation = () => {
    if (!scopeHospitalId || !selectedId) return;
    setValidation({ loading: true, result: null, error: null });
    setFeedback(null);
    validateHospitalConfiguration(scopeHospitalId, selectedId)
      .then((resp) => {
        if (!activeRef.current) return;
        setValidation({ loading: false, result: resp.result, error: null });
      })
      .catch((e) => {
        if (activeRef.current) {
          setValidation({ loading: false, result: null, error: describeError(e) });
        }
      });
  };

  const runActivation = async (doActivate: boolean) => {
    if (!scopeHospitalId || !selectedId) return;
    setFeedback(null);
    await activate.run(scopeHospitalId, selectedId, doActivate);
  };

  // Surface a rejection honestly (§18) and, on success, refresh the list so the
  // operational state the server wrote is what the UI shows next.
  useEffect(() => {
    if (activate.error) setFeedback(describeError(activate.error));
  }, [activate.error]);

  useEffect(() => {
    if (activate.data) {
      setFeedback(
        activate.data.reason === "already_active"
          ? "This hospital is already active."
          : activate.data.isActive
            ? "Hospital activated."
            : "Hospital de-activated.",
      );
      reloadList();
    }
  }, [activate.data, reloadList]);

  if (!isGlobalAdmin) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Hospital Activation</h1>
        <p className="text-sm text-muted-foreground">
          Tenant activation is restricted to global administrators. The backend
          re-authorizes every request regardless of what is shown here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">
          Hospital Activation{" "}
          <span className="text-sm font-normal text-muted-foreground">
            — Validate configuration & go live
          </span>
        </h1>
        <p className="text-sm text-muted-foreground">
          Select a hospital to review its configuration completeness and, once
          the readiness checks pass, activate it. The service owns the checks,
          the readiness gate and the write; the browser only asks.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Request context sent as the required transport header:{" "}
          <span className="font-mono">{scopeHospitalId ?? "—"}</span>
          {acting
            ? " — your account has no hospital of its own, so this id satisfies the shared transport only; the target tenant is chosen below and authorization comes from your verified role."
            : ""}
        </p>
        {actingError && (
          <p className="mt-1 text-xs text-destructive">{actingError}</p>
        )}
      </div>

      {listError && (
        <p role="alert" className="text-sm text-destructive">
          {listError}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>1 · Choose a hospital</CardTitle>
          <CardDescription>
            Live tenants visible to you. The activation badge reflects the
            server-side operational state.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {listLoading && hospitals.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading hospitals…</p>
          ) : hospitals.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No hospitals found. Provision one from Hospital Onboarding first.
            </p>
          ) : (
            <ul className="divide-y divide-border" data-testid="hospital-list">
              {hospitals.map((h) => (
                <li
                  key={h.id}
                  className="flex items-center justify-between gap-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{h.name}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {h.slug}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <ActivationBadge hospital={h} />
                    <Button
                      size="sm"
                      variant={selectedId === h.id ? "default" : "outline"}
                      onClick={() => setSelectedId(h.id)}
                      data-testid={`select-${h.id}`}
                    >
                      Select
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {selected && (
        <Card>
          <CardHeader>
            <CardTitle>2 · Validate & activate</CardTitle>
            <CardDescription>
              {selected.name} ·{" "}
              <span className="font-mono">{selected.id}</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <Button
                onClick={runValidation}
                disabled={!scopeHospitalId || validation.loading}
                data-testid="validate-btn"
              >
                {validation.loading ? "Validating…" : "Validate configuration"}
              </Button>
              <span className="text-xs text-muted-foreground">
                The server computes the checklist; nothing is decided here.
              </span>
            </div>

            {validation.error && (
              <p role="alert" className="text-sm text-destructive">
                {validation.error}
              </p>
            )}

            {validation.result && (
              <ValidationPanel result={validation.result} />
            )}

            {feedback && (
              <p className="text-sm text-muted-foreground" data-testid="activation-feedback">
                {feedback}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <Button
                onClick={() => void runActivation(true)}
                disabled={
                  !scopeHospitalId ||
                  activate.running ||
                  (validation.result ? !validation.result.ready : false)
                }
                data-testid="activate-btn"
              >
                {activate.running ? "Working…" : "Activate hospital"}
              </Button>
              <Button
                variant="outline"
                onClick={() => void runActivation(false)}
                disabled={!scopeHospitalId || activate.running}
                data-testid="deactivate-btn"
              >
                De-activate
              </Button>
              <p className="text-xs text-muted-foreground">
                Activation is refused server-side until the readiness checks
                pass. De-activation suspends operations and needs no check.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ActivationBadge({ hospital }: { hospital: HospitalActivationRow }) {
  if (hospital.is_active) {
    return (
      <Badge variant="secondary" data-testid={`badge-active-${hospital.id}`}>
        {hospital.activated_at ? "Active" : "Active (not formally activated)"}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" data-testid={`badge-inactive-${hospital.id}`}>
      Inactive
    </Badge>
  );
}

function ValidationPanel({ result }: { result: HospitalValidationResult }) {
  return (
    <div className="space-y-2" data-testid="validation-panel">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Readiness:</span>
        {result.ready ? (
          <Badge variant="secondary" data-testid="ready-badge">
            Ready to activate
          </Badge>
        ) : (
          <Badge variant="destructive" data-testid="not-ready-badge">
            Not ready
          </Badge>
        )}
      </div>
      <ul className="space-y-1">
        {result.checks.map((c: HospitalConfigCheck) => (
          <li key={c.key} className="flex items-center gap-2 text-sm">
            <span
              className={
                c.passed ? "text-emerald-600" : "text-destructive"
              }
              aria-hidden
            >
              {c.passed ? "✓" : "✗"}
            </span>
            <span>{c.label}</span>
            {c.blocking ? (
              <span className="text-xs text-muted-foreground">(blocking)</span>
            ) : (
              <span className="text-xs text-muted-foreground">
                (informational)
              </span>
            )}
            <span className="text-xs text-muted-foreground">— {c.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
