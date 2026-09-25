import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { cancelBooking } from "@/api/cancellations";
import {
  getBooking,
  listConsultationNotes,
  listDoctorNames,
  type BookingRow,
  type ConsultationNoteRow,
} from "@/api/reads";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { describeError } from "@/lib/errors";
import {
  canOfferCancellation,
  cancellationOutcome,
  cancellationReasonError,
  mayOfferRefund,
  refundOutcomeLabel,
} from "@/lib/cancellationStatus";
import { paymentStatus } from "@/lib/paymentStatus";
import type { CancelBookingResponse } from "@/types/api";
import { Badge, statusVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** Roles `cancel-booking` admits via requireRole. Rendering the control for
 *  them is a convenience only — the Edge Function re-authorizes every call, so
 *  this list is never the security boundary. */
const CANCELLATION_ROLES = [
  "receptionist",
  "hospital_admin",
  "global_admin",
] as const;

/** Booking detail + payment/billing state (Phase 6 §15/§16). All amounts are
 *  read from the backend's immutable fee snapshot on the booking row; the
 *  client never recomputes a fee and never reads the payment ledger directly
 *  (staff have no SELECT on it — the snapshot is the authorized surface).
 *  The payment badge is derived by the shared `paymentStatus` mapping, so the
 *  reception list and this page cannot disagree. */
export function BookingDetail() {
  const { hospitalId, role } = useAuth();
  const { bookingId } = useParams<{ bookingId: string }>();
  const [row, setRow] = useState<BookingRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<ConsultationNoteRow[] | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [notesLoading, setNotesLoading] = useState(true);
  const [doctorNames, setDoctorNames] = useState<Map<string, string>>(
    new Map(),
  );
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [wantRefund, setWantRefund] = useState(false);
  const [cancelResult, setCancelResult] = useState<CancelBookingResponse | null>(
    null,
  );

  useEffect(() => {
    if (!hospitalId || !bookingId) return;
    let active = true;
    setLoading(true);
    getBooking(hospitalId, bookingId)
      .then((r) => active && (setRow(r), setError(null)))
      .catch((e) => active && setError(describeError(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [hospitalId, bookingId]);

  // Clinical notes load independently of the booking row: migration 63's
  // RLS policy decides visibility, so an unauthorized deep-link simply
  // yields zero rows here, exactly as it does in the database.
  useEffect(() => {
    if (!hospitalId || !bookingId) return;
    let active = true;
    setNotesLoading(true);
    listConsultationNotes(hospitalId, bookingId)
      .then((r) => active && (setNotes(r), setNotesError(null)))
      .catch((e) => active && setNotesError(describeError(e)))
      .finally(() => active && setNotesLoading(false));
    return () => {
      active = false;
    };
  }, [hospitalId, bookingId]);

  // Human names for the treating/authoring doctors via the existing
  // directory read; purely cosmetic, a failure leaves labels absent.
  useEffect(() => {
    const ids = [
      ...new Set(
        [
          row?.assigned_doctor_id,
          ...(notes ?? []).map((n) => n.doctor_id),
        ].filter((v): v is string => Boolean(v)),
      ),
    ];
    if (ids.length === 0) return;
    let active = true;
    listDoctorNames(ids)
      .then((m) => active && setDoctorNames(m))
      .catch(() => {
        /* names are optional labels, never a security decision */
      });
    return () => {
      active = false;
    };
  }, [row?.assigned_doctor_id, notes]);

  /** Reload the booking from the backend. Used after a cancellation attempt so
   *  the page renders the database's state rather than anything the client
   *  assumed; a failed reload keeps the row already on screen and only adds an
   *  error banner, so the page is never blanked by a cancellation problem. */
  const refetch = useCallback(async () => {
    if (!hospitalId || !bookingId) return;
    try {
      setRow(await getBooking(hospitalId, bookingId));
    } catch (e) {
      setError(describeError(e));
    }
  }, [hospitalId, bookingId]);

  // One idempotency key per logical cancellation, reused across retries by
  // useAsyncAction, so a double-click replays instead of re-transitioning.
  const cancel = useAsyncAction(
    useCallback(
      (key: string, id: string, tenant: string) =>
        cancelBooking(
          {
            bookingId: id,
            cancellationReason: reason,
            initiateRefund: wantRefund,
          },
          tenant,
          key,
        ),
      [reason, wantRefund],
    ),
  );

  const closeConfirm = useCallback(() => {
    setConfirming(false);
    setReason("");
    setWantRefund(false);
  }, []);

  const submitCancellation = useCallback(async () => {
    if (!hospitalId || !bookingId) return;
    if (cancellationReasonError(reason)) return; // defensive: button is disabled
    const res = await cancel.run(bookingId, hospitalId);
    if (res) {
      setCancelResult(res);
      closeConfirm();
    }
    // Always reload after an attempt — the transition succeeded, was already
    // done, or was rejected (a concurrency rejection means the row moved while
    // the form was open). The page must show the database's state, never an
    // optimistic local `status = "cancelled"`.
    await refetch();
  }, [hospitalId, bookingId, reason, cancel, closeConfirm, refetch]);

  if (!hospitalId) {
    return <p className="text-muted-foreground">No hospital tenant attached.</p>;
  }

  // Doctor label only from the readable directory row (never fabricated).
  const doctorId = row?.assigned_doctor_id ?? notes?.[0]?.doctor_id ?? null;
  const doctorLabel = doctorId
    ? doctorNames.get(doctorId) ?? null
    : null;

  // Cancellation display: the outcome comes from the booking row the database
  // returned, the control from the backend's own role list. Both are render
  // decisions — `cancel-booking` re-enforces role, tenant and state.
  const cancellation = row ? cancellationOutcome(row) : null;
  const canCancel =
    !!row &&
    (CANCELLATION_ROLES as readonly (string | null)[]).includes(role ?? null) &&
    canOfferCancellation(row.status);
  const reasonError = cancellationReasonError(reason);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Booking</h1>
        <Link to="/reception" className="text-sm text-primary hover:underline">
          ← Back to dashboard
        </Link>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !row ? (
        <p className="text-sm text-muted-foreground">
          Booking not found or not visible to your account.
        </p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{row.patient_name}</CardTitle>
              <CardDescription>
                {row.patient_phone} · Ref {row.booking_reference ?? "—"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Status">
                <Badge variant={statusVariant(row.status)}>
                  {row.status.replace("_", " ")}
                </Badge>
              </Row>
              <Row label="Token">
                <span className="font-mono">{row.token_number ?? "—"}</span>
              </Row>
              <Row label="Source">{row.booking_source}</Row>
              <Row label="Date">{row.appointment_date}</Row>
              {row.estimated_wait_minutes != null && (
                <Row label="Est. wait">{row.estimated_wait_minutes}m</Row>
              )}
              {row.consultation_started_at && (
                <Row label="Consult started">
                  {new Date(row.consultation_started_at).toLocaleString()}
                </Row>
              )}
              {row.consultation_completed_at && (
                <Row label="Consult completed">
                  {new Date(row.consultation_completed_at).toLocaleString()}
                </Row>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Payment &amp; billing</CardTitle>
              <CardDescription>Snapshot written by the backend.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Payment">
                <PaymentBadge row={row} />
              </Row>
              {row.payment_status_detail && (
                <Row label="Detail">{row.payment_status_detail}</Row>
              )}
              <Row label="Platform fee">₹{fmt(row.platform_fee_snapshot)}</Row>
              <Row label="Receptionist fee">₹{fmt(row.receptionist_fee_snapshot)}</Row>
              <Row label="Hospital fee">₹{fmt(row.hospital_fee_snapshot)}</Row>
              <Row label="Total">
                <span className="font-semibold">₹{fmt(row.total_amount_snapshot)}</span>
              </Row>
              {row.booking_fee_inr != null && (
                <Row label="Booking fee">₹{fmt(row.booking_fee_inr)}</Row>
              )}
              {row.payment_reference && (
                <Row label="Reference">
                  <span className="font-mono">{row.payment_reference}</span>
                </Row>
              )}
            </CardContent>
          </Card>

          {(cancellation || canCancel || cancelResult) && row && (
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Cancellation</CardTitle>
                <CardDescription>
                  {cancellation
                    ? "Cancellation outcome as recorded on the booking row."
                    : "Cancelling runs the existing cancel-booking path, which re-checks role, tenant and current state."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {cancellation && (
                  <>
                    <Row label="Status">
                      <Badge variant={statusVariant("cancelled")}>
                        {cancellation.label}
                      </Badge>
                    </Row>
                    <div>
                      <p className="font-medium">Cancellation reason</p>
                      {/* Staff free text: rendered as plain React text, never
                          HTML, and never rewritten by the client. */}
                      {cancellation.reason ? (
                        <p className="break-words whitespace-pre-wrap text-muted-foreground">
                          {cancellation.reason}
                        </p>
                      ) : (
                        <p className="text-muted-foreground">
                          No cancellation reason was recorded.
                        </p>
                      )}
                    </div>
                    {cancellation.cancelledAt && (
                      <Row label="Cancelled at">
                        {new Date(cancellation.cancelledAt).toLocaleString()}
                      </Row>
                    )}
                  </>
                )}

                {cancelResult && (
                  <p className="rounded-md bg-muted p-3">
                    {cancelResult.alreadyCancelled
                      ? "Cancellation already completed"
                      : "Cancellation completed"}
                    {" · "}
                    {refundOutcomeLabel(cancelResult.refundInitiated)}
                  </p>
                )}

                {canCancel && (
                  <div className="space-y-3">
                    {!!cancel.error && (
                      <p
                        role="alert"
                        className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
                      >
                        {describeError(cancel.error)}
                      </p>
                    )}

                    {!confirming ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                          setCancelResult(null);
                          setConfirming(true);
                        }}
                        disabled={cancel.running}
                      >
                        Cancel booking
                      </Button>
                    ) : (
                      <div className="space-y-3 rounded-md border border-border p-3">
                        <p className="font-medium">Confirm cancellation</p>
                        <p className="text-muted-foreground">
                          This cancels token{" "}
                          <span className="font-mono">
                            {row.token_number ?? "—"}
                          </span>{" "}
                          for {row.patient_name} on {row.appointment_date}. The
                          backend verifies the booking is still in state{" "}
                          <span className="font-mono">{row.status}</span>{" "}
                          before it changes anything.
                        </p>

                        <div className="space-y-1">
                          <Label htmlFor="cancellation-reason">
                            Cancellation reason
                          </Label>
                          <Textarea
                            id="cancellation-reason"
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="Why is this booking being cancelled?"
                            disabled={cancel.running}
                          />
                          {reason.length > 0 && reasonError && (
                            <p
                              role="alert"
                              className="text-xs text-destructive"
                            >
                              {reasonError}
                            </p>
                          )}
                        </div>

                        {mayOfferRefund(row) && (
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <input
                                id="cancel-request-refund"
                                type="checkbox"
                                className="h-4 w-4 rounded border-input"
                                checked={wantRefund}
                                onChange={(e) => setWantRefund(e.target.checked)}
                                disabled={cancel.running}
                              />
                              <Label htmlFor="cancel-request-refund">
                                Request a refund
                              </Label>
                            </div>
                            {/* The UI sends a boolean only: no amount, no
                                validity decision (D16). */}
                            <p className="text-xs text-muted-foreground">
                              Sends this request to the existing backend refund
                              path. The backend decides whether a refund is made
                              and for how much.
                            </p>
                          </div>
                        )}

                        <div className="flex gap-2">
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => void submitCancellation()}
                            disabled={cancel.running || !!reasonError}
                          >
                            {cancel.running
                              ? "Submitting cancellation…"
                              : "Confirm cancellation"}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={closeConfirm}
                            disabled={cancel.running}
                          >
                            Keep booking
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Consultation</CardTitle>
              <CardDescription>
                Persisted clinical record, shown exactly as stored.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {doctorLabel && (
                <Row label="Doctor">{doctorLabel}</Row>
              )}
              <Row label="Status">
                <Badge variant={statusVariant(row.status)}>
                  {row.status.replace("_", " ")}
                </Badge>
              </Row>

              {notesError ? (
                <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  {notesError}
                </p>
              ) : notesLoading ? (
                <p className="text-muted-foreground">Loading…</p>
              ) : (notes ?? []).length === 0 ? (
                <p className="text-muted-foreground">
                  No clinical notes recorded.
                </p>
              ) : (
                (notes ?? []).map((note, i) => (
                  <div
                    key={note.id}
                    className="space-y-2 rounded-md border border-border p-3"
                  >
                    {(notes ?? []).length > 1 && (
                      <p className="text-xs text-muted-foreground">
                        Note {i + 1} · recorded{" "}
                        {new Date(note.created_at).toLocaleString()}
                      </p>
                    )}
                    <div>
                      <p className="font-medium">Clinical Notes</p>
                      {note.notes.trim() ? (
                        <p className="whitespace-pre-wrap">{note.notes}</p>
                      ) : (
                        <p className="text-muted-foreground">
                          No clinical notes recorded.
                        </p>
                      )}
                    </div>
                    <div>
                      <p className="font-medium">Diagnosis</p>
                      {note.diagnosis_summary?.trim() ? (
                        <p className="whitespace-pre-wrap">
                          {note.diagnosis_summary}
                        </p>
                      ) : (
                        <p className="text-muted-foreground">
                          No diagnosis recorded.
                        </p>
                      )}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

/** Payment badge for one booking row. Presentation only: the two authoritative
 *  fields (`payment_completed`, then `booking_fee_inr`) are mapped by the
 *  shared helper so an INR 0 walk-in no longer reads as an unpaid payment. */
function PaymentBadge({ row }: { row: BookingRow }) {
  const status = paymentStatus(row);
  return <Badge variant={status.variant}>{status.label}</Badge>;
}

function fmt(n: number | null): string {
  return (n ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 0 });
}
