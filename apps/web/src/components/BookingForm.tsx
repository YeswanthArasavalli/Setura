import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/auth/AuthProvider";
import { createBooking } from "@/api/booking";
import {
  listHospitalDoctors,
  searchPatients,
  type HospitalDoctorOption,
  type PatientRow,
} from "@/api/reads";
import { ApiError, describeError } from "@/lib/errors";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { todayISO } from "@/lib/dates";
import type { BookingSource, CreateBookingResponse } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface Props {
  source: BookingSource;
  title: string;
  description: string;
}

/**
 * Registration + appointment/walk-in form (Phase 6 §9/§10/§11).
 *
 * Identity normalisation/dedup, fee snapshot, token allocation and tenant
 * validation all happen on the backend via create-booking; this form only
 * collects input and displays the backend result. The submit button is
 * disabled while a submission is in flight, and a stable idempotency key is
 * reused for the duration of this submission (backend idempotency is final).
 */
export function BookingForm({ source, title, description }: Props) {
  const { hospitalId } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState("");
  const [village, setVillage] = useState("");
  const [date, setDate] = useState(todayISO());
  const [doctorId, setDoctorId] = useState("");
  const [doctors, setDoctors] = useState<HospitalDoctorOption[]>([]);
  // `loading`/`error` are tracked separately from the list itself: an empty
  // list during the first fetch (or after a failed one) is NOT evidence that
  // the hospital has no doctors, and rendering it as "No doctors available"
  // let a receptionist submit an unqueued walk-in on a transient state.
  const [doctorsState, setDoctorsState] = useState<
    "loading" | "ready" | "error"
  >("loading");

  // Optional find-existing affordance (name/phone → patient).
  const [matches, setMatches] = useState<PatientRow[]>([]);

  useEffect(() => {
    if (!hospitalId || phone.replace(/\D/g, "").length < 6) {
      setMatches([]);
      return;
    }
    let active = true;
    const t = setTimeout(() => {
      searchPatients(hospitalId, phone)
        .then((r) => active && setMatches(r))
        .catch(() => active && setMatches([]));
    }, 300);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [phone, hospitalId]);

  // Assigning a doctor is what puts a booking into a live, callable queue
  // (see listHospitalDoctors). Load the tenant's assignable doctors once.
  useEffect(() => {
    if (!hospitalId) return;
    let active = true;
    setDoctorsState("loading");
    listHospitalDoctors(hospitalId)
      .then((r) => {
        if (!active) return;
        setDoctors(r);
        setDoctorsState("ready");
      })
      .catch(() => {
        if (!active) return;
        setDoctors([]);
        setDoctorsState("error");
      });
    return () => {
      active = false;
    };
  }, [hospitalId]);

  const action = useAsyncAction<[], CreateBookingResponse>(
    useMemo(
      () =>
        (key) => {
          if (!hospitalId) throw new Error("No tenant");
          return createBooking(
            {
              hospitalId,
              patientName: name.trim(),
              patientPhone: phone.trim(),
              patientAge: age ? Number(age) : null,
              patientGender:
                gender === "M" || gender === "F" || gender === "Other"
                  ? gender
                  : null,
              village: village.trim() || null,
              bookingSource: source,
              appointmentDate: date,
              doctorId: doctorId || null,
            },
            hospitalId,
            key,
          );
        },
      [hospitalId, name, phone, age, gender, village, date, source, doctorId],
    ),
  );

  // Backend field errors are derived from the thrown ApiError — never copied
  // into local state during render (that is a React anti-pattern).
  const fieldErrors: Record<string, string[]> =
    action.error instanceof ApiError ? (action.error.fieldErrors ?? {}) : {};

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const result = await action.run();
    if (result) {
      navigate(`/bookings/${result.bookingId}`);
    }
  }

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field id="name" label="Patient name" errors={fieldErrors.patientName}>
            <Input
              id="name"
              required
              minLength={2}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <Field
            id="phone"
            label="Phone (10-digit)"
            errors={fieldErrors.patientPhone}
          >
            <Input
              id="phone"
              required
              inputMode="numeric"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            {matches.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Existing patient: {matches[0].full_name} — submitting will reuse
                this record (dedup by phone).
              </p>
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field id="age" label="Age" errors={fieldErrors.patientAge}>
              <Input
                id="age"
                type="number"
                min={0}
                max={150}
                value={age}
                onChange={(e) => setAge(e.target.value)}
              />
            </Field>
            <Field id="gender" label="Gender" errors={fieldErrors.patientGender}>
              <select
                id="gender"
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">—</option>
                <option value="M">M</option>
                <option value="F">F</option>
                <option value="Other">Other</option>
              </select>
            </Field>
          </div>

          <Field id="village" label="Village" errors={fieldErrors.village}>
            <Input
              id="village"
              value={village}
              onChange={(e) => setVillage(e.target.value)}
            />
          </Field>

          <Field
            id="doctor"
            label="Doctor (assigns a live queue)"
            errors={fieldErrors.doctorId}
          >
            <select
              id="doctor"
              value={doctorId}
              onChange={(e) => setDoctorId(e.target.value)}
              disabled={doctorsState === "loading"}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">
                {doctorsState === "loading"
                  ? "Loading doctors…"
                  : doctorsState === "error"
                    ? "Doctor list unavailable — retry before assigning"
                    : doctors.length === 0
                      ? "No doctors on record for this hospital"
                      : "— No assignment (token not queued) —"}
              </option>
              {doctors.map((d) => (
                <option key={d.doctorId} value={d.doctorId}>
                  {d.label}
                </option>
              ))}
            </select>
            {doctorsState !== "loading" && !doctorId && (
              <p
                className={`mt-1 text-xs ${
                  source === "walkin"
                    ? "text-destructive"
                    : "text-muted-foreground"
                }`}
              >
                {source === "walkin"
                  ? "Without a doctor the walk-in gets a token but does not enter any doctor's queue — the Doctor Console cannot call it."
                  : "Assign a doctor to attach this appointment to their queue."}
              </p>
            )}
          </Field>

          <Field
            id="date"
            label="Appointment date"
            errors={fieldErrors.appointmentDate}
          >
            <Input
              id="date"
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>

          {action.error ? (
            <p role="alert" className="text-sm text-destructive">
              {describeError(action.error)}
            </p>
          ) : null}

          <Button
            type="submit"
            className="w-full"
            disabled={action.running || doctorsState === "loading"}
          >
            {action.running
              ? "Submitting…"
              : doctorsState === "loading"
                ? "Loading doctors…"
                : source === "walkin"
                  ? "Create walk-in & issue token"
                  : "Create appointment"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({
  id,
  label,
  errors,
  children,
}: {
  id: string;
  label: string;
  errors?: string[];
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {errors?.length ? (
        <p className="text-xs text-destructive">{errors.join(", ")}</p>
      ) : null}
    </div>
  );
}
