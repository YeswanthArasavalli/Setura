import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function Login() {
  const { signIn, error, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const from = (location.state as { from?: { pathname: string } })?.from ?? "/";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      navigate(from, { replace: true });
    } catch {
      // signIn() already stored a safe message in `error`.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>SETURA Staff Console</CardTitle>
          <CardDescription>Sign in with your hospital staff account.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy || loading}>
              {busy || loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>

          {import.meta.env.DEV && (
            <div className="mt-4 rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              <p className="mb-1 font-medium">Local demo accounts (password: Setura@123)</p>
              <ul className="space-y-0.5">
                <li>reception@surya.test — receptionist</li>
                <li>dr@surya.test — doctor</li>
                <li>admin@surya.test — hospital admin</li>
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
