import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { listNotifications, type NotificationRow } from "@/api/reads";
import { describeError } from "@/lib/errors";
import { notificationStatus } from "@/lib/notificationStatus";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

/**
 * Read-only staff Notifications / delivery-status surface (Phase 7).
 *
 * Pure visibility: it lists the tenant's `notification_queue` rows (which
 * already carry WhatsApp-bound sends via `channel`) with their lifecycle
 * status, retry count, the queued/sent/delivered/failed timestamps and the
 * last error. There are deliberately NO actions here — no retry, resend,
 * cancel or dead-letter replay — those are future, separately-authorized
 * surfaces (§9). Reads flow React UI → `reads.ts` → PostgREST → RLS
 * (`notif_queue_admin`); the authenticated session, not a client-supplied
 * `hospital_id` route param, is the security boundary.
 */
export function Notifications() {
  const { hospitalId } = useAuth();
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!hospitalId) return;
    let active = true;
    setLoading(true);
    listNotifications(hospitalId)
      .then((r) => active && (setRows(r), setError(null)))
      .catch((e) => active && setError(describeError(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [hospitalId]);

  if (!hospitalId) {
    return <p className="text-muted-foreground">No hospital tenant attached.</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Notifications</h1>
        <p className="text-sm text-muted-foreground">
          Read-only delivery status for patient notifications, including
          WhatsApp sends.
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Delivery status</CardTitle>
          <CardDescription>
            Most recent first. Rows are scoped to your hospital by RLS.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : error ? (
            // A failed read is reported by the alert above; the card must not
            // imply "no records" for what is actually an error (§10).
            <p className="text-sm text-muted-foreground">
              Could not load notifications.
            </p>
          ) : rows === null || rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No notifications found.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Patient / Ref</TH>
                  <TH>Channel</TH>
                  <TH>Status</TH>
                  <TH>Retries</TH>
                  <TH>Queued</TH>
                  <TH>Sent</TH>
                  <TH>Delivered</TH>
                  <TH>Failed</TH>
                  <TH>Last error</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((n) => {
                  const status = notificationStatus(n.status);
                  return (
                    <TR key={n.id}>
                      <TD>
                        <div className="max-w-[12rem] truncate">
                          {n.recipient}
                        </div>
                        {n.booking_id && (
                          <Link
                            to={`/bookings/${n.booking_id}`}
                            className="text-xs text-primary hover:underline"
                          >
                            View booking
                          </Link>
                        )}
                      </TD>
                      <TD className="capitalize">{n.channel}</TD>
                      <TD>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </TD>
                      <TD className="font-mono">{n.retry_count}</TD>
                      <TD className="whitespace-nowrap text-xs">
                        {fmt(n.created_at)}
                      </TD>
                      <TD className="whitespace-nowrap text-xs">
                        {fmt(n.sent_at)}
                      </TD>
                      <TD className="whitespace-nowrap text-xs">
                        {fmt(n.delivered_at)}
                      </TD>
                      <TD className="whitespace-nowrap text-xs">
                        {fmt(n.failed_at)}
                      </TD>
                      <TD className="max-w-[16rem]">
                        {n.last_error ? (
                          <span
                            className="block truncate text-xs text-muted-foreground"
                            title={n.last_error}
                          >
                            {n.last_error}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            —
                          </span>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Render a stored timestamp for humans, or an em dash when the backend has
 *  not recorded that lifecycle stage yet. Never fabricates a value. */
function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}
