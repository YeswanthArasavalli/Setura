import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { RequireRole } from "@/auth/RequireRole";
import { AppShell } from "@/components/AppShell";
import { Login } from "@/routes/Login";
import { ReceptionDashboard } from "@/routes/ReceptionDashboard";
import { BookAppointment } from "@/routes/BookAppointment";
import { WalkIn } from "@/routes/WalkIn";
import { Patients } from "@/routes/Patients";
import { Notifications } from "@/routes/Notifications";
import { QueueBoard } from "@/routes/QueueBoard";
import { DoctorConsole } from "@/routes/DoctorConsole";
import { BookingDetail } from "@/routes/BookingDetail";
import { AdminCommandCentre } from "@/routes/AdminCommandCentre";
import { AdminAudit } from "@/routes/AdminAudit";
import { AdminReports } from "@/routes/AdminReports";
import { AdminFinancial } from "@/routes/AdminFinancial";
import { AdminAlerts } from "@/routes/AdminAlerts";
import { AdminOperations } from "@/routes/AdminOperations";
import { AdminPortfolio } from "@/routes/AdminPortfolio";
import { HospitalOnboarding } from "@/routes/HospitalOnboarding";
import { HospitalConfiguration } from "@/routes/HospitalConfiguration";
import { IntegrationConfiguration } from "@/routes/IntegrationConfiguration";
import { ClinicalConfiguration } from "@/routes/ClinicalConfiguration";
import { BroadcastComposer } from "@/routes/BroadcastComposer";

const RECEPTION_ROLES = ["receptionist", "hospital_admin"] as const;
const DOCTOR_ROLES = ["doctor", "hospital_admin"] as const;
// G-03: the admin surface mirrors the backend's own command-center role gate
// (hospital_admin | global_admin). This is a UX boundary only — the Edge
// Function re-enforces requireRole server-side on every read.
const ADMIN_ROLES = ["hospital_admin", "global_admin"] as const;
// G-08: the cross-tenant portfolio surface mirrors the backend's own scope
// rule — `executive-analytics` answers `portfolio`/`benchmarks` for a
// `global_admin` and returns 403 FORBIDDEN for everyone else, hospital admins
// included. Unlike the other admin routes this list is deliberately NOT
// widened to `hospital_admin`.
const GLOBAL_ADMIN_ROLES = ["global_admin"] as const;

/** Send each role to its natural home after login (Phase 6 §5 role routing;
 *  G-03 gives the admin roles their dedicated Command Centre destination). */
function Landing() {
  const { role } = useAuth();
  if (role === "doctor") return <Navigate to="/doctor" replace />;
  if (role === "hospital_admin" || role === "global_admin")
    return <Navigate to="/admin" replace />;
  if (role === "receptionist") return <Navigate to="/reception" replace />;
  return <div className="p-8 text-muted-foreground">No console for this role.</div>;
}

export default function App() {
  const { session, loading } = useAuth();

  if (!loading && !session) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireRole roles={[...RECEPTION_ROLES, ...DOCTOR_ROLES, ...ADMIN_ROLES]}>
            <AppShell />
          </RequireRole>
        }
      >
        <Route index element={<Landing />} />
        <Route
          path="/reception"
          element={
            <RequireRole roles={[...RECEPTION_ROLES]}>
              <ReceptionDashboard />
            </RequireRole>
          }
        />
        <Route
          path="/reception/book"
          element={
            <RequireRole roles={[...RECEPTION_ROLES]}>
              <BookAppointment />
            </RequireRole>
          }
        />
        <Route
          path="/reception/walk-in"
          element={
            <RequireRole roles={[...RECEPTION_ROLES]}>
              <WalkIn />
            </RequireRole>
          }
        />
        <Route
          path="/reception/patients"
          element={
            <RequireRole roles={[...RECEPTION_ROLES]}>
              <Patients />
            </RequireRole>
          }
        />
        <Route
          path="/reception/notifications"
          element={
            <RequireRole roles={[...RECEPTION_ROLES]}>
              <Notifications />
            </RequireRole>
          }
        />
        <Route
          path="/queue"
          element={
            <RequireRole roles={[...RECEPTION_ROLES]}>
              <QueueBoard />
            </RequireRole>
          }
        />
        <Route
          path="/doctor"
          element={
            <RequireRole roles={[...DOCTOR_ROLES]}>
              <DoctorConsole />
            </RequireRole>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireRole roles={[...ADMIN_ROLES]}>
              <AdminCommandCentre />
            </RequireRole>
          }
        />
        <Route
          path="/admin/audit"
          element={
            <RequireRole roles={[...ADMIN_ROLES]}>
              <AdminAudit />
            </RequireRole>
          }
        />
        {/* G-06: executive / operational reports viewer. Same admin-only UX
            boundary as G-03/G-05; the backend re-authorizes role + tenant. */}
        <Route
          path="/admin/reports"
          element={
            <RequireRole roles={[...ADMIN_ROLES]}>
              <AdminReports />
            </RequireRole>
          }
        />
        {/* G-09: read-only Finance / Collections surface over the existing
            financial-command-center reads. Same hospital_admin + global_admin
            UX boundary as G-03/G-05/G-06; the Edge Function re-authorizes
            role + tenant and the financial RPCs stay service-role-only. */}
        <Route
          path="/admin/financial"
          element={
            <RequireRole roles={[...ADMIN_ROLES]}>
              <AdminFinancial />
            </RequireRole>
          }
        />
        {/* G-08: global-admin-only, read-only portfolio/benchmark surface over
            the existing tenant-free `executive-analytics` global actions. The
            guard is a UX boundary; the Edge Function is authoritative. */}
        <Route
          path="/admin/portfolio"
          element={
            <RequireRole roles={[...GLOBAL_ADMIN_ROLES]}>
              <AdminPortfolio />
            </RequireRole>
          }
        />
        {/* WS-ONBOARD-1: global-admin-only tenant provisioning. `global_admin`
            ONLY (a hospital admin must not even see the entry) mirrors the
            backend's own `requireRole(['global_admin'])` and the RPC's DB-layer
            re-check. The route guard is a UX boundary; the Edge Function and the
            service-role RPC remain the security and creation authority. */}
        <Route
          path="/admin/onboarding"
          element={
            <RequireRole roles={[...GLOBAL_ADMIN_ROLES]}>
              <HospitalOnboarding />
            </RequireRole>
          }
        />
        {/* WS-ONBOARD-2: hospital configuration write surface. Both admin
            roles can edit their own tenant; a hospital_admin's tenant is
            enforced by the backend (the RPC re-checks actor role + tenant),
            and the acting-hospital context in useAuth() controls which
            tenant a global_admin edits here. The route guard is a UX
            boundary; the Edge Function and the RPC remain the security and
            write authority. */}
        <Route
          path="/admin/hospital-settings"
          element={
            <RequireRole roles={[...ADMIN_ROLES]}>
              <HospitalConfiguration />
            </RequireRole>
          }
        />
        {/* WS-ONBOARD-3: integration configuration + secure credential
            management surface. Both admin roles open their own tenant's
            public identifiers + enablement; only a global_admin can rotate
            the platform-global secret (the rotate_secret RPC re-checks the
            actor role at the DB layer). The route guard is a UX boundary;
            the Edge Function and the RPCs remain the security and write
            authority, and no read path can ever return a stored secret. */}
        <Route
          path="/admin/integrations"
          element={
            <RequireRole roles={[...ADMIN_ROLES]}>
              <IntegrationConfiguration />
            </RequireRole>
          }
        />
        {/* WS-ONBOARD-4: clinical configuration (departments, doctors, weekly
            schedules, leave). Both admin roles configure their own tenant. The
            route guard is a UX boundary only: the Edge Function re-resolves the
            JWT, re-checks requireRole + the X-Hospital-ID tenant and calls
            service-role-only SECURITY DEFINER RPCs, each of which re-checks the
            actor role and the entity's hospital at the DB layer. One page with
            four tabs, so this is one navigation entry rather than four. */}
        <Route
          path="/admin/clinical-configuration"
          element={
            <RequireRole roles={[...ADMIN_ROLES]}>
              <ClinicalConfiguration />
            </RequireRole>
          }
        />
        {/* G-10 read + G-UI lifecycle-mutation Alert-Center surface over the
            existing alert-center function (list + analytics reads plus
            acknowledge / resolve / escalate / suppress). Same hospital_admin +
            global_admin UX boundary as G-03/G-05/G-06/G-09; the Edge Function
            re-authorizes role + tenant and the alert RPCs stay service-role-only,
            so the UI controls are a convenience, never the security boundary. */}
        <Route
          path="/admin/alerts"
          element={
            <RequireRole roles={[...ADMIN_ROLES]}>
              <AdminAlerts />
            </RequireRole>
          }
        />
        {/* G-11: read-only Hospital Operations Analytics surface over the two
            existing tenant-scoped executive-analytics reads
            (daily_operations + doctor_rankings). Same hospital_admin +
            global_admin UX boundary as G-03/G-05/G-06/G-09/G-10; the Edge
            Function re-authorizes role + tenant and the analytics RPCs stay
            service-role-only. No mutation and no cross-hospital aggregation
            is reachable from this page (GLOBAL_ACTIONS remain G-08's). */}
        <Route
          path="/admin/operations"
          element={
            <RequireRole roles={[...ADMIN_ROLES]}>
              <AdminOperations />
            </RequireRole>
          }
        />
        {/* C2b: Broadcast Composer over the existing command-center `broadcast_*`
            actions. Same hospital_admin + global_admin UX boundary as the other
            admin surfaces; the Edge Function re-authorizes role + tenant on
            every request and owns recipients, message text and idempotency, so
            these controls are a convenience, never the security boundary. */}
        <Route
          path="/admin/broadcast"
          element={
            <RequireRole roles={[...ADMIN_ROLES]}>
              <BroadcastComposer />
            </RequireRole>
          }
        />
        <Route path="/bookings/:bookingId" element={<BookingDetail />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
