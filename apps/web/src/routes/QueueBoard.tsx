import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { getQueueSnapshot, queueControl } from "@/api/queue";
import { listDoctorNames, listTodaysBookings, type BookingRow } from "@/api/reads";
import { describeError } from "@/lib/errors";
import { todayISO } from "@/lib/dates";
import type { QueueControlAction, QueueSnapshot } from "@/types/api";
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

/** Live queue board (Phase 6 §12). Every control action goes through the
 *  existing queue-control Edge Function, which returns a fresh snapshot so the
 *  UI converges to DB truth in one round-trip. No queue state machine is
 *  reimplemented client-side. */
export function QueueBoard() {
  const { hospitalId } = useAuth();
  const [sessions, setSessions] = useState<BookingRow[]>([]);
  const [doctorNames, setDoctorNames] = useState<Map<string, string>>(
    new Map(),
  );
  const [sessionId, setSessionId] = useState<string>("");
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!hospitalId) return;
    let active = true;
    listTodaysBookings(hospitalId, todayISO())
      .then((r) => {
        if (!active) return;
        const queued = r.filter((b) => b.queue_session_id);
        setSessions(queued);
        setError(null);
        // Label each session with its doctor (migration 61 exposes the
        // directory read to same-hospital staff); failures degrade to the
        // neutral fallback label and never block the queue itself.
        const ids = [
          ...new Set(
            queued.map((b) => b.assigned_doctor_id).filter((v): v is string =>
              !!v,
            ),
          ),
        ];
        return listDoctorNames(ids).then((names) => {
          if (active) setDoctorNames(names);
        }).catch(() => {
          // Directory read is a labelling nicety only: keep the queue usable
          // with neutral labels rather than surfacing a failure here.
          if (active) setDoctorNames(new Map());
        });
      })
      .catch((e) => active && setError(describeError(e)));
    return () => {
      active = false;
    };
  }, [hospitalId]);

  // Distinct active sessions today, keyed by queue_session_id. A session is
  // per-doctor, so the doctor is the only label reception can act on; "Session
  // N" was ambiguous once more than one doctor was calling.
  const sessionOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of sessions) {
      if (!b.queue_session_id || map.has(b.queue_session_id)) continue;
      const doctor = b.assigned_doctor_id
        ? doctorNames.get(b.assigned_doctor_id)
        : undefined;
      map.set(
        b.queue_session_id,
        doctor ? `Dr. ${doctor}` : `Queue ${map.size + 1}`,
      );
    }
    return [...map.entries()];
  }, [sessions, doctorNames]);

  useEffect(() => {
    if (!sessionId) setSessionId(sessionOptions[0]?.[0] ?? "");
  }, [sessionOptions, sessionId]);

  const refresh = useCallback(async () => {
    if (!hospitalId || !sessionId) return;
    try {
      setSnapshot(await getQueueSnapshot(sessionId, hospitalId));
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, [hospitalId, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (action: QueueControlAction, bookingId?: string) => {
      if (!hospitalId || !sessionId || busy) return;
      setBusy(true);
      try {
        const res = await queueControl({ queueSessionId: sessionId, action, bookingId }, hospitalId);
        setSnapshot(res.snapshot);
        setError(null);
      } catch (e) {
        setError(describeError(e));
      } finally {
        setBusy(false);
      }
    },
    [hospitalId, sessionId, busy],
  );

  if (!hospitalId) {
    return <p className="text-muted-foreground">No hospital tenant attached.</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Queue board</h1>
          <p className="text-sm text-muted-foreground">
            Reception controls for the live token queue.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {sessionOptions.length > 0 && (
            <select
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              {sessionOptions.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          )}
          <Button variant="outline" onClick={() => void refresh()} disabled={!sessionId || busy}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {sessionOptions.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No active queue sessions today.
          </CardContent>
        </Card>
      ) : !snapshot ? (
        <p className="text-sm text-muted-foreground">Loading queue…</p>
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-4 p-4 text-sm">
              <div>
                <span className="text-muted-foreground">Now serving </span>
                <span className="font-mono text-lg font-semibold">
                  {snapshot.currently_called
                    ? `#${snapshot.currently_called.token_number}`
                    : "—"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Live token </span>
                <span className="font-mono font-semibold">
                  {snapshot.session.current_live_token}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Waiting </span>
                <span className="font-semibold">{snapshot.waiting.length}</span>
              </div>
              {snapshot.session.is_paused && (
                <Badge variant="warning">Paused</Badge>
              )}
              <div className="ml-auto flex gap-2">
                {snapshot.session.is_paused ? (
                  <Button size="sm" onClick={() => void act("resume")} disabled={busy}>
                    Resume intake
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => void act("pause")} disabled={busy}>
                    Pause intake
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Waiting</CardTitle>
              <CardDescription>Actions call the queue-control Edge Function.</CardDescription>
            </CardHeader>
            <CardContent>
              {snapshot.waiting.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nobody waiting.</p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Pos</TH>
                      <TH>Token</TH>
                      <TH>Patient</TH>
                      <TH>Status</TH>
                      <TH>Est. wait</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {snapshot.waiting.map((w) => (
                      <TR key={w.booking_id}>
                        <TD>{w.position}</TD>
                        <TD className="font-mono font-semibold">{w.token_number}</TD>
                        <TD>{w.patient_name}</TD>
                        <TD>
                          <Badge variant={statusVariant(w.status)}>
                            {w.status.replace("_", " ")}
                          </Badge>
                        </TD>
                        <TD>{w.estimated_wait_minutes}m</TD>
                        <TD className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" onClick={() => void act("call", w.booking_id)} disabled={busy}>
                              Call
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => void act("skip", w.booking_id)} disabled={busy}>
                              Skip
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => void act("mark_absent", w.booking_id)} disabled={busy}>
                              Absent
                            </Button>
                          </div>
                        </TD>
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
