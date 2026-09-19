import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { doctorOps } from "@/api/doctorOps";
import { describeError } from "@/lib/errors";
import type { DoctorDashboard } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

/** Doctor consultation console (Phase 6 §13/§14). Exposes the already-proven
 *  doctor-operations workflow (start → call → consult → note → complete); the
 *  client adds no clinical logic and never writes state directly. */
export function DoctorConsole() {
  const { hospitalId } = useAuth();
  const [dash, setDash] = useState<DoctorDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [diagnosis, setDiagnosis] = useState("");

  const load = useCallback(async () => {
    if (!hospitalId) return;
    try {
      const res = await doctorOps.dashboard(hospitalId);
      setDash(res.dashboard ?? null);
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, [hospitalId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (fn: () => Promise<{ dashboard?: DoctorDashboard }>) => {
      if (!hospitalId || busy) return;
      setBusy(true);
      try {
        const res = await fn();
        if (res.dashboard) setDash(res.dashboard);
        else await load();
        setError(null);
      } catch (e) {
        setError(describeError(e));
      } finally {
        setBusy(false);
      }
    },
    [hospitalId, busy, load],
  );

  if (!hospitalId) {
    return <p className="text-muted-foreground">No hospital tenant attached.</p>;
  }

  const current = dash?.current_patient ?? null;
  const consulting = !!current?.consultation_started_at;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Doctor console</h1>
          <p className="text-sm text-muted-foreground">
            Consultation workflow driven by the backend.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={busy}>
          Refresh
        </Button>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {!dash ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !dash.has_session ? (
        <Card>
          <CardHeader>
            <CardTitle>No session active</CardTitle>
            <CardDescription>
              Start your session to begin calling patients from the queue.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              disabled={busy}
              onClick={() => void run(() => doctorOps.startSession(hospitalId))}
            >
              Start session
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(() => doctorOps.callNext(dash.queue_session_id!, hospitalId))
              }
            >
              Call next
            </Button>
            {current && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(() => doctorOps.recall(dash.queue_session_id!, hospitalId))
                }
              >
                Recall current
              </Button>
            )}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>
                {current ? `Now: ${current.patient_name}` : "No patient called"}
              </CardTitle>
              <CardDescription>
                {current
                  ? `Token #${current.token_number ?? "—"} · ${current.status.replace("_", " ")}`
                  : "Call the next patient to begin."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {current && (
                <>
                  <div className="flex gap-2">
                    {!consulting ? (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            doctorOps.startConsultation(
                              dash.queue_session_id!,
                              current.booking_id,
                              hospitalId,
                            ),
                          )
                        }
                      >
                        Start consultation
                      </Button>
                    ) : (
                      <Badge variant="success">In consultation</Badge>
                    )}
                  </div>

                  {consulting && (
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="note">Consultation note</Label>
                        <Textarea
                          id="note"
                          rows={4}
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="Clinical notes…"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="diagnosis">Diagnosis summary</Label>
                        <Textarea
                          id="diagnosis"
                          rows={2}
                          value={diagnosis}
                          onChange={(e) => setDiagnosis(e.target.value)}
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          disabled={busy || !note.trim()}
                          onClick={() =>
                            void run(() =>
                              doctorOps.saveNote(
                                current.booking_id,
                                hospitalId,
                                note.trim(),
                                diagnosis.trim() || undefined,
                                dash.queue_session_id,
                              ),
                            )
                          }
                        >
                          Save note
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              doctorOps.completeConsultation(
                                dash.queue_session_id!,
                                current.booking_id,
                                hospitalId,
                              ),
                            )
                          }
                        >
                          Complete consultation
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Waiting</CardTitle>
            </CardHeader>
            <CardContent>
              {!dash.next_patients?.length ? (
                <p className="text-sm text-muted-foreground">Queue is empty.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Pos</TH>
                      <TH>Token</TH>
                      <TH>Patient</TH>
                      <TH>Est. wait</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {dash.next_patients.map((p) => (
                      <TR key={p.booking_id}>
                        <TD>{p.position}</TD>
                        <TD className="font-mono">{p.token_number ?? "—"}</TD>
                        <TD>{p.patient_name}</TD>
                        <TD>{p.estimated_wait_minutes ?? "—"}m</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
