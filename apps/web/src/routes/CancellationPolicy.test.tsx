import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError } from "@/lib/errors";
import type { CancellationPolicyReadResponseBody } from "@/types/api";

/**
 * WS-CONF-1 - Hospital Cancellation Policy Configuration frontend.
 *
 * The browser owns NOTHING of the write path (that is proven end-to-end by
 * the backend real-HTTP suite). These tests pin the page's OWN guarantees:
 *
 *  - the exported pure helper - buildPatch - mirrors the exact backend limits
 *    deterministically (whole-number windows >= 0, percentages 0..100,
 *    money >= 0, notes <= 2000, full window <= partial window), so the client
 *    pre-check never disagrees with what the RPC enforces; unchanged fields
 *    are OMITTED from the patch, and NUMERIC string/number representation
 *    differences do not fabricate an edit;
 *  - the admin route guard renders a restricted message for a non-admin and
 *    never fires a read (a UX boundary; the backend re-authorizes anyway);
 *  - loading a snapshot renders the SERVER-returned values (never a
 *    browser-fabricated default);
 *  - saving uses ONE stable Idempotency-Key per logical action with the
 *    version the server last returned;
 *  - a 409 DB_CONCURRENCY_ERROR and a 422 validation refusal are honestly
 *    surfaced, never dressed as a success.
 */
const readCall = vi.fn();
const updateCall = vi.fn();
vi.mock("@/api/cancellationPolicy", () => ({
  getCancellationPolicy: (hospitalId: string) => readCall(hospitalId),
  updateCancellationPolicy: (
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

const { buildPatch, CancellationPolicy } = await import(
  "@/routes/CancellationPolicy"
);

// ─── Fixture: a canonical server snapshot ────────────────────────────────────

function snapshot(
  over: Partial<CancellationPolicyReadResponseBody> = {},
): CancellationPolicyReadResponseBody {
  return {
    hospitalId: "h-1",
    version: 3,
    policy: {
      id: "p-1",
      full_refund_within_minutes: 30,
      partial_refund_percentage: "50.00",
      partial_refund_within_minutes: 1440,
      same_day_refund_percentage: "0.00",
      no_show_penalty_enabled: false,
      no_show_penalty_amount_inr: "0.00",
      allow_manual_full_refund: true,
      version: 3,
      effective_from: "2026-01-01",
      notes: "Baseline",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-06-01T00:00:00Z",
    },
    history: [],
    ...over,
  };
}

const baseBuffer = () => ({
  fullRefundWithinMinutes: "30",
  partialRefundWithinMinutes: "1440",
  partialRefundPercentage: "50",
  sameDayRefundPercentage: "0",
  noShowPenaltyEnabled: false,
  noShowPenaltyAmountInr: "0",
  allowManualFullRefund: true,
  notes: "Baseline",
});

// ─── Pure helper ─────────────────────────────────────────────────────────────

describe("buildPatch", () => {
  const snap = snapshot();
  it("returns no patch when the buffer is identical to the snapshot", () => {
    const { patch, errors } = buildPatch(snap, baseBuffer());
    expect(patch).toBeUndefined();
    expect(Object.keys(errors)).toHaveLength(0);
  });
  it("emits ONLY the changed fields", () => {
    const { patch } = buildPatch(snap, {
      ...baseBuffer(),
      fullRefundWithinMinutes: "45",
    });
    expect(patch).toEqual({ full_refund_within_minutes: 45 });
  });
  it("treats NUMERIC strings and numbers as equal (no spurious patch)", () => {
    // PostgREST may return a NUMERIC as either a string or a number; the
    // diff must not send an update just because the representation differs.
    const s = snapshot({
      policy: { ...snap.policy, partial_refund_percentage: 50 },
    });
    const { patch } = buildPatch(s, baseBuffer());
    expect(patch).toBeUndefined();
  });
  it("requires whole numbers >= 0 for the minute windows (mirrors RPC)", () => {
    expect(
      buildPatch(snap, { ...baseBuffer(), fullRefundWithinMinutes: "" }).errors
        .fullRefundWithinMinutes,
    ).toBeTruthy();
    expect(
      buildPatch(snap, { ...baseBuffer(), fullRefundWithinMinutes: "-5" }).errors
        .fullRefundWithinMinutes,
    ).toBeTruthy();
    expect(
      buildPatch(snap, { ...baseBuffer(), fullRefundWithinMinutes: "1.5" }).errors
        .fullRefundWithinMinutes,
    ).toBeTruthy();
    expect(
      buildPatch(snap, { ...baseBuffer(), partialRefundWithinMinutes: "abc" })
        .errors.partialRefundWithinMinutes,
    ).toBeTruthy();
  });
  it("enforces percentages 0..100", () => {
    expect(
      buildPatch(snap, { ...baseBuffer(), sameDayRefundPercentage: "150" })
        .errors.sameDayRefundPercentage,
    ).toBeTruthy();
    expect(
      buildPatch(snap, { ...baseBuffer(), partialRefundPercentage: "-1" })
        .errors.partialRefundPercentage,
    ).toBeTruthy();
    // 70.5 inside the range is a legal patch value.
    const { patch, errors } = buildPatch(snap, {
      ...baseBuffer(),
      partialRefundPercentage: "70.5",
    });
    expect(Object.keys(errors)).toHaveLength(0);
    expect(patch).toEqual({ partial_refund_percentage: 70.5 });
  });
  it("enforces money >= 0 and boolean toggles emit exactly when flipped", () => {
    expect(
      buildPatch(snap, { ...baseBuffer(), noShowPenaltyAmountInr: "-2" }).errors
        .noShowPenaltyAmountInr,
    ).toBeTruthy();
    const { patch } = buildPatch(snap, {
      ...baseBuffer(),
      noShowPenaltyEnabled: true,
      allowManualFullRefund: false,
    });
    expect(patch).toEqual({
      no_show_penalty_enabled: true,
      allow_manual_full_refund: false,
    });
  });
  it("rejects notes over 2000 chars and trims the rest", () => {
    expect(
      buildPatch(snap, { ...baseBuffer(), notes: "x".repeat(2001) }).errors
        .notes,
    ).toBeTruthy();
    const { patch } = buildPatch(snap, { ...baseBuffer(), notes: "  Tight  " });
    expect(patch).toEqual({ notes: "Tight" });
  });
  it("mirrors the DB cross-tier CHECK: full window must not exceed partial", () => {
    const { patch, errors } = buildPatch(snap, {
      ...baseBuffer(),
      fullRefundWithinMinutes: "2000",
    });
    expect(errors.fullRefundWithinMinutes).toBeTruthy();
    expect(patch).toBeUndefined();
  });
});

// ─── Component behavior ──────────────────────────────────────────────────────

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/admin/cancellation-policy"]}>
      <Routes>
        <Route
          path="/admin/cancellation-policy"
          element={<CancellationPolicy />}
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

it("hides the form from a non-admin (UX guard) and never reads", () => {
  auth.current.role = "doctor";
  renderPage();
  expect(
    screen.getByText(/restricted to hospital and global administrators/i),
  ).toBeInTheDocument();
  expect(readCall).not.toHaveBeenCalled();
});

it("shows a waiting state when there is no acting hospital", () => {
  auth.current.hospitalId = null;
  renderPage();
  expect(
    screen.getByText(/waiting for a request context/i),
  ).toBeInTheDocument();
  expect(readCall).not.toHaveBeenCalled();
});

it("loads and renders the server snapshot (values + version badge)", async () => {
  renderPage();
  await waitFor(() => expect(readCall).toHaveBeenCalledWith("h-1"));
  expect(await screen.findByDisplayValue("30")).toBeInTheDocument();
  expect(screen.getByDisplayValue("1440")).toBeInTheDocument();
  expect(screen.getByText("v3")).toBeInTheDocument();
});

it("saves with one stable idempotency key and only the changed fields", async () => {
  updateCall.mockResolvedValue({
    hospitalId: "h-1",
    version: 4,
    updated: true,
  });
  renderPage();
  await screen.findByDisplayValue("30");

  const fullMin = screen.getByTestId("full-min");
  await userEvent.clear(fullMin);
  await userEvent.type(fullMin, "45");

  await userEvent.click(screen.getByTestId("save-btn"));

  await waitFor(() => expect(updateCall).toHaveBeenCalledTimes(1));
  const [hosp, key, input] = updateCall.mock.calls[0];
  expect(hosp).toBe("h-1");
  expect(typeof key).toBe("string");
  expect(key.length).toBeGreaterThan(0);
  expect(input).toEqual({
    expectedVersion: 3,
    patch: { full_refund_within_minutes: 45 },
  });

  // Honest success banner after the server confirms.
  expect(
    await screen.findByText(/saved\. new version 4/i),
  ).toBeInTheDocument();
});

it("renders an honest conflict error and never a fake success", async () => {
  updateCall.mockRejectedValue(
    new ApiError({
      code: "DB_CONCURRENCY_ERROR",
      message: "Policy was changed by someone else. Reload and try again.",
      status: 409,
    }),
  );
  renderPage();
  await screen.findByDisplayValue("30");
  await userEvent.clear(screen.getByTestId("full-min"));
  await userEvent.type(screen.getByTestId("full-min"), "60");
  await userEvent.click(screen.getByTestId("save-btn"));

  expect(
    await screen.findByText(/someone else changed|reload and try again/i),
  ).toBeInTheDocument();
  expect(screen.queryByText(/saved\. new version/i)).toBeNull();
});

it("renders an honest validation error and never a fake success", async () => {
  updateCall.mockRejectedValue(
    new ApiError({
      code: "VALIDATION_ERROR",
      message: "Policy rejected",
      status: 422,
    }),
  );
  renderPage();
  await screen.findByDisplayValue("30");
  await userEvent.clear(screen.getByTestId("partial-pct"));
  // Locally valid (0-100, changed): the refusal must come from the server.
  await userEvent.type(screen.getByTestId("partial-pct"), "90");
  await userEvent.click(screen.getByTestId("save-btn"));

  expect(await screen.findByText(/policy rejected/i)).toBeInTheDocument();
  expect(screen.queryByText(/saved\. new version/i)).toBeNull();
});

it("disables the save when an edit is locally invalid, before any request", async () => {
  renderPage();
  await screen.findByDisplayValue("30");

  // A valid edit first: the button genuinely becomes enabled.
  await userEvent.clear(screen.getByTestId("full-min"));
  await userEvent.type(screen.getByTestId("full-min"), "45");
  await waitFor(() =>
    expect(
      (screen.getByTestId("save-btn") as HTMLButtonElement).disabled,
    ).toBe(false),
  );

  // Then an out-of-range percentage: buildPatch yields no valid patch, so
  // the page withdraws the save — the client pre-check agrees with the RPC.
  await userEvent.clear(screen.getByTestId("same-day-pct"));
  await userEvent.type(screen.getByTestId("same-day-pct"), "120");
  await waitFor(() =>
    expect(
      (screen.getByTestId("save-btn") as HTMLButtonElement).disabled,
    ).toBe(true),
  );
  expect(updateCall).not.toHaveBeenCalled();
});
