/**
 * tests/integration/consultation_notes_read.test.ts
 *
 * Migration 63 (`consultation_notes_staff_read`) — the clinical-note /
 * diagnosis display UI depends on it: before it, consultation_notes had
 * RLS with ZERO policies and SELECT only for service_role, so no staff
 * client could read persisted note content at all.
 *
 * Proven here against the REAL stack, as the REAL roles (security
 * matrix; positives prove the read, negatives prove it is not widened):
 *   1. the authoring doctor, same-hospital receptionist and
 *      hospital_admin can read the note (faithful notes + diagnosis);
 *   2. a same-hospital PEER doctor cannot (doctor scope is
 *      author-scoped, not hospital-wide);
 *   3. another hospital's staff sees nothing of hospital A's note
 *      (zero rows, not an error) and only its own hospital's note;
 *   4. a user with no hospital role and `anon` see nothing;
 *   5. the global-admin model applies (seeded root admin reads);
 *   6. the read is SELECT-only: authenticated INSERT/UPDATE/DELETE are
 *      refused at the privilege layer;
 *   7. the writer RPC `save_consultation_note` stays service-role-only
 *      (authenticated EXECUTE refused) and the service write path is
 *      unchanged.
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

let LOCAL_STATUS: LocalStatus | null = null;

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

type Shared = Awaited<ReturnType<typeof bootstrap>>;
let _ctx: Shared | null = null;

async function bootstrap() {
  const status = await getLocalStatus();
  if (!status) {
    throw new Error(
      "Local Supabase stack is not running. Run `supabase start` first.",
    );
  }
  LOCAL_STATUS = status;
  Deno.env.set("APP_ENV", "test");
  Deno.env.set("SUPABASE_URL", status.API_URL);
  Deno.env.set("SUPABASE_ANON_KEY", status.ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", status.SERVICE_ROLE_KEY);

  const { createAuthClient, getAnonClient, getServiceClient } = await import(
    "../../supabase/functions/_shared/db.ts"
  );
  const runtime = await import(
    "../../supabase/functions/_shared/queue/queue_runtime.ts"
  );
  return {
    db: getServiceClient(),
    anon: getAnonClient(),
    createAuthClient,
    runtime,
  };
}

async function ctx(): Promise<Shared> {
  if (!_ctx) _ctx = await bootstrap();
  return _ctx;
}

const RUN = crypto.randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "3");
const FIXTURE_PASSWORD = `D63-${RUN}-fixture-pass`;

function todayLocal(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const TODAY = todayLocal();

interface Actor {
  userId: string;
  email: string;
  token: string;
}

type RoleName = "hospital_admin" | "doctor" | "receptionist";

async function createAuthUser(userId: string, email: string): Promise<void> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const resp = await fetch(`${LOCAL_STATUS.API_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${LOCAL_STATUS.SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: userId,
      email,
      email_confirm: true,
      password: FIXTURE_PASSWORD,
    }),
  });
  if (resp.status >= 300) {
    throw new Error(`admin user create failed: ${resp.status}`);
  }
}

async function tokenFor(email: string): Promise<string> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        "apikey": LOCAL_STATUS.ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password: FIXTURE_PASSWORD }),
    },
  );
  if (resp.status >= 300) {
    throw new Error(`password grant failed: ${resp.status}`);
  }
  const json = await resp.json() as { access_token?: string };
  assertExists(json.access_token);
  return json.access_token!;
}

/** Seeded root admin (never a fixture: read-only use, never deleted). */
async function seededGlobalAdminToken(): Promise<string> {
  if (!LOCAL_STATUS) throw new Error("bootstrap not run");
  const resp = await fetch(
    `${LOCAL_STATUS.API_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        "apikey": LOCAL_STATUS.ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: SEED.GLOBAL_ADMIN_EMAIL,
        password: "Setura@123",
      }),
    },
  );
  assertEquals(resp.status, 200, "seeded global admin must sign in");
  const json = await resp.json() as { access_token?: string };
  assertExists(json.access_token);
  return json.access_token!;
}

async function deleteAuthUser(userId: string): Promise<void> {
  if (!LOCAL_STATUS) return;
  try {
    await fetch(`${LOCAL_STATUS.API_URL}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${LOCAL_STATUS.SERVICE_ROLE_KEY}` },
    });
  } catch {
    // Best-effort: a leftover fixture user holds no role and is inert.
  }
}

// deno-lint-ignore no-explicit-any
type AnyClient = any;

interface NoteRow {
  id: string;
  booking_id: string;
  notes: string;
  diagnosis_summary: string | null;
}

/** Note rows on a booking that the caller's RLS actually exposes. */
async function visibleNotes(
  client: AnyClient,
  bookingId: string,
): Promise<NoteRow[]> {
  const { data, error } = await client
    .from("consultation_notes")
    .select("id,booking_id,notes,diagnosis_summary")
    .eq("booking_id", bookingId);
  assertEquals(error, null);
  return (data ?? []) as NoteRow[];
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

interface FixtureState {
  hospitalA: string;
  hospitalB: string;
  /** Doctor at A who authors the note under test. */
  authorA: Actor;
  /** Fellow doctor at A: must NOT read A's note (author-scoped). */
  peerA: Actor;
  receptionistA: Actor;
  adminA: Actor;
  docB: Actor;
  receptionistB: Actor;
  patient: Actor;
  /** The hospital-A booking + note every read below targets. */
  bookingA: string;
  noteAId: string;
  /** Hospital B's own booking + note (B reads its own, not A's). */
  bookingB: string;
  noteBId: string;
  globalAdminToken: string;
}

let F: FixtureState | null = null;

function fx(): FixtureState {
  if (!F) throw new Error("setup test not run");
  return F;
}

async function makeBookingWithNote(
  hospitalId: string,
  doctorId: string,
  tag: string,
  notes: string,
  diagnosis: string | null,
): Promise<{ bookingId: string; noteId: string }> {
  const { db, runtime } = await ctx();

  const { data: session, error: sErr } = await db
    .from("queue_sessions")
    .insert({
      hospital_id: hospitalId,
      doctor_id: doctorId,
      session_date: TODAY,
      session_name: `d63_${RUN}_${tag}`,
      max_tokens: 50,
    })
    .select("id")
    .single();
  assertEquals(sErr, null);
  assertExists(session);

  const { data: booking, error: bErr } = await db
    .from("bookings")
    .insert({
      hospital_id: hospitalId,
      queue_session_id: session.id as string,
      patient_name: `D63 ${RUN} ${tag}`,
      patient_phone: `95${RUN}${tag}`,
      token_number: 1,
      status: "waiting",
      booking_source: "walkin",
      appointment_date: TODAY,
      assigned_doctor_id: doctorId,
    })
    .select("id")
    .single();
  assertEquals(bErr, null);
  assertExists(booking);
  const bookingId = booking.id as string;

  // REAL write path: the same service-role RPC doctor-operations uses.
  const saved = await runtime.runSaveConsultationNote(
    db,
    bookingId,
    doctorId,
    { notes, diagnosisSummary: diagnosis },
  );
  assertEquals(saved.ok, true);
  assertExists(saved.note_id);
  return { bookingId, noteId: saved.note_id! };
}

Deno.test("d63: setup - two hospitals, staff, bookings and notes", async () => {
  const { db } = await ctx();

  const { data: hA, error: hAErr } = await db
    .from("hospitals")
    .insert({ name: `D63 Notes ${RUN} A`, slug: `d63-notes-${RUN}-a` })
    .select("id")
    .single();
  assertEquals(hAErr, null);
  const { data: hB, error: hBErr } = await db
    .from("hospitals")
    .insert({ name: `D63 Notes ${RUN} B`, slug: `d63-notes-${RUN}-b` })
    .select("id")
    .single();
  assertEquals(hBErr, null);
  assertExists(hA);
  assertExists(hB);
  const hospitalA = hA.id as string;
  const hospitalB = hB.id as string;

  async function actor(
    tag: string,
    fullName: string,
    phoneSuffix: string,
    hospitalId: string | null,
    role: RoleName | null,
  ): Promise<Actor> {
    const userId = crypto.randomUUID();
    const email = `d63-${tag}-${RUN}@setura.test`;
    await createAuthUser(userId, email);
    const { error: pErr } = await db.from("profiles").upsert({
      id: userId,
      full_name: fullName,
      normalized_phone: `95${RUN}${phoneSuffix}9`,
    });
    assertEquals(pErr, null);
    if (role) {
      const { error } = await db.from("user_roles").insert({
        user_id: userId,
        hospital_id: hospitalId,
        role,
        is_primary: true,
      });
      assertEquals(error, null, `grant ${role} to ${tag}`);
    }
    return { userId, email, token: await tokenFor(email) };
  }

  const authorA = await actor("auth-a", `D63 Author A ${RUN}`, "01", hospitalA, "doctor");
  const peerA = await actor("peer-a", `D63 Peer A ${RUN}`, "02", hospitalA, "doctor");
  const receptionistA = await actor("rec-a", `D63 Rec A ${RUN}`, "03", hospitalA, "receptionist");
  const adminA = await actor("adm-a", `D63 Adm A ${RUN}`, "04", hospitalA, "hospital_admin");
  const docB = await actor("doc-b", `D63 Doc B ${RUN}`, "05", hospitalB, "doctor");
  const receptionistB = await actor("rec-b", `D63 Rec B ${RUN}`, "06", hospitalB, "receptionist");
  // No user_roles row: a pure authenticated user must gain nothing.
  const patient = await actor("pat", `D63 Patient ${RUN}`, "07", null, null);

  const noteA = await makeBookingWithNote(
    hospitalA,
    authorA.userId,
    "01",
    `Headache since morning. ${RUN}`,
    "Tension headache",
  );
  const noteB = await makeBookingWithNote(
    hospitalB,
    docB.userId,
    "02",
    `Abdominal pain. ${RUN}`,
    "Gastritis",
  );

  F = {
    hospitalA,
    hospitalB,
    authorA,
    peerA,
    receptionistA,
    adminA,
    docB,
    receptionistB,
    patient,
    bookingA: noteA.bookingId,
    noteAId: noteA.noteId,
    bookingB: noteB.bookingId,
    noteBId: noteB.noteId,
    globalAdminToken: await seededGlobalAdminToken(),
  };
});

// ─── 1. Positives: authorized staff read the note faithfully ────────────────

Deno.test("d63: authoring doctor reads back their own note verbatim", async () => {
  const { createAuthClient } = await ctx();
  const f = fx();

  const rows = await visibleNotes(createAuthClient(f.authorA.token), f.bookingA);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].id, f.noteAId);
  assertEquals(rows[0].notes, `Headache since morning. ${RUN}`);
  assertEquals(rows[0].diagnosis_summary, "Tension headache");
});

Deno.test("d63: same-hospital receptionist and hospital admin read the note", async () => {
  const { createAuthClient } = await ctx();
  const f = fx();

  for (const staff of [f.receptionistA, f.adminA]) {
    const rows = await visibleNotes(
      createAuthClient(staff.token),
      f.bookingA,
    );
    assertEquals(rows.length, 1, `as ${staff.email}`);
    assertEquals(rows[0].id, f.noteAId, `as ${staff.email}`);
  }
});

Deno.test("d63: global admin reads per the established global-admin model", async () => {
  const { createAuthClient } = await ctx();
  const f = fx();

  const rows = await visibleNotes(
    createAuthClient(f.globalAdminToken),
    f.bookingA,
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].id, f.noteAId);
});

// ─── 2. Negatives: the grant is not widened ─────────────────────────────────

Deno.test("d63: a fellow doctor at the SAME hospital cannot read the note", async () => {
  const { createAuthClient } = await ctx();
  const f = fx();

  const rows = await visibleNotes(createAuthClient(f.peerA.token), f.bookingA);
  assertEquals(rows, [], "doctor scope is author-scoped, not hospital-wide");
});

Deno.test("d63: another hospital's staff see zero rows, not an error", async () => {
  const { createAuthClient } = await ctx();
  const f = fx();

  const cross = await visibleNotes(
    createAuthClient(f.receptionistB.token),
    f.bookingA,
  );
  assertEquals(cross, [], "Tenant B must not read Tenant A's note");

  // …and B's own staff read only B's note.
  const own = await visibleNotes(
    createAuthClient(f.receptionistB.token),
    f.bookingB,
  );
  assertEquals(own.length, 1);
  assertEquals(own[0].id, f.noteBId);

  const docBRows = await visibleNotes(
    createAuthClient(f.docB.token),
    f.bookingB,
  );
  assertEquals(docBRows.length, 1, "author-scoped read works at B too");
});

Deno.test("d63: role-less user and anon see nothing", async () => {
  const { createAuthClient, anon } = await ctx();
  const f = fx();

  const rows = await visibleNotes(
    createAuthClient(f.patient.token),
    f.bookingA,
  );
  assertEquals(rows, []);

  // Anon has no table SELECT grant at all (migration 46/63 keep it
  // revoked), so PostgREST refuses with SQLSTATE 42501 at the
  // privilege layer - a harder denial than the zero-row RLS answer.
  const { data, error } = await anon
    .from("consultation_notes")
    .select("id")
    .eq("booking_id", f.bookingA);
  assertEquals(data, null);
  assertExists(error, "anon must not read consultation notes");
  assertStringIncludes(error.message, "permission denied");
});

// ─── 3. The read is SELECT-only for authenticated ───────────────────────────

Deno.test("d63: authenticated cannot INSERT/UPDATE/DELETE consultation notes", async () => {
  const { createAuthClient } = await ctx();
  const f = fx();
  const client = createAuthClient(f.receptionistA.token) as AnyClient;

  const ins = await client.from("consultation_notes").insert({
    booking_id: f.bookingA,
    hospital_id: f.hospitalA,
    notes: `forged ${RUN}`,
  });
  assertExists(ins.error, "authenticated INSERT must be refused");
  assertStringIncludes(ins.error.message, "permission denied");

  const upd = await client
    .from("consultation_notes")
    .update({ notes: `tampered ${RUN}` })
    .eq("id", f.noteAId);
  assertExists(upd.error, "authenticated UPDATE must be refused");
  assertStringIncludes(upd.error.message, "permission denied");

  const del = await client
    .from("consultation_notes")
    .delete()
    .eq("id", f.noteAId);
  assertExists(del.error, "authenticated DELETE must be refused");
  assertStringIncludes(del.error.message, "permission denied");

  // The row is untouched (read back through the author).
  const rows = await visibleNotes(createAuthClient(f.authorA.token), f.bookingA);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].notes, `Headache since morning. ${RUN}`);
});

Deno.test("d63: the writer RPC stays service-role-only", async () => {
  const { createAuthClient } = await ctx();
  const f = fx();
  const client = createAuthClient(f.authorA.token) as AnyClient;

  const { error } = await client.rpc("save_consultation_note", {
    p_booking_id: f.bookingA,
    p_doctor_id: f.authorA.userId,
    p_notes: `client-side write ${RUN}`,
  });
  assertExists(
    error,
    "authenticated EXECUTE on save_consultation_note must stay refused",
  );
});

Deno.test("d63: service-role write path still appends after the read policy", async () => {
  const { db, runtime, createAuthClient } = await ctx();
  const f = fx();

  const second = await runtime.runSaveConsultationNote(
    db,
    f.bookingA,
    f.authorA.userId,
    { notes: `Follow-up ${RUN}`, diagnosisSummary: null },
  );
  assertEquals(second.ok, true);

  // Append (not replace): the author now sees both notes; null diagnosis
  // renders as null data, never as the text "null".
  const rows = await visibleNotes(createAuthClient(f.authorA.token), f.bookingA);
  assertEquals(rows.length, 2);
  const follow = rows.find((r) => r.id === second.note_id);
  assertExists(follow);
  assertEquals(follow.diagnosis_summary, null);
});

// ─── 4. Teardown ─────────────────────────────────────────────────────────────

Deno.test("zz d63: teardown removes every fixture row", async () => {
  const { db } = await ctx();
  const f = fx();

  // Bookings first (consultation_notes cascade), then sessions, actors,
  // hospitals. Fixture audit trail is not written by these paths.
  for (const bookingId of [f.bookingA, f.bookingB]) {
    const { error } = await db.from("bookings").delete().eq("id", bookingId);
    assertEquals(error, null);
  }
  for (const tag of ["01", "02"]) {
    const { error } = await db
      .from("queue_sessions")
      .delete()
      .like("session_name", `d63_${RUN}_${tag}`);
    assertEquals(error, null);
  }
  for (
    const a of [
      f.authorA,
      f.peerA,
      f.receptionistA,
      f.adminA,
      f.docB,
      f.receptionistB,
      f.patient,
    ]
  ) {
    const { error } = await db.from("profiles").delete().eq("id", a.userId);
    assertEquals(error, null);
    await deleteAuthUser(a.userId);
  }
  for (const h of [f.hospitalA, f.hospitalB]) {
    const { error } = await db.from("hospitals").delete().eq("id", h);
    assertEquals(error, null);
  }

  // Leftover guard: every note of this run is gone.
  const { count } = await db
    .from("consultation_notes")
    .select("id", { count: "exact", head: true })
    .like("notes", `%${RUN}%`);
  assertEquals(count, 0);

  F = null;
});
