/**
 * tests/unit/validation.test.ts — Smoke tests for Zod schemas and
 * request parsing. Pure module: no env bootstrap needed.
 */

import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

import {
  BookingSourceSchema,
  CreateBookingSchema,
  DateSchema,
  FutureDateSchema,
  getWeekday,
  isValidAdvanceBookingDate,
  normalizePhone,
  parseBody,
  PhoneSchema,
} from "../../supabase/functions/_shared/validation.ts";
import { ValidationError } from "../../supabase/functions/_shared/errors.ts";

// ─── Phone normalization ──────────────────────────────────────────────────────

Deno.test("normalizePhone strips separators", () => {
  assertEquals(normalizePhone("98765 43210"), "9876543210");
  assertEquals(normalizePhone("98765-43210"), "9876543210");
  assertEquals(normalizePhone("(987) 654-3210"), "9876543210");
});

Deno.test("normalizePhone strips +91 / 91 country prefix", () => {
  assertEquals(normalizePhone("+919876543210"), "9876543210");
  assertEquals(normalizePhone("919876543210"), "9876543210");
  // 10-digit input starting with 91 is NOT stripped (length guard)
  assertEquals(normalizePhone("9123456789"), "9123456789");
});

Deno.test("PhoneSchema accepts valid Indian mobiles, rejects others", () => {
  assertEquals(PhoneSchema.safeParse("9876543210").success, true);
  assertEquals(PhoneSchema.safeParse("+91 6876543210").success, true);
  // must start with 6-9
  assertEquals(PhoneSchema.safeParse("5876543210").success, false);
  // wrong length
  assertEquals(PhoneSchema.safeParse("987654321").success, false);
  // empty
  assertEquals(PhoneSchema.safeParse("").success, false);
});

// ─── Date schemas ─────────────────────────────────────────────────────────────

Deno.test("DateSchema enforces YYYY-MM-DD", () => {
  assertEquals(DateSchema.safeParse("2026-08-15").success, true);
  assertEquals(DateSchema.safeParse("15-08-2026").success, false);
  assertEquals(DateSchema.safeParse("2026-13-45").success, false);
});

Deno.test("FutureDateSchema rejects past dates, accepts today", () => {
  assertEquals(FutureDateSchema.safeParse("2020-01-01").success, false);
  const today = new Date().toISOString().split("T")[0];
  assertEquals(FutureDateSchema.safeParse(today).success, true);
});

Deno.test("BookingSourceSchema matches the booking_source enum", () => {
  for (
    const src of ["online", "manual_free", "manual_whatsapp", "walkin"]
  ) {
    assertEquals(BookingSourceSchema.safeParse(src).success, true);
  }
  assertEquals(BookingSourceSchema.safeParse("receptionist").success, false);
});

// ─── CreateBookingSchema ──────────────────────────────────────────────────────

Deno.test("CreateBookingSchema applies defaults and normalizes phone", () => {
  const result = CreateBookingSchema.safeParse({
    hospitalId: "00000000-0000-4000-8000-000000000001",
    patientName: "  Ravi Kumar  ",
    patientPhone: "+91 9876543210",
    bookingSource: "online",
    appointmentDate: "2099-01-01",
  });
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.hasDiabetes, false);
    assertEquals(result.data.hasBp, false);
    assertEquals(result.data.patientName, "Ravi Kumar");
    assertEquals(result.data.patientPhone, "9876543210");
    assertEquals(result.data.doctorId, undefined);
  }
});

Deno.test("CreateBookingSchema rejects invalid UUID and short name", () => {
  const result = CreateBookingSchema.safeParse({
    hospitalId: "not-a-uuid",
    patientName: "R",
    patientPhone: "9876543210",
    bookingSource: "online",
    appointmentDate: "2099-01-01",
  });
  assertEquals(result.success, false);
  if (!result.success) {
    const paths = result.error.issues.map((i) => i.path.join("."));
    assert(paths.includes("hospitalId"));
    assert(paths.includes("patientName"));
  }
});

// ─── parseBody ────────────────────────────────────────────────────────────────

function jsonRequest(body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

Deno.test("parseBody returns validated, transformed data", async () => {
  const req = jsonRequest({ phone: "+91 9876543210" });
  const parsed = await parseBody(req, z.object({ phone: PhoneSchema }));
  assertEquals(parsed.phone, "9876543210");
});

Deno.test("parseBody throws ValidationError on invalid JSON", async () => {
  const req = new Request("http://localhost/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  await assertRejects(
    () => parseBody(req, DateSchema),
    ValidationError,
    "Invalid JSON body",
  );
});

Deno.test("parseBody rejects oversized bodies via Content-Length", async () => {
  const req = jsonRequest({ x: 1 }, { "Content-Length": "999999" });
  await assertRejects(
    () => parseBody(req, DateSchema, 32_768),
    ValidationError,
    "Request body too large",
  );
});

Deno.test("parseBody aggregates field-level errors", async () => {
  const req = jsonRequest({
    hospitalId: "bad",
    patientName: "R",
    patientPhone: "123",
    bookingSource: "online",
    appointmentDate: "2099-01-01",
  });
  try {
    await parseBody(req, CreateBookingSchema);
    throw new Error("should have thrown");
  } catch (err) {
    assert(err instanceof ValidationError);
    const fields = Object.keys((err as ValidationError).fieldErrors);
    assert(fields.includes("hospitalId"));
    assert(fields.includes("patientName"));
    assert(fields.includes("patientPhone"));
  }
});

// ─── Advance-booking window + weekday helpers ─────────────────────────────────

Deno.test("isValidAdvanceBookingDate enforces [today, today+max]", () => {
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86_400_000);
  const yesterday = new Date(Date.now() - 86_400_000);
  const in7 = new Date(Date.now() + 7 * 86_400_000);
  const in8 = new Date(Date.now() + 8 * 86_400_000);

  assert(isValidAdvanceBookingDate(fmt(today), 7));
  assert(isValidAdvanceBookingDate(fmt(tomorrow), 7));
  assert(isValidAdvanceBookingDate(fmt(in7), 7));
  assertFalse(isValidAdvanceBookingDate(fmt(yesterday), 7));
  assertFalse(isValidAdvanceBookingDate(fmt(in8), 7));
});

Deno.test("getWeekday returns 0=Sunday … 6=Saturday", () => {
  assertEquals(getWeekday("2026-08-09"), 0); // Sunday
  assertEquals(getWeekday("2026-08-10"), 1); // Monday
  assertEquals(getWeekday("2026-08-15"), 6); // Saturday
});

Deno.test("assertThrows smoke: ValidationError construction never throws", () => {
  assertThrows(
    () => {
      throw new ValidationError("x", { f: ["bad"] });
    },
    ValidationError,
  );
});
