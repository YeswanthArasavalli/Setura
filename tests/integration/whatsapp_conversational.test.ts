/**
 * tests/integration/whatsapp_conversational.test.ts
 *
 * Phase 1.1 — WhatsApp-first patient experience against the REAL
 * local stack (no mocks; Meta is never called).
 *
 * Drives processInboundMessage() end-to-end through the actual
 * conversation state machine, flows, RPCs and job queue:
 *
 *   Booking:      new patient / existing patient / duplicate /
 *                 idempotent / hospital isolation
 *   Queue:        active queue / no booking / completed / cancelled
 *   Reschedule:   success / doctor unavailable / hospital closed /
 *                 invalid date / concurrent update
 *   Cancel:       success / already cancelled / refund path /
 *                 no refund path
 *   Conversation: state timeout / interrupted flow / invalid input /
 *                 repeated messages / handoff
 *
 * Run with:  deno task test:integration   (requires `supabase start`)
 */

import {
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { SEED } from "../utils/seed_constants.ts";

interface LocalStatus {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

async function getLocalStatus(): Promise<LocalStatus | null> {
  try {
    const cmd = new Deno.Command("supabase", {
      args: ["status", "-o", "json"],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await cmd.output();
    if (code !== 0) return null;
    const text = new TextDecoder().decode(stdout);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return JSON.parse(text.slice(start, end + 1)) as LocalStatus;
  } catch {
    return null;
  }
}

// ─── Bootstrap: env must be set before _shared modules load ────────────────

type ServiceClient = Awaited<ReturnType<typeof getServiceClientLazy>>;

async function getServiceClientLazy() {
  const { getServiceClient } = await import(
    "../../supabase/functions/_shared/db.ts"
  );
  return getServiceClient();
}

let _client: ServiceClient | null = null;
let _engine:
  | typeof import("../../supabase/functions/_shared/whatsapp/whatsapp_conversation_engine.ts")
  | null = null;
let _logger:
  | InstanceType<
    typeof import("../../supabase/functions/_shared/logger.ts").Logger
  >
  | null = null;

async function client(): Promise<ServiceClient> {
  if (_client) return _client;

  const status = await getLocalStatus();
  if (!status) {
    throw new Error(
      "Local Supabase stack is not running. Run `supabase start` first.",
    );
  }

  Deno.env.set("APP_ENV", "test");
  Deno.env.set("SUPABASE_URL", status.API_URL);
  Deno.env.set("SUPABASE_ANON_KEY", status.ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", status.SERVICE_ROLE_KEY);

  _client = await getServiceClientLazy();
  _engine = await import(
    "../../supabase/functions/_shared/whatsapp/whatsapp_conversation_engine.ts"
  );
  const { Logger } = await import(
    "../../supabase/functions/_shared/logger.ts"
  );
  _logger = new Logger({ endpoint: "wa-conversational-test" });

  return _client;
}

// ─── Per-run fixture isolation ───────────────────────────────────────────────

// Digits-only run id: fixture phones flow through the queue lookup's
// E.164 validation and must not contain hex letters.
const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "7");

const PHONE_BOOK = `9811${RUN}01`;
const PHONE_QUEUE = `9811${RUN}02`;
const PHONE_NOQUEUE = `9811${RUN}03`;
const PHONE_QCANCEL = `9811${RUN}04`;
const PHONE_RESCHED = `9811${RUN}05`;
const PHONE_SUNDAY = `9811${RUN}06`;
const PHONE_HOLIDAY = `9811${RUN}07`;
const PHONE_BADDATe = `9811${RUN}08`;
const PHONE_CONCURRENT = `9811${RUN}09`;
const PHONE_CANCEL = `9811${RUN}10`;
const PHONE_REFUND = `9811${RUN}11`;
const PHONE_NOREFUND = `9811${RUN}12`;
const PHONE_CONV = `9811${RUN}13`;
const PHONE_HANDOFF = `9811${RUN}14`;
const PHONE_ISO = `9811${RUN}15`;

const HOSPITAL_A = SEED.HOSPITAL_ID;

function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Next date (>= startDaysAhead days out) the seeded doctor works. */
function nextWorkday(startDaysAhead: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + startDaysAhead);
  while (d.getDay() === 0) d.setDate(d.getDate() + 1); // doctor off Sundays
  return d;
}

const DATE_A = nextWorkday(1); // first valid future date
const DATE_B = nextWorkday(
  Math.max(2, Math.ceil((DATE_A.getTime() - Date.now()) / 86400000) + 1),
);
const DATE_HOL = nextWorkday(
  Math.max(3, Math.ceil((DATE_B.getTime() - Date.now()) / 86400000) + 1),
);
const TODAY = isoLocal(new Date());

function ddmm(d: Date): string {
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

// ─── Conversation driver helpers ─────────────────────────────────────────────

let msgSeq = 0;

interface SendResult {
  duplicate: boolean;
  intent: string;
  state: string;
  repliesEnqueued: number;
  replies: string[];
  metaId: string;
}

const metricNames: string[] = [];
const metricSink = {
  increment(name: string): void {
    metricNames.push(name);
  },
};

/** Sends one inbound message through the engine and collects replies. */
async function send(
  phone: string,
  text: string,
  opts: { hospitalId?: string; metaMessageId?: string } = {},
): Promise<SendResult> {
  const db = await client();
  const metaId = opts.metaMessageId ?? `waconv.${RUN}.${++msgSeq}`;

  const result = await _engine!.processInboundMessage(
    db,
    {
      hospitalId: opts.hospitalId ?? HOSPITAL_A,
      phone,
      text,
      metaMessageId: metaId,
    },
    _logger!,
    metricSink,
  );

  const { data } = await db
    .from("job_queue")
    .select("payload, idempotency_key")
    .like("idempotency_key", `reply_${metaId}%`)
    .order("created_at", { ascending: true });

  const replies = ((data ?? []) as Array<{
    payload: { text: string };
    idempotency_key: string;
  }>)
    .filter((r) => r.idempotency_key.startsWith(`reply_${metaId}_`))
    .map((r) => r.payload.text);

  if (!result.duplicate) {
    assertEquals(
      result.repliesEnqueued,
      replies.length,
      "engine must report exactly the reply jobs it enqueued",
    );
  }

  // A duplicate is a hard no-op: ignore jobs enqueued by the original.
  return { ...result, replies: result.duplicate ? [] : replies, metaId };
}

async function getState(
  phone: string,
  hospitalId: string = HOSPITAL_A,
): Promise<
  {
    state: string;
    context: Record<string, unknown>;
    unknown_count: number;
    expires_at: string;
  } | null
> {
  const db = await client();
  const { data, error } = await db.rpc("get_conversation_state", {
    p_hospital_id: hospitalId,
    p_phone: phone,
  });
  assertEquals(error, null);
  const rows = data as unknown as Array<{
    state: string;
    context: Record<string, unknown>;
    unknown_count: number;
    expires_at: string;
  }>;
  return rows && rows.length > 0 ? rows[0] : null;
}

/** Creates a booking directly through the atomic RPC (fixture). */
async function createDirectBooking(opts: {
  phone: string;
  date: string;
  name?: string;
  hospitalId?: string;
  doctorId?: string | null;
}): Promise<{ bookingId: string; token: number }> {
  const db = await client();
  const idemKey = `direct_${RUN}_${crypto.randomUUID().slice(0, 8)}`;

  const { data, error } = await db.rpc("create_booking", {
    p_hospital_id: opts.hospitalId ?? HOSPITAL_A,
    p_queue_session_id: undefined,
    p_patient_id: undefined,
    p_patient_name: opts.name ?? `Fixture ${RUN}`,
    p_patient_phone: opts.phone,
    p_booking_source: "manual_whatsapp",
    p_doctor_id: opts.doctorId === null
      ? undefined
      : (opts.doctorId ?? SEED.DOCTOR_ID),
    p_appointment_date: opts.date,
    p_platform_fee: 10,
    p_receptionist_fee: 0,
    p_hospital_fee: 0,
    p_idempotency_key: idemKey,
  });

  assertEquals(error, null);
  const rows = data as Array<{ booking_id: string; token_number: number }>;
  assertExists(rows?.[0]);
  return { bookingId: rows[0].booking_id, token: rows[0].token_number };
}

async function getBooking(bookingId: string): Promise<{
  status: string;
  appointment_date: string;
  hospital_id: string;
  token_number: number | null;
  idempotency_key: string | null;
  booking_source: string;
  carry_forwarded_from: string | null;
  cancellation_reason: string | null;
}> {
  const db = await client();
  const { data, error } = await db
    .from("bookings")
    .select(
      "status, appointment_date, hospital_id, token_number, idempotency_key, booking_source, carry_forwarded_from, cancellation_reason",
    )
    .eq("id", bookingId)
    .single();
  assertEquals(error, null);
  return data as unknown as ReturnType<typeof getBooking> extends Promise<
    infer T
  > ? T
    : never;
}

async function countBookings(phone: string, date: string): Promise<number> {
  const db = await client();
  const { data } = await db
    .from("bookings")
    .select("id")
    .eq("hospital_id", HOSPITAL_A)
    .eq("patient_phone", phone)
    .eq("appointment_date", date)
    .eq("is_deleted", false);
  return (data ?? []).length;
}

// ════════════════════════════════════════════════════════════════════════════
// BOOKING
// ════════════════════════════════════════════════════════════════════════════

Deno.test("wa booking: new patient — asks for name first", async () => {
  const r = await send(PHONE_BOOK, "book");
  assertEquals(r.state, "booking");
  assertStringIncludes(r.replies[0].toLowerCase(), "name");
});

Deno.test("wa booking: name given — advances to date selection", async () => {
  const r = await send(PHONE_BOOK, `my name is Ravi Test${RUN}`);
  // Seeded hospital has exactly one active doctor → auto-selected.
  assertEquals(r.state, "selecting_date");
  assertStringIncludes(r.replies[0].toLowerCase(), "date");
});

Deno.test("wa booking: valid date — asks for confirmation with fee", async () => {
  const r = await send(PHONE_BOOK, ddmm(DATE_A));
  assertEquals(r.state, "confirming");
  assertStringIncludes(r.replies[0], isoLocal(DATE_A));
  assertStringIncludes(r.replies[0].toLowerCase(), "confirm");
});

Deno.test("wa booking: yes — booking created with token via RPC", async () => {
  const before = await countBookings(PHONE_BOOK, isoLocal(DATE_A));
  assertEquals(before, 0);

  const r = await send(PHONE_BOOK, "yes");
  assertEquals(r.state, "idle");
  assertStringIncludes(r.replies[0].toLowerCase(), "confirmed");

  const db = await client();
  const { data } = await db
    .from("bookings")
    .select("id, token_number, status, booking_source, idempotency_key")
    .eq("hospital_id", HOSPITAL_A)
    .eq("patient_phone", PHONE_BOOK)
    .eq("appointment_date", isoLocal(DATE_A))
    .eq("is_deleted", false)
    .limit(1);

  const rows = data as Array<{
    id: string;
    token_number: number;
    status: string;
    booking_source: string;
    idempotency_key: string;
  }>;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].status, "booked");
  assertEquals(rows[0].booking_source, "manual_whatsapp");
  assertEquals(
    rows[0].idempotency_key,
    `wa_book_${HOSPITAL_A}_${PHONE_BOOK}_${isoLocal(DATE_A)}`,
  );
  assertStringIncludes(r.replies[0], `*${rows[0].token_number}*`);

  // Patient row was created hospital-scoped
  const { data: patients } = await db
    .from("patients")
    .select("id, full_name")
    .eq("hospital_id", HOSPITAL_A)
    .eq("normalized_phone", PHONE_BOOK);
  assertEquals((patients ?? []).length, 1);
});

Deno.test("wa booking: existing patient skips the name step", async () => {
  const r = await send(PHONE_BOOK, "book appointment");
  assertEquals(r.state, "selecting_date");
  assertStringIncludes(r.replies[0].toLowerCase(), "date");
  // Abort cleanly so later tests see a clean state
  await send(PHONE_BOOK, "no");
});

Deno.test("wa booking: duplicate same-day booking is refused politely", async () => {
  await send(PHONE_BOOK, ddmm(DATE_A)); // already asked for confirmation?
  const state = await getState(PHONE_BOOK);
  // If previous abort left us idle, restart the flow
  if (state?.state !== "confirming") {
    await send(PHONE_BOOK, "book");
    await send(PHONE_BOOK, ddmm(DATE_A));
  }

  const before = await countBookings(PHONE_BOOK, isoLocal(DATE_A));
  const r = await send(PHONE_BOOK, "yes");

  assertEquals(r.state, "idle");
  assertEquals(await countBookings(PHONE_BOOK, isoLocal(DATE_A)), before);
  assertStringIncludes(r.replies[0].toLowerCase(), "already have a booking");
});

Deno.test("wa booking: create_booking idempotency key is replay-safe", async () => {
  const db = await client();
  const idemKey = `wa_book_replay_${RUN}`;

  const mk = () =>
    db.rpc("create_booking", {
      p_hospital_id: HOSPITAL_A,
      p_queue_session_id: undefined,
      p_patient_id: undefined,
      p_patient_name: `Replay ${RUN}`,
      p_patient_phone: `9800${RUN}00`,
      p_booking_source: "manual_whatsapp",
      p_doctor_id: SEED.DOCTOR_ID,
      p_appointment_date: isoLocal(DATE_B),
      p_platform_fee: 10,
      p_receptionist_fee: 0,
      p_hospital_fee: 0,
      p_idempotency_key: idemKey,
    });

  const first = await mk();
  assertEquals(first.error, null);
  const second = await mk();
  assertEquals(second.error, null);

  const a = (first.data as Array<{ booking_id: string }>)[0];
  const b = (second.data as Array<{ booking_id: string }>)[0];
  assertEquals(a.booking_id, b.booking_id, "replay must return same booking");
});

Deno.test("wa booking: hospital isolation — booking stays in its tenant", async () => {
  const db = await client();

  // Second tenant with one active doctor schedule
  const { data: hospitalB, error: hErr } = await db
    .from("hospitals")
    .insert({
      name: `P11 Conv Hospital ${RUN}`,
      slug: `p11-conv-${RUN}`,
    })
    .select("id")
    .single();
  assertEquals(hErr, null);
  const hospitalBId = (hospitalB as { id: string }).id;

  const { error: schedErr } = await db
    .from("doctor_schedules")
    .insert({
      doctor_id: SEED.DOCTOR_ID,
      hospital_id: hospitalBId,
      weekday: DATE_B.getDay(),
      start_time: "09:00:00",
      end_time: "17:00:00",
    });
  assertEquals(schedErr, null);

  // Same physical phone books at tenant B
  const r1 = await send(PHONE_ISO, "book", { hospitalId: hospitalBId });
  assertEquals(r1.state, "booking"); // patient unknown at tenant B
  const r2 = await send(PHONE_ISO, `my name is Iso Patient${RUN}`, {
    hospitalId: hospitalBId,
  });
  assertEquals(r2.state, "selecting_date");
  const r3 = await send(PHONE_ISO, ddmm(DATE_B), { hospitalId: hospitalBId });
  assertEquals(r3.state, "confirming");
  const r4 = await send(PHONE_ISO, "yes", { hospitalId: hospitalBId });
  assertEquals(r4.state, "idle");

  const { data: bookingsB } = await db
    .from("bookings")
    .select("id, hospital_id")
    .eq("patient_phone", PHONE_ISO)
    .eq("appointment_date", isoLocal(DATE_B))
    .eq("is_deleted", false);

  const rows = bookingsB as Array<{ id: string; hospital_id: string }>;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].hospital_id, hospitalBId);

  // Tenant A has no booking and no patient for this phone
  const { data: bookingsA } = await db
    .from("bookings")
    .select("id")
    .eq("hospital_id", HOSPITAL_A)
    .eq("patient_phone", PHONE_ISO)
    .eq("is_deleted", false);
  assertEquals((bookingsA ?? []).length, 0);

  const { data: patientsA } = await db
    .from("patients")
    .select("id")
    .eq("hospital_id", HOSPITAL_A)
    .eq("normalized_phone", PHONE_ISO);
  assertEquals((patientsA ?? []).length, 0);

  // State rows are hospital-scoped: both tenants keep separate rows
  const stateB = await getState(PHONE_ISO, hospitalBId);
  assertExists(stateB);
  assertEquals(stateB!.state, "idle");

  // Cleanup: the global seed invariant expects exactly 12 schedule
  // rows for the seeded doctor, so remove the fixture tenant's data.
  await db.from("bookings").delete().eq("hospital_id", hospitalBId);
  await db.from("doctor_schedules").delete().eq("hospital_id", hospitalBId);
});

// ════════════════════════════════════════════════════════════════════════════
// QUEUE
// ════════════════════════════════════════════════════════════════════════════

Deno.test("wa queue: active booking — token, live token, ahead, wait", async () => {
  const db = await client();

  const { bookingId, token } = await createDirectBooking({
    phone: PHONE_QUEUE,
    date: TODAY,
    name: `Queue Patient ${RUN}`,
  });

  // Fixture queue session with a known live token
  const { data: session, error: sErr } = await db
    .from("queue_sessions")
    .insert({
      hospital_id: HOSPITAL_A,
      session_date: TODAY,
      current_live_token: 0,
    })
    .select("id")
    .single();
  assertEquals(sErr, null);
  const sessionId = (session as { id: string }).id;

  await db.from("bookings").update({ queue_session_id: sessionId }).eq(
    "id",
    bookingId,
  );

  const live = Math.max(0, token - 2);
  await db.from("queue_sessions").update({ current_live_token: live }).eq(
    "id",
    sessionId,
  );

  const ahead = Math.max(0, token - live - 1);

  const { data: schedRow } = await db
    .from("doctor_schedules")
    .select("average_consultation_minutes")
    .eq("doctor_id", SEED.DOCTOR_ID)
    .eq("hospital_id", HOSPITAL_A)
    .eq("weekday", new Date().getDay())
    .eq("is_active", true)
    .maybeSingle();
  const avg = (schedRow as { average_consultation_minutes: number } | null)
    ?.average_consultation_minutes ?? 10;

  const r = await send(PHONE_QUEUE, "status");
  assertEquals(r.state, "queue_lookup");
  const reply = r.replies[0];
  assertStringIncludes(reply, `*${token}*`);
  assertStringIncludes(reply, `*${live}*`);

  if (ahead > 0) {
    assertStringIncludes(reply, `Patients ahead: ${ahead}`);
    assertStringIncludes(reply, `~${ahead * avg} min`);
  } else {
    assertStringIncludes(reply.toLowerCase(), "you are next");
  }
});

Deno.test("wa queue: no active booking — polite redirect", async () => {
  const r = await send(PHONE_NOQUEUE, "queue");
  assertEquals(r.state, "queue_lookup");
  assertStringIncludes(r.replies[0].toLowerCase(), "don't have a booking");
});

Deno.test("wa queue: completed booking reports completion", async () => {
  const db = await client();
  await db.from("bookings").update({ status: "completed" }).eq(
    "patient_phone",
    PHONE_QUEUE,
  ).eq("hospital_id", HOSPITAL_A);

  const r = await send(PHONE_QUEUE, "my turn");
  assertStringIncludes(r.replies[0].toLowerCase(), "completed");
});

Deno.test("wa queue: cancelled booking reports cancellation", async () => {
  await createDirectBooking({
    phone: PHONE_QCANCEL,
    date: TODAY,
    name: `QCancel ${RUN}`,
  });

  const db = await client();
  await db.from("bookings").update({ status: "cancelled" }).eq(
    "patient_phone",
    PHONE_QCANCEL,
  ).eq("hospital_id", HOSPITAL_A);

  const r = await send(PHONE_QCANCEL, "token");
  assertStringIncludes(r.replies[0].toLowerCase(), "cancelled");
});

// ════════════════════════════════════════════════════════════════════════════
// RESCHEDULE
// ════════════════════════════════════════════════════════════════════════════

Deno.test("wa reschedule: success — old rescheduled, new booking + token", async () => {
  const db = await client();
  const { bookingId } = await createDirectBooking({
    phone: PHONE_RESCHED,
    date: isoLocal(DATE_A),
    name: `Resched ${RUN}`,
  });

  const r1 = await send(PHONE_RESCHED, "reschedule");
  assertEquals(r1.state, "rescheduling");
  assertStringIncludes(r1.replies[0], isoLocal(DATE_A));

  const r2 = await send(PHONE_RESCHED, ddmm(DATE_B));
  assertEquals(r2.state, "rescheduling");
  assertStringIncludes(r2.replies[0].toLowerCase(), "yes");

  const r3 = await send(PHONE_RESCHED, "yes");
  assertEquals(r3.state, "idle");
  assertStringIncludes(r3.replies[0], isoLocal(DATE_B));

  const old = await getBooking(bookingId);
  assertEquals(old.status, "rescheduled");

  const { data: newData } = await db
    .from("bookings")
    .select("id, token_number, status, carry_forwarded_from, idempotency_key")
    .eq("hospital_id", HOSPITAL_A)
    .eq("patient_phone", PHONE_RESCHED)
    .eq("appointment_date", isoLocal(DATE_B))
    .eq("is_deleted", false)
    .limit(1);

  const rows = newData as Array<{
    id: string;
    token_number: number;
    status: string;
    carry_forwarded_from: string | null;
    idempotency_key: string;
  }>;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].status, "booked");
  assertEquals(rows[0].carry_forwarded_from, bookingId);
  assertEquals(
    rows[0].idempotency_key,
    `wa_resched_${bookingId}_${isoLocal(DATE_B)}`,
  );
  assertStringIncludes(r3.replies[0], `*${rows[0].token_number}*`);
});

Deno.test("wa reschedule: doctor unavailable on requested date", async () => {
  const db = await client();
  await createDirectBooking({
    phone: PHONE_SUNDAY,
    date: isoLocal(DATE_A),
    name: `Sunday ${RUN}`,
  });

  // Block the doctor on DATE_B while the hospital stays open, so the
  // rejection comes from the doctor-availability branch specifically.
  const { error: ovErr } = await db
    .from("doctor_availability_overrides")
    .insert({
      doctor_id: SEED.DOCTOR_ID,
      hospital_id: HOSPITAL_A,
      override_date: isoLocal(DATE_B),
      override_type: "unavailable",
    });
  assertEquals(ovErr, null);

  try {
    await send(PHONE_SUNDAY, "reschedule");
    const r = await send(PHONE_SUNDAY, ddmm(DATE_B));

    assertEquals(r.state, "rescheduling");
    assertStringIncludes(r.replies[0].toLowerCase(), "not available");

    // Booking untouched
    const { data } = await db
      .from("bookings")
      .select("status")
      .eq("patient_phone", PHONE_SUNDAY)
      .eq("hospital_id", HOSPITAL_A)
      .eq("is_deleted", false);
    const rows = data as Array<{ status: string }>;
    assertEquals(rows.length, 1);
    assertEquals(rows[0].status, "booked");
  } finally {
    await db
      .from("doctor_availability_overrides")
      .delete()
      .eq("hospital_id", HOSPITAL_A)
      .eq("override_date", isoLocal(DATE_B));
  }
});

Deno.test("wa reschedule: hospital closed (holiday) on requested date", async () => {
  const db = await client();

  await createDirectBooking({
    phone: PHONE_HOLIDAY,
    date: isoLocal(DATE_A),
    name: `Holiday ${RUN}`,
  });

  const { error: holErr } = await db
    .from("hospital_holidays")
    .upsert(
      {
        hospital_id: HOSPITAL_A,
        holiday_date: isoLocal(DATE_HOL),
        description: `P11 test holiday ${RUN}`,
      },
      { onConflict: "hospital_id,holiday_date" },
    );
  assertEquals(holErr, null);

  try {
    await send(PHONE_HOLIDAY, "reschedule");
    const r = await send(PHONE_HOLIDAY, ddmm(DATE_HOL));

    assertEquals(r.state, "rescheduling");
    assertStringIncludes(r.replies[0].toLowerCase(), "holiday");
  } finally {
    // Holiday dates are computed relative to "now", so a leaked row
    // collides with DATE_A/DATE_B of a later run on a nearby day and
    // breaks unrelated reschedule tests. Remove it (same pattern as
    // the doctor_availability_overrides cleanup above).
    await db
      .from("hospital_holidays")
      .delete()
      .eq("hospital_id", HOSPITAL_A)
      .eq("holiday_date", isoLocal(DATE_HOL));
  }
});

Deno.test("wa reschedule: invalid date re-prompts without state loss", async () => {
  await createDirectBooking({
    phone: PHONE_BADDATe,
    date: isoLocal(DATE_A),
    name: `BadDate ${RUN}`,
  });

  await send(PHONE_BADDATe, "reschedule");
  const r = await send(PHONE_BADDATe, "banana split");

  assertEquals(r.state, "rescheduling");
  assertStringIncludes(r.replies[0].toLowerCase(), "date");

  // Flow still alive: a valid date continues it
  const r2 = await send(PHONE_BADDATe, ddmm(DATE_B));
  assertEquals(r2.state, "rescheduling");
  assertStringIncludes(r2.replies[0].toLowerCase(), "yes");
});

Deno.test("wa reschedule: concurrent cancellation aborts cleanly", async () => {
  const db = await client();
  const { bookingId } = await createDirectBooking({
    phone: PHONE_CONCURRENT,
    date: isoLocal(DATE_A),
    name: `Concurrent ${RUN}`,
  });

  await send(PHONE_CONCURRENT, "reschedule");
  await send(PHONE_CONCURRENT, ddmm(DATE_B)); // confirmation prompt

  // Staff cancels concurrently while the patient is replying
  await db.from("bookings").update({ status: "cancelled" }).eq(
    "id",
    bookingId,
  );

  const r = await send(PHONE_CONCURRENT, "yes");
  assertEquals(r.state, "idle");
  assertStringIncludes(r.replies[0].toLowerCase(), "cancelled");

  // No new booking was created
  const { data } = await db
    .from("bookings")
    .select("id, status")
    .eq("patient_phone", PHONE_CONCURRENT)
    .eq("hospital_id", HOSPITAL_A)
    .eq("is_deleted", false);
  const rows = data as Array<{ id: string; status: string }>;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].id, bookingId);
  assertEquals(rows[0].status, "cancelled");
});

// ════════════════════════════════════════════════════════════════════════════
// CANCEL
// ════════════════════════════════════════════════════════════════════════════

Deno.test("wa cancel: success with reason recorded", async () => {
  const { bookingId } = await createDirectBooking({
    phone: PHONE_CANCEL,
    date: isoLocal(DATE_A),
    name: `Cancel ${RUN}`,
  });

  const r1 = await send(PHONE_CANCEL, "cancel my booking");
  assertEquals(r1.state, "cancellation");
  assertStringIncludes(r1.replies[0], isoLocal(DATE_A));

  const r2 = await send(PHONE_CANCEL, "yes");
  assertEquals(r2.state, "idle");
  assertStringIncludes(r2.replies[0].toLowerCase(), "cancelled");

  const booking = await getBooking(bookingId);
  assertEquals(booking.status, "cancelled");
  assertEquals(
    booking.cancellation_reason,
    "Cancelled by patient via WhatsApp",
  );
});

Deno.test("wa cancel: already cancelled is idempotent", async () => {
  const r = await send(PHONE_CANCEL, "cancel");
  assertEquals(r.state, "idle");
  assertStringIncludes(r.replies[0].toLowerCase(), "already cancelled");
});

Deno.test("wa cancel: refund path for paid booking", async () => {
  const db = await client();
  const { bookingId } = await createDirectBooking({
    phone: PHONE_REFUND,
    date: isoLocal(DATE_B),
    name: `Refund ${RUN}`,
  });

  await db.from("bookings").update({
    payment_completed: true,
    booking_fee_inr: 20,
  }).eq("id", bookingId);

  const { error: orderErr } = await db
    .from("payment_orders")
    .insert({
      hospital_id: HOSPITAL_A,
      booking_id: bookingId,
      amount_inr: 20,
      payment_status: "captured",
    });
  assertEquals(orderErr, null);

  await send(PHONE_REFUND, "cancel");
  const r = await send(PHONE_REFUND, "yes");

  assertEquals(r.state, "idle");
  assertStringIncludes(r.replies[0].toLowerCase(), "cancelled");
  assertStringIncludes(r.replies[0], "₹20");

  const { data: refunds } = await db
    .from("payment_refunds")
    .select("booking_id, refund_amount_inr")
    .eq("booking_id", bookingId);

  const rows = refunds as Array<
    { booking_id: string; refund_amount_inr: number }
  >;
  assertEquals(rows.length, 1);
  assertEquals(Number(rows[0].refund_amount_inr), 20);
});

Deno.test("wa cancel: no refund for unpaid booking", async () => {
  const db = await client();
  const { bookingId } = await createDirectBooking({
    phone: PHONE_NOREFUND,
    date: isoLocal(DATE_B),
    name: `NoRefund ${RUN}`,
  });

  await send(PHONE_NOREFUND, "cancel");
  const r = await send(PHONE_NOREFUND, "yes");

  assertEquals(r.state, "idle");
  assertStringIncludes(r.replies[0].toLowerCase(), "cancelled");
  assertEquals(r.replies[0].includes("Refund"), false);

  const { data: refunds } = await db
    .from("payment_refunds")
    .select("id")
    .eq("booking_id", bookingId);
  assertEquals((refunds ?? []).length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// CONVERSATION STATE MACHINE
// ════════════════════════════════════════════════════════════════════════════

Deno.test("wa conversation: expired state resets to idle", async () => {
  const db = await client();

  await send(PHONE_CONV, "book");
  const mid = await getState(PHONE_CONV);
  assertEquals(mid?.state, "booking");

  // Force expiry
  await db.from("whatsapp_conversation_states").update({
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  }).eq("hospital_id", HOSPITAL_A).eq("phone_number", PHONE_CONV);

  // The flow must NOT continue: context was dropped with the state
  const r = await send(PHONE_CONV, `my name is Expired ${RUN}`);
  assertEquals(r.state, "idle"); // unknown intent, flow gone
  assertStringIncludes(r.replies[0].toLowerCase(), "didn't understand");
});

Deno.test("wa conversation: strong intent interrupts an in-progress flow", async () => {
  await send(PHONE_CONV, "book");
  const mid = await getState(PHONE_CONV);
  assertEquals(mid?.state, "booking");

  const r = await send(PHONE_CONV, "cancel that, actually cancel my booking");
  // Cancel intent takes over; no cancellable booking exists
  assertEquals(r.state, "idle");
  assertStringIncludes(r.replies[0].toLowerCase(), "couldn't find");
});

Deno.test("wa conversation: repeated unknown input escalates to handoff", async () => {
  const r1 = await send(PHONE_CONV, "zzz qqq");
  assertEquals(r1.state, "idle");
  assertStringIncludes(r1.replies[0].toLowerCase(), "didn't understand");

  await send(PHONE_CONV, "zzz qqq again");

  const r3 = await send(PHONE_CONV, "still gibberish here");
  assertEquals(r3.state, "handoff");
  assertStringIncludes(r3.replies[0].toLowerCase(), "staff");

  // Handed-off conversations acknowledge only
  const r4 = await send(PHONE_CONV, "hello?");
  assertEquals(r4.state, "handoff");
  assertStringIncludes(r4.replies[0].toLowerCase(), "staff");
});

Deno.test("wa conversation: repeated Meta message is a no-op", async () => {
  const metaId = `waconv.replay.${RUN}`;
  const r1 = await send(PHONE_HANDOFF, "help", { metaMessageId: metaId });
  assertEquals(r1.repliesEnqueued, 1);

  const r2 = await send(PHONE_HANDOFF, "help", { metaMessageId: metaId });
  assertEquals(r2.duplicate, true);
  assertEquals(r2.repliesEnqueued, 0);
  assertEquals(r2.replies.length, 0);
});

Deno.test("wa conversation: explicit human handoff request", async () => {
  const r = await send(`9811${RUN}16`, "I want to talk to a human");
  assertEquals(r.state, "handoff");
  assertStringIncludes(r.replies[0].toLowerCase(), "staff");

  const state = await getState(`9811${RUN}16`);
  assertEquals(state?.context.reason, "patient_requested");

  // Handoff is audited for the dashboard
  const db = await client();
  const { data: audits } = await db
    .from("audit_logs")
    .select("id, action_type, notes")
    .eq("hospital_id", HOSPITAL_A)
    .eq("entity_type", "whatsapp_conversation")
    .eq("action_type", "whatsapp_send")
    .order("created_at", { ascending: false })
    .limit(1);
  const rows = audits as Array<
    { id: string; action_type: string; notes: string | null }
  >;
  assertEquals(rows.length, 1);
  assertStringIncludes(rows[0].notes ?? "", "whatsapp_patient");
});

Deno.test("wa conversation: inbound messages are persisted as received", async () => {
  const db = await client();
  const { data } = await db
    .from("whatsapp_messages")
    .select("direction, message_status, hospital_id")
    .eq("hospital_id", HOSPITAL_A)
    .eq("message_status", "received")
    .limit(5);

  const rows = data as Array<{
    direction: string;
    message_status: string;
    hospital_id: string;
  }>;
  assertEquals(rows.length > 0, true, "inbound rows must be recorded");
  assertEquals(rows[0].direction, "incoming");
});

Deno.test("wa conversation: reply jobs carry phone, text and hospital", async () => {
  const db = await client();
  const metaId = `waconv.payload.${RUN}`;

  await send(`9811${RUN}17`, "help", { metaMessageId: metaId });

  const { data } = await db
    .from("job_queue")
    .select("payload, hospital_id, job_type")
    .eq("idempotency_key", `reply_${metaId}_0`)
    .maybeSingle();

  const row = data as {
    payload: {
      text: string;
      phone: string;
      hospital_id: string;
      idem_key: string;
    };
    hospital_id: string;
    job_type: string;
  } | null;
  assertExists(row);
  assertEquals(row!.job_type, "send_whatsapp_message");
  assertEquals(row!.hospital_id, HOSPITAL_A);
  assertEquals(row!.payload.hospital_id, HOSPITAL_A);
  assertEquals(row!.payload.phone, `+919811${RUN}17`);
  assertEquals(row!.payload.idem_key, `reply_${metaId}_0`);
  assertStringIncludes(row!.payload.text.toLowerCase(), "book");
});
