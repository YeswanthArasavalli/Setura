/**
 * tests/utils/seed_constants.ts — Fixed identifiers from supabase/seed.sql
 *
 * These values are the contract between the deterministic seed and
 * every test/assertion that verifies seeded state. If the seed
 * changes, change ONLY this file and the seed together.
 */

export const SEED = {
  HOSPITAL_ID: "00000000-0000-4000-8000-000000000001",
  GLOBAL_ADMIN_ID: "00000000-0000-4000-8000-0000000000a1",
  HOSPITAL_ADMIN_ID: "00000000-0000-4000-8000-0000000000a2",
  DOCTOR_ID: "00000000-0000-4000-8000-0000000000a3",
  RECEPTIONIST_ID: "00000000-0000-4000-8000-0000000000a4",

  HOSPITAL_NAME: "Surya Hospital",
  HOSPITAL_SLUG: "surya-hospital",

  GLOBAL_ADMIN_EMAIL: "root@setura.test",
  HOSPITAL_ADMIN_EMAIL: "admin@surya.test",
  DOCTOR_EMAIL: "dr@surya.test",
  RECEPTIONIST_EMAIL: "reception@surya.test",

  // Seeded counts (exact — proves idempotency, no duplicate rows)
  EXPECTED: {
    PROFILES: 4,
    USER_ROLES: 4,
    DOCTOR_SPECIALIZATIONS: 1,
    WORKING_HOURS_ROWS: 7,
    DOCTOR_SCHEDULES: 12, // 6 weekdays × 2 shifts
    QUEUE_CONFIGS: 3,
    FEATURE_FLAGS: 3,
  },
} as const;
