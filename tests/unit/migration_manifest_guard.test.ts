/**
 * tests/unit/migration_manifest_guard.test.ts
 *
 * G7-02 I-2 — proves the migration-immutability gate itself.
 *
 * `scripts/validate_migration_manifest.ts` is a CI *tool*, so its decision
 * logic is exercised here against synthetic fixtures rather than by mutating
 * real migrations. The pure `analyze()` function is the single source of the
 * verdict; the CLI layer only feeds it from the filesystem. These cases lock
 * the semantics the release-control pipeline relies on:
 *
 *   tampered baseline file          -> "modified"
 *   file present, not manifested    -> "unmanifested"
 *   manifested file missing on disk -> "missing"
 *   duplicate numeric prefix        -> "duplicate-prefix"
 *   non-deterministic manifest order-> "ordering"
 *   legitimate append (new NN after baseline, manifest updated) -> CLEAN
 *   edited baselined hash           -> "baseline-modified"
 *   migration inserted before baseline max -> "baseline-insert"
 *   baselined entry deleted         -> "baseline-deleted"
 *   baselined entry moved backwards -> "baseline-reordered" (with "ordering")
 *
 * P3-02 adds the hash-domain semantics (canonical LF content == committed
 * blob), which is what makes the same tree valid on a Windows CRLF working
 * copy and on a clean LF checkout:
 *
 *   CRLF vs LF bytes of one file   -> identical canonical hash
 *   lone CR byte                   -> preserved, never stripped
 *   genuine SQL content change     -> still "modified" (negative control)
 *   the real supabase/migrations/ tree -> zero issues
 *
 * P3-02 Option A adds the one-time normalization allowance, whose whole purpose
 * is that it is proven from migration BYTES and cannot be requested:
 *
 *   baseline=CRLF rendering, new=canonical, bytes identical -> CLEAN + notice
 *   same proof from an LF or a CRLF checkout                -> identical
 *   genuine edit (manifest untouched / rewritten / CRLF)     -> still fails
 *   reverse direction, or entry already normalized          -> still fails
 *   no crlfHash supplied (fail closed)                      -> still fails
 *   real 73-entry tree vs its own normalized baseline       -> CLEAN, 0 notices
 *
 * Run: deno task test
 */

import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  analyze,
  canonicalizeMigrationBytes,
  crlfRenderingOfCanonicalBytes,
  type DiskMigration,
  hashBytes,
  hashCanonicalMigrationBytes,
  type IntIssue,
} from "../../scripts/validate_migration_manifest.ts";

const enc = (s: string) => new TextEncoder().encode(s);

// 64-hex placeholders; the values are irrelevant, only their distinctness is.
const H = (c: string) => c.repeat(64);

function line(m: DiskMigration): string {
  return `${m.hash}  ${m.name}`;
}

function manifestOf(disk: DiskMigration[]): string {
  return disk.map(line).join("\n") + "\n";
}

function kinds(issues: IntIssue[]): string[] {
  return issues.map((i) => i.kind).sort();
}

const BASE: DiskMigration[] = [
  { num: 1, name: "01_alpha.sql", hash: H("a") },
  { num: 2, name: "02_beta.sql", hash: H("b") },
  { num: 3, name: "03_gamma.sql", hash: H("c") },
];

/**
 * Build a disk entry exactly as the CLI does: the canonical hash plus the hash
 * of the same canonical content rendered with CRLF. These two values are the
 * content proof the normalization allowance is judged on.
 */
type Proven = DiskMigration & { crlfHash: string };

async function entry(
  num: number,
  name: string,
  text: string,
): Promise<Proven> {
  const canon = canonicalizeMigrationBytes(enc(text));
  return {
    num,
    name,
    hash: await hashBytes(canon),
    crlfHash: await hashBytes(crlfRenderingOfCanonicalBytes(canon)),
  };
}

Deno.test("manifest guard: a consistent tree yields zero issues", () => {
  const issues = analyze({ disk: BASE, manifestText: manifestOf(BASE) });
  assertEquals(issues, []);
});

Deno.test("manifest guard: edited file content is 'modified'", () => {
  const tampered = BASE.map((m) => m.num === 2 ? { ...m, hash: H("f") } : m);
  // Manifest still records the ORIGINAL hash for 02.
  const issues = analyze({ disk: tampered, manifestText: manifestOf(BASE) });
  assertEquals(kinds(issues), ["modified"]);
});

Deno.test("manifest guard: unmanifested file is caught", () => {
  const withExtra: DiskMigration[] = [
    ...BASE,
    { num: 4, name: "04_delta.sql", hash: H("d") },
  ];
  const issues = analyze({ disk: withExtra, manifestText: manifestOf(BASE) });
  assertEquals(kinds(issues), ["unmanifested"]);
});

Deno.test("manifest guard: manifested-but-absent file is 'missing'", () => {
  const shrunk = BASE.slice(0, 2); // drop 03 on disk
  const issues = analyze({ disk: shrunk, manifestText: manifestOf(BASE) });
  assertEquals(kinds(issues), ["missing"]);
});

Deno.test("manifest guard: duplicate numeric prefix is caught", () => {
  const dup: DiskMigration[] = [
    BASE[0],
    { num: 2, name: "02_beta.sql", hash: H("b") },
    { num: 2, name: "02_behta.sql", hash: H("e") },
  ];
  const issues = analyze({ disk: dup, manifestText: manifestOf(dup) });
  assertEquals(kinds(issues).includes("duplicate-prefix"), true);
});

Deno.test("manifest guard: non-deterministic manifest order is 'ordering'", () => {
  const swapped = `${line(BASE[1])}\n${line(BASE[0])}\n${line(BASE[2])}\n`;
  const issues = analyze({ disk: BASE, manifestText: swapped });
  assertEquals(kinds(issues), ["ordering"]);
});

Deno.test("manifest guard: legitimate append after the baseline is CLEAN", () => {
  // Baseline is 01-03; PR adds 04 and extends the manifest.
  const baselineText = BASE.map(line).join("\n") + "\n";
  const appended: DiskMigration[] = [
    ...BASE,
    { num: 4, name: "04_delta.sql", hash: H("d") },
  ];
  const issues = analyze({
    disk: appended,
    manifestText: manifestOf(appended),
    baselineText,
  });
  assertEquals(issues, []);
});

Deno.test("manifest guard: editing a baselined hash fails append-only", () => {
  // Author edits 02 AND rewrites its manifest line to match the new hash —
  // the disk<->manifest check passes, but the baseline comparison catches it.
  // No crlfHash is supplied, so the normalization allowance is inert here.
  const editedDisk: DiskMigration[] = BASE.map((m) =>
    m.num === 2 ? { ...m, hash: H("9") } : m
  );
  const baselineText = BASE.map(line).join("\n") + "\n";
  const issues = analyze({
    disk: editedDisk,
    manifestText: manifestOf(editedDisk),
    baselineText,
  });
  assertEquals(kinds(issues), ["baseline-modified"]);
});

Deno.test("manifest guard: deleting a baselined entry fails (baseline-deleted)", () => {
  // Migration 02 is removed from disk AND from the manifest. Disk and manifest
  // agree perfectly, so only the baseline comparison can catch the rewrite.
  const shrunk: DiskMigration[] = [BASE[0], BASE[2]];
  const issues = analyze({
    disk: shrunk,
    manifestText: manifestOf(shrunk),
    baselineText: BASE.map(line).join("\n") + "\n",
  });
  assertEquals(kinds(issues), ["baseline-deleted"]);
});

Deno.test("manifest guard: reordering baselined entries fails (baseline-reordered)", () => {
  // Same entries, same hashes, one baselined line moved backwards. `ordering`
  // necessarily co-fires because the manifest is no longer lexicographic; both
  // kinds are pinned exactly rather than accepted as alternatives.
  const reordered = [BASE[1], BASE[0], BASE[2]];
  const issues = analyze({
    disk: BASE,
    manifestText: reordered.map(line).join("\n") + "\n",
    baselineText: BASE.map(line).join("\n") + "\n",
  });
  assertEquals(kinds(issues), ["baseline-reordered", "ordering"]);
});

Deno.test("manifest guard: migration inserted before the baseline max fails", () => {
  // Baseline is 01 + 03; the PR inserts 02_delta between them with a unique
  // prefix and a correctly ordered manifest, so baseline-insert is the ONLY
  // possible violation. The previous fixture tripped duplicate-prefix instead,
  // which left this kind unproven.
  const baselineSet: DiskMigration[] = [BASE[0], BASE[2]];
  const inserted: DiskMigration[] = [
    BASE[0],
    { num: 2, name: "02_delta.sql", hash: H("d") },
    BASE[2],
  ];
  const issues = analyze({
    disk: inserted,
    manifestText: manifestOf(inserted),
    baselineText: baselineSet.map(line).join("\n") + "\n",
  });
  assertEquals(kinds(issues), ["baseline-insert"]);
});

Deno.test("manifest guard: output is deterministic", () => {
  const bad = BASE.map((m) => ({ ...m, hash: H("1") })); // all mismatched
  const a = analyze({ disk: bad, manifestText: manifestOf(BASE) });
  const b = analyze({ disk: bad, manifestText: manifestOf(BASE) });
  assertEquals(a, b);
  // Sorted by kind+detail for stable output.
  const sorted = [...a].sort((x, y) =>
    (x.kind + x.detail).localeCompare(y.kind + y.detail)
  );
  assertEquals(a, sorted);
});

// ─── P3-02: canonical LF hash domain ────────────────────────────────────────

Deno.test("canonicalization: CRLF and LF bytes of one file hash identically", async () => {
  const sql = "create table t (\n  id int\n);\n\n-- done\n";
  const crlf = sql.replace(/\n/g, "\r\n");
  assertEquals(
    await hashCanonicalMigrationBytes(enc(sql)),
    await hashCanonicalMigrationBytes(enc(crlf)),
  );
});

Deno.test("canonicalization: only CR inside a CRLF pair is removed", () => {
  // Lone CR (classic CR-only line ending, or a trailing CR) is NOT stripped:
  // the rule is deliberate, so normalization never rewrites unrelated bytes.
  const loneCr = new Uint8Array([0x61, 0x0d, 0x62]); // "a\rb"
  assertEquals(canonicalizeMigrationBytes(loneCr), loneCr);
  // CR at end of file is likewise preserved.
  const trailing = new Uint8Array([0x61, 0x0d]); // "a\r"
  assertEquals(canonicalizeMigrationBytes(trailing), trailing);
  // Whereas a real CRLF collapses to LF.
  assertEquals(
    Array.from(canonicalizeMigrationBytes(new Uint8Array([0x61, 0x0d, 0x0a]))),
    [0x61, 0x0a],
  );
});

Deno.test("manifest guard: a CRLF working copy passes an LF-recorded manifest", async () => {
  const body = "insert into t values (1);\n";
  const recorded = await hashCanonicalMigrationBytes(enc(body)); // LF author
  const checkout = await hashCanonicalMigrationBytes(
    enc(body.replace(/\n/g, "\r\n")),
  ); // Windows checkout
  const disk: DiskMigration[] = [{ num: 1, name: "01_a.sql", hash: checkout }];
  const issues = analyze({
    disk,
    manifestText: `${recorded}  01_a.sql\n`,
  });
  assertEquals(issues, []);
});

Deno.test("manifest guard NEGATIVE CONTROL: a genuine SQL edit still fails", async () => {
  const original = "insert into t values (1);\n";
  const tampered = "insert into t values (1), (2);\n";
  const manifestText = `${await hashCanonicalMigrationBytes(
    enc(original),
  )}  01_a.sql\n`;
  const disk: DiskMigration[] = [{
    num: 1,
    name: "01_a.sql",
    hash: await hashCanonicalMigrationBytes(enc(tampered)),
  }];
  const issues = analyze({ disk, manifestText });
  assertEquals(issues.map((i) => i.kind), ["modified"]);
  // Line-ending churn alone must not be the reason: same content, CRLF bytes.
  const crlfOnly: DiskMigration[] = [{
    num: 1,
    name: "01_a.sql",
    hash: await hashCanonicalMigrationBytes(
      enc(original.replace(/\n/g, "\r\n")),
    ),
  }];
  assertEquals(analyze({ disk: crlfOnly, manifestText }), []);
});

Deno.test("manifest guard: real supabase/migrations/ tree is consistent", async () => {
  // Proves the committed manifest attests the canonical content of every real
  // migration, on whatever line endings this machine checked out.
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const disk: DiskMigration[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile || !e.name.endsWith(".sql")) continue;
    const num = Number(e.name.slice(0, 2));
    disk.push({
      num,
      name: e.name,
      hash: await hashCanonicalMigrationBytes(
        await Deno.readFile(new URL(e.name, dir)),
      ),
    });
  }
  disk.sort((a, b) => a.num - b.num || a.name.localeCompare(b.name));
  const manifestText = await new TextDecoder().decode(
    await Deno.readFile(new URL("MANIFEST.sha256", dir)),
  );
  const manifestLines = manifestText.split(/\r?\n/).filter((l) => l.length > 0);
  assertEquals(manifestLines.length, disk.length);
  assertEquals(analyze({ disk, manifestText }), []);
});

// ─── P3-02 Option A: content-proved normalization allowance ─────────────────

Deno.test("allowance: accepts a byte-identical re-record, proven from content", async () => {
  const e = await entry(1, "01_a.sql", "insert into t values (1);\n");
  const notices: string[] = [];
  const issues = analyze({
    disk: [e],
    manifestText: `${e.hash}  01_a.sql\n`,
    baselineText: `${e.crlfHash}  01_a.sql\n`,
    notice: (d: string) => notices.push(d),
  });
  assertEquals(issues, []);
  // The acceptance is announced, never silent.
  assertEquals(notices.length, 1);
  assertEquals(notices[0].includes("01_a.sql"), true);
});

Deno.test("allowance: proof is identical for an LF and a CRLF checkout", async () => {
  const body = "insert into t values (1);\nselect 2;\n";
  const fromLf = await entry(1, "01_a.sql", body);
  const fromCrlf = await entry(1, "01_a.sql", body.replace(/\n/g, "\r\n"));
  // The proof is derived from canonical content, so CI (LF) and a Windows
  // working copy (CRLF) compute the same two values and reach one verdict.
  assertEquals(fromCrlf.hash, fromLf.hash);
  assertEquals(fromCrlf.crlfHash, fromLf.crlfHash);
  for (const d of [fromLf, fromCrlf]) {
    assertEquals(
      analyze({
        disk: [d],
        manifestText: `${d.hash}  01_a.sql\n`,
        baselineText: `${fromLf.crlfHash}  01_a.sql\n`,
      }),
      [],
    );
  }
});

Deno.test("allowance NEGATIVE: a genuine edit fails however it is rendered or recorded", async () => {
  const original = "insert into t values (1);\n";
  const tampered = "insert into t values (1), (2);\n";
  const before = await entry(1, "01_a.sql", original);
  const after = await entry(1, "01_a.sql", tampered);
  const baselineText = `${before.crlfHash}  01_a.sql\n`;

  // (a) Edit with the manifest untouched: gate 1 and the baseline both flag it.
  assertEquals(
    kinds(
      analyze({
        disk: [after],
        manifestText: `${before.hash}  01_a.sql\n`,
        baselineText,
      }),
    ),
    ["baseline-modified", "modified"],
  );

  // (b) Edit with the manifest hash rewritten to the new content. Gate 1 is
  // satisfied, so only the allowance decision matters — and it must refuse,
  // because the BYTES differ even though both records are self-consistent.
  assertEquals(
    kinds(
      analyze({
        disk: [after],
        manifestText: `${after.hash}  01_a.sql\n`,
        baselineText,
      }),
    ),
    ["baseline-modified"],
  );

  // (c) The same edit committed with CRLF endings: canonicalization folds the
  // rendering, so the proof is identical and the edit is still refused.
  const afterCrlf = await entry(1, "01_a.sql", tampered.replace(/\n/g, "\r\n"));
  assertEquals(
    kinds(
      analyze({
        disk: [afterCrlf],
        manifestText: `${afterCrlf.hash}  01_a.sql\n`,
        baselineText,
      }),
    ),
    ["baseline-modified"],
  );
});

Deno.test("allowance NEGATIVE: reverse direction and an already-normalized entry are refused", async () => {
  const e = await entry(1, "01_a.sql", "insert into t values (1);\n");
  // (a) Moving a normalized record back to the CRLF rendering is not a
  // normalization: refused, and gate 1 flags it as modified.
  assertEquals(
    kinds(
      analyze({
        disk: [e],
        manifestText: `${e.crlfHash}  01_a.sql\n`,
        baselineText: `${e.hash}  01_a.sql\n`,
      }),
    ),
    ["baseline-modified", "modified"],
  );
  // (b) The state every PR after the normalization is in: baseline == manifest.
  // Clean, and decisively ZERO notices — the allowance cannot fire.
  const notices: string[] = [];
  assertEquals(
    analyze({
      disk: [e],
      manifestText: `${e.hash}  01_a.sql\n`,
      baselineText: `${e.hash}  01_a.sql\n`,
      notice: (d: string) => notices.push(d),
    }),
    [],
  );
  assertEquals(notices.length, 0);
});

Deno.test("allowance is inert without the CLI content proof (fail closed)", async () => {
  const e = await entry(1, "01_a.sql", "insert into t values (1);\n");
  // Identical hashes to the accepted case, but no crlfHash reaches the check:
  // the allowance must not be reachable by omitting the proof.
  const unproven: DiskMigration = { num: 1, name: "01_a.sql", hash: e.hash };
  assertEquals(
    kinds(
      analyze({
        disk: [unproven],
        manifestText: `${e.hash}  01_a.sql\n`,
        baselineText: `${e.crlfHash}  01_a.sql\n`,
      }),
    ),
    ["baseline-modified"],
  );
});

Deno.test("crlfRenderingOfCanonicalBytes round-trips and preserves a lone CR", () => {
  const canon = canonicalizeMigrationBytes(enc("a\nb\r\nc"));
  assertEquals(new TextDecoder().decode(canon), "a\nb\nc");
  const crlf = crlfRenderingOfCanonicalBytes(canon);
  assertEquals(new TextDecoder().decode(crlf), "a\r\nb\r\nc");
  assertEquals(
    new TextDecoder().decode(canonicalizeMigrationBytes(crlf)),
    "a\nb\nc",
  );
  // A lone CR survives the rendering, so a real byte edit stays detectable.
  const lone = canonicalizeMigrationBytes(
    new Uint8Array([0x61, 0x0d, 0x62, 0x0a]),
  );
  assertEquals(
    Array.from(crlfRenderingOfCanonicalBytes(lone)),
    [0x61, 0x0d, 0x62, 0x0d, 0x0a],
  );
  // Content without any LF has no distinct rendering.
  const noLf = canonicalizeMigrationBytes(new Uint8Array([0x61, 0x62]));
  assertEquals(crlfRenderingOfCanonicalBytes(noLf), noLf);
});

Deno.test("allowance: self-extinguishing across the real supabase/migrations/ tree", async () => {
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  const disk: Proven[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile || !e.name.endsWith(".sql")) continue;
    const canon = canonicalizeMigrationBytes(
      await Deno.readFile(new URL(e.name, dir)),
    );
    disk.push({
      num: Number(e.name.slice(0, 2)),
      name: e.name,
      hash: await hashBytes(canon),
      crlfHash: await hashBytes(crlfRenderingOfCanonicalBytes(canon)),
    });
  }
  disk.sort((a, b) => a.num - b.num || a.name.localeCompare(b.name));
  const manifestText = await new TextDecoder().decode(
    await Deno.readFile(new URL("MANIFEST.sha256", dir)),
  );
  assertEquals(
    manifestText.split(/\r?\n/).filter((l) => l.length > 0).length,
    disk.length,
  );
  // Every committed content has a distinct CRLF rendering, so a normalized
  // entry can never satisfy the allowance again for any future baseline.
  for (const e of disk) assertNotEquals(e.hash, e.crlfHash);
  // Baseline == the normalized manifest, i.e. the base of every future PR.
  const notices: string[] = [];
  assertEquals(
    analyze({
      disk,
      manifestText,
      baselineText: manifestText,
      notice: (d: string) => notices.push(d),
    }),
    [],
  );
  assertEquals(notices.length, 0);
});
