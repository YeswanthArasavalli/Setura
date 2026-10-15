/**
 * scripts/validate_migration_manifest.ts — G7-02 I-2 migration immutability gate
 *
 * Verifies `supabase/migrations/MANIFEST.sha256` (the forward immutability
 * baseline established by G7-03) against the actual migration files on disk,
 * and — when a baseline copy of the manifest is supplied — that the manifest
 * has evolved *append-only* (no already-baselined migration was edited,
 * removed, reordered, or inserted before the established sequence).
 *
 *   deno task validate:migration-manifest
 *   deno run --allow-read scripts/validate_migration_manifest.ts \
 *     --baseline-manifest <path-to-base-commit-manifest>
 *   deno run --allow-read --allow-write scripts/validate_migration_manifest.ts --update
 *
 * The manifest format (must match the G7-03 baseline byte-for-byte):
 *   <64 lowercase hex sha256><SP><SP><migration basename>
 * one line per migration, ordered lexicographically (== numerically for the
 * two-digit NN_ scheme), self-excluded, terminated by a single trailing newline.
 *
 * Hash domain (P3-02 CI repair): a migration's hash is the SHA-256 of its
 * CANONICAL LF content, i.e. the bytes Git actually stores for that blob, not
 * the bytes of whichever working copy happens to be on disk. `--update` feeds
 * the same `canonicalizeMigrationBytes()` path, so the recorder and the
 * validator can never disagree about how a migration is hashed.
 *
 * Baseline normalization allowance (P3-02 Option A): the append-only check
 * compares two manifests, so on hash strings alone a legitimate re-record is
 * indistinguishable from an edited migration whose manifest line was rewritten.
 * The allowance removes that ambiguity with CONTENT evidence, never with a
 * flag: a baselined hash may change ONLY when the actual migration bytes prove
 * the old record was SHA-256(CRLF rendering) and the new record is
 * SHA-256(canonical content) of one and the same content. It is one-time and
 * self-extinguishing — once an entry holds the canonical hash, re-satisfying
 * the proof would need a SHA-256 collision between a content and its own CRLF
 * rendering. No CLI flag, workflow condition or author choice activates it.
 *
 * Model (brief §9): a PR that adds `57_*.sql` MUST also append its line to the
 * manifest in the same PR. `--update` performs that append deterministically
 * WITHOUT touching any existing line, so a legitimate new migration never
 * requires editing history. CI supplies `--baseline-manifest` (extracted from
 * the PR base) so that editing an *already-baselined* migration's hash is a
 * hard failure even when the author also rewrites the manifest line — the only
 * permitted baseline change is the content-proved re-attestation above, which
 * requires the migration bytes themselves to be unchanged.
 *
 * Exit code: 0 = integrity holds, 1 = integrity failure. Output is
 * deterministic (sorted) so a clean tree reproduces byte-identical stdout.
 */

const MANIFEST_NAME = "MANIFEST.sha256";

export interface IntIssue {
  kind: string;
  detail: string;
}

export interface DiskMigration {
  num: number;
  name: string;
  hash: string;
  /**
   * SHA-256 of the SAME canonical content rendered with CRLF line endings —
   * the historical Windows working-copy form. The CLI fills it from real bytes;
   * the normalization allowance uses it as the content proof. When it is absent
   * the allowance is inert and `baseline-modified` fails closed.
   */
  crlfHash?: string;
}

export interface ManifestLine {
  hash: string;
  name: string;
}

/** SHA-256 of raw bytes, lowercase hex — matches the manifest encoding. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  // Copy into a standalone ArrayBuffer so the value is a BufferSource under
  // Deno's stricter TS lib (Uint8Array<ArrayBufferLike> is not assignable).
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Normalize a migration's bytes to canonical LF form.
 *
 * Only a CR that is immediately followed by LF is removed, so CRLF -> LF and a
 * lone CR (or a CR at end of file) is preserved byte-for-byte. That is a
 * deliberate choice: line-ending normalization must not silently rewrite
 * unrelated control bytes, and Git's own text normalization is defined the same
 * way. With this rule the hashed value equals the SHA-256 of the committed
 * blob on any platform, so a clean LF checkout (CI) and a Windows CRLF working
 * copy (core.autocrlf=true) agree.
 */
export function canonicalizeMigrationBytes(bytes: Uint8Array): Uint8Array {
  const cr = 0x0d;
  const lf = 0x0a;
  let firstCrlf = -1;
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === cr && bytes[i + 1] === lf) {
      firstCrlf = i;
      break;
    }
  }
  // Hot path: nothing to do, return the input untouched.
  if (firstCrlf === -1) return bytes;
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < firstCrlf; i++) out[n++] = bytes[i];
  for (let i = firstCrlf; i < bytes.length; i++) {
    if (bytes[i] === cr && i + 1 < bytes.length && bytes[i + 1] === lf) {
      continue;
    }
    out[n++] = bytes[i];
  }
  return out.subarray(0, n);
}

/** SHA-256 of a migration's canonical (LF) content. */
export function hashCanonicalMigrationBytes(
  bytes: Uint8Array,
): Promise<string> {
  return hashBytes(canonicalizeMigrationBytes(bytes));
}

/**
 * Render canonical (LF) content as its CRLF form.
 *
 * Canonical content contains no CR immediately followed by LF by construction,
 * so inserting a CR before every LF reproduces exactly the Windows working-copy
 * bytes that a raw-byte hash recorded. A lone CR stays a lone CR, and
 * canonicalizeMigrationBytes(crlfRenderingOfCanonicalBytes(x)) === x, which is
 * what makes the normalization proof independent of the checkout's line endings.
 */
export function crlfRenderingOfCanonicalBytes(canon: Uint8Array): Uint8Array {
  const lf = 0x0a;
  let lfs = 0;
  for (let i = 0; i < canon.length; i++) if (canon[i] === lf) lfs++;
  // Hot path: content without a single LF has no distinct CRLF rendering.
  if (lfs === 0) return canon;
  const out = new Uint8Array(canon.length + lfs);
  let n = 0;
  for (let i = 0; i < canon.length; i++) {
    if (canon[i] === lf) out[n++] = 0x0d;
    out[n++] = canon[i];
  }
  return out;
}

export function prefixNum(name: string): number | null {
  const m = name.match(/^(\d{2})_/);
  return m ? Number(m[1]) : null;
}

/** Parse a manifest into ordered lines; records structural defects. */
export function parseManifest(
  text: string,
  label: string,
  fail: (kind: string, detail: string) => void,
): ManifestLine[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const out: ManifestLine[] = [];
  for (const line of lines) {
    const hash = line.slice(0, 64);
    const sep = line.slice(64, 66);
    const name = line.slice(66);
    if (!/^[0-9a-f]{64}$/.test(hash) || sep !== "  " || !name) {
      fail(
        "manifest-format",
        `${label}: malformed line (expected "<sha256>  <basename>"): ${line}`,
      );
      continue;
    }
    if (name.includes("/") || name.includes("\\")) {
      fail(
        "manifest-format",
        `${label}: entry must be a basename, got ${name}`,
      );
      continue;
    }
    out.push({ hash, name });
  }
  return out;
}

/** Order must be lexicographic (== numeric); a violation implies a reorder. */
export function assertOrdered(
  lines: ManifestLine[],
  label: string,
  fail: (kind: string, detail: string) => void,
): void {
  for (let i = 1; i < lines.length; i++) {
    if (lines[i - 1].name.localeCompare(lines[i].name) > 0) {
      fail(
        "ordering",
        `${label}: ${lines[i - 1].name} must not precede ${
          lines[i].name
        } (non-deterministic order)`,
      );
    }
  }
}

/**
 * Enforce append-only evolution against a baseline manifest: every baseline
 * entry must survive unchanged and in relative order, and any additional
 * entries must be numbered strictly after the highest baseline number (i.e.
 * appended, never inserted before/between the established sequence).
 *
 * `disk` supplies the content proof for the one-time normalization allowance
 * (see header); omit it and every baselined hash change fails. `notice` is
 * audit output only — it never suppresses an issue.
 */
export function assertAppendOnly(
  baseline: ManifestLine[],
  current: ManifestLine[],
  fail: (kind: string, detail: string) => void,
  disk: readonly DiskMigration[] = [],
  notice?: (detail: string) => void,
): void {
  const currentByName = new Map(current.map((l) => [l.name, l]));
  const diskByName = new Map(disk.map((e) => [e.name, e]));
  const baseMaxNum = baseline.reduce(
    (acc, l) => Math.max(acc, prefixNum(l.name) ?? acc),
    0,
  );

  let cursor = 0;
  for (const b of baseline) {
    const c = currentByName.get(b.name);
    if (!c) {
      fail(
        "baseline-deleted",
        `baselined migration ${b.name} disappeared from the manifest (history must be append-only)`,
      );
      continue;
    }
    if (c.hash !== b.hash) {
      // Content-proved normalization allowance, and nothing else. Accepted only
      // when the migration bytes themselves attest that the baseline record was
      // the CRLF rendering (b.hash === crlfHash) and the new record is the
      // canonical hash of that identical content (c.hash === hash). Because the
      // branch already requires b.hash !== c.hash, acceptance also implies
      // crlfHash !== hash: a content with no distinct CRLF rendering can never
      // qualify, and a normalized entry can never qualify a second time.
      const d = diskByName.get(b.name);
      if (d && d.crlfHash === b.hash && d.hash === c.hash) {
        notice?.(
          `${b.name}: baselined record re-attested from CRLF rendering to canonical content (one-time line-ending normalization; bytes unchanged)`,
        );
      } else {
        fail(
          "baseline-modified",
          `baselined migration ${b.name} hash changed — applied migrations are IMMUTABLE; add a corrective migration instead`,
        );
      }
    }
    const idx = current.findIndex((l) => l.name === b.name);
    if (idx !== -1 && idx < cursor) {
      fail(
        "baseline-reordered",
        `baselined migration ${b.name} moved out of order`,
      );
    } else if (idx !== -1) {
      cursor = idx + 1;
    }
  }

  const baseNames = new Set(baseline.map((l) => l.name));
  for (const c of current) {
    if (baseNames.has(c.name)) continue;
    const n = prefixNum(c.name);
    if (n !== null && n <= baseMaxNum) {
      fail(
        "baseline-insert",
        `new migration ${c.name} (${n}) is inserted before/between the established baseline (max ${baseMaxNum}); new migrations may only be appended`,
      );
    }
  }
}

export interface AnalyzeInput {
  disk: DiskMigration[];
  manifestText: string;
  baselineText?: string;
  /** Audit sink for accepted content-proved re-records; cannot add issues. */
  notice?: (detail: string) => void;
}

/**
 * Core integrity analysis, free of filesystem/CLI concerns so it can be unit
 * tested deterministically against synthetic fixtures.
 */
export function analyze(input: AnalyzeInput): IntIssue[] {
  const issues: IntIssue[] = [];
  const fail = (kind: string, detail: string) => issues.push({ kind, detail });

  // Duplicate numeric prefixes on disk.
  const byNum = new Map<number, string>();
  for (const e of input.disk) {
    if (byNum.has(e.num)) {
      fail(
        "duplicate-prefix",
        `migration number ${e.num} is used by both ${
          byNum.get(e.num)
        } and ${e.name}`,
      );
    }
    byNum.set(e.num, e.name);
  }

  const manifest = parseManifest(input.manifestText, MANIFEST_NAME, fail);
  assertOrdered(manifest, MANIFEST_NAME, fail);

  const diskByName = new Map(input.disk.map((e) => [e.name, e]));
  const manifestByName = new Map(manifest.map((l) => [l.name, l]));

  // Disk <-> manifest reconciliation (§8 items 7-9).
  for (const e of input.disk) {
    const m = manifestByName.get(e.name);
    if (!m) {
      fail(
        "unmanifested",
        `${e.name} exists on disk but is absent from the manifest`,
      );
      continue;
    }
    if (m.hash !== e.hash) {
      fail(
        "modified",
        `${e.name} content hash does not match the manifest entry`,
      );
    }
  }
  for (const m of manifest) {
    if (!diskByName.has(m.name)) {
      fail(
        "missing",
        `${m.name} is listed in the manifest but missing on disk`,
      );
    }
  }

  // Duplicate manifest entries.
  const seen = new Set<string>();
  for (const m of manifest) {
    if (seen.has(m.name)) {
      fail("duplicate-entry", `${m.name} listed more than once`);
    }
    seen.add(m.name);
  }

  // Optional append-only enforcement against the PR base (§7 / §9).
  if (input.baselineText !== undefined) {
    const baseline = parseManifest(input.baselineText, "baseline", fail);
    assertAppendOnly(baseline, manifest, fail, input.disk, input.notice);
  }

  issues.sort((a, b) => (a.kind + a.detail).localeCompare(b.kind + b.detail));
  return issues;
}

// ─── CLI driver ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
  const args = Deno.args;
  const flagValue = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };
  const doUpdate = args.includes("--update");
  const baselinePath = flagValue("--baseline-manifest");

  // Enumerate on-disk migrations in numeric order.
  const disk: DiskMigration[] = [];
  for await (const e of Deno.readDir(migrationsDir)) {
    if (!e.isFile || !e.name.endsWith(".sql")) continue;
    const num = prefixNum(e.name);
    if (num === null) {
      console.log(
        `  ERROR [ordering] ${e.name}: file name lacks a NN_ numeric prefix`,
      );
      Deno.exit(1);
    }
    // Canonical LF content == the committed blob, on every platform. The CRLF
    // rendering of that same content is hashed too, so the append-only check can
    // prove a historical record attested identical bytes (normalization allowance).
    const canon = canonicalizeMigrationBytes(
      await Deno.readFile(new URL(e.name, migrationsDir)),
    );
    disk.push({
      num: num!,
      name: e.name,
      hash: await hashBytes(canon),
      crlfHash: await hashBytes(crlfRenderingOfCanonicalBytes(canon)),
    });
  }
  disk.sort((a, b) => a.num - b.num || a.name.localeCompare(b.name));

  const manifestUrl = new URL(MANIFEST_NAME, migrationsDir);
  let manifestText: string;
  try {
    manifestText = await new TextDecoder().decode(
      await Deno.readFile(manifestUrl),
    );
  } catch {
    console.error(
      `Migration manifest: MISSING — ${MANIFEST_NAME} not found in supabase/migrations/`,
    );
    Deno.exit(1);
  }

  // --update: append missing entries deterministically without editing history.
  if (doUpdate) {
    const parsed = parseManifest(manifestText, MANIFEST_NAME, () => {});
    const listed = new Set(parsed.map((l) => l.name));
    const toAppend = disk
      .filter((e) => !listed.has(e.name))
      .map((e) => `${e.hash}  ${e.name}`);
    if (toAppend.length > 0) {
      const existing = manifestText.replace(/\s+$/, "").split(/\r?\n/);
      const next = [...existing, ...toAppend].sort((a, b) =>
        a.slice(66).localeCompare(b.slice(66))
      );
      await Deno.writeTextFile(manifestUrl, next.join("\n") + "\n");
      console.log(
        `Migration manifest: appended ${toAppend.length} entr(y|ies): ${
          toAppend.map((l) => l.slice(66)).join(", ")
        }`,
      );
    } else {
      console.log(
        "Migration manifest: already up to date (nothing to append).",
      );
    }
    Deno.exit(0);
  }

  let baselineText: string | undefined;
  if (baselinePath) {
    try {
      baselineText = await Deno.readTextFile(baselinePath);
    } catch {
      console.error(`Migration manifest: cannot read baseline ${baselinePath}`);
      Deno.exit(1);
    }
  }

  // Re-record notices are audit output, so a normalization is visible in the
  // CI log instead of being silently accepted.
  const notices: string[] = [];
  const issues = analyze({
    disk,
    manifestText,
    baselineText,
    notice: (d: string) => notices.push(d),
  });

  console.log(
    `Migration manifest: ${disk.length} migration(s), ${
      parseManifest(manifestText, MANIFEST_NAME, () => {}).length
    } manifest line(s)` +
      (baselineText !== undefined
        ? " [append-only baseline check enabled]"
        : ""),
  );
  for (const n of notices) console.log(`  NOTICE [re-record] ${n}`);
  for (const i of issues) console.log(`  ERROR [${i.kind}] ${i.detail}`);
  console.log(
    `Result: ${issues.length} integrity issue(s), ${notices.length} accepted re-record(s)`,
  );

  if (issues.length > 0) Deno.exit(1);
}

if (import.meta.main) {
  await main();
}
