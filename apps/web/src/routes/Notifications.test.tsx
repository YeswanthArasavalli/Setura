import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { NotificationRow } from "@/api/reads";

/**
 * The read-only Notifications / delivery-status surface (Phase 7).
 *
 * RLS scoping is proven by the DB, so only the `reads.ts` boundary is mocked
 * here. The tests pin the required UX states (list, status labels, loading,
 * empty, error), long-error layout safety and that no action buttons exist.
 */
const listNotifications = vi.fn();
vi.mock("@/api/reads", () => ({
  listNotifications: (h: string) => listNotifications(h),
}));
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ hospitalId: "h-1" }),
}));

const { Notifications } = await import("@/routes/Notifications");

function notification(
  overrides: Partial<NotificationRow> = {},
): NotificationRow {
  return {
    id: "n-1",
    hospital_id: "h-1",
    patient_id: "p-1",
    booking_id: "b-1",
    channel: "whatsapp",
    priority: "medium",
    status: "delivered",
    recipient: "+919876543210",
    title: "Appointment reminder",
    retry_count: 0,
    scheduled_for: "2026-09-22T09:00:00Z",
    sent_at: "2026-09-22T09:00:05Z",
    delivered_at: "2026-09-22T09:00:20Z",
    failed_at: null,
    last_error: null,
    created_at: "2026-09-22T09:00:00Z",
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/reception/notifications"]}>
      <Routes>
        <Route path="/reception/notifications" element={<Notifications />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listNotifications.mockReset();
});

describe("Notifications surface", () => {
  it("renders notification records returned by the read", async () => {
    listNotifications.mockResolvedValue([
      notification({ recipient: "+919876543210" }),
      notification({ id: "n-2", recipient: "+919999988888", channel: "sms" }),
    ]);
    renderPage();

    expect(await screen.findByText("+919876543210")).toBeInTheDocument();
    expect(screen.getByText("+919999988888")).toBeInTheDocument();
    expect(screen.getByText("sms")).toBeInTheDocument();
  });

  it("renders the mapped status label (not the raw enum)", async () => {
    listNotifications.mockResolvedValue([
      notification({ status: "permanently_failed" }),
    ]);
    renderPage();

    expect(await screen.findByText("Failed permanently")).toBeInTheDocument();
    // The raw enum value must never leak into the rendered page.
    expect(screen.queryByText("permanently_failed")).toBeNull();
  });

  it("shows a loading state while the read is in flight", () => {
    listNotifications.mockReturnValue(
      new Promise(() => {
        /* never settles: models the transient loading window */
      }),
    );
    renderPage();

    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the empty state (not an error) when there are no records", async () => {
    listNotifications.mockResolvedValue([]);
    renderPage();

    expect(
      await screen.findByText("No notifications found."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces a failed read as an error, never as an empty list", async () => {
    listNotifications.mockRejectedValue(new Error("notification read failed"));
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "notification read failed",
    );
    expect(screen.queryByText("No notifications found.")).toBeNull();
  });

  it("truncates a long last_error without breaking the row or leaking undefined", async () => {
    const long = "x".repeat(500);
    listNotifications.mockResolvedValue([
      notification({ status: "failed", last_error: long }),
    ]);
    renderPage();

    const cell = await screen.findByTitle(long);
    expect(cell).toBeInTheDocument();
    // Truncation keeps it in a single bounded cell, not an uncontrolled blob.
    expect(cell.className).toContain("truncate");
    expect(document.body.textContent).not.toMatch(/undefined|\[object/);
  });

  it("is read-only: renders no retry/resend/cancel action controls", async () => {
    listNotifications.mockResolvedValue([notification()]);
    renderPage();
    await screen.findByText("+919876543210");

    for (const label of ["Retry", "Resend", "Cancel", "Replay"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("does not leak internal identifiers or fields into unrelated text", async () => {
    listNotifications.mockResolvedValue([
      notification({ id: "secret-uuid-1" }),
    ]);
    renderPage();
    await screen.findByText("+919876543210");

    // The row uuid is used only as a React key, never rendered as visible text.
    expect(screen.queryByText("secret-uuid-1")).toBeNull();
    // No raw hospital id leaks into the DOM text.
    expect(screen.queryByText("h-1")).toBeNull();
  });
});
