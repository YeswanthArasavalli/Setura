// TEMP: hosted E1 journey + tenant isolation against real staging HTTPS.
export {};
// Disposable seed data only. Prints masked, non-secret signals.
const REF = "gzcqasntcbqqmgsoikms";
const BASE = `https://${REF}.supabase.co`;
const HOSP_A = "00000000-0000-4000-8000-000000000001";
const HOSP_B = "00000000-0000-4000-8000-000000000002";
const DOCTOR = "00000000-0000-4000-8000-0000000000a3";

const rawAll = Deno.readTextFileSync("./_keys.json");
const keys = JSON.parse(rawAll.slice(rawAll.indexOf("["), rawAll.lastIndexOf("]") + 1)) as { name: string; type: string; api_key: string }[];
const ANON = keys.find((k) => k.type === "publishable")?.api_key || "";

async function hit(path: string, opt: RequestInit, key = ANON) {
  const r = await fetch(BASE + path, { ...opt, headers: { apikey: key, ...(opt.headers || {}) } });
  const t = await r.text();
  return { status: r.status, text: t };
}
const json = (s: string) => { try { return JSON.parse(s); } catch { return {}; } };
async function login(email: string) {
  const r = await hit("/auth/v1/token?grant_type=password", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Setura@123" }),
  });
  return json(r.text).access_token || "";
}
const short = (s: string, n = 140) => s.slice(0, n).replace(/\s+/g, " ");

// ── 1. Tenant A staff login ─────────────────────────────────────────────
const JWT_A = await login("reception@surya.test");
console.log("1_login_A            :", JWT_A ? "OK (token)" : `FAIL`);

// ── 2. E1 walk-in booking through hosted Edge Function ──────────────────
const apptDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const bookBody = {
  hospitalId: HOSP_A, patientName: "E1 Staging Patient", patientPhone: "9876543210",
  patientAge: 42, patientGender: "M", bookingSource: "walkin",
  doctorId: DOCTOR, appointmentDate: apptDate,
};
const idem1 = crypto.randomUUID();
const b1 = await hit("/functions/v1/create-booking", {
  method: "POST",
  headers: { "content-type": "application/json", Authorization: `Bearer ${JWT_A}`, "X-Hospital-ID": HOSP_A, "Idempotency-Key": idem1 },
  body: JSON.stringify(bookBody),
});
const r1 = json(b1.text);
console.log("2_create_booking     :", `HTTP ${b1.status} token=${r1?.data?.tokenNumber ?? r1?.tokenNumber ?? "?"} ref=${short(String(r1?.data?.bookingReference ?? r1?.bookingReference ?? ""), 20)}`);
console.log("                        body=", short(b1.text));

// ── 3. Replay with same idempotency key ─────────────────────────────────
const b2 = await hit("/functions/v1/create-booking", {
  method: "POST",
  headers: { "content-type": "application/json", Authorization: `Bearer ${JWT_A}`, "X-Hospital-ID": HOSP_A, "Idempotency-Key": idem1 },
  body: JSON.stringify(bookBody),
});
console.log("3_idempotent_replay  :", `HTTP ${b2.status} same_token=${json(b2.text)?.data?.tokenNumber === r1?.data?.tokenNumber ? "yes" : "?"}`);

// ── 4. Booking visible to A via REST (RLS-scoped) ───────────────────────
const v = await hit(`/rest/v1/bookings?select=id,token_number,booking_reference,status&hospital_id=eq.${HOSP_A}`, { headers: { Authorization: `Bearer ${JWT_A}` } });
const rowsV = json(v.text);
console.log("4_A_reads_own_bookings:", `HTTP ${v.status} rows=${Array.isArray(rowsV) ? rowsV.length : short(v.text)}`);

// ── 5. Tenant B login + cannot see A patients/bookings ──────────────────
const JWT_B = await login("reception-b@surya.test");
const pB = await hit(`/rest/v1/patients?select=id,hospital_id`, { headers: { Authorization: `Bearer ${JWT_B}` } });
const rowsB = json(pB.text);
const foreign = Array.isArray(rowsB) ? rowsB.filter((x: { hospital_id: string }) => x.hospital_id !== HOSP_B).length : -1;
console.log("5_B_reads_patients   :", `HTTP ${pB.status} rows=${Array.isArray(rowsB) ? rowsB.length : "?"} foreign=${foreign}`);
const sB = await hit(`/rest/v1/hospital_settings?select=*&hospital_id=eq.${HOSP_A}`, { headers: { Authorization: `Bearer ${JWT_B}` } });
console.log("6_B_reads_A_settings :", `HTTP ${sB.status} rows=${Array.isArray(json(sB.text)) ? json(sB.text).length : short(sB.text)}`);

// ── 7. A cannot act on B through the Edge Function ─────────────────────
const x = await hit("/functions/v1/create-booking", {
  method: "POST",
  headers: { "content-type": "application/json", Authorization: `Bearer ${JWT_A}`, "X-Hospital-ID": HOSP_B, "Idempotency-Key": crypto.randomUUID() },
  body: JSON.stringify({ ...bookBody, hospitalId: HOSP_B }),
});
console.log("7_A_books_in_B       :", `HTTP ${x.status} ${short(x.text)}`);

// ── 8. A cannot read B rows via REST filter ─────────────────────────────
const q = await hit(`/rest/v1/patients?select=id&hospital_id=eq.${HOSP_B}`, { headers: { Authorization: `Bearer ${JWT_A}` } });
console.log("8_A_filter_B         :", `HTTP ${q.status} rows=${Array.isArray(json(q.text)) ? json(q.text).length : short(q.text)}`);
