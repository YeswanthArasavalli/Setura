import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import {
  getBooking,
  listConsultationNotes,
  listDoctorNames,
  type BookingRow,
  type ConsultationNoteRow,
} from "@/api/reads";
import { describeError } from "@/lib/errors";
import { paymentStatus } from "@/lib/paymentStatus";
import { Badge, statusVariant } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/** Booking detail + payment/billing state (Phase 6 §15/§16). All amounts are
 *  read from the backend's immutable fee snapshot on the booking row; the
 *  client never recomputes a fee and never reads the payment ledger directly
 *  (staff have no SELECT on it — the snapshot is the authorized surface).
 *  The payment badge is derived by the shared `paymentStatus` mapping, so the
 *  reception list and this page cannot disagree. */
export function BookingDetail() {
  const { hospitalId } = useAuth();
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

  if (!hospitalId) {
    return <p className="text-muted-foreground">No hospital tenant attached.</p>;
  }

  // Doctor label only from the readable directory row (never fabricated).
  const doctorId = row?.assigned_doctor_id ?? notes?.[0]?.doctor_id ?? null;
  const doctorLabel = doctorId
    ? doctorNames.get(doctorId) ?? null
    : null;

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
