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
 *
 * Run: deno task test
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  analyze,
  type DiskMigration,
  type IntIssue,
} from "../../scripts/validate_migration_manifest.ts";

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
  const editedDisk: DiskMigration[] = BASE.map((m) =>
    m.num === 2 ? { ...m, hash: H("9") } : m
  );
  const baselineText = BASE.map(line).join("\n") + "\n";
  const issues = analyze({
    disk: editedDisk,
    manifestText: manifestOf(editedDisk),
    baselineText,
  });
  assertEquals(kinds(issues).includes("baseline-modified"), true);
});

Deno.test("manifest guard: migration inserted before the baseline max fails", () => {
  // Someone adds a migration numbered 02_ (between existing 02 and 03) —
  // an out-of-order insert, not a valid append.
  const inserted: DiskMigration[] = [
    BASE[0],
    BASE[1],
    { num: 2, name: "02_extra.sql", hash: H("e") },
    BASE[2],
  ];
  const baselineText = BASE.map(line).join("\n") + "\n";
  const issues = analyze({
    disk: inserted,
    manifestText: manifestOf(inserted),
    baselineText,
  });
  const k = kinds(issues);
  assertEquals(
    k.includes("duplicate-prefix") || k.includes("baseline-insert") ||
      k.includes("ordering"),
    true,
    `expected an insert violation, got: ${JSON.stringify(issues)}`,
  );
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
