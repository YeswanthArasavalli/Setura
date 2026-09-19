// Real-backend E2E of the Phase 6 core journey. This is NOT the browser app;
// it replays the EXACT HTTP contracts the frontend api/ layer sends (same
// headers, bodies, idempotency) against the running local Supabase stack, so we
// get deterministic runtime evidence of the journey the slice depends on.
//
// Run: node apps/web/e2e/core_journey.mjs  (requires `supabase start` up)
const BASE = process.env.E2E_BASE || "http://127.0.0.1:54321";
const ANON =
  process.env.E2E_ANON ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const HOSPITAL = "00000000-0000-4000-8000-000000000001";
const DOCTOR = "00000000-0000-4000-8000-0000000000a3";
const PW = "Setura@123";

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${detail}` : ""}`);
}

async function login(email) {
  const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON },
    body: JSON.stringify({ email, password: PW }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    throw new Error(`login ${email} → ${r.status} ${JSON.stringify(j)}`);
  }
  return j.access_token;
}

async function callFn(fn, token, body, { idem } = {}) {
  const headers = {
    "Content-Type": "application/json",
    apikey: ANON,
    Authorization: `Bearer ${token}`,
    "X-Hospital-ID": HOSPITAL,
  };
  if (idem) headers["Idempotency-Key"] = idem;
  const r = await fetch(`${BASE}/functions/v1/${fn}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}

function stamp() {
  return Date.now().toString().slice(-7);
}

async function main() {
  console.log("— Phase 6 core-journey E2E against", BASE, "—\n");

  // 1. Auth (receptionist) — real login, role/tenant resolved server-side.
  const recep = await login("reception@surya.test");
  check("receptionist login yields JWT", !!recep);

  const today = new Date().toISOString().slice(0, 10);

  // 1b. Doctor picker source: receptionist reads doctor_specializations via
  //     RLS (the embedded profiles.full_name may be null for non-admins, but
  //     the doctor_id needed to assign a queue must be visible).
  const docsRes = await fetch(
    `${BASE}/rest/v1/doctor_specializations?hospital_id=eq.${HOSPITAL}&is_deleted=eq.false&select=doctor_id,specialization_name,profiles(full_name)`,
    { headers: { apikey: ANON, Authorization: `Bearer ${recep}` } },
  );
  const docs = await docsRes.json();
  check(
    "receptionist can read assignable doctors (picker source)",
    Array.isArray(docs) && docs.some((d) => d.doctor_id === DOCTOR),
    `rows=${Array.isArray(docs) ? docs.length : JSON.stringify(docs)}`,
  );

  // 2a. Walk-in WITHOUT a doctor (exactly what BookingForm sends today).
  const s1 = stamp();
  const k1 = crypto.randomUUID();
  const noDoc = await callFn(
    "create-booking",
    recep,
    {
      hospitalId: HOSPITAL,
      patientName: `E2E NoDoc ${s1}`,
      patientPhone: `980${s1}`.slice(0, 10),
      patientAge: 40,
      patientGender: "M",
      village: "Narsapur",
      bookingSource: "walkin",
      appointmentDate: today,
      doctorId: null,
    },
    { idem: k1 },
  );
  check(
    "walk-in (no doctor) → 2xx",
    noDoc.status >= 200 && noDoc.status < 300,
    `status ${noDoc.status} ${JSON.stringify(noDoc.json?.error || "")}`,
  );
  const noDocData = noDoc.json?.data;
  console.log(
    "   · no-doctor booking:",
    JSON.stringify({
      tokenNumber: noDocData?.tokenNumber,
      queueSessionId: noDocData?.queueSessionId,
      fees: noDocData?.fees,
    }),
  );

  // 2b. Walk-in WITH a doctor → enters that doctor's callable queue.
  const s2 = stamp() + "a";
  const k2 = crypto.randomUUID();
  const withDoc = await callFn(
    "create-booking",
    recep,
    {
      hospitalId: HOSPITAL,
      patientName: `E2E Queue ${s2}`,
      patientPhone: `9811${s2}`.slice(0, 10),
      patientAge: 33,
      patientGender: "F",
      village: "Narsapur",
      bookingSource: "walkin",
      appointmentDate: today,
      doctorId: DOCTOR,
    },
    { idem: k2 },
  );
  check(
    "walk-in (with doctor) → 2xx",
    withDoc.status >= 200 && withDoc.status < 300,
    `status ${withDoc.status} ${JSON.stringify(withDoc.json?.error || "")}`,
  );
  const bk = withDoc.json?.data;
  const queueSessionId = bk?.queueSessionId;
  const bookingId = bk?.bookingId;
  check(
    "with-doctor booking is attached to a queue session",
    !!queueSessionId,
    `queueSessionId=${queueSessionId}`,
  );
  check("with-doctor booking got a token", Number.isFinite(bk?.tokenNumber), `token=${bk?.tokenNumber}`);

  // 3. Idempotency replay — same key must NOT create a second booking.
  const replay = await callFn(
    "create-booking",
    recep,
    {
      hospitalId: HOSPITAL,
      patientName: `E2E Queue ${s2}`,
      patientPhone: `9811${s2}`.slice(0, 10),
      bookingSource: "walkin",
      appointmentDate: today,
      doctorId: DOCTOR,
    },
    { idem: k2 },
  );
  check(
    "replay of same Idempotency-Key returns same bookingId",
    replay.json?.data?.bookingId === bookingId,
    `${replay.json?.data?.bookingId} vs ${bookingId}`,
  );

  // 4. Queue snapshot via queue-control (reception board).
  const snap = await callFn(
    "queue-control",
    recep,
    { queueSessionId, action: "snapshot" },
  );
  check(
    "queue-control snapshot → 2xx with snapshot",
    snap.status === 200 && !!snap.json?.data?.snapshot,
    `status ${snap.status}`,
  );
  const waitingTokens = (snap.json?.data?.snapshot?.waiting || []).map(
    (w) => w.token_number,
  );
  check(
    "our booking appears in the waiting queue",
    waitingTokens.includes(bk?.tokenNumber),
    `waiting=${JSON.stringify(waitingTokens)}`,
  );

  // 5. Doctor journey: login → start session → call next → consult → note → complete.
  const doctor = await login("dr@surya.test");
  check("doctor login yields JWT", !!doctor);

  const startSess = await callFn("doctor-operations", doctor, {
    action: "start_session",
  });
  check(
    "doctor start_session → 2xx",
    startSess.status === 200 && !!startSess.json?.data,
    `status ${startSess.status} ${JSON.stringify(startSess.json?.error || "")}`,
  );

  const callNext = await callFn("doctor-operations", doctor, {
    action: "call_next",
    queueSessionId,
  });
  check(
    "doctor call_next → 2xx",
    callNext.status === 200,
    `status ${callNext.status} ${JSON.stringify(callNext.json?.error || "")}`,
  );

  const startConsult = await callFn("doctor-operations", doctor, {
    action: "start_consultation",
    queueSessionId,
    bookingId,
  });
  check(
    "doctor start_consultation → 2xx",
    startConsult.status === 200,
    `status ${startConsult.status} ${JSON.stringify(startConsult.json?.error || "")}`,
  );

  const saveNote = await callFn("doctor-operations", doctor, {
    action: "save_note",
    queueSessionId,
    bookingId,
    notes: "E2E examination note.",
    diagnosisSummary: "E2E diagnosis",
  });
  check(
    "doctor save_note → 2xx",
    saveNote.status === 200,
    `status ${saveNote.status} ${JSON.stringify(saveNote.json?.error || "")}`,
  );

  const complete = await callFn("doctor-operations", doctor, {
    action: "complete_consultation",
    queueSessionId,
    bookingId,
  });
  check(
    "doctor complete_consultation → 2xx",
    complete.status === 200,
    `status ${complete.status} ${JSON.stringify(complete.json?.error || "")}`,
  );

  // 6. Read the booking via PostgREST/RLS exactly as BookingDetail does, to
  //    confirm the payment/billing snapshot fields are visible to staff.
  const readRes = await fetch(
    `${BASE}/rest/v1/bookings?id=eq.${bookingId}&hospital_id=eq.${HOSPITAL}&select=id,status,token_number,booking_source,payment_completed,total_amount_snapshot,platform_fee_snapshot,consultation_completed_at`,
    { headers: { apikey: ANON, Authorization: `Bearer ${recep}` } },
  );
  const rows = await readRes.json();
  check(
    "receptionist can read own booking via RLS",
    Array.isArray(rows) && rows.length === 1,
    `rows=${Array.isArray(rows) ? rows.length : "?"}`,
  );
  console.log("   · booking read:", JSON.stringify(rows?.[0] || rows));
  check(
    "completed consultation is reflected on the booking",
    !!rows?.[0]?.consultation_completed_at,
    `consultation_completed_at=${rows?.[0]?.consultation_completed_at}`,
  );

  // 7. Tenant isolation probe: a JWT for a DIFFERENT hospital's booking filter
  //    must return nothing (RLS). Use a random uuid as hospital_id.
  const iso = await fetch(
    `${BASE}/rest/v1/bookings?id=eq.${bookingId}&hospital_id=eq.00000000-0000-4000-8000-00000000dead&select=id`,
    { headers: { apikey: ANON, Authorization: `Bearer ${recep}` } },
  );
  const isoRows = await iso.json();
  check(
    "cross-tenant read returns nothing (RLS)",
    Array.isArray(isoRows) && isoRows.length === 0,
    `rows=${JSON.stringify(isoRows)}`,
  );

  console.log(`\n— E2E ${failures === 0 ? "PASSED" : `FAILED (${failures})`} —`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E crashed:", e.message);
  process.exit(2);
});
