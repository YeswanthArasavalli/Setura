/**
 * validation.ts — Zod schemas and runtime validators
 *
 * All inbound request bodies are validated here before reaching business logic.
 * Normalization (phone, dates) happens inside the schema transforms.
 */

import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { ValidationError } from "./errors.ts";

// ─── Primitive validators ─────────────────────────────────────────────────────

export const UuidSchema = z
  .string()
  .uuid("Must be a valid UUID");

export const OptionalUuidSchema = z
  .string()
  .uuid("Must be a valid UUID")
  .optional()
  .nullable();

/**
 * Phone normalization:
 * - Strips spaces, dashes, parentheses
 * - Strips country code (91 or +91) for 10-digit Indian numbers
 * - Returns 10-digit normalized phone
 */
export function normalizePhone(raw: string): string {
  let phone = raw.replace(/[\s\-().+]/g, "");
  if (phone.startsWith("91") && phone.length === 12) {
    phone = phone.slice(2);
  }
  return phone;
}

export const PhoneSchema = z
  .string()
  .min(1, "Phone is required")
  .transform(normalizePhone)
  .refine((p) => /^[6-9][0-9]{9}$/.test(p), {
    message: "Must be a valid 10-digit Indian mobile number",
  });

export const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format")
  .refine((d) => !isNaN(Date.parse(d)), { message: "Must be a valid date" });

export const FutureDateSchema = DateSchema.refine(
  (d) => new Date(d) >= new Date(new Date().toISOString().split("T")[0]),
  { message: "Date must not be in the past" },
);

export const GenderSchema = z.enum(["M", "F", "Other"]).optional().nullable();

export const BloodGroupSchema = z
  .enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"])
  .optional()
  .nullable();

export const BookingSourceSchema = z.enum(
  [
    "online",
    "manual_free",
    "manual_whatsapp",
    "walkin",
  ] as const,
);

// ─── Create booking schema ────────────────────────────────────────────────────

export const CreateBookingSchema = z.object({
  hospitalId: UuidSchema,
  queueSessionId: OptionalUuidSchema,
  patientName: z.string().min(2, "Name must be at least 2 characters").max(100)
    .trim(),
  patientPhone: PhoneSchema,
  patientAge: z.number().int().min(0).max(150).optional().nullable(),
  patientGender: GenderSchema,
  village: z.string().max(100).trim().optional().nullable(),
  bloodGroup: BloodGroupSchema,
  hasDiabetes: z.boolean().default(false),
  hasBp: z.boolean().default(false),
  bookingSource: BookingSourceSchema,
  doctorId: OptionalUuidSchema,
  appointmentDate: FutureDateSchema,
});

export type ValidatedCreateBookingRequest = z.infer<typeof CreateBookingSchema>;

// ─── Generic request body parser ─────────────────────────────────────────────

/**
 * Parses and validates the request body against a Zod schema.
 * Throws ValidationError with field-level errors on failure.
 * Throws ValidationError("Body too large") if > maxBytes.
 */
export async function parseBody<T>(
  req: Request,
  schema: z.ZodSchema<T>,
  maxBytes = 32_768, // 32 KB
): Promise<T> {
  // Size guard
  const contentLength = req.headers.get("Content-Length");
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new ValidationError("Request body too large", {
      body: [`Maximum size is ${maxBytes} bytes`],
    });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ValidationError("Invalid JSON body", {
      body: ["Request body must be valid JSON"],
    });
  }

  const result = schema.safeParse(raw);

  if (!result.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join(".") || "root";
      if (!fieldErrors[key]) fieldErrors[key] = [];
      fieldErrors[key].push(issue.message);
    }
    throw new ValidationError("Validation failed", fieldErrors);
  }

  return result.data;
}

// ─── Hospital open check helpers ──────────────────────────────────────────────

export function isValidAdvanceBookingDate(
  date: string,
  maxAdvanceDays: number,
): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  const diffMs = target.getTime() - today.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return diffDays >= 0 && diffDays <= maxAdvanceDays;
}

/**
 * Returns the day-of-week index for an ISO date string (0 = Sunday),
 * matching hospital_working_hours.weekday.
 */
export function getWeekday(date: string): number {
  return new Date(date).getDay(); // 0=Sunday
}
