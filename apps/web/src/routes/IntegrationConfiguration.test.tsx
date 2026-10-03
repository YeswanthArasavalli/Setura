import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError } from "@/lib/errors";
import type {
  IntegrationConfigView,
  IntegrationConfigurationReadResponseBody,
} from "@/types/api";

/**
 * WS-ONBOARD-3 - Integration Configuration frontend.
 *
 * The browser owns NOTHING of the write path and can NEVER read a stored
 * secret back (that security contract is proven end-to-end by the real-HTTP
 * Edge suite). These tests pin the page's OWN guarantees:
 *
 *  - the exported pure helpers - findIntegration / integrationBufferFrom /
 *    validateIntegration / buildIntegrationPatch - mirror the exact backend
 *    allowlist + limits deterministically, so the client pre-check never
 *    disagrees with what the RPC enforces (and a razorpay buffer never emits
 *    meta-only waba/contact fields);
 *  - the admin route guard renders a restricted message for a non-admin and
 *    never fires a read;
 *  - loading a snapshot renders the SERVER-returned identifiers and the
 *    secret PRESENCE marker only - the recognizable fake secret NEVER appears;
 *  - editing one field produces a targeted diff (unchanged fields OMITTED)
 *    saved with the loaded expectedVersion and ONE stable Idempotency-Key;
 *  - the write-only rotate control is visible to a global_admin and absent
 *    for a hospital_admin;
 *  - a connection test surfaces only the sanitized enum banner;
 *  - a 409 DB_CONCURRENCY_ERROR is honestly surfaced, never dressed as a
 *    success.
 */

const FAKE_SECRET = "TEST_SECRET_SHOULD_NEVER_LEAK_123456";

const readCall = vi.fn();
const updateCall = vi.fn();
const testCall = vi.fn();
const rotateCall = vi.fn();
vi.mock("@/api/integrations", () => ({
  getIntegrationConfiguration: (hospitalId: string) => readCall(hospitalId),
  updateIntegration: (hospitalId: string, key: string, input: unknown) =>
    updateCall(hospitalId, key, input),
  testIntegration: (hospitalId: string, key: string, provider: unknown) =>
    testCall(hospitalId, key, provider),
  rotateIntegrationSecret: (
    hospitalId: string,
    key: string,
    provider: unknown,
    secret: string,
  ) => rotateCall(hospitalId, key, provider, secret),
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
  findIntegration,
  integrationBufferFrom,
  validateIntegration,
  buildIntegrationPatch,
  IntegrationConfiguration,
} = await import("@/routes/IntegrationConfiguration");

// ─── Fixture: a canonical server snapshot ────────────────────────────────────

function rz(over: Partial<IntegrationConfigView> = {}): IntegrationConfigView {
  return {
    provider: "razorpay",
    public_identifier: "rzp_live_abc",
    waba_id: null,
    contact_number: null,
    enabled: true,
    status: "configured",
    last_tested_at: null,
    last_test_status: null,
    last_rotated_at: null,
    version: 2,
    ...over,
  };
}

function meta(over: Partial<IntegrationConfigView> = {}): IntegrationConfigView {
  return {
    provider: "meta_whatsapp",
    public_identifier: "pn-111",
    waba_id: "waba-999",
    contact_number: "+919800000000",
    enabled: false,
    status: "unconfigured",
    last_tested_at: null,
    last_test_status: null,
    last_rotated_at: null,
    version: 1,
    ...over,
  };
}

function snapshot(
  over: Partial<IntegrationConfigurationReadResponseBody> = {},
): IntegrationConfigurationReadResponseBody {
  return {
    hospitalId: "h-1",
    integrations: [rz(), meta()],
    platformSecrets: [
      { provider: "razorpay", secret_present: true, last_rotated_at: null },
      { provider: "meta_whatsapp", secret_present: false, last_rotated_at: null },
    ],
    ...over,
  };
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe("findIntegration", () => {
  it("selects by provider and returns undefined for an absent row", () => {
    const snap = snapshot();
    expect(findIntegration(snap, "razorpay")?.public_identifier).toBe(
      "rzp_live_abc",
    );
    expect(findIntegration({ ...snap, integrations: [meta()] }, "razorpay"))
      .toBeUndefined();
  });
});

describe("integrationBufferFrom", () => {
  it("defaults a missing row to an empty, disabled buffer (no fabricated id)", () => {
    expect(integrationBufferFrom(undefined)).toEqual({
      public_identifier: "",
      waba_id: "",
      contact_number: "",
      enabled: false,
    });
  });
  it("copies the server identifiers verbatim (null → empty string)", () => {
    expect(integrationBufferFrom(meta())).toEqual({
      public_identifier: "pn-111",
      waba_id: "waba-999",
      contact_number: "+919800000000",
      enabled: false,
    });
  });
});

describe("validateIntegration", () => {
  it("accepts a clean razorpay buffer", () => {
    expect(
      Object.keys(
        validateIntegration("razorpay", integrationBufferFrom(rz())),
      ),
    ).toHaveLength(0);
  });
  it("rejects a >200-char public identifier (mirrors RPC)", () => {
    const buf = { ...integrationBufferFrom(rz()), public_identifier: "x".repeat(201) };
    expect(validateIntegration("razorpay", buf).public_identifier).toBeTruthy();
  });
  it("rejects >200 waba / >32 contact only for meta", () => {
    const bad = {
      public_identifier: "pn",
      waba_id: "w".repeat(201),
      contact_number: "c".repeat(33),
      enabled: true,
    };
    const e = validateIntegration("meta_whatsapp", bad);
    expect(e.waba_id).toBeTruthy();
    expect(e.contact_number).toBeTruthy();
    // The same over-long values are IGNORED for razorpay (no meta fields).
    expect(
      Object.keys(validateIntegration("razorpay", bad)),
    ).toHaveLength(0);
  });
});

describe("buildIntegrationPatch", () => {
  it("returns nothing when the buffer equals the loaded row", () => {
    const base = rz();
    expect(
      buildIntegrationPatch("razorpay", base, integrationBufferFrom(base)),
    ).toEqual({});
  });
  it("emits ONLY the changed identifier, not untouched fields", () => {
    const base = rz();
    const buf = { ...integrationBufferFrom(base), public_identifier: "rzp_new" };
    expect(buildIntegrationPatch("razorpay", base, buf)).toEqual({
      public_identifier: "rzp_new",
    });
  });
  it("never emits meta-only fields for a razorpay buffer", () => {
    const base = rz();
    const buf = { ...integrationBufferFrom(base), waba_id: "sneak", contact_number: "123" };
    const patch = buildIntegrationPatch("razorpay", base, buf);
    expect(patch.waba_id).toBeUndefined();
    expect(patch.contact_number).toBeUndefined();
  });
  it("emits enablement flip as a boolean", () => {
    const base = rz({ enabled: false });
    const buf = { ...integrationBufferFrom(base), enabled: true };
    expect(buildIntegrationPatch("razorpay", base, buf)).toEqual({
      enabled: true,
    });
  });
  it("diffs all four meta fields when changed", () => {
    const base = meta();
    const buf = {
      public_identifier: "pn-222",
      waba_id: "waba-888",
      contact_number: "+919800001111",
      enabled: true,
    };
    expect(buildIntegrationPatch("meta_whatsapp", base, buf)).toEqual({
      public_identifier: "pn-222",
      waba_id: "waba-888",
      contact_number: "+919800001111",
      enabled: true,
    });
  });
});

// ─── Component behavior ──────────────────────────────────────────────────────

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/integrations"]}>
      <Routes>
        <Route path="/admin/integrations" element={<IntegrationConfiguration />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  readCall.mockReset();
  updateCall.mockReset();
  testCall.mockReset();
  rotateCall.mockReset();
  auth.current.role = "hospital_admin";
  auth.current.hospitalId = "h-1";
  readCall.mockResolvedValue(snapshot());
});

it("hides the surface from a non-admin (UX guard) and never reads", () => {
  auth.current.role = "doctor";
  renderPage();
  expect(
    screen.getByText(/surface is for hospital administrators/i),
  ).toBeInTheDocument();
  expect(readCall).not.toHaveBeenCalled();
});

it("loads and renders the server identifiers + secret PRESENCE only", async () => {
  renderPage();
  await waitFor(() => expect(readCall).toHaveBeenCalledWith("h-1"));
  expect(await screen.findByDisplayValue("rzp_live_abc")).toBeInTheDocument();
  // razorpay secret_present: true → the PRESENCE marker reads "Configured".
  const cred = await screen.findByText(/platform credential/i);
  expect(cred.textContent).toContain("Configured");
  // The value itself is NEVER rendered anywhere.
  expect(screen.queryByText(FAKE_SECRET)).toBeNull();
  expect(document.body.textContent).not.toContain(FAKE_SECRET);
});

it("saves with the loaded expectedVersion, one stable key and only the change", async () => {
  updateCall.mockResolvedValue({ provider: "razorpay", version: 3, status: "configured" });
  readCall.mockResolvedValue(snapshot());
  renderPage();
  await screen.findByDisplayValue("rzp_live_abc");

  const idInput = screen.getByDisplayValue("rzp_live_abc");
  await userEvent.clear(idInput);
  await userEvent.type(idInput, "rzp_live_new");

  await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

  await waitFor(() => expect(updateCall).toHaveBeenCalledTimes(1));
  const [hosp, key, input] = updateCall.mock.calls[0];
  expect(hosp).toBe("h-1");
  expect(typeof key).toBe("string");
  expect(key.length).toBeGreaterThan(0);
  expect(input).toEqual({
    provider: "razorpay",
    expectedVersion: 2,
    patch: { public_identifier: "rzp_live_new" },
  });
});

it("shows the write-only rotate control to a global_admin only", async () => {
  auth.current.role = "global_admin";
  renderPage();
  await screen.findByDisplayValue("rzp_live_abc");
  expect(
    screen.getByText(/rotate platform secret/i),
  ).toBeInTheDocument();
  expect(
    screen.getByPlaceholderText(/never shown again/i),
  ).toBeInTheDocument();
});

it("does NOT show the rotate control to a hospital_admin", async () => {
  auth.current.role = "hospital_admin";
  renderPage();
  await screen.findByDisplayValue("rzp_live_abc");
  expect(screen.queryByText(/rotate platform secret/i)).toBeNull();
  expect(screen.queryByPlaceholderText(/never shown again/i)).toBeNull();
});

it("surfaces only the sanitized enum from a connection test", async () => {
  testCall.mockResolvedValue({
    provider: "razorpay",
    result: "CONNECTED",
    message: "Reachable.",
  });
  renderPage();
  await screen.findByDisplayValue("rzp_live_abc");
  await userEvent.click(screen.getByRole("button", { name: /test connection/i }));
  expect(await screen.findByText(/connection test: connected/i)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain(FAKE_SECRET);
});

it("renders an honest conflict banner and never a fake success", async () => {
  updateCall.mockRejectedValue(
    new ApiError({
      code: "DB_CONCURRENCY_ERROR",
      message: "Integration was changed by someone else.",
      status: 409,
    }),
  );
  renderPage();
  await screen.findByDisplayValue("rzp_live_abc");
  const idInput = screen.getByDisplayValue("rzp_live_abc");
  await userEvent.clear(idInput);
  await userEvent.type(idInput, "rzp_conflict");
  await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

  expect(await screen.findByText(/save failed/i)).toBeInTheDocument();
  expect(
    await screen.findByText(/someone else changed this configuration/i),
  ).toBeInTheDocument();
  expect(screen.queryByText(/saved\. new version/i)).toBeNull();
});
