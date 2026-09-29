import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  roles: string[];
}

const NAV: NavItem[] = [
  { to: "/reception", label: "Dashboard", roles: ["receptionist", "hospital_admin", "global_admin"] },
  { to: "/reception/book", label: "Appointment", roles: ["receptionist", "hospital_admin", "global_admin"] },
  { to: "/reception/walk-in", label: "Walk-in", roles: ["receptionist", "hospital_admin", "global_admin"] },
  { to: "/reception/patients", label: "Patients", roles: ["receptionist", "hospital_admin", "global_admin"] },
  { to: "/reception/notifications", label: "Notifications", roles: ["receptionist", "hospital_admin", "global_admin"] },
  { to: "/queue", label: "Queue / Tokens", roles: ["receptionist", "hospital_admin", "global_admin"] },
  { to: "/doctor", label: "Doctor Console", roles: ["doctor", "hospital_admin", "global_admin"] },
  // G-03: admin-only surface. Receptionist and doctor must not even see the
  // entry; the route itself is guarded again and the backend is authoritative.
  { to: "/admin", label: "Command Centre", roles: ["hospital_admin", "global_admin"] },
  // G-05: same admin-only boundary for the audit & compliance viewer.
  { to: "/admin/audit", label: "Audit & Compliance", roles: ["hospital_admin", "global_admin"] },
];

export function AppShell() {
  const { staff, signOut } = useAuth();
  const role = staff?.role ?? "";
  const items = NAV.filter((n) => n.roles.includes(role));

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-base font-semibold tracking-tight">
              SETURA <span className="text-muted-foreground">Staff Console</span>
            </span>
            <Badge variant="secondary">{role.replace("_", " ")}</Badge>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <div className="hidden text-right sm:block">
              <div className="font-medium">{staff?.fullName}</div>
              <div className="text-xs text-muted-foreground font-mono">
                {staff?.hospitalId ?? "no tenant"}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-2">
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                cn(
                  "whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground",
                  isActive && "border-primary text-foreground",
                )
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
