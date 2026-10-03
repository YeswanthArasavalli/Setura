import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  getIntegrationConfiguration,
  rotateIntegrationSecret,
  testIntegration,
  updateIntegration,
  type IntegrationPatch,
} from "@/api/integrations";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { ApiError, describeError } from "@/lib/errors";
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
import type {
  IntegrationConfigurationReadResponseBody,
  IntegrationConfigView,
  IntegrationProvider,
} from "@/types/api";

/**
 * WS-ONBOARD-3 - Integration Configuration & Secure Credential Management.
 *
 * A professional admin workflow over the `integration-configuration` Edge
 * Function and its five canonical RPCs (migration 67). `hospital_admin`
 * edits their own tenant's public identifiers + enablement; `global_admin`
 * additionally rotates the platform-global provider secret. The route guard
 * is a UX boundary; the Edge Function and the RPCs are the security and
 * write authority.
 *
 * The frontend owns NOTHING of the write path and can NEVER read a secret
 * back: there is no field that displays a stored credential. The secret
 * input is write-only (type=password, cleared after a successful rotation)
 * and is only visible to a global_admin. A connection test returns only a
 * sanitized enum; the credential never crosses this boundary.
 */

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: IntegrationConfigurationReadResponseBody };

export interface IntegrationBuffer {
  public_identifier: string;
  waba_id: string;
  contact_number: string;
  enabled: boolean;
}

export type IntegrationFieldError = Partial<
  Record<"public_identifier" | "waba_id" | "contact_number", string>
>;

const PROVIDERS: Array<{ id: IntegrationProvider; label: string }> = [
  { id: "razorpay", label: "Razorpay" },
  { id: "meta_whatsapp", label: "WhatsApp (Meta)" },
];

export function findIntegration(
  snap: IntegrationConfigurationReadResponseBody,
  provider: IntegrationProvider,
): IntegrationConfigView | undefined {
  return snap.integrations.find((i) => i.provider === provider);
}

export function integrationBufferFrom(
  view: IntegrationConfigView | undefined,
): IntegrationBuffer {
  return {
    public_identifier: view?.public_identifier ?? "",
    waba_id: view?.waba_id ?? "",
    contact_number: view?.contact_number ?? "",
    enabled: view?.enabled ?? false,
  };
}

export function validateIntegration(
  provider: IntegrationProvider,
  buf: IntegrationBuffer,
): IntegrationFieldError {
  const errors: IntegrationFieldError = {};
  const pid = buf.public_identifier.trim();
  if (pid.length > 200) {
    errors.public_identifier = "Public identifier must be 200 characters or fewer.";
  }
  if (provider === "meta_whatsapp") {
    if (buf.waba_id.trim().length > 200) {
      errors.waba_id = "WABA ID must be 200 characters or fewer.";
    }
    if (buf.contact_number.trim().length > 32) {
      errors.contact_number = "Contact number must be 32 characters or fewer.";
    }
  }
  return errors;
}

/** Diff the buffer against the loaded row; emit ONLY changed, editable,
 *  provider-appropriate fields. Exported so tests drive it directly. */
export function buildIntegrationPatch(
  provider: IntegrationProvider,
  base: IntegrationConfigView | undefined,
  buf: IntegrationBuffer,
): IntegrationPatch {
  const patch: IntegrationPatch = {};
  const opt = (v: string): string | undefined => (v.trim() ? v.trim() : undefined);

  const curPid = base?.public_identifier ?? "";
  if (buf.public_identifier.trim() !== curPid) {
    patch.public_identifier = opt(buf.public_identifier) ?? "";
  }
  if (provider === "meta_whatsapp") {
    const curWaba = base?.waba_id ?? "";
    if (buf.waba_id.trim() !== curWaba) patch.waba_id = opt(buf.waba_id) ?? "";
    const curContact = base?.contact_number ?? "";
    if (buf.contact_number.trim() !== curContact) {
      patch.contact_number = opt(buf.contact_number) ?? "";
    }
  }
  if (buf.enabled !== (base?.enabled ?? false)) patch.enabled = buf.enabled;
  return patch;
}

export function IntegrationConfiguration() {
  const { staff, hospitalId } = useAuth();
  const canAccess = staff?.role === "hospital_admin" ||
    staff?.role === "global_admin";
  const isGlobalAdmin = staff?.role === "global_admin";

  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [provider, setProvider] = useState<IntegrationProvider>("razorpay");
  const [buffer, setBuffer] = useState<IntegrationBuffer | null>(null);
  const [errors, setErrors] = useState<IntegrationFieldError>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [secretInput, setSecretInput] = useState("");

  const reload = useCallback(async () => {
    if (!hospitalId || !canAccess) return;
    setLoad({ kind: "loading" });
    try {
      const snap = await getIntegrationConfiguration(hospitalId);
      setLoad({ kind: "ready", snapshot: snap });
      setBuffer(integrationBufferFrom(findIntegration(snap, provider)));
      setErrors({});
    } catch (err) {
      setLoad({ kind: "error", message: describeError(err) });
    }
  }, [hospitalId, canAccess, provider]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useAsyncAction(async (key: string) => {
    if (load.kind !== "ready" || !buffer) throw new Error("Nothing loaded yet");
    const found = validateIntegration(provider, buffer);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      throw new Error("Fix the highlighted fields before saving.");
    }
    const base = findIntegration(load.snapshot, provider);
    const patch = buildIntegrationPatch(provider, base, buffer);
    if (Object.keys(patch).length === 0) {
      return { status: "noop" as const, version: base?.version ?? 0 };
    }
    const res = await updateIntegration(hospitalId!, key, {
      provider,
      expectedVersion: base?.version ?? 0,
      patch,
    });
    return { status: "saved" as const, version: res.version };
  });

  const connectionTest = useAsyncAction(async (key: string) => {
    const res = await testIntegration(hospitalId!, key, provider);
    return res;
  });

  const rotate = useAsyncAction(async (key: string) => {
    if (!secretInput) throw new Error("Enter a secret value to rotate.");
    await rotateIntegrationSecret(hospitalId!, key, provider, secretInput);
    setSecretInput("");
    return { status: "rotated" as const };
  });

  const dirty = useMemo(() => {
    if (load.kind !== "ready" || !buffer) return false;
    const base = findIntegration(load.snapshot, provider);
    return Object.keys(buildIntegrationPatch(provider, base, buffer)).length > 0;
  }, [load, buffer, provider]);

  if (!canAccess) {
    return (
      <div className="p-8 text-muted-foreground">
        This integrations surface is for hospital administrators.
      </div>
    );
  }
  if (!hospitalId) {
    return (
      <div className="p-8 text-muted-foreground">
        Waiting for a request context (no acting hospital).
      </div>
    );
  }
  if (load.kind === "loading") {
    return <div className="p-8 text-muted-foreground">Loading integrations...</div>;
  }
  if (load.kind === "error") {
    return (
      <div className="p-8 space-y-3">
        <Badge variant="destructive">Failed to load</Badge>
        <p className="text-sm text-muted-foreground">{load.message}</p>
        <Button variant="outline" onClick={() => void reload()}>Retry</Button>
      </div>
    );
  }

  const snap = load.snapshot;
  const base = findIntegration(snap, provider);
  const secretPresence = snap.platformSecrets.find((s) => s.provider === provider);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Integration Configuration
        </h1>
        <p className="text-sm text-muted-foreground">
          Tenant <span className="font-mono">{snap.hospitalId}</span>
          {isGlobalAdmin ? " · editing as global_admin" : ""}
        </p>
      </div>

      <div className="flex gap-2">
        {PROVIDERS.map((p) => (
          <Button
            key={p.id}
            variant={p.id === provider ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setProvider(p.id);
              setBuffer(
                integrationBufferFrom(findIntegration(snap, p.id)),
              );
              setErrors({});
              setBanner(null);
              save.reset();
              connectionTest.reset();
              rotate.reset();
            }}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {banner && <Card><CardContent className="py-3 text-sm">{banner}</CardContent></Card>}

      <ProviderCard
        provider={provider}
        version={base?.version ?? 0}
        status={base?.status ?? "unconfigured"}
        lastTestStatus={base?.last_test_status ?? null}
        secretPresent={!!secretPresence?.secret_present}
        secretLastRotatedAt={secretPresence?.last_rotated_at ?? null}
        buffer={buffer ?? integrationBufferFrom(base)}
        errors={errors}
        isGlobalAdmin={isGlobalAdmin}
        secretInput={secretInput}
        onSecretChange={(v) => {
          setBanner(null);
          setSecretInput(v);
        }}
        onField={(k, v) => {
          setBanner(null);
          setBuffer((b) => (b ? { ...b, [k]: v } : b));
        }}
        running={save.running || connectionTest.running || rotate.running}
        saveError={save.error}
        onSave={() => {
          void save.run().then((r) => {
            if (!r) return;
            setBanner(
              r.status === "noop" ? "No changes to save." : `Saved. New version ${r.version}.`,
            );
            void reload();
          });
        }}
        onTest={() => {
          void connectionTest.run().then((r) => {
            if (!r) return;
            setBanner(`Connection test: ${r.result}. ${r.message}`);
            void reload();
          });
        }}
        onRotate={() => {
          void rotate.run().then((r) => {
            if (!r) return;
            setBanner("Secret rotated. It is stored securely and can never be read back.");
            void reload();
          });
        }}
        dirty={dirty}
      />
    </div>
  );
}

interface ProviderCardProps {
  provider: IntegrationProvider;
  version: number;
  status: string;
  lastTestStatus: string | null;
  secretPresent: boolean;
  secretLastRotatedAt: string | null;
  buffer: IntegrationBuffer;
  errors: IntegrationFieldError;
  isGlobalAdmin: boolean;
  secretInput: string;
  onSecretChange: (v: string) => void;
  onField: (k: keyof IntegrationBuffer, v: string | boolean) => void;
  running: boolean;
  saveError: unknown | null;
  dirty: boolean;
  onSave: () => void;
  onTest: () => void;
  onRotate: () => void;
}

function ProviderCard(props: ProviderCardProps) {
  const isMeta = props.provider === "meta_whatsapp";
  const pidLabel = isMeta ? "Meta Phone Number ID" : "Razorpay Key ID";
  const conflict = props.saveError instanceof ApiError &&
    props.saveError.code === "DB_CONCURRENCY_ERROR";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {isMeta ? "WhatsApp / Meta" : "Razorpay"}
        </CardTitle>
        <CardDescription className="flex items-center gap-2">
          <Badge variant="secondary">status: {props.status}</Badge>
          <span className="font-mono text-xs">v{props.version}</span>
          {props.lastTestStatus && (
            <span className="text-xs">last test: {props.lastTestStatus}</span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!!props.saveError && !conflict && (
          <div className="space-y-1">
            <Badge variant="destructive">Save failed</Badge>
            <p className="text-sm">{describeError(props.saveError)}</p>
          </div>
        )}
        {conflict && (
          <div className="space-y-1">
            <Badge variant="destructive">Save failed</Badge>
            <p className="text-sm text-muted-foreground">
              Someone else changed this configuration. Reload and try again.
            </p>
          </div>
        )}

        <TextRow
          label={pidLabel}
          value={props.buffer.public_identifier}
          onChange={(v) => props.onField("public_identifier", v)}
          error={props.errors.public_identifier}
        />
        {isMeta && (
          <>
            <TextRow
              label="WABA ID"
              value={props.buffer.waba_id}
              onChange={(v) => props.onField("waba_id", v)}
              error={props.errors.waba_id}
            />
            <TextRow
              label="Contact Number"
              value={props.buffer.contact_number}
              onChange={(v) => props.onField("contact_number", v)}
              error={props.errors.contact_number}
            />
          </>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-4 items-center">
          <Label>Enabled</Label>
          <label className="sm:col-span-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={props.buffer.enabled}
              onChange={(e) => props.onField("enabled", e.target.checked)}
            />
            {props.buffer.enabled ? "Enabled" : "Disabled"}
          </label>
        </div>

        {/* Platform-global secret PRESENCE only - the value is never shown. */}
        <div className="rounded-md border p-3 text-sm space-y-1">
          <div className="font-medium">
            Platform credential:{" "}
            {props.secretPresent ? "Configured" : "Not configured"}
          </div>
          {props.secretLastRotatedAt && (
            <div className="text-xs text-muted-foreground">
              last rotated: {props.secretLastRotatedAt}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Secrets are platform-global and stored in the server-side secret
            vault. A stored secret can never be read back through this UI.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={props.onSave} disabled={props.running || !props.dirty}>
            {props.running ? "Working..." : props.dirty ? "Save changes" : "Saved"}
          </Button>
          <Button variant="outline" onClick={props.onTest} disabled={props.running}>
            Test connection
          </Button>
        </div>

        {props.isGlobalAdmin && (
          <div className="space-y-2 border-t pt-3">
            <Label className="text-sm">
              Rotate platform secret (global_admin)
            </Label>
            <div className="flex gap-2">
              <Input
                type="password"
                value={props.secretInput}
                onChange={(e) => props.onSecretChange(e.target.value)}
                placeholder="Paste new secret value (never shown again)"
              />
              <Button onClick={props.onRotate} disabled={props.running}>
                Rotate secret
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TextRow(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-4 items-start">
      <Label className="sm:pt-2">{props.label}</Label>
      <div className="sm:col-span-2">
        <Input value={props.value} onChange={(e) => props.onChange(e.target.value)} />
        {props.error && <p className="text-xs text-red-600 mt-1">{props.error}</p>}
      </div>
    </div>
  );
}
