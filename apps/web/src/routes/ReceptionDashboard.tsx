import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { listTodaysBookings, type BookingRow } from "@/api/reads";
import { describeError } from "@/lib/errors";
import { todayISO } from "@/lib/dates";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge, statusVariant } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

/** Operational reception dashboard (Phase 6 §8): today's real state, not decoration. */
export function ReceptionDashboard() {
  const { staff, hospitalId } = useAuth();
  const [rows, setRows] = useState<BookingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hospitalId) return;
    let active = true;
    listTodaysBookings(hospitalId, todayISO())
      .then((r) => active && (setRows(r), setError(null)))
      .catch((e) => active && setError(describeError(e)));
    return () => {
      active = false;
    };
  }, [hospitalId]);

  if (!hospitalId) {
    return (
      <p className="text-muted-foreground">
        No hospital tenant is attached to your account.
      </p>
    );
  }

  const byStatus = (rows ?? []).reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  const waiting = (rows ?? []).filter((r) =>
    ["checked_in", "waiting"].includes(r.status),
  );
  const current = (rows ?? []).find((r) => r.status === "called");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Welcome, {staff?.fullName}</h1>
          <p className="text-sm text-muted-foreground">
            Reception console · {todayISO()}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/reception/book"
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            New appointment
          </Link>
          <Link
            to="/reception/walk-in"
            className="inline-flex h-10 items-center justify-center rounded-md bg-secondary px-4 text-sm font-medium text-secondary-foreground hover:bg-secondary/80"
          >
            New walk-in
          </Link>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Today's bookings" value={rows ? String(rows.length) : "…"} />
        <Stat label="Waiting" value={rows ? String(waiting.length) : "…"} />
        <Stat
          label="Currently called"
          value={current ? `#${current.token_number}` : "—"}
        />
        <Stat
          label="Completed"
          value={rows ? String(byStatus["completed"] ?? 0) : "…"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Today's appointments</CardTitle>
          <CardDescription>
            Read from the booking table under RLS — tenant-scoped by the
            database, not the client.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rows === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No bookings today.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Token</TH>
                  <TH>Patient</TH>
                  <TH>Source</TH>
                  <TH>Status</TH>
                  <TH>Payment</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-mono font-semibold">
                      {r.token_number ?? "—"}
                    </TD>
                    <TD>{r.patient_name}</TD>
                    <TD className="text-muted-foreground">{r.booking_source}</TD>
                    <TD>
                      <Badge variant={statusVariant(r.status)}>
                        {r.status.replace("_", " ")}
                      </Badge>
                    </TD>
                    <TD>{r.payment_completed ? "Paid" : "Pending"}</TD>
                    <TD className="text-right">
                      <Link
                        to={`/bookings/${r.id}`}
                        className="text-primary hover:underline"
                      >
                        View
                      </Link>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-2xl font-semibold">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}
