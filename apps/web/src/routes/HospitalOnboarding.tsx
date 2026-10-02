import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  fetchActingHospitalContext,
  type ActingHospitalContext,
} from "@/api/portfolio";
import { provisionHospital, type ProvisionHospitalInput } from "@/api/onboarding";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { describeError } from "@/lib/errors";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ProvisionHospitalResponseBody } from "@/types/api";

/**
 * WS-ONBOARD-1 — Hospital Tenant Onboarding (global_admin only).
 *
 * Lets a global_admin create a new, working hospital tenant entirely from the
 * UI — no SQL, no seed editing, no environment changes, no developer help. It is
 * a FORM → REVIEW → CONFIRM → PROVISIONING → RESULT surface over the EXISTING
 * `provision-hospital` Edge Function and its single canonical
 * `provision_hospital` RPC.
 *
 * The frontend owns NOTHING of provisioning. It sends only the hospital identity
 * fields; the backend resolves the actor from the JWT, requires `global_admin`,
 * re-checks the role inside the RPC, creates the `hospitals` row and lets the
 * existing trigger create the default `hospital_settings`. This page never
 * touches a privileged key, never writes SQL and never decides tenancy — the
 * `global_admin` route guard is a UX boundary; the Edge Function is the
 * security boundary (§14).
 *
 * Scope is WS-ONBOARD-1 ONLY: it creates the tenant + system defaults. It does
 * NOT add doctors/staff/patients (no fake identities — the success step lists
 * that as the next action), does NOT edit `hospital_settings` (WS-ONBOARD-2) and
 * does NOT configure Razorpay / Meta credentials (WS-ONBOARD-3).
 *
 * Idempotency & double-submit: a submission uses one stable idempotency key minted
 * by `useAsyncAction`, reused across retries of the SAME logical action, and the
 * backend's EXISTING `api_idempotency_keys` registry makes a replay return the
 * stored result rather than create a duplicate. The button is disabled in flight
 * and `useAsyncAction` swallows a double-click — but the backend, not the UI, is
 * what actually prevents a duplicate tenant.
 *
 * Truthful outcomes (§12/§18): a failure renders the backend's client-safe
 * message via `describeError` (401/403/422/409/500 map to honest guidance) and is
 * never dressed as a success; a duplicate slug shows as a conflict, not a silent
 * pass. Success shows the SERVER-returned hospital identity, never an optimistic
 * fabrication.
 */

type Stage = "form" | "review" | "done";

type FieldKey =
  | "name"
  | "slug"
  | "phone"
  | "email"
  | "country"
  | "state"
  | "district"
  | "town"
  | "address"
  | "timezone";

interface Draft {
  name: string;
  slug: string;
  phone: string;
  email: string;
  country: string;
  state: string;
  district: string;
  town: string;
  address: string;
  timezone: string;
}

const EMPTY_DRAFT: Draft = {
  name: "",
  slug: "",
  phone: "",
  email: "",
  country: "",
  state: "",
  district: "",
  town: "",
  address: "",
  timezone: "",
};

// Backend `Schema` limits, mirrored here for usability only — the backend is
// authoritative. (name 2..200, slug 2..96 + SLUG_RE, phone 20, email 254,
// location fields 120, address 500, timezone 64.)
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Slugify a display name into a URL-safe token. Exported so tests can pin it. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

/** Field-level validation mirroring the exact backend constraints. Returns an
 *  empty object when the draft is submittable. Exported so tests can drive the
 *  validator directly, independent of rendering. */
export function validateOnboarding(
  draft: Draft,
): Partial<Record<FieldKey, string>> {
  const errors: Partial<Record<FieldKey, string>> = {};

  const name = draft.name.trim();
  if (!name) {
    errors.name = "Hospital name is required.";
  } else if (name.length < 2 || name.length > 200) {
    errors.name = "Name must be 2 to 200 characters.";
  }

  const slug = draft.slug.trim();
  if (!slug) {
    errors.slug = "A unique slug is required.";
  } else if (slug.length < 2 || slug.length > 96) {
    errors.slug = "Slug must be 2 to 96 characters.";
  } else if (!SLUG_RE.test(slug)) {
    errors.slug =
      "Slug must be lowercase letters and numbers, separated by single hyphens.";
  }

  if (draft.phone.trim() && draft.phone.trim().length > 20) {
    errors.phone = "Phone must be 20 characters or fewer.";
  }
  const email = draft.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = "Enter a valid email address.";
  } else if (email.length > 254) {
    errors.email = "Email must be 254 characters or fewer.";
  }

  const len = (v: string) => v.trim().length;
  if (len(draft.country) > 120) errors.country = "Max 120 characters.";
  if (len(draft.state) > 120) errors.state = "Max 120 characters.";
  if (len(draft.district) > 120) errors.district = "Max 120 characters.";
  if (len(draft.town) > 120) errors.town = "Max 120 characters.";
  if (len(draft.address) > 500) errors.address = "Max 500 characters.";
  if (len(draft.timezone) > 64) errors.timezone = "Max 64 characters.";

  return errors;
}

/** Normalize the draft into the exact backend body fields, trimming values and
 *  omitting blank optional fields so the server default applies. */
export function toProvisionInput(draft: Draft): ProvisionHospitalInput {
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);
  return {
    name: draft.name.trim(),
    slug: draft.slug.trim().toLowerCase(),
    phone: opt(draft.phone),
    email: opt(draft.email),
    country: opt(draft.country),
    state: opt(draft.state),
    district: opt(draft.district),
    town: opt(draft.town),
    address: opt(draft.address),
    timezone: opt(draft.timezone),
  };
}

export function HospitalOnboarding() {
  const { staff, hospitalId } = useAuth();
  const isGlobalAdmin = staff?.role === "global_admin";

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [slugDirty, setSlugDirty] = useState(false);
  const [stage, setStage] = useState<Stage>("form");
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<ProvisionHospitalResponseBody | null>(
    null,
  );

  const activeRef = useRef(true);
  const actingAttemptedRef = useRef(false);

  // Bounded acting context, reused from the established G-08/C2b pattern ONLY to
  // satisfy the shared `callFunction` transport header. The provision endpoint
  // ignores this value entirely — it is not a tenant filter for a create.
  const [acting, setActing] = useState<ActingHospitalContext | null>(null);
  const [actingError, setActingError] = useState<string | null>(null);
  const scopeHospitalId = hospitalId ?? acting?.hospitalId ?? null;

  const submit = useAsyncAction(
    useCallback(
      (key: string, tenant: string, input: ProvisionHospitalInput) =>
        provisionHospital(tenant, key, input),
      [],
    ),
  );

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isGlobalAdmin || hospitalId || actingAttemptedRef.current) return;
    actingAttemptedRef.current = true;
    fetchActingHospitalContext()
      .then((ctx) => {
        if (!activeRef.current) return;
        if (ctx) setActing(ctx);
        else {
          setActingError(
            "No hospital exists yet to satisfy the required request context.",
          );
        }
      })
      .catch((e) => {
        if (activeRef.current) setActingError(describeError(e));
      });
  }, [isGlobalAdmin, hospitalId]);

  // Surface a rejection honestly (§18). Read from reactive state, not the stale
  // closure value, because `run()` returns null for both a rejection and a
  // swallowed double-submit.
  useEffect(() => {
    if (submit.error) {
      setSubmitError(describeError(submit.error));
      setStage("review");
    }
  }, [submit.error]);

  // Derive the success transition from the last completed response.
  const lastResult = submit.data;
  useEffect(() => {
    if (lastResult && stage !== "done") {
      setCreated(lastResult);
      setSubmitError(null);
      setStage("done");
    }
  }, [lastResult, stage]);

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const onNameChange = (value: string) => {
    setDraft((d) => ({
      ...d,
      name: value,
      // Keep the slug in sync until the user edits it deliberately.
      slug: slugDirty ? d.slug : slugify(value),
    }));
  };

  const selectedFields = useMemo(
    () =>
      (
        [
          ["Country", draft.country.trim()],
          ["State", draft.state.trim()],
          ["District", draft.district.trim()],
          ["Town", draft.town.trim()],
          ["Timezone", draft.timezone.trim()],
          ["Phone", draft.phone.trim()],
          ["Email", draft.email.trim()],
          ["Address", draft.address.trim()],
        ] as [string, string][]
      ).filter(([, v]) => v),
    [draft],
  );

  if (!isGlobalAdmin) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Hospital Onboarding</h1>
        <p className="text-sm text-muted-foreground">
          Tenant provisioning is restricted to global administrators. The
          backend re-authorizes every request regardless of what is shown here.
        </p>
      </div>
    );
  }

  if (!scopeHospitalId) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">Hospital Onboarding</h1>
        {actingError ? (
          <ErrorBanner message={actingError} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Waiting for a request context the shared transport requires. No
            tenant can be provisioned yet.
          </p>
        )}
      </div>
    );
  }

  const goToReview = () => {
    const v = validateOnboarding(draft);
    setErrors(v);
    setSubmitError(null);
    if (Object.keys(v).length === 0) setStage("review");
  };

  const confirmAndProvision = async () => {
    const v = validateOnboarding(draft);
    setErrors(v);
    if (Object.keys(v).length > 0) {
      setStage("form");
      return;
    }
    setSubmitError(null);
    await submit.run(scopeHospitalId, toProvisionInput(draft));
    // Success/failure are driven by the reactive effects above; one click is one
    // in-flight request.
  };

  const startAnother = () => {
    setDraft(EMPTY_DRAFT);
    setSlugDirty(false);
    setStage("form");
    setErrors({});
    setCreated(null);
    setSubmitError(null);
    submit.reset();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            Hospital Onboarding{" "}
            <span className="text-sm font-normal text-muted-foreground">
              — Provision a new tenant
            </span>
          </h1>
          <p className="text-sm text-muted-foreground">
            {staff?.fullName} · creates a new hospital tenant and its default
            configuration through the existing provisioning service. The backend
            authorizes your role and owns the tenant creation; nothing is written
            from the browser.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Request context sent as the required transport header:{" "}
            <span className="font-mono">{scopeHospitalId}</span>
            {acting
              ? " — your account has no hospital of its own, so this id satisfies the shared transport only; it does not scope or limit the tenant being created."
              : " — taken from your session."}
          </p>
        </div>
      </div>

      <StageIndicator stage={stage} />

      {stage === "done" ? (
        <SuccessCard created={created} onAnother={startAnother} />
      ) : stage === "review" ? (
        <ReviewCard
          draft={draft}
          selectedFields={selectedFields}
          busy={submit.running}
          error={submitError}
          onBack={() => {
            setStage("form");
            setSubmitError(null);
          }}
          onConfirm={() => void confirmAndProvision()}
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>1 · Hospital details</CardTitle>
            <CardDescription>
              Only the fields needed to create the tenant. Name and slug are
              required; everything else is optional and, when left blank, uses
              the platform default chosen by the server.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                id="ho-name"
                label="Hospital name"
                required
                value={draft.name}
                error={errors.name}
                onChange={onNameChange}
                placeholder="Sunrise Multi-Speciality Hospital"
              />
              <TextField
                id="ho-slug"
                label="Slug (unique URL identifier)"
                required
                mono
                value={draft.slug}
                error={errors.slug}
                hint="Lowercase letters and numbers, hyphen-separated. Auto-filled from the name until you edit it."
                onChange={(value) => {
                  setSlugDirty(true);
                  patch({ slug: value.toLowerCase() });
                }}
                placeholder="sunrise-hospital"
              />
              <TextField
                id="ho-phone"
                label="Phone (optional)"
                value={draft.phone}
                error={errors.phone}
                onChange={(value) => patch({ phone: value })}
              />
              <TextField
                id="ho-email"
                label="Email (optional)"
                value={draft.email}
                error={errors.email}
                onChange={(value) => patch({ email: value })}
              />
              <TextField
                id="ho-country"
                label="Country (optional)"
                value={draft.country}
                error={errors.country}
                hint="Blank uses the platform default."
                onChange={(value) => patch({ country: value })}
              />
              <TextField
                id="ho-state"
                label="State (optional)"
                value={draft.state}
                error={errors.state}
                onChange={(value) => patch({ state: value })}
              />
              <TextField
                id="ho-district"
                label="District (optional)"
                value={draft.district}
                error={errors.district}
                onChange={(value) => patch({ district: value })}
              />
              <TextField
                id="ho-town"
                label="Town (optional)"
                value={draft.town}
                error={errors.town}
                onChange={(value) => patch({ town: value })}
              />
              <TextField
                id="ho-timezone"
                label="Timezone (optional)"
                value={draft.timezone}
                error={errors.timezone}
                onChange={(value) => patch({ timezone: value })}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="ho-address">Address (optional)</Label>
              <Input
                id="ho-address"
                value={draft.address}
                onChange={(e) => patch({ address: e.target.value })}
                data-testid="ho-address"
              />
              {errors.address && <FieldError message={errors.address} />}
            </div>

            <div className="flex items-center gap-3">
              <Button onClick={goToReview} data-testid="to-review">
                Review tenant
              </Button>
              <span className="text-xs text-muted-foreground">
                Nothing is created until you confirm on the next step.
              </span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Stage indicator ─────────────────────────────────────────────────────────

function StageIndicator({ stage }: { stage: Stage }) {
  const steps: { key: Stage; label: string }[] = [
    { key: "form", label: "Details" },
    { key: "review", label: "Review" },
    { key: "done", label: "Provisioned" },
  ];
  const order: Stage[] = ["form", "review", "done"];
  const current = order.indexOf(stage);
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Onboarding stage">
      {steps.map((s, i) => {
        const reached = i <= current;
        return (
          <li key={s.key} className="flex items-center gap-2">
            <span
              data-testid={`stage-${s.key}`}
              className={
                "rounded-full border px-2 py-0.5 " +
                (reached
                  ? "border-primary text-foreground"
                  : "border-border text-muted-foreground")
              }
            >
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <span className="text-muted-foreground">→</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ─── Text field ──────────────────────────────────────────────────────────────

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  required,
  mono,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  required?: boolean;
  mono?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={mono ? "font-mono" : undefined}
        data-testid={id}
      />
      {hint && !error && (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
      {error && <FieldError message={error} />}
    </div>
  );
}

function FieldError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="text-xs text-destructive"
      data-testid="field-error"
    >
      {message}
    </p>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
      data-testid="onboarding-error"
    >
      {message}
    </p>
  );
}

// ─── Review ──────────────────────────────────────────────────────────────────

function ReviewCard({
  draft,
  selectedFields,
  busy,
  error,
  onBack,
  onConfirm,
}: {
  draft: Draft;
  selectedFields: [string, string][];
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>2 · Review tenant</CardTitle>
        <CardDescription>
          Confirm before the tenant is created. The service applies platform
          defaults for anything left blank and re-checks your authorization
          server-side.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <PreviewRow label="Name" value={draft.name.trim()} />
        <PreviewRow label="Slug" value={draft.slug.trim().toLowerCase()} mono />
        {selectedFields.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No optional details provided — the server will apply its defaults.
          </p>
        ) : (
          selectedFields.map(([label, value]) => (
            <PreviewRow key={label} label={label} value={value} />
          ))
        )}

        <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
          This creates the hospital tenant and its default settings only. Doctors,
          staff and payment / messaging credentials are configured separately
          after the tenant exists.
        </div>

        {error && <ErrorBanner message={error} />}

        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={onBack} disabled={busy}>
            Back
          </Button>
          <Button
            onClick={onConfirm}
            disabled={busy}
            data-testid="confirm-provision"
          >
            {busy ? "Provisioning…" : "Confirm and provision"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PreviewRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-1 border-b border-border py-2 sm:grid-cols-[10rem_1fr]">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={"text-sm " + (mono ? "font-mono" : "")}>{value || "—"}</dd>
    </div>
  );
}

// ─── Success ─────────────────────────────────────────────────────────────────

function SuccessCard({
  created,
  onAnother,
}: {
  created: ProvisionHospitalResponseBody | null;
  onAnother: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>3 · Tenant provisioned</CardTitle>
        <CardDescription>
          The provisioning service created the hospital and its default
          configuration. The identity below is returned by the server.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {created ? (
          <div className="space-y-3">
            <Badge variant="secondary" data-testid="provisioned-badge">
              Hospital created
            </Badge>
            <PreviewRow label="Name" value={created.name} />
            <PreviewRow label="Slug" value={created.slug} mono />
            <PreviewRow label="Hospital ID" value={created.hospitalId} mono />
            <p className="text-xs text-muted-foreground">
              Next: configure this hospital's settings and add its doctors and
              staff. Payment and messaging credentials are set up separately.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No result returned.</p>
        )}

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={onAnother}
            data-testid="provision-another"
          >
            Provision another
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
