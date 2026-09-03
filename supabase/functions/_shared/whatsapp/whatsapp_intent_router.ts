/**
 * _shared/whatsapp/whatsapp_intent_router.ts
 *
 * Phase 1.1 — deterministic intent classification for inbound
 * WhatsApp messages. No LLMs: keyword/phrase matching with a
 * fixed precedence order, plus rule-based date parsing.
 */

export type Intent =
  | "book"
  | "queue_status"
  | "reschedule"
  | "cancel"
  | "yes"
  | "no"
  | "handoff"
  | "help"
  | "greeting"
  | "unknown";

const BOOK_KEYWORDS = [
  "book",
  "booking",
  "appointment",
  "slot",
  "need a doctor",
  "want doctor",
  "see doctor",
  "doctor kavali",
  "ticket",
];

const QUEUE_KEYWORDS = [
  "queue",
  "token",
  "status",
  "my turn",
  "waiting",
  "how long",
  "how many",
  "next",
  "when",
  "live",
];

const RESCHEDULE_KEYWORDS = [
  "reschedule",
  "re schedule",
  "change date",
  "change day",
  "change time",
  "postpone",
  "another day",
  "different day",
  "move to",
];

const CANCEL_KEYWORDS = [
  "cancel",
  "delete booking",
  "remove booking",
  "not coming",
  "wont come",
  "won't come",
  "dont want",
  "don't want",
  "refund",
];

const HANDOFF_KEYWORDS = [
  "human",
  "agent",
  "receptionist",
  "staff",
  "operator",
  "talk to",
  "speak to",
  "real person",
  "complaint",
];

const HELP_KEYWORDS = [
  "help",
  "menu",
  "options",
  "what can you do",
];

const GREETING_KEYWORDS = [
  "hi",
  "hello",
  "hey",
  "namaste",
  "namaskaram",
  "good morning",
  "good afternoon",
  "good evening",
];

const YES_KEYWORDS = [
  "yes",
  "yep",
  "yeah",
  "ok",
  "okay",
  "confirm",
  "correct",
  "sure",
  "haan",
  "avunu",
  "andi",
];

const NO_KEYWORDS = [
  "no",
  "nope",
  "cancel that",
  "stop",
  "dont",
  "don't",
  "vaddu",
  "ledu",
];

/** Normalizes free text for deterministic matching. */
export function normalizeText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(normalized: string, keywords: string[]): boolean {
  return keywords.some((k) => {
    if (k.includes(" ")) {
      return normalized.includes(k);
    }
    // Word-boundary match for single keywords
    return new RegExp(`(^|\\s)${k}(\\s|$)`).test(normalized);
  });
}

/**
 * Classifies a message into exactly one intent.
 *
 * Precedence (most specific first):
 *   reschedule > cancel > book > queue > handoff > help >
 *   greeting > yes/no (weakest — short words collide easily)
 */
export function classifyIntent(rawText: string): Intent {
  const text = normalizeText(rawText);

  if (!text) return "unknown";

  if (containsAny(text, RESCHEDULE_KEYWORDS)) return "reschedule";
  if (containsAny(text, CANCEL_KEYWORDS)) return "cancel";
  if (containsAny(text, BOOK_KEYWORDS)) return "book";
  if (containsAny(text, QUEUE_KEYWORDS)) return "queue_status";
  if (containsAny(text, HANDOFF_KEYWORDS)) return "handoff";
  if (containsAny(text, HELP_KEYWORDS)) return "help";
  if (containsAny(text, GREETING_KEYWORDS)) return "greeting";

  // yes/no only when the whole message is essentially the word
  const words = text.split(" ");
  if (words.length <= 2) {
    if (containsAny(text, NO_KEYWORDS)) return "no";
    if (containsAny(text, YES_KEYWORDS)) return "yes";
  }

  return "unknown";
}

// ─── Date parsing (deterministic, IST-friendly) ─────────────────────────────

const WEEKDAY_NAMES: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parses relative/absolute date phrases into YYYY-MM-DD.
 * Returns null when nothing parseable is present.
 *
 * Supported: today, tomorrow, day-after-tomorrow, weekday names,
 * dd/mm, dd-mm, dd/mm/yyyy.
 */
export function parseDateInput(
  rawText: string,
  now = new Date(),
): string | null {
  const text = normalizeText(rawText);
  if (!text) return null;

  if (/(^|\s)(today|eroju|eedu)(\s|$)/.test(text)) {
    return toIso(now);
  }

  if (/(^|\s)(tomorrow|rep(u)?)(\s|$)/.test(text)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return toIso(d);
  }

  if (/(^|\s)(day after tomorrow|day after)(\s|$)/.test(text)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 2);
    return toIso(d);
  }

  for (const [name, weekday] of Object.entries(WEEKDAY_NAMES)) {
    if (new RegExp(`(^|\\s)${name}(\\s|$)`).test(text)) {
      const d = new Date(now);
      const delta = (weekday - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + (delta === 0 ? 7 : delta));
      return toIso(d);
    }
  }

  // dd/mm(/yyyy) or dd-mm(-yyyy) — match against raw text because
  // normalizeText() strips '/' and '-' separators.
  const m = rawText.trim().toLowerCase().match(
    /(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/,
  );
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    let year = m[3] ? Number(m[3]) : now.getFullYear();
    if (year < 100) year += 2000;

    const candidate = new Date(year, month - 1, day);
    if (
      candidate.getFullYear() === year &&
      candidate.getMonth() === month - 1 &&
      candidate.getDate() === day
    ) {
      // Bare dd/mm in the past rolls into next year
      if (
        !m[3] &&
        candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())
      ) {
        candidate.setFullYear(year + 1);
      }
      return toIso(candidate);
    }
  }

  return null;
}

/** Extracts a likely patient name from phrases like "my name is X". */
export function extractName(rawText: string): string | null {
  const m = rawText.match(
    /(?:my name is|i am|i'm|im|nenu|naa peru)\s+([A-Za-z][A-Za-z .]{1,49})/i,
  );
  if (!m) return null;
  return m[1].trim().replace(/\s+/g, " ").slice(0, 50) || null;
}

/** Extracts a numeric choice ("1", "option 2", "doctor 3") from a reply. */
export function extractChoice(rawText: string): number | null {
  const text = normalizeText(rawText);
  const m = text.match(/(?:option\s+|doctor\s+|no\s+)?(\d{1,2})(?:\s|$)/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 20 ? n : null;
}
