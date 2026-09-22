/** Row shapes returned by PostgREST for the doctor-directory reads. */

export const doctorSpecRows = [
  {
    doctor_id: "d-1",
    specialization_name: "Cardiology",
    consultation_fee: 500,
    profiles: { full_name: "Anitha Rao" },
  },
  {
    doctor_id: "d-2",
    specialization_name: "Pediatrics",
    consultation_fee: 600,
    profiles: { full_name: "Mohan Das" },
  },
  // Same doctor, second specialization: must collapse into one option.
  {
    doctor_id: "d-2",
    specialization_name: "Neonatology",
    consultation_fee: 600,
    profiles: { full_name: "Mohan Das" },
  },
];

/** A caller whose RLS does not expose `profiles` at all (embedding rejected). */
export const doctorSpecRowsNoProfiles = [
  {
    doctor_id: "d-1",
    specialization_name: "Cardiology",
    consultation_fee: 500,
    profiles: null,
  },
];

/** `profiles` readable but the directory row has no name recorded. */
export const doctorSpecRowsNullProfile = [
  {
    doctor_id: "d-3",
    specialization_name: "General Medicine",
    consultation_fee: 300,
    profiles: { full_name: null },
  },
];

export const profileRows = [
  { id: "d-1", full_name: "Anitha Rao" },
  { id: "d-2", full_name: null },
];
