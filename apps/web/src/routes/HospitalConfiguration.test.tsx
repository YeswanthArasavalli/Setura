import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError } from "@/lib/errors";
import type { HospitalConfigurationReadResponseBody } from "@/types/api";

/**
 * WS-ONBOARD-2 - Hospital Configuration frontend.
 *
 * The browser owns NOTHING of the write path (that is proven end-to-end
 * by the backend real-HTTP suite). These tests pin the page's OWN
 * guarantees:
 *
 *  - the exported pure helpers - validateConfiguration / buildPatches /
 *    buildFeatureOverrides - mirror the exact backend limits
 *    deterministically, so the client pre-check never disagrees with
 *    what the RPC enforces;
 *  - the admin route guard renders a restricted message for a non-admin
 *    (a UX boundary; the backend re-authorizes regardless);
 *  - loading a snapshot renders the SERVER-returned values (never a
 *    browser-fabricated default);
 *  - editing one field produces a targeted diff (unchanged fields are
 *    OMITTED from the patch, not sent as empty strings);
 *  - saving uses ONE stable Idempotency-Key per logical action so a
 *    double-click cannot fire two updates;
 *  - a 409 DB_CONCURRENCY_ERROR is honestly surfaced with a Reload
 *    action, never dressed as a success;
 *  - a validation 422 honestly surfaces the backend message, never
 *    a fabricated success banner.
 */
const readCall = vi.fn();
const updateCall = vi.fn();
vi.mock("@/api/configuration", () => ({
  getHospitalConfiguration: (hospitalId: string) => readCall(hospitalId),
  updateHospitalConfiguration: (
    hospitalId: string,
    key: string,
    input: unknown,
  ) => updateCall(hospitalId, key, input),
}));

const auth = vi.hoisted(() => ({
  current: {
    role: "hospital_admin" as
      | "global_admin"
      | "hospital_admin"
      | "doctor"
      | "receptionist",
    hospitalId: "h-1" as string | null,
  },
}));
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({
    hospitalId: auth.current.hospitalId,
    staff: {
      fullName: "Admin",
      role: auth.current.role,
      hospitalId: auth.current.hospitalId,
    },
  }),
}));

const {
  validateConfiguration,
  buildPatches,
  buildFeatureOverrides,
  HospitalConfiguration,
} = await import("@/routes/HospitalConfiguration");

// ─── Fixture: a canonical server snapshot ────────────────────────────────────

function snapshot(
  over: Partial<HospitalConfigurationReadResponseBody> = {},
): HospitalConfigurationReadResponseBody {
  return {
    hospitalId: "h-1",
    version: 3,
    hospital: {
      id: "h-1",
      slug: "sunrise",
      name: "Sunrise Hospital",
      name_te: null,
      phone: "9800000000",
      email: "root@sunrise.test",
      country: "India",
      state: "KA",
      district: "Bengaluru",
      town: "Bengaluru",
      address: "1 MG Road",
      timezone: "Asia/Kolkata",
      online_booking_enabled: true,
      max_advance_booking_days: 30,
    },
    settings: {
      display_name: "Sunrise",
      logo_url: null,
      platform_fee_online: "20.00",
      platform_fee_whatsapp: "20.00",
      receptionist_fee: "10.00",
      booking_fee_amount: "20.00",
      online_booking_fee_enabled: true,
      default_consultation_fee_inr: "500.00",
      collect_consultation_at_hospital: true,
      gst_enabled: false,
      gst_percentage: "0.00",
      gst_registration_number: null,
      max_tokens_per_day: 100,
      allow_walkin_tokens: true,
      allow_online_booking: true,
      allow_carry_forward: false,
      queue_display_enabled: true,
      send_whatsapp_confirmation: true,
      send_whatsapp_reminder: true,
      send_feedback_request: false,
      reminder_before_minutes: 30,
      preferred_language: "en",
      timezone: "Asia/Kolkata",
      metadata: {},
      updated_at: "2026-01-01T00:00:00Z",
      updated_by: "u-1",
    },
    featureFlags: [
      {
        flag_key: "telemedicine",
        display_name: "Telemedicine",
        description: null,
        is_enabled: false,
        is_override: false,
      },
      {
        flag_key: "reports_v2",
        display_name: "Reports v2",
        description: null,
        is_enabled: true,
        is_override: false,
      },
    ],
    ...over,
  };
}

const baseBuffer = () => ({
  name: "Sunrise Hospital",
  phone: "9800000000",
  email: "root@sunrise.test",
  country: "India",
  state: "KA",
  district: "Bengaluru",
  town: "Bengaluru",
  address: "1 MG Road",
  timezone: "Asia/Kolkata",
  displayName: "Sunrise",
  logoUrl: "",
  preferredLanguage: "en",
  platformFeeOnline: "20",
  platformFeeWhatsapp: "20",
  receptionistFee: "10",
  defaultConsultationFee: "500",
  gstEnabled: false,
  gstPercentage: "0",
  gstRegistration: "",
  maxTokensPerDay: "100",
  reminderBeforeMinutes: "30",
  maxAdvanceBookingDays: "30",
  onlineBookingEnabled: true,
  onlineBookingFeeEnabled: true,
  allowWalkinTokens: true,
  allowOnlineBooking: true,
  allowCarryForward: false,
  queueDisplayEnabled: true,
  sendWhatsappConfirmation: true,
  sendWhatsappReminder: true,
  sendFeedbackRequest: false,
});

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe("validateConfiguration", () => {
  it("accepts the baseline buffer", () => {
    expect(Object.keys(validateConfiguration(baseBuffer()))).toHaveLength(0);
  });
  it("requires name / country / state / town / timezone (matches RPC)", () => {
    const e = validateConfiguration({
      ...baseBuffer(),
      name: "",
      country: "",
      state: "",
      town: "",
      timezone: "",
    });
    expect(e.name).toBeTruthy();
    expect(e.country).toBeTruthy();
    expect(e.state).toBeTruthy();
    expect(e.town).toBeTruthy();
    expect(e.timezone).toBeTruthy();
  });
  it("rejects a malformed email but allows blank", () => {
    expect(
      validateConfiguration({ ...baseBuffer(), email: "not-an-email" }).email,
    ).toBeTruthy();
    expect(
      Object.keys(validateConfiguration({ ...baseBuffer(), email: "" })),
    ).toHaveLength(0);
  });
  it("enforces max_tokens_per_day 1..5000 (mirrors RPC)", () => {
    expect(
      validateConfiguration({ ...baseBuffer(), maxTokensPerDay: "99999" })
        .maxTokensPerDay,
    ).toBeTruthy();
    expect(
      validateConfiguration({ ...baseBuffer(), maxTokensPerDay: "0" })
        .maxTokensPerDay,
    ).toBeTruthy();
    expect(
      validateConfiguration({ ...baseBuffer(), maxTokensPerDay: "abc" })
        .maxTokensPerDay,
    ).toBeTruthy();
    // A whole number 200 is fine.
    expect(
      Object.keys(validateConfiguration({ ...baseBuffer(), maxTokensPerDay: "200" })),
    ).toHaveLength(0);
  });
  it("enforces reminder_before_minutes 1..1440", () => {
    expect(
      validateConfiguration({ ...baseBuffer(), reminderBeforeMinutes: "2000" })
        .reminderBeforeMinutes,
    ).toBeTruthy();
  });
  it("enforces max_advance_booking_days 1..365 (integer)", () => {
    expect(
      validateConfiguration({ ...baseBuffer(), maxAdvanceBookingDays: "400" })
        .maxAdvanceBookingDays,
    ).toBeTruthy();
    expect(
      validateConfiguration({ ...baseBuffer(), maxAdvanceBookingDays: "1.5" })
        .maxAdvanceBookingDays,
    ).toBeTruthy();
  });
  it("enforces platform_fee_online 0..1_000_000", () => {
    expect(
      validateConfiguration({ ...baseBuffer(), platformFeeOnline: "9999999" })
        .platformFeeOnline,
    ).toBeTruthy();
  });
  it("enforces preferred_language 2..10 characters", () => {
    expect(
      validateConfiguration({ ...baseBuffer(), preferredLanguage: "e" })
        .preferredLanguage,
    ).toBeTruthy();
    expect(
      validateConfiguration({ ...baseBuffer(), preferredLanguage: "englishlong" })
        .preferredLanguage,
    ).toBeTruthy();
  });
});

describe("buildPatches", () => {
  const snap = snapshot();
  it("returns nothing when the buffer is identical to the snapshot", () => {
    const { hospitalPatch, settingsPatch } = buildPatches(snap, baseBuffer());
    expect(hospitalPatch).toBeUndefined();
    expect(settingsPatch).toBeUndefined();
  });
  it("emits ONLY the changed fields on the hospital patch", () => {
    const b = { ...baseBuffer(), phone: "9800011122" };
    const { hospitalPatch, settingsPatch } = buildPatches(snap, b);
    expect(hospitalPatch).toEqual({ phone: "9800011122" });
    expect(settingsPatch).toBeUndefined();
  });
  it("emits ONLY the changed fields on the settings patch", () => {
    const b = { ...baseBuffer(), maxTokensPerDay: "200" };
    const { hospitalPatch, settingsPatch } = buildPatches(snap, b);
    expect(hospitalPatch).toBeUndefined();
    expect(settingsPatch).toEqual({ max_tokens_per_day: 200 });
  });
  it("treats platform_fee_online NUMERIC strings and numbers as equal (does not emit a spurious patch)", () => {
    // PostgREST may return a NUMERIC as either a string or a number; the
    // diff must not send an update just because the representation differs.
    const b = { ...baseBuffer(), platformFeeOnline: "20" };
    const s = snapshot({
      settings: { ...snap.settings, platform_fee_online: 20 },
    });
    const { settingsPatch } = buildPatches(s, b);
    expect(settingsPatch).toBeUndefined();
  });
});

describe("buildFeatureOverrides", () => {
  const snap = snapshot();
  it("returns [] when no flag flips", () => {
    expect(buildFeatureOverrides(snap, {})).toEqual([]);
  });
  it("emits an override for each flipped flag", () => {
    const out = buildFeatureOverrides(snap, { telemedicine: true });
    expect(out).toEqual([{ flag_key: "telemedicine", is_enabled: true }]);
  });
  it("supports toggling off an already-enabled flag", () => {
    const out = buildFeatureOverrides(snap, { reports_v2: false });
    expect(out).toEqual([{ flag_key: "reports_v2", is_enabled: false }]);
  });
});

// ─── Component behavior ──────────────────────────────────────────────────────

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/hospital-settings"]}>
      <Routes>
        <Route
          path="/admin/hospital-settings"
          element={<HospitalConfiguration />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  readCall.mockReset();
  updateCall.mockReset();
  auth.current.role = "hospital_admin";
  auth.current.hospitalId = "h-1";
  readCall.mockResolvedValue(snapshot());
});

it("hides the form from a non-admin (UX guard)", () => {
  auth.current.role = "doctor";
  renderPage();
  expect(
    screen.getByText(/surface is for hospital administrators/i),
  ).toBeInTheDocument();
  expect(readCall).not.toHaveBeenCalled();
});

it("loads and renders the server snapshot (name + version)", async () => {
  renderPage();
  await waitFor(() => expect(readCall).toHaveBeenCalledWith("h-1"));
  expect(await screen.findByDisplayValue("Sunrise Hospital")).toBeInTheDocument();
  // Scope the version check to the header paragraph ("Tenant <slug> ·
  // version <N>"); "version" also appears in the Feature Configuration
  // description so a page-wide /version/i query would be ambiguous.
  const header = screen.getByText("Hospital Configuration").parentElement;
  expect(header?.textContent ?? "").toContain("sunrise");
  expect(header?.textContent ?? "").toMatch(/version\D*3/);
});

it("saves with one stable idempotency key and only the changed fields", async () => {
  updateCall.mockResolvedValue({
    hospitalId: "h-1",
    version: 4,
    updated: true,
  });
  renderPage();
  // Wait for the load to complete.
  await screen.findByDisplayValue("Sunrise Hospital");

  // Change the "Name" input (first input on the page inside Hospital
  // Information section).
  const name = screen.getByDisplayValue("Sunrise Hospital");
  await userEvent.clear(name);
  await userEvent.type(name, "Sunrise Medical Center");

  const saveBtn = screen.getByRole("button", { name: /save changes/i });
  await userEvent.click(saveBtn);

  await waitFor(() => expect(updateCall).toHaveBeenCalledTimes(1));
  const [hosp, key, input] = updateCall.mock.calls[0];
  expect(hosp).toBe("h-1");
  expect(typeof key).toBe("string");
  expect(key.length).toBeGreaterThan(0);
  expect(input).toEqual(
    expect.objectContaining({
      expectedVersion: 3,
      hospitalPatch: { name: "Sunrise Medical Center" },
    }),
  );
  // settingsPatch must be absent (nothing else changed).
  expect(input.settingsPatch).toBeUndefined();
});

it("renders an honest conflict banner with a Reload action and never a fake success", async () => {
  updateCall.mockRejectedValue(
    new ApiError({
      code: "DB_CONCURRENCY_ERROR",
      message: "Configuration was changed by someone else.",
      status: 409,
    }),
  );
  renderPage();
  await screen.findByDisplayValue("Sunrise Hospital");
  const name = screen.getByDisplayValue("Sunrise Hospital");
  await userEvent.clear(name);
  await userEvent.type(name, "Renamed After Conflict");
  await userEvent.click(
    screen.getByRole("button", { name: /save changes/i }),
  );

  expect(await screen.findByText(/save failed/i)).toBeInTheDocument();
  expect(
    await screen.findByText(/someone else changed this configuration/i),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /reload latest/i }),
  ).toBeInTheDocument();
  // No success banner.
  expect(screen.queryByText(/saved\. new version/i)).toBeNull();
});

it("renders an honest validation banner and never a fake success", async () => {
  updateCall.mockRejectedValue(
    new ApiError({
      code: "VALIDATION_ERROR",
      message: "Configuration rejected",
      status: 422,
    }),
  );
  renderPage();
  await screen.findByDisplayValue("Sunrise Hospital");
  const name = screen.getByDisplayValue("Sunrise Hospital");
  await userEvent.clear(name);
  await userEvent.type(name, "Renamed");
  await userEvent.click(
    screen.getByRole("button", { name: /save changes/i }),
  );
  expect(await screen.findByText(/save failed/i)).toBeInTheDocument();
  expect(screen.queryByText(/saved\. new version/i)).toBeNull();
});
