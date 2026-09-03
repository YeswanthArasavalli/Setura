/**
 * scripts/validate_migrations.ts — Phase 0 migration verification
 *
 * Static analysis of supabase/migrations/*.sql, run without a database:
 *
 *   deno task validate:migrations
 *
 * Checks performed (per deliverable 2 of Phase 0):
 *   1. Ordering       — files numbered NN_ sequentially, no gaps/dupes
 *   2. Syntax artifacts — markdown fences or non-SQL wrappers
 *   3. Duplicate objects — same table/index/function/policy/trigger/type
 *      defined in more than one migration without re-run guards
 *      (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS)
 *   4. Enum hazards   — ALTER TYPE ... ADD VALUE followed by a
 *      LANGUAGE sql function referencing the new value in the SAME
 *      transaction (PostgreSQL error 55P04, "unsafe use of new value")
 *   5. Rollback risks — DROP/ALTER DROP without IF EXISTS, TRUNCATE,
 *      unguarded CREATE statements that break re-runs
 *   6. Missing constraints — CREATE TABLE blocks without a PRIMARY KEY
 *   7. Privilege regressions — a future migration silently re-exposing a
 *      privileged SECURITY DEFINER RPC or a hardened table (see the
 *      PRIVILEGE REGRESSION DETECTION section for the exact rules)
 *
 * Exit code: 0 = clean, 1 = errors found. Warnings never fail the run.
 */

const MIGRATIONS_DIR = new URL("../supabase/migrations/", import.meta.url);

interface Finding {
  level: "error" | "warning";
  file: string;
  line: number;
  check: string;
  message: string;
}

const findings: Finding[] = [];

function report(
  level: Finding["level"],
  file: string,
  line: number,
  check: string,
  message: string,
): void {
  findings.push({ level, file, line, check, message });
}

// ─── Load migration files in numeric order ───────────────────────────────────

async function loadMigrations(): Promise<
  Array<{ name: string; num: number; text: string; lines: string[] }>
> {
  const entries: Array<{ name: string; num: number }> = [];

  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const m = entry.name.match(/^(\d{2})_/);
    if (!m) {
      report("error", entry.name, 0, "ordering", "file name lacks NN_ prefix");
      continue;
    }
    entries.push({ name: entry.name, num: Number(m[1]) });
  }

  entries.sort((a, b) => a.num - b.num || a.name.localeCompare(b.name));

  // Gap / duplicate number detection
  const seen = new Map<number, string>();
  for (const e of entries) {
    if (seen.has(e.num)) {
      report(
        "error",
        e.name,
        0,
        "ordering",
        `duplicate migration number ${e.num} (also used by ${seen.get(e.num)})`,
      );
    }
    seen.set(e.num, e.name);
  }
  for (let n = 1; n <= entries.length; n++) {
    if (!seen.has(n)) {
      report(
        "error",
        "<registry>",
        0,
        "ordering",
        `gap in migration numbering: ${String(n).padStart(2, "0")} is missing`,
      );
    }
  }

  const out = [];
  for (const e of entries) {
    const bytes = await Deno.readFile(new URL(e.name, MIGRATIONS_DIR));
    // Check: non-ASCII bytes. The Supabase CLI has been observed to
    // read SQL files with the system code page on Windows, silently
    // corrupting multi-byte UTF-8 data (e.g. Telugu hospital names
    // becoming '?????'). Keep migrations pure ASCII; put localized
    // data in supabase/seed.sql applied via UTF-8-safe tooling.
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] > 127) {
        report(
          "error",
          e.name,
          0,
          "encoding",
          `non-ASCII byte 0x${
            bytes[i].toString(16)
          } at offset ${i} — migrations must be pure ASCII`,
        );
        break;
      }
    }
    const text = new TextDecoder("utf-8").decode(bytes);
    out.push({ ...e, text, lines: text.split(/\r?\n/) });
  }
  return out;
}

// ─── Comment stripping (line comments only; safe for our corpus) ─────────────

function stripComments(line: string): string {
  const idx = line.indexOf("--");
  if (idx === -1) return line;
  return line.slice(0, idx);
}

// ─── Object definition tracking ──────────────────────────────────────────────

interface ObjectDef {
  kind: string;
  name: string;
  file: string;
  line: number;
  guarded: boolean;
}

const definitions = new Map<string, ObjectDef[]>();

function track(
  kind: string,
  name: string,
  file: string,
  line: number,
  guarded: boolean,
): void {
  const key = `${kind}:${name.toLowerCase()}`;
  const list = definitions.get(key) ?? [];
  list.push({ kind, name, file, line, guarded });
  definitions.set(key, list);
}

const OBJECT_PATTERNS: Array<{
  kind: string;
  regex: RegExp;
  guard: RegExp | null;
}> = [
  {
    kind: "table",
    regex: /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/i,
    guard: /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i,
  },
  {
    kind: "index",
    regex:
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?/i,
    guard:
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS/i,
  },
  {
    kind: "function",
    regex:
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?(\w+)"?\s*\(/i,
    guard: /CREATE\s+OR\s+REPLACE\s+FUNCTION/i,
  },
  {
    kind: "policy",
    regex: /CREATE\s+POLICY\s+"?(\w+)"?\s+ON/i,
    guard: null, // requires DROP POLICY IF EXISTS earlier in same file
  },
  {
    kind: "trigger",
    regex: /CREATE\s+TRIGGER\s+"?(\w+)"?\s+ON/i,
    guard: null, // requires DROP TRIGGER IF EXISTS earlier in same file
  },
  {
    kind: "type",
    regex: /CREATE\s+TYPE\s+(?:public\.)?"?(\w+)"?/i,
    guard: null, // requires DO $$ ... EXCEPTION duplicate_object wrapper
  },
  {
    kind: "view",
    regex: /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?"?(\w+)"?/i,
    guard: /CREATE\s+OR\s+REPLACE\s+VIEW/i,
  },
];

// ─── Per-file analysis ───────────────────────────────────────────────────────

interface TxSegment {
  addValues: Array<{ value: string; line: number }>;
  sqlLangFunctions: Array<{ name: string; line: number; body: string }>;
}

function analyzeFile(
  file: string,
  lines: string[],
): void {
  let inDollarQuote = false;
  let dollarTag = "";
  let currentTx: TxSegment = { addValues: [], sqlLangFunctions: [] };
  const txSegments: TxSegment[] = [];
  let txOpenLine = -1;
  let sawExplicitTx = false;

  // For policy/trigger re-run guard detection within a file
  const droppedPolicies = new Set<string>();
  const droppedTriggers = new Set<string>();

  const noCode = lines.map(stripComments);

  // First pass: detect DROP ... IF EXISTS guards per file
  for (const line of noCode) {
    for (
      const m of line.matchAll(/DROP\s+POLICY\s+IF\s+EXISTS\s+"?(\w+)"?/gi)
    ) {
      droppedPolicies.add(m[1].toLowerCase());
    }
    for (
      const m of line.matchAll(/DROP\s+TRIGGER\s+IF\s+EXISTS\s+"?(\w+)"?/gi)
    ) {
      droppedTriggers.add(m[1].toLowerCase());
    }
  }

  let pendingSqlFn: { name: string; line: number } | null = null;
  let fnBody: string[] = [];

  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;

    // Check 2: markdown fences / non-SQL artifacts
    if (/^```/.test(rawLine.trim())) {
      report(
        "error",
        file,
        lineNo,
        "syntax-artifact",
        `markdown fence found in SQL file: "${rawLine.trim()}"`,
      );
    }

    // Track dollar-quoted regions so CREATEs inside function bodies
    // are not mistaken for object definitions.
    const dq = rawLine.match(/(\$[a-zA-Z_]*\$)/g);
    if (dq) {
      for (const tag of dq) {
        if (!inDollarQuote) {
          inDollarQuote = true;
          dollarTag = tag;
          if (pendingSqlFn) fnBody = [];
        } else if (tag === dollarTag) {
          inDollarQuote = false;
          if (pendingSqlFn) {
            currentTx.sqlLangFunctions.push({
              name: pendingSqlFn.name,
              line: pendingSqlFn.line,
              body: fnBody.join("\n"),
            });
            pendingSqlFn = null;
          }
        }
      }
    }
    if (inDollarQuote) {
      if (pendingSqlFn) fnBody.push(rawLine);
      return;
    }

    const line = stripComments(rawLine);

    // Transaction segmentation
    if (/^\s*BEGIN\s*;/.test(line)) {
      sawExplicitTx = true;
      txOpenLine = lineNo;
      currentTx = { addValues: [], sqlLangFunctions: [] };
    }
    if (/^\s*COMMIT\s*;/.test(line)) {
      if (txOpenLine === -1) {
        report(
          "warning",
          file,
          lineNo,
          "rollback-risk",
          "COMMIT without BEGIN",
        );
      }
      txSegments.push(currentTx);
      currentTx = { addValues: [], sqlLangFunctions: [] };
      txOpenLine = -1;
    }

    // Enum ADD VALUE tracking
    for (
      const m of line.matchAll(
        /ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'(\w+)'/gi,
      )
    ) {
      currentTx.addValues.push({ value: m[1], line: lineNo });
    }

    // Detect start of a LANGUAGE sql function (body follows in $$)
    const fnMatch = line.match(
      /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?(\w+)"?\s*\(/i,
    );
    if (fnMatch && /LANGUAGE\s+sql\b/i.test(lookAheadLanguage(lines, i))) {
      pendingSqlFn = { name: fnMatch[2], line: lineNo };
    }

    // Rollback risk: destructive statements without IF EXISTS
    if (/\bDROP\s+(TABLE|TYPE|SCHEMA)\s+(?!IF\s+EXISTS)/i.test(line)) {
      report(
        "error",
        file,
        lineNo,
        "rollback-risk",
        `destructive ${line.trim()} without IF EXISTS`,
      );
    }
    if (/\bALTER\s+TABLE\s+\S+\s+DROP\s+COLUMN\s+(?!IF\s+EXISTS)/i.test(line)) {
      report(
        "warning",
        file,
        lineNo,
        "rollback-risk",
        `ALTER TABLE DROP COLUMN without IF EXISTS`,
      );
    }
    if (/\bTRUNCATE\b/i.test(line)) {
      report("warning", file, lineNo, "rollback-risk", "TRUNCATE in migration");
    }

    // Object definitions
    for (const p of OBJECT_PATTERNS) {
      const m = line.match(p.regex);
      if (!m) continue;
      let guarded = false;
      if (p.guard) {
        guarded = p.guard.test(line);
      } else if (p.kind === "policy") {
        guarded = droppedPolicies.has(m[1].toLowerCase());
      } else if (p.kind === "trigger") {
        guarded = droppedTriggers.has(m[1].toLowerCase());
      } else if (p.kind === "type") {
        guarded = /duplicate_object/i.test(lines.slice(i, i + 12).join("\n"));
      }
      if (!guarded && (p.kind === "table" || p.kind === "index")) {
        report(
          "warning",
          file,
          lineNo,
          "rerun-safety",
          `${p.kind} "${m[1]}" created without IF NOT EXISTS`,
        );
      }
      track(p.kind, m[1], file, lineNo, guarded);
    }

    // Missing primary key (checked on CREATE TABLE lines; body scanned below)
  });

  // Check 4: unsafe enum use within the same transaction segment.
  // PostgreSQL rejects LANGUAGE sql objects created in the same
  // transaction that added the enum value (SQLSTATE 55P04).
  const allSegments = txOpenLine !== -1
    ? [...txSegments, currentTx]
    : txSegments.length > 0
    ? txSegments
    : [currentTx];

  for (const seg of allSegments) {
    for (const av of seg.addValues) {
      for (const fn of seg.sqlLangFunctions) {
        if (fn.body.includes(`'${av.value}'`)) {
          report(
            "error",
            file,
            fn.line,
            "enum-hazard",
            `LANGUAGE sql function "${fn.name}" references enum value '${av.value}' added (line ${av.line}) in the SAME transaction — PostgreSQL rejects this (SQLSTATE 55P04). COMMIT between ADD VALUE and the function definition.`,
          );
        }
      }
    }
  }

  if (sawExplicitTx && !/COMMIT/.test(noCode.join("\n"))) {
    report("warning", file, 1, "rollback-risk", "BEGIN without COMMIT");
  }
}

/** Look ahead a few lines to find the LANGUAGE clause of a function. */
function lookAheadLanguage(lines: string[], start: number): string {
  return lines.slice(start, start + 30).join("\n");
}

// ─── Cross-file duplicate detection ──────────────────────────────────────────

function checkDuplicates(): void {
  for (const defs of definitions.values()) {
    if (defs.length < 2) continue;
    // Functions with CREATE OR REPLACE may legitimately repeat.
    const kind = defs[0].kind;
    if (kind === "function" && defs.every((d) => d.guarded)) continue;
    const files = defs.map((d) => `${d.file}:${d.line}`).join(", ");
    if (kind === "table" || kind === "index" || kind === "type") {
      if (defs.every((d) => d.guarded)) {
        report(
          "warning",
          defs[1].file,
          defs[1].line,
          "duplicate-objects",
          `${kind} "${
            defs[0].name
          }" defined in ${defs.length} migrations (${files}) — guarded, verify intent`,
        );
      } else {
        report(
          "error",
          defs[1].file,
          defs[1].line,
          "duplicate-objects",
          `${kind} "${
            defs[0].name
          }" defined multiple times without guards (${files})`,
        );
      }
    } else {
      report(
        "warning",
        defs[1].file,
        defs[1].line,
        "duplicate-objects",
        `${kind} "${
          defs[0].name
        }" appears in ${defs.length} migrations (${files})`,
      );
    }
  }
}

// ─── Missing constraints: CREATE TABLE without PRIMARY KEY ───────────────────

function checkPrimaryKeys(
  files: Array<{ name: string; text: string }>,
): void {
  for (const f of files) {
    const body = f.text.replace(/--[^\n]*/g, "");
    for (
      const m of body.matchAll(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\);/gi,
      )
    ) {
      const tableName = m[1];
      const cols = m[2];
      if (!/\bPRIMARY\s+KEY\b/i.test(cols)) {
        report(
          "warning",
          f.name,
          0,
          "missing-constraint",
          `table "${tableName}" has no PRIMARY KEY`,
        );
      }
    }
  }
}

// ─── PRIVILEGE REGRESSION DETECTION ──────────────────────────────────────────
//
// Migration 48 closed a real hole: Supabase ships
//
//     ALTER DEFAULT PRIVILEGES IN SCHEMA public
//         GRANT EXECUTE ON FUNCTIONS TO postgres, anon, authenticated,
//                                       service_role;
//
// so 191 of 193 SECURITY DEFINER functions were executable straight from
// PostgREST by anyone holding the anon key, and the 54 statements of the
// form "REVOKE ALL ON FUNCTION ... FROM PUBLIC" in migrations 27-46 were
// runtime no-ops against those explicit role grants.
//
// The purpose of this section is narrow and specific: a FUTURE migration
// must not be able to reopen that hole without the validator saying so.
//
// Design constraints taken seriously here:
//
//   * No blanket regex over lines. Every rule below runs against whole
//     SQL STATEMENTS with comments and dollar-quoted bodies removed, so
//     "GRANT" appearing in prose or inside a PL/pgSQL string never fires.
//   * Nothing fires on migrations 01-48. Those are history; 48 remediated
//     them wholesale and they must not be edited. PRIVILEGE_BASELINE is
//     the line between "already remediated" and "must prove itself".
//   * CREATE OR REPLACE of an EXISTING function is not flagged. Replacing
//     a function preserves its owner and ACL, so no privilege statement is
//     required and demanding one would be a false positive. Only a
//     genuinely new name/arity is flagged.
//   * A function may legitimately be granted to anon (the four Category A
//     RLS helpers are). The rule is not "never grant to anon", it is
//     "state the privileges explicitly instead of inheriting a default",
//     which is migration 39's proven pattern.
//   * USING (true) is correct for a policy scoped TO service_role, which
//     bypasses RLS regardless; migration 48 writes five such policies to
//     document intent. Only USING (true) reachable by a client role is a
//     finding.
//
// Rules:
//   P1  A new SECURITY DEFINER routine in a post-baseline migration with
//       no GRANT/REVOKE naming it.            -> ERROR
//       (PostgreSQL grants EXECUTE to PUBLIC by default, so silence here
//        means the function is world-executable.)
//   P2  A new SECURITY DEFINER routine with no SET search_path.  -> ERROR
//   P3  GRANT EXECUTE to anon/authenticated/PUBLIC on a routine that an
//       earlier migration locked to service_role.                -> ERROR
//   P4  ALTER DEFAULT PRIVILEGES ... GRANT ... TO anon/authenticated/
//       PUBLIC, or GRANT ON ALL FUNCTIONS/TABLES IN SCHEMA public to
//       those roles: the original hole, wholesale.               -> ERROR
//   P5  A table grant to anon/PUBLIC on a hardened table.        -> ERROR
//   P6  CREATE POLICY ... USING (true) granted to a client role on a
//       hardened table.                                          -> ERROR
//       The same shape on any other table is a WARNING, because a
//       genuinely public table is possible but rare.
//   P7  DISABLE ROW LEVEL SECURITY on a hardened table.          -> ERROR
//   P8  DROP POLICY on a hardened table with no CREATE POLICY for that
//       table in the same migration.                             -> WARNING
//
// P3 and P4 apply to every migration; the rest apply only above the
// baseline. Verified by probe: each rule fires on a synthetic regression
// and stays silent on CREATE OR REPLACE of an existing signature, on
// USING (true) TO service_role, on an explicitly-privileged new routine,
// and on a DO block whose body merely contains the same keywords.

const PRIVILEGE_BASELINE = 48;

/**
 * Tables migration 48 sections 8 and 9 took out of anon reach. These are
 * tenant-scoped operational data (patient conversation state, per-hospital
 * runtime events, alert activity) plus the two configuration tables that
 * were fully published: system_settings (GST, gateway fees, internal
 * operational settings) and role_permissions (the authorization matrix).
 */
const HARDENED_TABLES = new Set([
  "whatsapp_conversation_states",
  "queue_runtime_events",
  "analytics_refresh_logs",
  "alert_activity_log",
  "alert_suppressions",
  "alert_events",
  "system_settings",
  "role_permissions",
]);

const EXPOSED_ROLES = /\b(anon|authenticated|public)\b/i;

interface Stmt {
  sql: string;
  line: number;
}

/**
 * Splits a migration into statements, dropping comments and the contents
 * of dollar-quoted bodies. Dropping the bodies is what makes the rules
 * above precise: migration 48's own hardening loop contains the string
 * 'REVOKE ALL ON ROUTINE ' inside a DO block, and a line-based scanner
 * cannot tell that from a real statement.
 */
function extractStatements(text: string): Stmt[] {
  const out: Stmt[] = [];
  let buf = "";
  let startLine = -1;
  let line = 1;
  let i = 0;
  let dollarTag: string | null = null;

  const push = (ch: string) => {
    if (startLine === -1 && ch.trim() !== "") startLine = line;
    buf += ch;
  };

  while (i < text.length) {
    const ch = text[i];

    if (dollarTag) {
      if (text.startsWith(dollarTag, i)) {
        i += dollarTag.length;
        dollarTag = null;
        push(" ");
        continue;
      }
      if (ch === "\n") line++;
      i++;
      continue;
    }

    if (ch === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === "'") {
      // Keep quoted literals: role names and policy expressions live in
      // plain SQL, but a literal may contain a semicolon.
      push(ch);
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          push("''");
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          push("'");
          i++;
          break;
        }
        if (text[i] === "\n") line++;
        push(text[i]);
        i++;
      }
      continue;
    }

    const dq = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 32));
    if (dq) {
      dollarTag = dq[0];
      i += dq[0].length;
      push(" ");
      continue;
    }

    if (ch === ";") {
      if (buf.trim()) {
        out.push({
          sql: buf.replace(/\s+/g, " ").trim(),
          line: startLine === -1 ? line : startLine,
        });
      }
      buf = "";
      startLine = -1;
      i++;
      continue;
    }

    if (ch === "\n") line++;
    push(ch);
    i++;
  }

  if (buf.trim()) {
    out.push({
      sql: buf.replace(/\s+/g, " ").trim(),
      line: startLine === -1 ? line : startLine,
    });
  }
  return out;
}

/**
 * name/arity of a CREATE FUNCTION statement, or null when the statement
 * is not a function definition. Arity is counted at paren depth 0 so
 * NUMERIC(10,2) and DEFAULT expressions do not inflate it, which keeps
 * overloads (capture_payment/4 vs capture_payment/5) distinct.
 */
function functionSignature(
  sql: string,
): { name: string; arity: number; raw: string } | null {
  const m =
    /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?(\w+)"?\s*\(/i
      .exec(sql);
  if (!m) return null;

  let depth = 1;
  let i = m[0].length;
  let commas = 0;
  let params = "";
  for (; i < sql.length && depth > 0; i++) {
    const c = sql[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) break;
    } else if (c === "," && depth === 1) commas++;
    if (depth > 0) params += c;
  }

  const arity = params.trim() === "" ? 0 : commas + 1;
  return { name: m[1].toLowerCase(), arity, raw: sql };
}

/** Every routine named by a GRANT/REVOKE in one statement. */
function routinesNamedByPrivilegeStmt(sql: string): string[] {
  if (!/^(GRANT|REVOKE)\b/i.test(sql)) return [];
  const names: string[] = [];
  for (
    const m of sql.matchAll(
      /\bON\s+(?:FUNCTION|ROUTINE|PROCEDURE)\s+(?:public\.)?"?(\w+)"?/gi,
    )
  ) {
    names.push(m[1].toLowerCase());
  }
  return names;
}

/** The grantee list of a GRANT/REVOKE statement, lowercased. */
function granteesOf(sql: string): string {
  const m = /\b(?:TO|FROM)\s+([^()]*)$/i.exec(sql);
  return (m ? m[1] : "").toLowerCase();
}

/**
 * The role list of a CREATE POLICY statement, lowercased. An omitted TO
 * clause means the policy applies to PUBLIC, which is reported as such so
 * callers do not mistake "no roles named" for "no roles affected".
 */
function policyRoles(rest: string): string {
  const m = /\bTO\s+([\w\s,"]+?)(?=\s+USING\b|\s+WITH\s+CHECK\b|$)/i.exec(rest);
  return m ? m[1].toLowerCase() : "public";
}

function checkPrivileges(
  files: Array<{ name: string; num: number; text: string }>,
): void {
  /** Routines an earlier migration locked to service_role only. */
  const serviceOnly = new Map<string, string>();
  /** name/arity of every function defined so far, in migration order. */
  const definedSignatures = new Set<string>();

  for (const f of files) {
    const stmts = extractStatements(f.text);
    const post = f.num > PRIVILEGE_BASELINE;

    // Migration 48 hardens the long tail through a catalog-driven loop
    // rather than 145 literal statements. A post-baseline migration may
    // legitimately do the same, so recognise the shape.
    const hasBlanketHardening =
      /EXECUTE\s+'REVOKE\s+(?:ALL|EXECUTE)[^']*ON\s+(?:ROUTINE|FUNCTION)/i.test(
        f.text,
      );

    // Names given an explicit privilege statement anywhere in this file.
    const explicitlyPrivileged = new Set<string>();
    const policiesCreatedOn = new Set<string>();
    for (const s of stmts) {
      for (const n of routinesNamedByPrivilegeStmt(s.sql)) {
        explicitlyPrivileged.add(n);
      }
      const cp = /^CREATE\s+POLICY\s+"?\w+"?\s+ON\s+(?:public\.)?"?(\w+)"?/i
        .exec(s.sql);
      if (cp) policiesCreatedOn.add(cp[1].toLowerCase());
    }

    for (const s of stmts) {
      const sql = s.sql;

      // ── P4: the original hole, wholesale ────────────────────────────
      if (
        /^ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(sql) &&
        /\bGRANT\b/i.test(sql) && EXPOSED_ROLES.test(granteesOf(sql))
      ) {
        report(
          "error",
          f.name,
          s.line,
          "privilege-regression",
          `ALTER DEFAULT PRIVILEGES grants to anon/authenticated/PUBLIC — ` +
            `this is the exact default that made 191 SECURITY DEFINER ` +
            `functions callable from PostgREST and that migration 48 ` +
            `revoked. Grant per routine instead.`,
        );
      }
      if (
        /^GRANT\b/i.test(sql) &&
        /\bON\s+ALL\s+(?:FUNCTIONS|ROUTINES|TABLES|SEQUENCES)\s+IN\s+SCHEMA\s+public\b/i
          .test(sql) &&
        EXPOSED_ROLES.test(granteesOf(sql))
      ) {
        report(
          "error",
          f.name,
          s.line,
          "privilege-regression",
          `blanket GRANT ON ALL ... IN SCHEMA public to ` +
            `anon/authenticated/PUBLIC re-exposes every object at once`,
        );
      }

      // ── P3: re-opening a routine already locked to service_role ─────
      if (/^GRANT\b/i.test(sql)) {
        const grantees = granteesOf(sql);
        for (const name of routinesNamedByPrivilegeStmt(sql)) {
          if (serviceOnly.has(name) && EXPOSED_ROLES.test(grantees)) {
            report(
              "error",
              f.name,
              s.line,
              "privilege-regression",
              `routine "${name}" was locked to service_role by ` +
                `${serviceOnly.get(name)} and is being granted to ` +
                `${grantees.trim()} again. If this is intended, the ` +
                `classification in docs/security/` +
                `RPC_PRIVILEGE_CLASSIFICATION.tsv must change first.`,
            );
          }
        }
      }

      // Build the service-only set. A statement that also names anon or
      // authenticated is a deliberate public grant (Category A), so the
      // routine is not recorded as service-only.
      if (/^GRANT\s+EXECUTE\b/i.test(sql)) {
        const grantees = granteesOf(sql);
        if (
          /\bservice_role\b/.test(grantees) && !EXPOSED_ROLES.test(grantees)
        ) {
          for (const name of routinesNamedByPrivilegeStmt(sql)) {
            if (!serviceOnly.has(name)) serviceOnly.set(name, f.name);
          }
        } else if (EXPOSED_ROLES.test(grantees)) {
          for (const name of routinesNamedByPrivilegeStmt(sql)) {
            serviceOnly.delete(name);
          }
        }
      }

      // ── P5 / P7 / P8: hardened tables ──────────────────────────────
      // Only post-baseline files are examined. Migrations 12, 27 and 43
      // contain the very USING (true) policies that migration 48 drops;
      // flagging them would be flagging history that must not be edited.
      const tableGrant = !post
        ? null
        : /^GRANT\s+.+?\s+ON\s+(?:TABLE\s+)?(?:public\.)?"?(\w+)"?\s+TO\s+/i
          .exec(sql);
      if (tableGrant && HARDENED_TABLES.has(tableGrant[1].toLowerCase())) {
        const grantees = granteesOf(sql);
        if (/\b(anon|public)\b/.test(grantees)) {
          report(
            "error",
            f.name,
            s.line,
            "privilege-regression",
            `table "${tableGrant[1]}" was hardened by migration ` +
              `${PRIVILEGE_BASELINE} and must not be granted to ` +
              `${grantees.trim()}`,
          );
        }
      }

      const disableRls = !post
        ? null
        : /^ALTER\s+TABLE\s+(?:public\.)?"?(\w+)"?\s+DISABLE\s+ROW\s+LEVEL\s+SECURITY/i
          .exec(sql);
      if (disableRls && HARDENED_TABLES.has(disableRls[1].toLowerCase())) {
        report(
          "error",
          f.name,
          s.line,
          "privilege-regression",
          `RLS disabled on hardened table "${disableRls[1]}" — tenant ` +
            `isolation for this table depends on it`,
        );
      }

      const dropPolicy = !post
        ? null
        : /^DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+(?:public\.)?"?(\w+)"?/i
          .exec(sql);
      if (dropPolicy && HARDENED_TABLES.has(dropPolicy[2].toLowerCase())) {
        if (!policiesCreatedOn.has(dropPolicy[2].toLowerCase())) {
          report(
            "warning",
            f.name,
            s.line,
            "privilege-regression",
            `policy "${dropPolicy[1]}" dropped from hardened table ` +
              `"${dropPolicy[2]}" with no replacement policy in this ` +
              `migration — verify the table is not left unprotected`,
          );
        }
      }

      // ── P6: permissive policies ────────────────────────────────────
      // USING (true) is correct and intentional for a policy scoped TO
      // service_role: that role bypasses RLS anyway, and the explicit
      // policy documents the intent (migration 48 writes five of them).
      // The rule targets USING (true) reachable by a client role.
      const policy = !post
        ? null
        : /^CREATE\s+POLICY\s+"?(\w+)"?\s+ON\s+(?:public\.)?"?(\w+)"?([\s\S]*)$/i
          .exec(sql);
      if (
        policy && /USING\s*\(\s*true\s*\)/i.test(policy[3]) &&
        EXPOSED_ROLES.test(policyRoles(policy[3]))
      ) {
        const table = policy[2].toLowerCase();
        if (HARDENED_TABLES.has(table)) {
          report(
            "error",
            f.name,
            s.line,
            "privilege-regression",
            `policy "${policy[1]}" on hardened table "${policy[2]}" grants ` +
              `USING (true) to a client role, which is the unrestricted ` +
              `read that migration ${PRIVILEGE_BASELINE} replaced with a ` +
              `hospital-scoped policy`,
          );
        } else {
          report(
            "warning",
            f.name,
            s.line,
            "privilege-regression",
            `policy "${policy[1]}" on "${policy[2]}" grants USING (true) to ` +
              `a client role — confirm this table is public by design`,
          );
        }
      }

      // ── P1 / P2: new SECURITY DEFINER routines ─────────────────────
      const sig = functionSignature(sql);
      if (!sig) continue;

      const key = `${sig.name}/${sig.arity}`;
      const isNew = !definedSignatures.has(key);
      definedSignatures.add(key);

      if (!post || !isNew) continue;
      if (!/\bSECURITY\s+DEFINER\b/i.test(sig.raw)) continue;

      if (!explicitlyPrivileged.has(sig.name) && !hasBlanketHardening) {
        report(
          "error",
          f.name,
          s.line,
          "privilege-regression",
          `new SECURITY DEFINER routine "${sig.name}" (${sig.arity} arg) has ` +
            `no GRANT or REVOKE naming it. PostgreSQL grants EXECUTE on ` +
            `functions to PUBLIC by default, so this routine is callable ` +
            `from PostgREST by anon. Add the explicit pattern: REVOKE ALL ` +
            `... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO ` +
            `service_role.`,
        );
      }

      if (!/\bSET\s+search_path\b/i.test(sig.raw)) {
        report(
          "error",
          f.name,
          s.line,
          "privilege-regression",
          `SECURITY DEFINER routine "${sig.name}" has no SET search_path — ` +
            `it runs with the definer's rights and a caller-controlled ` +
            `search_path`,
        );
      }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const migrations = await loadMigrations();

for (const m of migrations) {
  analyzeFile(m.name, m.lines);
}
checkDuplicates();
checkPrimaryKeys(migrations);
checkPrivileges(migrations);

const errors = findings.filter((f) => f.level === "error");
const warnings = findings.filter((f) => f.level === "warning");

console.log(`Migration validation: ${migrations.length} files scanned`);
for (const f of errors) {
  console.log(`  ERROR   [${f.check}] ${f.file}:${f.line} — ${f.message}`);
}
for (const f of warnings) {
  console.log(`  WARN    [${f.check}] ${f.file}:${f.line} — ${f.message}`);
}
console.log(
  `Result: ${errors.length} error(s), ${warnings.length} warning(s)`,
);

if (errors.length > 0) Deno.exit(1);
