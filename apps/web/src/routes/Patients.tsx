import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import {
  listPatientHistory,
  searchPatients,
  type BookingRow,
  type PatientRow,
} from "@/api/reads";
import { describeError } from "@/lib/errors";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge, statusVariant } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

/** Patient find + full authorized visit history (Phase 6 §10/§17). Reads are
 *  RLS-scoped; the client filters but the database enforces tenancy. */
export function Patients() {
  const { hospitalId } = useAuth();
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<PatientRow[] | null>(null);
  const [selected, setSelected] = useState<PatientRow | null>(null);
  const [history, setHistory] = useState<BookingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hospitalId) return;
    let active = true;
    const t = setTimeout(() => {
      searchPatients(hospitalId, term)
        .then((r) => active && (setResults(r), setError(null)))
        .catch((e) => active && setError(describeError(e)));
    }, 300);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [term, hospitalId]);

  useEffect(() => {
    if (!hospitalId || !selected) {
      setHistory(null);
      return;
    }
    let active = true;
    listPatientHistory(hospitalId, selected.id)
      .then((r) => active && (setHistory(r), setError(null)))
      .catch((e) => active && setError(describeError(e)));
    return () => {
      active = false;
    };
  }, [selected, hospitalId]);

  if (!hospitalId) {
    return <p className="text-muted-foreground">No hospital tenant attached.</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Patients</h1>
        <p className="text-sm text-muted-foreground">
          Find a patient by name or phone, then review their full visit history.
        </p>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Search</CardTitle>
            <CardDescription>Tenant-scoped via RLS.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              autoFocus
              placeholder="Name or phone…"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            />
            {results === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : results.length === 0 ? (
              <p className="text-sm text-muted-foreground">No matches.</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {results.map((p) => (
                  <li key={p.id}>
                    <Button
                      variant="ghost"
                      className="h-auto w-full justify-start py-2"
                      onClick={() => setSelected(p)}
                    >
                      <div className="text-left">
                        <div className="font-medium">{p.full_name}</div>
                        <div className="text-xs text-muted-foreground">
                          {p.normalized_phone}
                          {p.village ? ` · ${p.village}` : ""}
                          {p.total_visits != null ? ` · ${p.total_visits} visits` : ""}
                        </div>
                      </div>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              {selected ? `History — ${selected.full_name}` : "History"}
            </CardTitle>
            <CardDescription>
              {selected
                ? `${selected.normalized_phone}`
                : "Select a patient to view visits."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!selected ? null : history === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : history.length === 0 ? (
              <p className="text-sm text-muted-foreground">No visits recorded.</p>
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Date</TH>
                    <TH>Token</TH>
                    <TH>Status</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {history.map((b) => (
                    <TR key={b.id}>
                      <TD>{b.appointment_date}</TD>
                      <TD className="font-mono">{b.token_number ?? "—"}</TD>
                      <TD>
                        <Badge variant={statusVariant(b.status)}>
                          {b.status.replace("_", " ")}
                        </Badge>
                      </TD>
                      <TD className="text-right">
                        <Link
                          to={`/bookings/${b.id}`}
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
    </div>
  );
}
