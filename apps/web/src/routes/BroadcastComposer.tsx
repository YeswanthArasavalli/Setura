import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  fetchActingHospitalContext,
  type ActingHospitalContext,
} from "@/api/portfolio";
import { listDoctorNames, listTodaysBookings } from "@/api/reads";
import { fetchAlertCenter } from "@/api/alertCenter";
import {
  broadcastAdminNotice,
  broadcastAlert,
  broadcastClosure,
  broadcastDoctorDelay,
  broadcastQueueSummary,
} from "@/api/commandCenter";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { describeError } from "@/lib/errors";
import { todayISO } from "@/lib/dates";
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
import type {
  AdminBroadcastKind,
  CommandCenterBroadcastResponse,
  CommandCenterBroadcastResult,
} from "@/types/api";

/**
 * C2b — Broadcast Composer (Hospital Admin operational broadcast surface).
 *
 * This is a COMPOSE → PREVIEW → CONFIRM → ENQUEUE front end over the EXISTING
 * `command-center` Edge Function's five `broadcast_*` actions. It owns NOTHING
 * of the broadcast itself:
 *
 *  - Recipients are chosen by the backend (`_shared/enterprise/broadcasts.ts`):
 *    the queue-active patients of a session, every still-active patient in
 *    today's queues, the hospital admins, or the admins of one alert. The
 *    composer never enters a phone number and never sends a recipient list
 *    (§10). Where the backend picks the audience, the preview DESCRIBES that
 *    scope rather than inventing a count; the only number ever shown is the
 *    server's own `broadcast.enqueued` after the request completes.
 *  - The final WhatsApp text is composed by the backend. For the
 *    backend-generated types (queue/delay/closure/alert) the preview states the
 *    OPERATION, never a fabricated exact message (§11). Only for the admin
 *    notice — whose `message` the composer genuinely supplies — is the exact
 *    text shown, and even there the `[kind]` tag the backend prefixes is
 *    disclosed rather than reproduced as if the browser owned it.
 *  - Replay safety is the backend's deterministic `enqueue_job` idempotency key;
 *    NO client idempotency system is introduced (§5/§16). The only duplicate-
 *    submit defence here is `useAsyncAction` disabling the control in flight.
 *
 * Server-authoritative and honest about delivery (§5/§6/§17): `ENQUEUED ≠
 * DELIVERED`. The worker is disabled and no scheduler is production-proven, so a
 * success renders "Broadcast queued." with the server's enqueue count and NEVER
 * claims WhatsApp delivery. There is no poll, no fake delivery tracker, and a
 * `enqueued: 0` (flag-gated patient broadcast) is shown as the server's honest
 * result, not dressed as a failure or a success-with-count.
 *
 * Authorization (§14/§20): the mutation controls render for `hospital_admin` /
 * `global_admin` purely as a UX convenience mirroring the backend's own
 * `requireRole` list; the Edge Function re-authorizes role + tenant on every
 * call, so hiding a control is NEVER the security boundary. Tenant travels only
 * in the `X-Hospital-ID` header `callFunction` sets; a tenant-less `global_admin`
 * reuses the established G-08 `fetchActingHospitalContext()` exactly once and
 * discloses it (§15). No hospital id is ever placed in a broadcast body.
 *
 * Error handling (§18): every backend rejection surfaces via `describeError`
 * (401/403/422/500 map to safe guidance). No SQLSTATE, raw error, stack, token
 * or patient PII is rendered — the backend envelope is already client-safe.
 */

/** The five composer types. Exported so tests can drive the validator directly. */
export type BroadcastType =
  | "queue_summary"
  | "doctor_delay"
  | "closure"
  | "admin_notice"
  | "alert";

/** Human labels — the internal `broadcast_*` action names are never shown. */
const TYPE_LABELS: Record<BroadcastType, string> = {
  queue_summary: "Queue Update",
  doctor_delay: "Doctor Delay",
  closure: "Hospital Closure",
  admin_notice: "Admin Notice",
  alert: "Alert Notification",
};

/** Recipient scope, described from the backend's own behaviour (§10). No count
 *  is invented; the audience is whatever the server selects for this action. */
const RECIPIENT_SCOPE: Record<BroadcastType, string> = {
  queue_summary:
    "Every patient currently active in the selected queue session — and only " +
    "while proactive WhatsApp queue updates are enabled for this hospital. The " +
    "backend chooses this audience; the composer sends no phone numbers.",
  doctor_delay:
    "Every patient currently active in the selected queue session — and only " +
    "while proactive WhatsApp queue updates are enabled for this hospital. The " +
    "backend chooses this audience; the composer sends no phone numbers.",
  closure:
    "Every patient still active in today's queues at this hospital — and only " +
    "while proactive WhatsApp queue updates are enabled. The backend resolves " +
    "this audience itself.",
  admin_notice:
    "Every administrator of this hospital who has a deliverable contact on " +
    "file. The backend selects the admin audience.",
  alert:
    "Every administrator of this hospital who has a deliverable contact on " +
    "file. The backend selects the admin audience for the chosen alert.",
};

const NOTICE_KIND_LABELS: Record<AdminBroadcastKind, string> = {
  daily_summary: "Daily summary",
  sla_breach: "SLA breach",
  congestion: "Congestion",
  operational_notice: "Operational notice",
};

const NOTICE_KINDS = Object.keys(NOTICE_KIND_LABELS) as AdminBroadcastKind[];

// Backend `Schema` limits, mirrored client-side for usability only (§13).
const MESSAGE_MAX = 500;
const REASON_MAX = 200;
const DELAY_MIN = 1;
const DELAY_MAX = 1440;

/** Roles `command-center` admits `broadcast_*` to via `requireRole`. Rendering
 *  the composer for them is a UX convenience ONLY — the Edge Function is the
 *  sole security boundary. */
const MUTATION_ROLES: readonly (string | null)[] = [
  "hospital_admin",
  "global_admin",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Field-level validation errors for the current draft, mirroring the exact
 *  backend constraints. Returns an empty object when the draft is submittable.
 *  Exported so tests can pin the rules independently of rendering. */
export function validateBroadcast(
  type: BroadcastType,
  draft: ComposerDraft,
): Partial<Record<BroadcastField, string>> {
  const errors: Partial<Record<BroadcastField, string>> = {};

  if (type === "queue_summary" || type === "doctor_delay") {
    if (!draft.queueSessionId) {
      errors.queueSessionId = "Select the queue session to broadcast to.";
    }
  }

  if (type === "doctor_delay") {
    const minutes = Number(draft.delayMinutes);
    if (
      draft.delayMinutes.trim() === "" ||
      !Number.isInteger(minutes) ||
      minutes < DELAY_MIN ||
      minutes > DELAY_MAX
    ) {
      errors.delayMinutes = `Enter a whole number of minutes between ${DELAY_MIN} and ${DELAY_MAX}.`;
    }
    if (draft.reason.length > REASON_MAX) {
      errors.reason = `Reason must be ${REASON_MAX} characters or fewer.`;
    }
  }

  if (type === "closure") {
    if (draft.closureDate && !DATE_RE.test(draft.closureDate)) {
      errors.closureDate = "Date must be YYYY-MM-DD.";
    }
    if (draft.reason.length > REASON_MAX) {
      errors.reason = `Reason must be ${REASON_MAX} characters or fewer.`;
    }
  }

  if (type === "admin_notice") {
    if (!draft.noticeKind) {
      errors.noticeKind = "Choose a notice category.";
    }
    const message = draft.message.trim();
    if (!message) {
      errors.message = "Enter the notice message.";
    } else if (draft.message.length > MESSAGE_MAX) {
      errors.message = `Message must be ${MESSAGE_MAX} characters or fewer.`;
    }
  }

  if (type === "alert") {
    if (!draft.alertId) {
      errors.alertId = "Select the alert to broadcast.";
    }
  }

  return errors;
}

type BroadcastField =
  | "queueSessionId"
  | "delayMinutes"
  | "reason"
  | "closureDate"
  | "noticeKind"
  | "message"
  | "alertId";

interface ComposerDraft {
  queueSessionId: string;
  delayMinutes: string;
  reason: string;
  closureDate: string;
  noticeKind: AdminBroadcastKind | "";
  message: string;
  alertId: string;
}

const EMPTY_DRAFT: ComposerDraft = {
  queueSessionId: "",
  delayMinutes: "",
  reason: "",
  closureDate: "",
  noticeKind: "",
  message: "",
  alertId: "",
};

/** The three-stage flow, made explicit to the user (§8). */
type Stage = "compose" | "preview" | "queued";

export function BroadcastComposer() {
  const { staff, hospitalId } = useAuth();
  const isGlobalAdmin = staff?.role === "global_admin";
  const canCompose = MUTATION_ROLES.includes(staff?.role ?? null);

  const [type, setType] = useState<BroadcastType>("queue_summary");
  const [draft, setDraft] = useState<ComposerDraft>(EMPTY_DRAFT);
  const [stage, setStage] = useState<Stage>("compose");
  const [errors, setErrors] = useState<Partial<Record<BroadcastField, string>>>(
    {},
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CommandCenterBroadcastResult | null>(
    null,
  );

  // Context sources for the two selector-backed types, loaded from the SAME
  // established reads the rest of the console uses (RLS reads + alert-center
  // read). Never fetched on a keystroke — once per mount and reloaded after a
  // submit so the pickers reflect current operational state (§8 refresh).
  const [sessionOptions, setSessionOptions] = useState<[string, string][]>([]);
  const [alertOptions, setAlertOptions] = useState<
    { id: string; label: string }[]
  >([]);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextLoading, setContextLoading] = useState(false);

  const activeRef = useRef(true);
  const actingAttemptedRef = useRef(false);

  // Established G-08 bounded acting context for a tenant-less global admin.
  const [acting, setActing] = useState<ActingHospitalContext | null>(null);
  const [actingError, setActingError] = useState<string | null>(null);
  const scopeHospitalId = hospitalId ?? acting?.hospitalId ?? null;

  const broadcast = useAsyncAction(
    useCallback(
      (_key: string, tenant: string, currentType: BroadcastType) =>
        runBroadcast(tenant, currentType, draft),
      // `draft` is read at call time from the closure the hook holds; the hook
      // re-creates `run` whenever `fn` changes, so keep `draft` a dependency.
      [draft],
    ),
  );

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  // Surface a rejected broadcast honestly (§18). `useAsyncAction` swallows the
  // error into its own state and returns null, so the rejection is read from
  // that reactive state — never from the stale closure value right after
  // `run()`. A double-submit-swallow leaves the error null and fires nothing.
  useEffect(() => {
    if (broadcast.error) {
      setSubmitError(describeError(broadcast.error));
      setOutcome(null);
      setStage("preview");
    }
  }, [broadcast.error]);

  useEffect(() => {
    if (!isGlobalAdmin || hospitalId || actingAttemptedRef.current) return;
    actingAttemptedRef.current = true;
    fetchActingHospitalContext()
      .then((ctx) => {
        if (!activeRef.current) return;
        if (ctx) setActing(ctx);
        else {
          setActingError(
            "No hospital exists to satisfy the required broadcast context.",
          );
        }
      })
      .catch((e) => {
        if (activeRef.current) setActingError(describeError(e));
      });
  }, [isGlobalAdmin, hospitalId]);

  const loadContext = useCallback(async () => {
    if (!scopeHospitalId) return;
    setContextLoading(true);
    setContextError(null);
    try {
      // Session picker source (doctor-delay / queue-summary) and alert picker
      // source (alert broadcast) load together; a failure of one degrades only
      // its own picker. Both are established RLS / alert-center reads.
      const [bookingsRes, alertsRes] = await Promise.allSettled([
        listTodaysBookings(scopeHospitalId, todayISO()),
        fetchAlertCenter(scopeHospitalId, { status: "open" }),
      ]);

      if (!activeRef.current) return;

      if (bookingsRes.status === "fulfilled") {
        const queued = bookingsRes.value.filter((b) => b.queue_session_id);
        const ids = [
          ...new Set(
            queued
              .map((b) => b.assigned_doctor_id)
              .filter((v): v is string => !!v),
          ),
        ];
        let names = new Map<string, string>();
        try {
          names = await listDoctorNames(ids);
        } catch {
          // Directory labelling is a nicety; keep the picker usable.
        }
        if (!activeRef.current) return;
        const map = new Map<string, string>();
        for (const b of queued) {
          if (!b.queue_session_id || map.has(b.queue_session_id)) continue;
          const doctor = b.assigned_doctor_id
            ? names.get(b.assigned_doctor_id)
            : undefined;
          map.set(b.queue_session_id, doctor ?? `Queue ${map.size + 1}`);
        }
        setSessionOptions([...map.entries()]);
      }

      if (alertsRes.status === "fulfilled") {
        const alerts = alertsRes.value.center.alerts ?? [];
        setAlertOptions(
          alerts.map((a) => ({
            id: a.id,
            label: `${a.severity.toUpperCase()} · ${a.alert_key}`,
          })),
        );
      } else {
        setAlertOptions([]);
      }

      // Surface a context read failure only when BOTH sources failed — one
      // working picker still allows that type; a total failure is honest.
      if (
        bookingsRes.status === "rejected" &&
        alertsRes.status === "rejected"
      ) {
        setContextError(describeError(bookingsRes.reason));
      }
    } finally {
      if (activeRef.current) setContextLoading(false);
    }
  }, [scopeHospitalId]);

  // Initial context load, once the tenant scope is known (guarded so a
  // StrictMode remount cannot double-fire).
  const didInitRef = useRef(false);
  useEffect(() => {
    if (!scopeHospitalId || didInitRef.current) return;
    didInitRef.current = true;
    void loadContext();
  }, [scopeHospitalId, loadContext]);

  // Success transition is derived from the last completed response, so it never
  // races a stale closure value. Declared with the other hooks — BEFORE the
  // early returns below — so the hook count is identical every render.
  const lastResult = broadcast.data;
  useEffect(() => {
    if (lastResult && stage !== "queued") {
      setOutcome(lastResult.broadcast);
      setStage("queued");
      void loadContext();
    }
  }, [lastResult, stage, loadContext]);

  const sessionSelectedLabel = useMemo(
    () => sessionOptions.find(([id]) => id === draft.queueSessionId)?.[1] ?? null,
    [sessionOptions, draft.queueSessionId],
  );
  const alertSelectedLabel = useMemo(
    () => alertOptions.find((o) => o.id === draft.alertId)?.label ?? null,
    [alertOptions, draft.alertId],
  );

  if (!scopeHospitalId) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Broadcast Composer</h1>
        {actingError ? (
          <ErrorBanner message={actingError} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Waiting for the hospital context the broadcast service requires on
            every request. No broadcast can be composed yet.
          </p>
        )}
      </div>
    );
  }

  if (!canCompose) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Broadcast Composer</h1>
        <p className="text-sm text-muted-foreground">
          Operational broadcasts are restricted to hospital and global
          administrators. The backend re-authorizes every request regardless of
          what is shown here.
        </p>
      </div>
    );
  }

  const patch = (p: Partial<ComposerDraft>) =>
    setDraft((d) => ({ ...d, ...p }));

  const switchType = (next: BroadcastType) => {
    setType(next);
    setStage("compose");
    setErrors({});
    setSubmitError(null);
    setOutcome(null);
  };

  const goToPreview = () => {
    const v = validateBroadcast(type, draft);
    setErrors(v);
    setSubmitError(null);
    if (Object.keys(v).length === 0) setStage("preview");
  };

  const confirmAndQueue = async () => {
    // Revalidate defensively (§12: never rely on the button being disabled).
    const v = validateBroadcast(type, draft);
    setErrors(v);
    if (Object.keys(v).length > 0) {
      setStage("compose");
      return;
    }
    setSubmitError(null);
    await broadcast.run(scopeHospitalId, type);
    // On success the resolved response drives the state (see the success
    // effect above); on failure the `broadcast.error` effect returns to the
    // preview step. `run()` returns null for BOTH a rejection and a swallowed
    // double-submit, so neither is handled here — one click is exactly one
    // in-flight request (§12).
  };

  const startAnother = () => {
    setDraft(EMPTY_DRAFT);
    setStage("compose");
    setErrors({});
    setOutcome(null);
    setSubmitError(null);
    broadcast.reset();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            Broadcast Composer{" "}
            <span className="text-sm font-normal text-muted-foreground">
              — Operational WhatsApp Broadcasts
            </span>
          </h1>
          <p className="text-sm text-muted-foreground">
            {staff?.fullName} · composes a broadcast request against the
            existing command-center function. The backend selects the
            recipients, writes the message and guarantees replay safety; this
            surface only submits the request and reports that it was queued.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Request context sent as the required tenant header:{" "}
            <span className="font-mono">{scopeHospitalId}</span>
            {acting
              ? " — your account has no hospital of its own, so this one is used only to satisfy the header."
              : " — taken from your session."}
          </p>
        </div>
      </div>

      {contextError && <ErrorBanner message={contextError} />}

      {/* Stage indicator, so compose / preview / enqueue are unmistakable. */}
      <StageIndicator stage={stage} />

      {stage === "queued" ? (
        <QueuedCard
          type={type}
          outcome={outcome}
          error={submitError}
          onAnother={startAnother}
        />
      ) : stage === "preview" ? (
        <PreviewCard
          type={type}
          draft={draft}
          sessionSelectedLabel={sessionSelectedLabel}
          alertSelectedLabel={alertSelectedLabel}
          busy={broadcast.running}
          error={submitError}
          onBack={() => {
            setStage("compose");
            setSubmitError(null);
          }}
          onConfirm={() => void confirmAndQueue()}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>1 · Choose a broadcast</CardTitle>
            <CardDescription>
              Only the five broadcast types the backend supports. A count or
              audience is never guessed here — the recipient scope appears in
              the preview.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(TYPE_LABELS) as BroadcastType[]).map((t) => (
                <Button
                  key={t}
                  type="button"
                  size="sm"
                  variant={type === t ? "default" : "outline"}
                  onClick={() => switchType(t)}
                  data-testid={`type-${t}`}
                >
                  {TYPE_LABELS[t]}
                </Button>
              ))}
            </div>

            <div className="space-y-4">
              <ContextFields
                type={type}
                draft={draft}
                errors={errors}
                sessionOptions={sessionOptions}
                alertOptions={alertOptions}
                contextLoading={contextLoading}
                onPatch={patch}
              />
            </div>

            <div className="flex items-center gap-3">
              <Button onClick={goToPreview} data-testid="to-preview">
                Review broadcast
              </Button>
              <span className="text-xs text-muted-foreground">
                Nothing is sent until you confirm on the next step.
              </span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Dispatch the confirmed broadcast to the matching existing wrapper, sending
 *  ONLY the fields the backend reads for that action (optional blanks omitted
 *  so the server default applies). No recipient list, no hospital id, no
 *  idempotency key — all owned by the backend. */
function runBroadcast(
  tenant: string,
  type: BroadcastType,
  draft: ComposerDraft,
): Promise<CommandCenterBroadcastResponse> {
  const reason = draft.reason.trim();
  switch (type) {
    case "queue_summary":
      return broadcastQueueSummary(tenant, draft.queueSessionId);
    case "doctor_delay":
      return broadcastDoctorDelay(tenant, {
        queueSessionId: draft.queueSessionId,
        delayMinutes: Number(draft.delayMinutes),
        ...(reason ? { reason } : {}),
      });
    case "closure":
      return broadcastClosure(tenant, {
        ...(draft.closureDate ? { date: draft.closureDate } : {}),
        ...(reason ? { reason } : {}),
      });
    case "admin_notice":
      return broadcastAdminNotice(tenant, {
        kind: draft.noticeKind as AdminBroadcastKind,
        message: draft.message,
      });
    case "alert":
      return broadcastAlert(tenant, { alertId: draft.alertId });
  }
}

// ─── Stage indicator ─────────────────────────────────────────────────────────

function StageIndicator({ stage }: { stage: Stage }) {
  const steps: { key: Stage; label: string }[] = [
    { key: "compose", label: "Compose" },
    { key: "preview", label: "Preview" },
    { key: "queued", label: "Queued" },
  ];
  const order: Stage[] = ["compose", "preview", "queued"];
  const current = order.indexOf(stage);
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Broadcast stage">
      {steps.map((s, i) => {
        const reached = i <= current;
        return (
          <li key={s.key} className="flex items-center gap-2">
            <span
              data-testid={`stage-${s.key}`}
              className={
                "rounded-full border px-2 py-0.5 " +
                (reached
                  ? "border-primary text-foreground"
                  : "border-border text-muted-foreground")
              }
            >
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <span className="text-muted-foreground">→</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ─── Context fields ──────────────────────────────────────────────────────────

function ContextFields({
  type,
  draft,
  errors,
  sessionOptions,
  alertOptions,
  contextLoading,
  onPatch,
}: {
  type: BroadcastType;
  draft: ComposerDraft;
  errors: Partial<Record<BroadcastField, string>>;
  sessionOptions: [string, string][];
  alertOptions: { id: string; label: string }[];
  contextLoading: boolean;
  onPatch: (p: Partial<ComposerDraft>) => void;
}) {
  const needsSession = type === "queue_summary" || type === "doctor_delay";

  return (
    <>
      {needsSession && (
        <div className="space-y-1">
          <Label htmlFor="bc-session">Queue session</Label>
          {contextLoading ? (
            <p className="text-sm text-muted-foreground">
              Loading active sessions…
            </p>
          ) : sessionOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active queue sessions today.
            </p>
          ) : (
            <select
              id="bc-session"
              value={draft.queueSessionId}
              onChange={(e) => onPatch({ queueSessionId: e.target.value })}
              className="h-10 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm"
              data-testid="bc-session"
            >
              <option value="">Select a session…</option>
              {sessionOptions.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          )}
          {errors.queueSessionId && (
            <FieldError message={errors.queueSessionId} />
          )}
        </div>
      )}

      {type === "doctor_delay" && (
        <>
          <div className="space-y-1">
            <Label htmlFor="bc-delay">Delay (minutes)</Label>
            <Input
              id="bc-delay"
              type="number"
              inputMode="numeric"
              min={DELAY_MIN}
              max={DELAY_MAX}
              value={draft.delayMinutes}
              onChange={(e) => onPatch({ delayMinutes: e.target.value })}
              className="max-w-40"
              data-testid="bc-delay"
            />
            <p className="text-xs text-muted-foreground">
              Whole number between {DELAY_MIN} and {DELAY_MAX}.
            </p>
            {errors.delayMinutes && <FieldError message={errors.delayMinutes} />}
          </div>
          <ReasonField draft={draft} errors={errors} onPatch={onPatch} />
        </>
      )}

      {type === "closure" && (
        <>
          <div className="space-y-1">
            <Label htmlFor="bc-date">Session date (optional)</Label>
            <Input
              id="bc-date"
              type="date"
              value={draft.closureDate}
              onChange={(e) => onPatch({ closureDate: e.target.value })}
              className="max-w-48"
              data-testid="bc-date"
            />
            <p className="text-xs text-muted-foreground">
              Blank uses today. Not sent to the backend unless set.
            </p>
            {errors.closureDate && <FieldError message={errors.closureDate} />}
          </div>
          <ReasonField draft={draft} errors={errors} onPatch={onPatch} />
        </>
      )}

      {type === "admin_notice" && (
        <>
          <div className="space-y-1">
            <Label htmlFor="bc-kind">Notice category</Label>
            <select
              id="bc-kind"
              value={draft.noticeKind}
              onChange={(e) =>
                onPatch({ noticeKind: e.target.value as AdminBroadcastKind })
              }
              className="h-10 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm"
              data-testid="bc-kind"
            >
              <option value="">Select a category…</option>
              {NOTICE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {NOTICE_KIND_LABELS[k]}
                </option>
              ))}
            </select>
            {errors.noticeKind && <FieldError message={errors.noticeKind} />}
          </div>
          <div className="space-y-1">
            <Label htmlFor="bc-message">Message</Label>
            <Textarea
              id="bc-message"
              value={draft.message}
              onChange={(e) => onPatch({ message: e.target.value })}
              maxLength={MESSAGE_MAX + 1}
              className="max-w-2xl"
              data-testid="bc-message"
            />
            <p className="text-xs text-muted-foreground">
              {draft.message.length}/{MESSAGE_MAX} characters. The backend
              prefixes this with the selected category tag.
            </p>
            {errors.message && <FieldError message={errors.message} />}
          </div>
        </>
      )}

      {type === "alert" && (
        <div className="space-y-1">
          <Label htmlFor="bc-alert">Open alert</Label>
          {contextLoading ? (
            <p className="text-sm text-muted-foreground">Loading alerts…</p>
          ) : alertOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No open alerts to broadcast.
            </p>
          ) : (
            <select
              id="bc-alert"
              value={draft.alertId}
              onChange={(e) => onPatch({ alertId: e.target.value })}
              className="h-10 w-full max-w-md rounded-md border border-input bg-background px-3 text-sm"
              data-testid="bc-alert"
            >
              <option value="">Select an alert…</option>
              {alertOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          {errors.alertId && <FieldError message={errors.alertId} />}
        </div>
      )}
    </>
  );
}

function ReasonField({
  draft,
  errors,
  onPatch,
}: {
  draft: ComposerDraft;
  errors: Partial<Record<BroadcastField, string>>;
  onPatch: (p: Partial<ComposerDraft>) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor="bc-reason">Reason (optional)</Label>
      <Input
        id="bc-reason"
        value={draft.reason}
        onChange={(e) => onPatch({ reason: e.target.value })}
        maxLength={REASON_MAX}
        className="max-w-2xl"
        data-testid="bc-reason"
      />
      <p className="text-xs text-muted-foreground">
        Up to {REASON_MAX} characters. Included in the message only when
        provided.
      </p>
      {errors.reason && <FieldError message={errors.reason} />}
    </div>
  );
}

function FieldError({ message }: { message: string }) {
  return (
    <p role="alert" className="text-xs text-destructive" data-testid="field-error">
      {message}
    </p>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
      data-testid="broadcast-error"
    >
      {message}
    </p>
  );
}

// ─── Preview ─────────────────────────────────────────────────────────────────

function PreviewCard({
  type,
  draft,
  sessionSelectedLabel,
  alertSelectedLabel,
  busy,
  error,
  onBack,
  onConfirm,
}: {
  type: BroadcastType;
  draft: ComposerDraft;
  sessionSelectedLabel: string | null;
  alertSelectedLabel: string | null;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>2 · Review broadcast</CardTitle>
        <CardDescription>
          Confirm the operation before it is queued. The recipients and final
          wording are decided by the backend.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <PreviewRow label="Type" value={TYPE_LABELS[type]} />
        <PreviewRow
          label="Target / context"
          value={contextSummary(type, draft, sessionSelectedLabel, alertSelectedLabel)}
        />
        <PreviewRow
          label="Message content"
          value={messageSummary(type, draft)}
          mono={type === "admin_notice"}
        />
        <PreviewRow label="Recipients" value={RECIPIENT_SCOPE[type]} />

        <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
          Queuing accepts the broadcast for delivery by the background pipeline.
          It does NOT confirm that any WhatsApp message was delivered.
        </div>

        {error && <ErrorBanner message={error} />}

        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={onBack} disabled={busy}>
            Back
          </Button>
          <Button
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-queue"
          >
            {busy ? "Queueing…" : "Confirm and queue"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function contextSummary(
  type: BroadcastType,
  draft: ComposerDraft,
  sessionLabel: string | null,
  alertLabel: string | null,
): string {
  switch (type) {
    case "queue_summary":
    case "doctor_delay":
      return `Queue session: ${sessionLabel ?? draft.queueSessionId}`;
    case "closure":
      return draft.closureDate
        ? `Closing sessions dated ${draft.closureDate}`
        : "Today's active queues";
    case "admin_notice":
      return draft.noticeKind
        ? `Category: ${NOTICE_KIND_LABELS[draft.noticeKind]}`
        : "—";
    case "alert":
      return `Alert: ${alertLabel ?? draft.alertId}`;
  }
}

/** Honest message preview (§11). Only the admin notice's exact text is shown —
 *  that is the text the composer supplies. The backend-generated messages are
 *  described as an operation, never reconstructed as a fake exact string. */
function messageSummary(type: BroadcastType, draft: ComposerDraft): string {
  const reason = draft.reason.trim();
  switch (type) {
    case "queue_summary":
      return "The backend composes each patient's queue snapshot (now serving, their token, patients ahead). Exact wording is generated server-side.";
    case "doctor_delay":
      return `The backend notifies each active patient that the doctor is running about ${
        draft.delayMinutes || "?"
      } minutes late${reason ? `, noting: "${reason}"` : ""}. Exact wording is generated server-side.`;
    case "closure":
      return `The backend notifies each still-active patient that the hospital is closing${
        reason ? `, noting: "${reason}"` : ""
      }. Exact wording is generated server-side.`;
    case "admin_notice":
      return `[${draft.noticeKind}] ${draft.message}`;
    case "alert":
      return "The backend delivers the alert's own severity and message to the hospital admins. Exact wording is generated server-side.";
  }
}

function PreviewRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-border py-2 sm:grid-cols-[10rem_1fr]">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={"text-sm " + (mono ? "font-mono" : "")}>{value}</dd>
    </div>
  );
}

// ─── Queued outcome ──────────────────────────────────────────────────────────

function QueuedCard({
  type,
  outcome,
  error,
  onAnother,
}: {
  type: BroadcastType;
  outcome: CommandCenterBroadcastResult | null;
  error: string | null;
  onAnother: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>3 · Broadcast queued</CardTitle>
        <CardDescription>
          The command-center backend accepted the {TYPE_LABELS[type]} request.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <ErrorBanner message={error} />
        ) : outcome ? (
          <div className="space-y-3">
            <Badge variant="secondary" data-testid="queued-badge">
              Broadcast queued
            </Badge>
            {/* The enqueued count is the SERVER's number, never an invented
                audience size; 0 is shown honestly (e.g. flag-gated). */}
            <p className="text-sm" data-testid="queued-summary">
              {outcome.enqueued === 0
                ? "The backend accepted the request and queued 0 messages — for a " +
                  "patient broadcast this is expected when WhatsApp queue updates " +
                  "are disabled for the hospital or no recipients qualify."
                : `The backend queued ${outcome.enqueued} message${
                    outcome.enqueued === 1 ? "" : "s"
                  } for delivery.`}
            </p>
            <p className="text-xs text-muted-foreground">
              Queued means accepted for the delivery pipeline, not that any
              message was delivered. Delivery status is out of scope for the
              composer.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No result returned.</p>
        )}

        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={onAnother} data-testid="compose-another">
            Compose another
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
