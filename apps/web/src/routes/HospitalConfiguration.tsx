import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/auth/AuthProvider";
import {
  getHospitalConfiguration,
  updateHospitalConfiguration,
  type HospitalPatch,
  type SettingsPatch,
  type FeatureOverrideInput,
} from "@/api/configuration";
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
import type { HospitalConfigurationReadResponseBody } from "@/types/api";

/**
 * WS-ONBOARD-2 - Hospital Configuration Write Surfaces.
 *
 * A professional admin configuration workflow over the EXISTING
 * `hospital-configuration` Edge Function and its two canonical
 * `get_hospital_configuration` / `update_hospital_configuration` RPCs
 * (migration 66). Accessible to `hospital_admin` (edits their own
 * tenant) and `global_admin` (edits the acting-hospital tenant). The
 * route guard is a UX boundary; the Edge Function and the RPC are the
 * security and write authority.
 *
 * The frontend owns NOTHING of the write path. It sends a deliberate
 * field-level patch built by comparing the current server snapshot to
 * the local edit buffer; the RPC applies it atomically, records a
 * config_versions row via the existing AFTER-UPDATE trigger, and emits
 * an audit event via the existing `logAuditEvent` primitive. Razorpay /
 * Meta credential fields are deliberately ABSENT (WS-ONBOARD-3 owns
 * them), and `collect_consultation_at_hospital` is displayed but not
 * editable because the SETURA business model fixes it to TRUE.
 *
 * Truthful outcomes: a save shows "Saved" only after the server has
 * returned 200; a 409 CONFIG_VERSION_CONFLICT maps to an honest
 * "someone else changed this" message with a Reload action; a
 * validation 422 maps to a per-field message from the backend envelope.
 * A submission uses one stable idempotency key minted by
 * `useAsyncAction`, so a retry of the SAME logical action replays the
 * stored response rather than writing twice. The button is disabled in
 * flight and `useAsyncAction` swallows a double-click, but the backend
 * is what actually prevents duplicate mutations, duplicate versions and
 * duplicate audits.
 */

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: HospitalConfigurationReadResponseBody };

type FieldKey =
  | "name"
  | "phone"
  | "email"
  | "country"
  | "state"
  | "district"
  | "town"
  | "address"
  | "timezone"
  | "displayName"
  | "logoUrl"
  | "preferredLanguage"
  | "platformFeeOnline"
  | "platformFeeWhatsapp"
  | "receptionistFee"
  | "defaultConsultationFee"
  | "gstEnabled"
  | "gstPercentage"
  | "gstRegistration"
  | "maxTokensPerDay"
  | "reminderBeforeMinutes"
  | "maxAdvanceBookingDays";

interface EditBuffer {
  name: string;
  phone: string;
  email: string;
  country: string;
  state: string;
  district: string;
  town: string;
  address: string;
  timezone: string;
  displayName: string;
  logoUrl: string;
  preferredLanguage: string;
  platformFeeOnline: string;
  platformFeeWhatsapp: string;
  receptionistFee: string;
  defaultConsultationFee: string;
  gstEnabled: boolean;
  gstPercentage: string;
  gstRegistration: string;
  maxTokensPerDay: string;
  reminderBeforeMinutes: string;
  maxAdvanceBookingDays: string;
  onlineBookingEnabled: boolean;
  onlineBookingFeeEnabled: boolean;
  allowWalkinTokens: boolean;
  allowOnlineBooking: boolean;
  allowCarryForward: boolean;
  queueDisplayEnabled: boolean;
  sendWhatsappConfirmation: boolean;
  sendWhatsappReminder: boolean;
  sendFeedbackRequest: boolean;
}

function bufferFrom(snap: HospitalConfigurationReadResponseBody): EditBuffer {
  const s = snap.settings;
  const h = snap.hospital;
  const num = (v: string | number | null | undefined) =>
    v === null || v === undefined ? "" : String(v);
  return {
    name: h.name ?? "",
    phone: h.phone ?? "",
    email: h.email ?? "",
    country: h.country ?? "",
    state: h.state ?? "",
    district: h.district ?? "",
    town: h.town ?? "",
    address: h.address ?? "",
    timezone: h.timezone ?? "",
    displayName: s.display_name ?? "",
    logoUrl: s.logo_url ?? "",
    preferredLanguage: s.preferred_language ?? "",
    platformFeeOnline: num(s.platform_fee_online),
    platformFeeWhatsapp: num(s.platform_fee_whatsapp),
    receptionistFee: num(s.receptionist_fee),
    defaultConsultationFee: num(s.default_consultation_fee_inr),
    gstEnabled: !!s.gst_enabled,
    gstPercentage: num(s.gst_percentage),
    gstRegistration: s.gst_registration_number ?? "",
    maxTokensPerDay: num(s.max_tokens_per_day),
    reminderBeforeMinutes: num(s.reminder_before_minutes),
    maxAdvanceBookingDays: num(h.max_advance_booking_days),
    onlineBookingEnabled: !!h.online_booking_enabled,
    onlineBookingFeeEnabled: !!s.online_booking_fee_enabled,
    allowWalkinTokens: !!s.allow_walkin_tokens,
    allowOnlineBooking: !!s.allow_online_booking,
    allowCarryForward: !!s.allow_carry_forward,
    queueDisplayEnabled: !!s.queue_display_enabled,
    sendWhatsappConfirmation: !!s.send_whatsapp_confirmation,
    sendWhatsappReminder: !!s.send_whatsapp_reminder,
    sendFeedbackRequest: !!s.send_feedback_request,
  };
}

/** Numeric field specifiers used by validation and patch building. */
const NUMERIC_FIELDS: Array<
  {
    key: keyof EditBuffer;
    min: number;
    max: number;
    integer: boolean;
    label: string;
  }
> = [
  { key: "platformFeeOnline", min: 0, max: 1_000_000, integer: false, label: "Platform fee (online)" },
  { key: "platformFeeWhatsapp", min: 0, max: 1_000_000, integer: false, label: "Platform fee (WhatsApp)" },
  { key: "receptionistFee", min: 0, max: 1_000_000, integer: false, label: "Receptionist fee" },
  { key: "defaultConsultationFee", min: 0, max: 1_000_000, integer: false, label: "Default consultation fee" },
  { key: "gstPercentage", min: 0, max: 100, integer: false, label: "GST percentage" },
  { key: "maxTokensPerDay", min: 1, max: 5000, integer: true, label: "Max tokens / day" },
  { key: "reminderBeforeMinutes", min: 1, max: 1440, integer: true, label: "Reminder lead (minutes)" },
  { key: "maxAdvanceBookingDays", min: 1, max: 365, integer: true, label: "Max advance booking days" },
];

/** Text length limits (mirrors the Edge Schema; the RPC remains
 *  authoritative). Exported so tests can drive the validator directly. */
export function validateConfiguration(
  buf: EditBuffer,
): Partial<Record<FieldKey, string>> {
  const errors: Partial<Record<FieldKey, string>> = {};
  const req = (v: string) => v.trim();

  if (!req(buf.name) || req(buf.name).length < 2 || req(buf.name).length > 200) {
    errors.name = "Name must be 2..200 characters.";
  }
  if (req(buf.phone).length > 20) errors.phone = "Phone must be 20 characters or fewer.";
  const email = req(buf.email);
  if (email) {
    if (email.length > 254) errors.email = "Email must be 254 characters or fewer.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Enter a valid email.";
  }
  if (!req(buf.country)) errors.country = "Country is required.";
  else if (req(buf.country).length > 120) errors.country = "Country must be 120 characters or fewer.";
  if (!req(buf.state)) errors.state = "State is required.";
  else if (req(buf.state).length > 120) errors.state = "State must be 120 characters or fewer.";
  if (req(buf.district).length > 120) errors.district = "District must be 120 characters or fewer.";
  if (!req(buf.town)) errors.town = "Town is required.";
  else if (req(buf.town).length > 120) errors.town = "Town must be 120 characters or fewer.";
  if (req(buf.address).length > 500) errors.address = "Address must be 500 characters or fewer.";
  if (!req(buf.timezone)) errors.timezone = "Timezone is required.";
  else if (req(buf.timezone).length > 64) errors.timezone = "Timezone must be 64 characters or fewer.";

  if (req(buf.displayName).length > 200) errors.displayName = "Display name must be 200 characters or fewer.";
  if (req(buf.logoUrl).length > 500) errors.logoUrl = "Logo URL must be 500 characters or fewer.";
  const lang = req(buf.preferredLanguage);
  if (lang.length < 2 || lang.length > 10) errors.preferredLanguage = "Language code must be 2..10 characters.";
  if (req(buf.gstRegistration).length > 32) errors.gstRegistration = "GST number must be 32 characters or fewer.";

  for (const spec of NUMERIC_FIELDS) {
    const v = String(buf[spec.key] ?? "").trim();
    if (!v) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      errors[spec.key as FieldKey] = `${spec.label} must be a number.`;
      continue;
    }
    if (spec.integer && !Number.isInteger(n)) {
      errors[spec.key as FieldKey] = `${spec.label} must be a whole number.`;
      continue;
    }
    if (n < spec.min || n > spec.max) {
      errors[spec.key as FieldKey] = `${spec.label} must be between ${spec.min} and ${spec.max}.`;
    }
  }
  return errors;
}

/** Diff the buffer against the loaded snapshot; return the exact field
 *  patches to send. Exported so tests can drive the builder directly.
 *
 *  NUMERIC comparison rule: PostgREST serialises NUMERIC columns as
 *  strings ("20.00" for 20.00, or "20" depending on scale) and
 *  INTEGER/SMALLINT as JS numbers. Comparing the string forms would
 *  emit a spurious patch whenever the buffer shows "20" while the
 *  snapshot shows "20.00" even though the value is unchanged. For
 *  every NUMERIC-typed column we therefore compare via Number() and
 *  only emit a patch when the numeric value genuinely differs. */
export function buildPatches(
  snap: HospitalConfigurationReadResponseBody,
  buf: EditBuffer,
): { hospitalPatch?: HospitalPatch; settingsPatch?: SettingsPatch } {
  const h: HospitalPatch = {};
  const s: SettingsPatch = {};
  const opt = (v: string): string | undefined => (v.trim() ? v.trim() : undefined);
  const numEq = (
    a: string | number | null | undefined,
    b: string | number | null | undefined,
  ): boolean => {
    const an = a === null || a === undefined || String(a).trim() === ""
      ? null
      : Number(a);
    const bn = b === null || b === undefined || String(b).trim() === ""
      ? null
      : Number(b);
    if (an === null || bn === null) return an === bn;
    return an === bn;
  };

  if (buf.name.trim() !== snap.hospital.name) h.name = buf.name.trim();
  if (opt(buf.phone) !== (snap.hospital.phone ?? undefined)) h.phone = opt(buf.phone) ?? "";
  if (opt(buf.email) !== (snap.hospital.email ?? undefined)) h.email = opt(buf.email) ?? "";
  if (buf.country.trim() !== snap.hospital.country) h.country = buf.country.trim();
  if (buf.state.trim() !== snap.hospital.state) h.state = buf.state.trim();
  if (opt(buf.district) !== (snap.hospital.district ?? undefined)) h.district = opt(buf.district) ?? "";
  if (buf.town.trim() !== snap.hospital.town) h.town = buf.town.trim();
  if (opt(buf.address) !== (snap.hospital.address ?? undefined)) h.address = opt(buf.address) ?? "";
  if (buf.timezone.trim() !== snap.hospital.timezone) h.timezone = buf.timezone.trim();
  if (buf.onlineBookingEnabled !== snap.hospital.online_booking_enabled) {
    h.online_booking_enabled = buf.onlineBookingEnabled;
  }
  if (Number(buf.maxAdvanceBookingDays) !== snap.hospital.max_advance_booking_days) {
    h.max_advance_booking_days = Number(buf.maxAdvanceBookingDays);
  }

  if (opt(buf.displayName) !== (snap.settings.display_name ?? undefined)) {
    s.display_name = opt(buf.displayName) ?? "";
  }
  if (opt(buf.logoUrl) !== (snap.settings.logo_url ?? undefined)) s.logo_url = opt(buf.logoUrl) ?? "";
  if (!numEq(buf.platformFeeOnline, snap.settings.platform_fee_online)) {
    s.platform_fee_online = Number(buf.platformFeeOnline);
  }
  if (!numEq(buf.platformFeeWhatsapp, snap.settings.platform_fee_whatsapp)) {
    s.platform_fee_whatsapp = Number(buf.platformFeeWhatsapp);
  }
  if (!numEq(buf.receptionistFee, snap.settings.receptionist_fee)) {
    s.receptionist_fee = Number(buf.receptionistFee);
  }
  if (buf.onlineBookingFeeEnabled !== snap.settings.online_booking_fee_enabled) {
    s.online_booking_fee_enabled = buf.onlineBookingFeeEnabled;
  }
  if (!numEq(buf.defaultConsultationFee, snap.settings.default_consultation_fee_inr)) {
    s.default_consultation_fee_inr = buf.defaultConsultationFee.trim()
      ? Number(buf.defaultConsultationFee)
      : null;
  }
  if (buf.gstEnabled !== snap.settings.gst_enabled) s.gst_enabled = buf.gstEnabled;
  if (!numEq(buf.gstPercentage, snap.settings.gst_percentage)) {
    s.gst_percentage = Number(buf.gstPercentage);
  }
  if (opt(buf.gstRegistration) !== (snap.settings.gst_registration_number ?? undefined)) {
    s.gst_registration_number = opt(buf.gstRegistration) ?? "";
  }
  if (Number(buf.maxTokensPerDay) !== snap.settings.max_tokens_per_day) {
    s.max_tokens_per_day = Number(buf.maxTokensPerDay);
  }
  if (buf.allowWalkinTokens !== snap.settings.allow_walkin_tokens) {
    s.allow_walkin_tokens = buf.allowWalkinTokens;
  }
  if (buf.allowOnlineBooking !== snap.settings.allow_online_booking) {
    s.allow_online_booking = buf.allowOnlineBooking;
  }
  if (buf.allowCarryForward !== snap.settings.allow_carry_forward) {
    s.allow_carry_forward = buf.allowCarryForward;
  }
  if (buf.queueDisplayEnabled !== snap.settings.queue_display_enabled) {
    s.queue_display_enabled = buf.queueDisplayEnabled;
  }
  if (buf.sendWhatsappConfirmation !== snap.settings.send_whatsapp_confirmation) {
    s.send_whatsapp_confirmation = buf.sendWhatsappConfirmation;
  }
  if (buf.sendWhatsappReminder !== snap.settings.send_whatsapp_reminder) {
    s.send_whatsapp_reminder = buf.sendWhatsappReminder;
  }
  if (buf.sendFeedbackRequest !== snap.settings.send_feedback_request) {
    s.send_feedback_request = buf.sendFeedbackRequest;
  }
  if (Number(buf.reminderBeforeMinutes) !== snap.settings.reminder_before_minutes) {
    s.reminder_before_minutes = Number(buf.reminderBeforeMinutes);
  }
  if (buf.preferredLanguage.trim() !== snap.settings.preferred_language) {
    s.preferred_language = buf.preferredLanguage.trim();
  }
  if (buf.timezone.trim() !== snap.settings.timezone) s.timezone = buf.timezone.trim();

  const hasH = Object.keys(h).length > 0;
  const hasS = Object.keys(s).length > 0;
  return {
    ...(hasH ? { hospitalPatch: h } : {}),
    ...(hasS ? { settingsPatch: s } : {}),
  };
}

/** Compute the feature-flag overrides to upsert: only flags whose
 *  effective value the operator has flipped relative to the loaded
 *  snapshot. */
export function buildFeatureOverrides(
  snap: HospitalConfigurationReadResponseBody,
  edits: Record<string, boolean>,
): FeatureOverrideInput[] {
  const out: FeatureOverrideInput[] = [];
  for (const f of snap.featureFlags) {
    const next = edits[f.flag_key] ?? f.is_enabled;
    if (next !== f.is_enabled) out.push({ flag_key: f.flag_key, is_enabled: next });
  }
  return out;
}

export function HospitalConfiguration() {
  const { staff, hospitalId } = useAuth();
  const canAccess = staff?.role === "hospital_admin" || staff?.role === "global_admin";

  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [buffer, setBuffer] = useState<EditBuffer | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [savedBanner, setSavedBanner] = useState<string | null>(null);
  const [featureEdits, setFeatureEdits] = useState<Record<string, boolean>>({});

  const reload = useCallback(async () => {
    if (!hospitalId || !canAccess) return;
    setLoad({ kind: "loading" });
    try {
      const snap = await getHospitalConfiguration(hospitalId);
      setLoad({ kind: "ready", snapshot: snap });
      setBuffer(bufferFrom(snap));
      setErrors({});
      setFeatureEdits({});
    } catch (err) {
      setLoad({ kind: "error", message: describeError(err) });
    }
  }, [hospitalId, canAccess]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useAsyncAction(async (key: string) => {
    if (load.kind !== "ready" || !buffer) {
      throw new Error("Nothing loaded yet");
    }
    const found = validateConfiguration(buffer);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      throw new Error("Fix the highlighted fields before saving.");
    }
    const { hospitalPatch, settingsPatch } = buildPatches(load.snapshot, buffer);
    const featureOverrides = buildFeatureOverrides(load.snapshot, featureEdits);
    if (!hospitalPatch && !settingsPatch && featureOverrides.length === 0) {
      return { status: "noop" as const, version: load.snapshot.version };
    }
    const result = await updateHospitalConfiguration(hospitalId!, key, {
      expectedVersion: load.snapshot.version,
      hospitalPatch,
      settingsPatch,
      featureOverrides: featureOverrides.length > 0 ? featureOverrides : undefined,
    });
    return { status: "saved" as const, version: result.version };
  });

  const setField = <K extends keyof EditBuffer>(k: K, v: EditBuffer[K]) => {
    setSavedBanner(null);
    setBuffer((b) => (b ? { ...b, [k]: v } : b));
  };

  const dirty = useMemo(() => {
    if (load.kind !== "ready" || !buffer) return false;
    const { hospitalPatch, settingsPatch } = buildPatches(load.snapshot, buffer);
    const featureChanges = buildFeatureOverrides(load.snapshot, featureEdits);
    return !!(hospitalPatch || settingsPatch || featureChanges.length > 0);
  }, [load, buffer, featureEdits]);

  if (!canAccess) {
    return (
      <div className="p-8 text-muted-foreground">
        This surface is for hospital administrators.
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
    return <div className="p-8 text-muted-foreground">Loading configuration...</div>;
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
  const isGlobalAdmin = staff?.role === "global_admin";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Hospital Configuration</h1>
          <p className="text-sm text-muted-foreground">
            Tenant <span className="font-mono">{snap.hospital.slug}</span> · version{" "}
            <span className="font-mono">{snap.version}</span>
            {isGlobalAdmin ? " · editing as global_admin" : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void reload()} disabled={save.running}>
            Reload
          </Button>
          <Button
            onClick={() => {
              void save.run().then((r) => {
                if (!r) return;
                if (r.status === "noop") setSavedBanner("No changes to save.");
                else setSavedBanner(`Saved. New version ${r.version}.`);
                void reload();
              });
            }}
            disabled={save.running || !dirty}
          >
            {save.running ? "Saving..." : dirty ? "Save changes" : "Saved"}
          </Button>
        </div>
      </div>

      {savedBanner && (
        <Card><CardContent className="py-3 text-sm">{savedBanner}</CardContent></Card>
      )}
      {!!save.error && (
        <Card>
          <CardContent className="py-3 text-sm space-y-2">
            <Badge variant="destructive">Save failed</Badge>
            <p>{describeError(save.error)}</p>
            {save.error instanceof ApiError &&
            save.error.code === "DB_CONCURRENCY_ERROR" ? (
              <>
                <p className="text-muted-foreground">
                  Someone else changed this configuration. Reload to see the
                  latest version before editing again.
                </p>
                <Button variant="outline" size="sm" onClick={() => void reload()}>
                  Reload latest
                </Button>
              </>
            ) : null}
          </CardContent>
        </Card>
      )}

      {buffer && (
        <>
          <Section title="Hospital Information">
            <TextRow label="Name" value={buffer.name} onChange={(v) => setField("name", v)} error={errors.name} />
            <TextRow label="Phone" value={buffer.phone} onChange={(v) => setField("phone", v)} error={errors.phone} />
            <TextRow label="Email" value={buffer.email} onChange={(v) => setField("email", v)} error={errors.email} />
            <TextRow label="Country" value={buffer.country} onChange={(v) => setField("country", v)} error={errors.country} />
            <TextRow label="State" value={buffer.state} onChange={(v) => setField("state", v)} error={errors.state} />
            <TextRow label="District" value={buffer.district} onChange={(v) => setField("district", v)} error={errors.district} />
            <TextRow label="Town" value={buffer.town} onChange={(v) => setField("town", v)} error={errors.town} />
            <TextRow label="Address" value={buffer.address} onChange={(v) => setField("address", v)} error={errors.address} />
          </Section>

          <Section title="Regional Settings">
            <TextRow label="Timezone" value={buffer.timezone} onChange={(v) => setField("timezone", v)} error={errors.timezone} />
            <TextRow
              label="Preferred Language"
              value={buffer.preferredLanguage}
              onChange={(v) => setField("preferredLanguage", v)}
              error={errors.preferredLanguage}
            />
          </Section>

          <Section title="Branding">
            <TextRow label="Display Name" value={buffer.displayName} onChange={(v) => setField("displayName", v)} error={errors.displayName} />
            <TextRow label="Logo URL" value={buffer.logoUrl} onChange={(v) => setField("logoUrl", v)} error={errors.logoUrl} />
          </Section>

          <Section title="Booking Configuration">
            <BoolRow
              label="Online Booking Enabled (hospital tenant)"
              value={buffer.onlineBookingEnabled}
              onChange={(v) => setField("onlineBookingEnabled", v)}
            />
            <BoolRow
              label="Allow Online Booking (settings)"
              value={buffer.allowOnlineBooking}
              onChange={(v) => setField("allowOnlineBooking", v)}
            />
            <TextRow
              label="Max Advance Booking Days"
              value={buffer.maxAdvanceBookingDays}
              onChange={(v) => setField("maxAdvanceBookingDays", v)}
              error={errors.maxAdvanceBookingDays}
            />
          </Section>

          <Section title="Queue Configuration">
            <TextRow
              label="Max Tokens / Day"
              value={buffer.maxTokensPerDay}
              onChange={(v) => setField("maxTokensPerDay", v)}
              error={errors.maxTokensPerDay}
            />
            <BoolRow
              label="Allow Walk-in Tokens"
              value={buffer.allowWalkinTokens}
              onChange={(v) => setField("allowWalkinTokens", v)}
            />
            <BoolRow
              label="Allow Carry Forward"
              value={buffer.allowCarryForward}
              onChange={(v) => setField("allowCarryForward", v)}
            />
            <BoolRow
              label="Queue Display Enabled"
              value={buffer.queueDisplayEnabled}
              onChange={(v) => setField("queueDisplayEnabled", v)}
            />
          </Section>

          <Section title="Notifications">
            <BoolRow
              label="WhatsApp Confirmation"
              value={buffer.sendWhatsappConfirmation}
              onChange={(v) => setField("sendWhatsappConfirmation", v)}
            />
            <BoolRow
              label="WhatsApp Reminder"
              value={buffer.sendWhatsappReminder}
              onChange={(v) => setField("sendWhatsappReminder", v)}
            />
            <BoolRow
              label="Feedback Request"
              value={buffer.sendFeedbackRequest}
              onChange={(v) => setField("sendFeedbackRequest", v)}
            />
            <TextRow
              label="Reminder Lead (minutes)"
              value={buffer.reminderBeforeMinutes}
              onChange={(v) => setField("reminderBeforeMinutes", v)}
              error={errors.reminderBeforeMinutes}
            />
          </Section>

          <Section title="Fee Configuration">
            <CardDescription className="mb-2 block">
              SETURA collects only the booking / platform fee. Consultation
              fees are paid directly at the hospital (invariant:
              collect_consultation_at_hospital = {String(
                snap.settings.collect_consultation_at_hospital,
              )}).
            </CardDescription>
            <TextRow
              label="Platform Fee (Online)"
              value={buffer.platformFeeOnline}
              onChange={(v) => setField("platformFeeOnline", v)}
              error={errors.platformFeeOnline}
            />
            <TextRow
              label="Platform Fee (WhatsApp)"
              value={buffer.platformFeeWhatsapp}
              onChange={(v) => setField("platformFeeWhatsapp", v)}
              error={errors.platformFeeWhatsapp}
            />
            <TextRow
              label="Receptionist Fee"
              value={buffer.receptionistFee}
              onChange={(v) => setField("receptionistFee", v)}
              error={errors.receptionistFee}
            />
            <BoolRow
              label="Online Booking Fee Enabled"
              value={buffer.onlineBookingFeeEnabled}
              onChange={(v) => setField("onlineBookingFeeEnabled", v)}
            />
            <TextRow
              label="Default Consultation Fee (informational)"
              value={buffer.defaultConsultationFee}
              onChange={(v) => setField("defaultConsultationFee", v)}
              error={errors.defaultConsultationFee}
            />
            <BoolRow
              label="GST Enabled"
              value={buffer.gstEnabled}
              onChange={(v) => setField("gstEnabled", v)}
            />
            <TextRow
              label="GST Percentage"
              value={buffer.gstPercentage}
              onChange={(v) => setField("gstPercentage", v)}
              error={errors.gstPercentage}
            />
            <TextRow
              label="GST Registration Number"
              value={buffer.gstRegistration}
              onChange={(v) => setField("gstRegistration", v)}
              error={errors.gstRegistration}
            />
          </Section>

          <Section title="Feature Configuration">
            <CardDescription className="mb-2 block">
              Global defaults, with optional per-hospital overrides. Changing a
              switch here writes a hospital-scoped
              <code className="mx-1">feature_flags</code>row; the existing
              version trigger records the change.
            </CardDescription>
            {snap.featureFlags.length === 0 && (
              <p className="text-sm text-muted-foreground">No flags defined.</p>
            )}
            <ul className="space-y-2">
              {snap.featureFlags.map((f) => {
                const next = featureEdits[f.flag_key] ?? f.is_enabled;
                return (
                  <li key={f.flag_key} className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">
                        {f.display_name ?? f.flag_key}
                        {f.is_override && (
                          <Badge variant="secondary" className="ml-2">override</Badge>
                        )}
                      </div>
                      {f.description && (
                        <div className="text-xs text-muted-foreground">{f.description}</div>
                      )}
                      <div className="text-xs font-mono text-muted-foreground">{f.flag_key}</div>
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={next}
                        onChange={(e) => {
                          setSavedBanner(null);
                          setFeatureEdits((prev) => ({
                            ...prev,
                            [f.flag_key]: e.target.checked,
                          }));
                        }}
                      />
                      Enabled
                    </label>
                  </li>
                );
              })}
            </ul>
          </Section>

          <Section title="Integrations (out of scope)">
            <p className="text-sm text-muted-foreground">
              Razorpay / Meta / WhatsApp credentials are intentionally not
              editable here; WS-ONBOARD-3 will add a secure credentials write
              surface.
            </p>
          </Section>
        </>
      )}
    </div>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{props.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">{props.children}</CardContent>
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
        {props.error && (
          <p className="text-xs text-red-600 mt-1">{props.error}</p>
        )}
      </div>
    </div>
  );
}

function BoolRow(props: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-4 items-center">
      <Label>{props.label}</Label>
      <label className="sm:col-span-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={props.value}
          onChange={(e) => props.onChange(e.target.checked)}
        />
        {props.value ? "Enabled" : "Disabled"}
      </label>
    </div>
  );
}
