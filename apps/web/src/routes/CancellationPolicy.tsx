import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  getCancellationPolicy,
  updateCancellationPolicy,
  type CancellationPolicyPatch,
} from "@/api/cancellationPolicy";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CancellationPolicyReadResponseBody } from "@/types/api";

/**
 * WS-CONF-1 - Hospital Cancellation Policy Configuration.
 *
 * A professional admin surface over the `cancellation-policy` Edge Function and
 * its two canonical `get_cancellation_policy` / `update_cancellation_policy`
 * RPCs (migration 72). Accessible to `hospital_admin` (edits their own tenant)
 * and `global_admin` (edits the acting-hospital tenant). The route guard is a
 * UX boundary; the Edge Function and the service-role RPC are the security and
 * write authority.
 *
 * The frontend owns NOTHING of the write path. It sends a deliberate field-level
 * patch built by comparing the current server snapshot to the local edit buffer;
 * the RPC applies it atomically, bumps `version` so the EXISTING
 * trg_cancel_policy_history trigger records the prior snapshot, and the Edge
 * layer emits one audit event via the existing `logAuditEvent` primitive.
 *
 * This page configures the hospital's OWN refund-policy inputs (windows, refund
 * percentages, no-show penalty, manual-full-refund allowance, notes). It never
 * computes a refund and never invents business policy - the canonical
 * `calculate_refund_amount` engine remains the sole consumer.
 *
 * Truthful outcomes: a save shows "Saved" only after the server returns 200; an
 * expected-version conflict maps to an honest "someone else changed this"
 * message with a Reload action; a validation 422 surfaces the client-safe
 * backend message. A submission uses one stable idempotency key minted by
 * `useAsyncAction`; the backend's existing `api_idempotency_keys` registry is
 * what actually prevents duplicate mutations, versions and audits.
 */

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: CancellationPolicyReadResponseBody };

export interface EditBuffer {
  fullRefundWithinMinutes: string;
  partialRefundWithinMinutes: string;
  partialRefundPercentage: string;
  sameDayRefundPercentage: string;
  noShowPenaltyEnabled: boolean;
  noShowPenaltyAmountInr: string;
  allowManualFullRefund: boolean;
  notes: string;
}

const numStr = (v: string | number | null | undefined): string =>
  v === null || v === undefined ? "" : String(v);

function bufferFrom(
  snap: CancellationPolicyReadResponseBody,
): EditBuffer {
  const p = snap.policy;
  return {
    fullRefundWithinMinutes: numStr(p.full_refund_within_minutes),
    partialRefundWithinMinutes: numStr(p.partial_refund_within_minutes),
    partialRefundPercentage: numStr(p.partial_refund_percentage),
    sameDayRefundPercentage: numStr(p.same_day_refund_percentage),
    noShowPenaltyEnabled: !!p.no_show_penalty_enabled,
    noShowPenaltyAmountInr: numStr(p.no_show_penalty_amount_inr),
    allowManualFullRefund: !!p.allow_manual_full_refund,
    notes: p.notes ?? "",
  };
}

export type FieldKey = keyof EditBuffer;

export function CancellationPolicy() {
  const { staff, hospitalId } = useAuth();
  const canAccess =
    staff?.role === "hospital_admin" || staff?.role === "global_admin";

  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [buffer, setBuffer] = useState<EditBuffer | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [banner, setBanner] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!hospitalId || !canAccess) return;
    setLoad({ kind: "loading" });
    setBanner(null);
    try {
      const snap = await getCancellationPolicy(hospitalId);
      setLoad({ kind: "ready", snapshot: snap });
      setBuffer(bufferFrom(snap));
      setErrors({});
    } catch (err) {
      setLoad({ kind: "error", message: describeError(err) });
    }
  }, [hospitalId, canAccess]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useAsyncAction<[], { status: "noop" | "saved"; version: number }>(
    useCallback(
      async (key) => {
        if (load.kind !== "ready" || !buffer || !hospitalId) {
          return { status: "noop" as const, version: 0 };
        }
        const { patch, errors: fieldErrors } = buildPatch(
          load.snapshot,
          buffer,
        );
        setErrors(fieldErrors);
        if (Object.keys(fieldErrors).length > 0) {
          throw new Error("Fix the highlighted fields before saving.");
        }
        if (!patch) {
          return { status: "noop" as const, version: load.snapshot.version };
        }
        const result = await updateCancellationPolicy(hospitalId, key, {
          expectedVersion: load.snapshot.version,
          patch,
        });
        return {
          status: result.updated ? ("saved" as const) : ("noop" as const),
          version: result.version,
        };
      },
      [load, buffer, hospitalId],
    ),
  );

  const hasEdits = useMemo(() => {
    if (load.kind !== "ready" || !buffer) return false;
    const { patch } = buildPatch(load.snapshot, buffer);
    return patch !== undefined;
    // Recompute only when the buffer or loaded snapshot identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer, load.kind === "ready" ? load.snapshot.version : null]);

  const set = <K extends FieldKey>(key: K, value: EditBuffer[K]) => {
    setBuffer((b) => (b ? { ...b, [key]: value } : b));
    setBanner(null);
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  if (!canAccess) {
    return (
      <div className="p-8 text-muted-foreground">
        Cancellation policy configuration is restricted to hospital and global
        administrators.
      </div>
    );
  }
  if (!hospitalId) {
    return (
      <div className="p-8 text-muted-foreground">
        Waiting for a request context (no acting hospital).
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">
          Cancellation Policy{" "}
          <span className="text-sm font-normal text-muted-foreground">
            — Refund windows & penalties
          </span>
        </h1>
        <p className="text-sm text-muted-foreground">
          Configure when and how much of the booking / platform fee is refunded
          on cancellation. These are your hospital&apos;s own policy inputs; the
          server computes the refund. Changing this never affects completed
          refunds.
        </p>
      </div>

      {load.kind === "loading" && (
        <p className="text-sm text-muted-foreground">Loading policy…</p>
      )}
      {load.kind === "error" && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            {load.message}
          </p>
          <Button size="sm" variant="outline" onClick={() => void reload()}>
            Retry
          </Button>
        </div>
      )}

      {load.kind === "ready" && buffer && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Refund tiers</CardTitle>
              <CardDescription>
                Current policy version{" "}
                <Badge variant="secondary">v{load.snapshot.version}</Badge>
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field
                id="full-min"
                label="Free cancellation within (minutes)"
                hint="100% refund at or before this many minutes before the appointment"
                value={buffer.fullRefundWithinMinutes}
                error={errors.fullRefundWithinMinutes}
                onChange={(v) => set("fullRefundWithinMinutes", v)}
              />
              <Field
                id="partial-min"
                label="Partial-refund window (minutes)"
                hint="Last chance window for a partial refund"
                value={buffer.partialRefundWithinMinutes}
                error={errors.partialRefundWithinMinutes}
                onChange={(v) => set("partialRefundWithinMinutes", v)}
              />
              <Field
                id="partial-pct"
                label="Partial refund (%)"
                hint="0–100"
                value={buffer.partialRefundPercentage}
                error={errors.partialRefundPercentage}
                onChange={(v) => set("partialRefundPercentage", v)}
              />
              <Field
                id="same-day-pct"
                label="Same-day cancellation refund (%)"
                hint="0–100, applies when the appointment is today"
                value={buffer.sameDayRefundPercentage}
                error={errors.sameDayRefundPercentage}
                onChange={(v) => set("sameDayRefundPercentage", v)}
              />
              <Field
                id="noshow-amt"
                label="No-show penalty (₹)"
                hint="Deducted from any future refund; 0 to disable"
                value={buffer.noShowPenaltyAmountInr}
                error={errors.noShowPenaltyAmountInr}
                onChange={(v) => set("noShowPenaltyAmountInr", v)}
              />
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={buffer.noShowPenaltyEnabled}
                    onChange={(e) =>
                      set("noShowPenaltyEnabled", e.target.checked)
                    }
                    data-testid="noshow-enabled"
                  />
                  No-show penalty enabled
                </label>
              </div>
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={buffer.allowManualFullRefund}
                    onChange={(e) =>
                      set("allowManualFullRefund", e.target.checked)
                    }
                    data-testid="manual-refund-enabled"
                  />
                  Allow hospital admin to grant a manual full refund
                </label>
              </div>
              <div className="sm:col-span-2 flex flex-col gap-1">
                <Label htmlFor="notes">Notes</Label>
                <textarea
                  id="notes"
                  className="min-h-[64px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={buffer.notes}
                  onChange={(e) => set("notes", e.target.value)}
                  data-testid="notes"
                />
                {errors.notes && (
                  <p className="text-xs text-destructive">{errors.notes}</p>
                )}
              </div>
            </CardContent>
          </Card>

          <div className="flex items-center gap-3">
            <Button
              onClick={() => {
                void save.run().then((r) => {
                  if (!r) return;
                  if (r.status === "noop") setBanner("No changes to save.");
                  else {
                    // Reload first: `reload()` clears the banner synchronously,
                    // so the success message must be set AFTER it resolves or
                    // React batching would never show it.
                    void reload().then(() =>
                      setBanner(`Saved. New version ${r.version}.`),
                    );
                  }
                }).catch(() => {
                  /* error surfaced via save.error below */
                });
              }}
              disabled={save.running || !hasEdits}
              data-testid="save-btn"
            >
              {save.running ? "Saving…" : "Save policy"}
            </Button>
            <Button
              variant="outline"
              onClick={() => void reload()}
              disabled={save.running}
              data-testid="reload-btn"
            >
              Reload
            </Button>
          </div>

          {save.error && (
            <p role="alert" className="text-sm text-destructive">
              {describeError(save.error)}
            </p>
          )}
          {banner && (
            <p className="text-sm text-muted-foreground" data-testid="banner">
              {banner}
            </p>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Version history</CardTitle>
              <CardDescription>
                Prior policy snapshots, newest first.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {load.snapshot.history.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No prior versions recorded yet.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {load.snapshot.history.map((h) => (
                    <li
                      key={`${h.version}-${h.created_at}`}
                      className="flex items-center justify-between gap-3 py-2 text-sm"
                    >
                      <span className="font-medium">v{h.version}</span>
                      <span className="text-muted-foreground">
                        {new Date(h.created_at).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  value: string;
  error?: string;
  onChange: (v: string) => void;
}

function Field({ id, label, hint, value, error, onChange }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={id}
      />
      {hint && !error && (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** Compare the edit buffer to the loaded snapshot and produce the minimal
 *  field-level patch, or `undefined` when nothing changed. Numeric fields are
 *  validated here so a bad value becomes a per-field error, not a server round
 *  trip; the RPC remains the authoritative validator. Exported for tests,
 *  exactly like the HospitalConfiguration helpers. */
export function buildPatch(
  snap: CancellationPolicyReadResponseBody,
  buf: EditBuffer,
): { patch?: CancellationPolicyPatch; errors: Partial<Record<FieldKey, string>> } {
  const errors: Partial<Record<FieldKey, string>> = {};
  const patch: CancellationPolicyPatch = {};
  const p = snap.policy;

  const intField = (
    raw: string,
    key: FieldKey,
    current: number,
  ): number | undefined => {
    if (raw.trim() === "") {
      errors[key] = "Required";
      return undefined;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      errors[key] = "Must be a whole number ≥ 0";
      return undefined;
    }
    return n !== current ? n : undefined;
  };

  const pctField = (
    raw: string,
    key: FieldKey,
    current: string | number,
  ): number | undefined => {
    if (raw.trim() === "") {
      errors[key] = "Required";
      return undefined;
    }
    const n = Number(raw);
    if (Number.isNaN(n) || n < 0 || n > 100) {
      errors[key] = "Must be between 0 and 100";
      return undefined;
    }
    return n !== Number(current) ? n : undefined;
  };

  const moneyField = (
    raw: string,
    key: FieldKey,
    current: string | number,
  ): number | undefined => {
    if (raw.trim() === "") {
      errors[key] = "Required";
      return undefined;
    }
    const n = Number(raw);
    if (Number.isNaN(n) || n < 0) {
      errors[key] = "Must be a number ≥ 0";
      return undefined;
    }
    return n !== Number(current) ? n : undefined;
  };

  const full = intField(
    buf.fullRefundWithinMinutes,
    "fullRefundWithinMinutes",
    Number(p.full_refund_within_minutes),
  );
  if (full !== undefined) patch.full_refund_within_minutes = full;

  const partialMin = intField(
    buf.partialRefundWithinMinutes,
    "partialRefundWithinMinutes",
    Number(p.partial_refund_within_minutes),
  );
  if (partialMin !== undefined) patch.partial_refund_within_minutes = partialMin;

  const partialPct = pctField(
    buf.partialRefundPercentage,
    "partialRefundPercentage",
    p.partial_refund_percentage,
  );
  if (partialPct !== undefined) patch.partial_refund_percentage = partialPct;

  const samePct = pctField(
    buf.sameDayRefundPercentage,
    "sameDayRefundPercentage",
    p.same_day_refund_percentage,
  );
  if (samePct !== undefined) patch.same_day_refund_percentage = samePct;

  const nsAmt = moneyField(
    buf.noShowPenaltyAmountInr,
    "noShowPenaltyAmountInr",
    p.no_show_penalty_amount_inr,
  );
  if (nsAmt !== undefined) patch.no_show_penalty_amount_inr = nsAmt;

  if (buf.noShowPenaltyEnabled !== !!p.no_show_penalty_enabled) {
    patch.no_show_penalty_enabled = buf.noShowPenaltyEnabled;
  }
  if (buf.allowManualFullRefund !== !!p.allow_manual_full_refund) {
    patch.allow_manual_full_refund = buf.allowManualFullRefund;
  }
  const notes = buf.notes.trim();
  if (notes !== (p.notes ?? "")) {
    if (notes.length > 2000) errors.notes = "Too long (max 2000 characters)";
    else patch.notes = notes;
  }

  // Cross-tier ordering, mirrored from the DB CHECK, to fail locally first.
  const effFull =
    patch.full_refund_within_minutes ?? Number(p.full_refund_within_minutes);
  const effPartial =
    patch.partial_refund_within_minutes ??
    Number(p.partial_refund_within_minutes);
  if (effFull > effPartial && !errors.fullRefundWithinMinutes) {
    errors.fullRefundWithinMinutes =
      "Must not exceed the partial-refund window";
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }
  const changed = Object.keys(patch).length > 0;
  return { patch: changed ? patch : undefined, errors };
}
