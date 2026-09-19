/**
 * scripts/release_manifest.ts — G7-02 I-2 release-candidate provenance
 *
 * Produces a machine-readable provenance summary (`release/manifest.json`)
 * that can be attached to a release candidate. It is a VALIDATION/PROVENANCE
 * artifact ONLY — it records no deployment, creates no environment, and fabricates
 * no result. Every field it cannot observe is left at the honest default.
 *
 *   deno task release:manifest
 *   deno run --allow-read --allow-write --allow-env scripts/release_manifest.ts \
 *     --commit <sha> --branch <name> --tag <vX.Y.Z> \
 *     --backend PASS --frontend PASS --security UNPROVEN ...
 *
 * Inputs come from CLI flags, else environment variables (so GitHub Actions can
 * feed them from the `github` context without hardcoding), else the value
 * "UNPROVEN". Status fields are restricted to the certification vocabulary
 * PASS | FAIL | BLOCKED | UNPROVEN — an unrecognised value degrades to UNPROVEN
 * rather than to a false PASS.
 *
 * No secret VALUES are ever recorded; only commit/branch/tag names, hashes and
 * counts appear in the output.
 */

const STATUSES = ["PASS", "FAIL", "BLOCKED", "UNPROVEN"] as const;
type Status = typeof STATUSES[number];
const DEFAULT_STATUS: Status = "UNPROVEN";
const DEFAULT_META = "UNPROVEN";

const MIGRATIONS_DIR = new URL("../supabase/migrations/", import.meta.url);
const MANIFEST_NAME = "MANIFEST.sha256";
const DIST_INDEX = new URL("../apps/web/dist/index.html", import.meta.url);
const OUT_URL = new URL("../release/manifest.json", import.meta.url);

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", bytes.slice().buffer)
    .then((d) =>
      Array.from(new Uint8Array(d))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    );
}

const argMap = new Map<string, string>();
{
  const argv = [...Deno.args];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    // Support both `--key value` and `--key=value`.
    if (m[2] !== undefined) {
      argMap.set(key, m[2]);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      argMap.set(key, argv[++i]);
    } else {
      argMap.set(key, "");
    }
  }
}

/** flag > env > default. */
function resolve(flag: string, env: string, dflt: string): string {
  if (argMap.has(flag)) return argMap.get(flag) || dflt;
  const v = Deno.env.get(env);
  return v && v.length > 0 ? v : dflt;
}

function resolveStatus(flag: string, env: string): Status {
  const raw = resolve(flag, env, DEFAULT_STATUS).toUpperCase();
  return (STATUSES as readonly string[]).includes(raw)
    ? (raw as Status)
    : DEFAULT_STATUS;
}

// Migration manifest hash + count.
let manifestHash = DEFAULT_META;
let migrationCount: number | "UNPROVEN" = "UNPROVEN";
try {
  const manifestBytes = await Deno.readFile(
    new URL(MANIFEST_NAME, MIGRATIONS_DIR),
  );
  manifestHash = await sha256Hex(manifestBytes);
  let n = 0;
  for await (const e of Deno.readDir(MIGRATIONS_DIR)) {
    if (e.isFile && e.name.endsWith(".sql")) n++;
  }
  migrationCount = n;
} catch {
  // Absent/unreadable manifest stays UNPROVEN rather than blocking generation.
}

// Frontend build hash (of the produced index.html entry, if built).
let frontendBuildHash = resolve(
  "frontend-build-hash",
  "RELEASE_FRONTEND_BUILD_HASH",
  DEFAULT_META,
);
if (frontendBuildHash === DEFAULT_META) {
  try {
    frontendBuildHash = await sha256Hex(await Deno.readFile(DIST_INDEX));
  } catch {
    frontendBuildHash = DEFAULT_META;
  }
}

interface Manifest {
  schema_version: string;
  generated_at: string;
  purpose: string;
  commit_sha: string;
  branch: string;
  tag: string;
  source_revision: string;
  migration_manifest_sha256: string;
  migration_count: number | string;
  frontend_build_hash: string;
  results: {
    backend: Status;
    frontend: Status;
    security: Status;
    worker: Status;
    scheduler: Status;
    financial: Status;
    build: Status;
  };
  deployment: string;
  note: string;
}

const manifest: Manifest = {
  schema_version: "1",
  generated_at: new Date().toISOString(),
  purpose: "release-candidate provenance (validation only)",
  commit_sha: resolve("commit", "RELEASE_COMMIT", DEFAULT_META),
  branch: resolve("branch", "RELEASE_BRANCH", DEFAULT_META),
  tag: resolve("tag", "RELEASE_TAG", DEFAULT_META),
  source_revision: resolve(
    "source-revision",
    "RELEASE_SOURCE_REVISION",
    DEFAULT_META,
  ),
  migration_manifest_sha256: manifestHash,
  migration_count: migrationCount,
  frontend_build_hash: frontendBuildHash,
  results: {
    backend: resolveStatus("backend", "RELEASE_RESULT_BACKEND"),
    frontend: resolveStatus("frontend", "RELEASE_RESULT_FRONTEND"),
    security: resolveStatus("security", "RELEASE_RESULT_SECURITY"),
    worker: resolveStatus("worker", "RELEASE_RESULT_WORKER"),
    scheduler: resolveStatus("scheduler", "RELEASE_RESULT_SCHEDULER"),
    financial: resolveStatus("financial", "RELEASE_RESULT_FINANCIAL"),
    build: resolveStatus("build", "RELEASE_RESULT_BUILD"),
  },
  deployment: "NOT PERFORMED",
  note: "Provenance metadata only. Does not assert staging/production " +
    "deployment or certification. BLOCKED/UNPROVEN results are never " +
    "promoted to PASS.",
};

await Deno.mkdir(new URL("../release/", import.meta.url), { recursive: true });
await Deno.writeTextFile(OUT_URL, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Release manifest written to release/manifest.json`);
console.log(JSON.stringify(manifest, null, 2));
