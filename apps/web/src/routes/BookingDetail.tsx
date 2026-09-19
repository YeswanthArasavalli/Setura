import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { getBooking, type BookingRow } from "@/api/reads";
import { describeError } from "@/lib/errors";
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
 *  (staff have no SELECT on it — the snapshot is the authorized surface). */
export function BookingDetail() {
  const { hospitalId } = useAuth();
  const { bookingId } = useParams<{ bookingId: string }>();
  const [row, setRow] = useState<BookingRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  if (!hospitalId) {
    return <p className="text-muted-foreground">No hospital tenant attached.</p>;
  }

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
                <Badge variant={row.payment_completed ? "success" : "secondary"}>
                  {row.payment_completed ? "Paid" : "Pending"}
                </Badge>
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

function fmt(n: number | null): string {
  return (n ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 0 });
}
