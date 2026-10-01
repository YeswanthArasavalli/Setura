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
import { AdminPortfolio } from "@/routes/AdminPortfolio";

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
        {/* G-10: read-only Alert-Center surface over the existing alert-center
            list + analytics reads. Same hospital_admin + global_admin UX
            boundary as G-03/G-05/G-06/G-09; the Edge Function re-authorizes
            role + tenant and the alert RPCs stay service-role-only. No mutation
            action is reachable from this page. */}
        <Route
          path="/admin/alerts"
          element={
            <RequireRole roles={[...ADMIN_ROLES]}>
              <AdminAlerts />
            </RequireRole>
          }
        />
        <Route path="/bookings/:bookingId" element={<BookingDetail />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
