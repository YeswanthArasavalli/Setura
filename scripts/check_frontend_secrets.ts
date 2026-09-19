/**
 * scripts/check_frontend_secrets.ts — G7-02 I-2 frontend build hygiene gate
 *
 * Scans the built frontend bundle (`apps/web/dist`) to prove that no
 * server-side secret material or secret *name* leaked into the client, and to
 * enforce the documented production source-map policy.
 *
 *   deno run --allow-read scripts/check_frontend_secrets.ts [distDir]
 *   deno run --allow-read scripts/check_frontend_secrets.ts --deny-sourcemaps
 *
 * Rationale (PHASE_7_G7_02 §9 / brief §11): the frontend is a thin client that
 * may only ever carry public `VITE_*` values (`VITE_SUPABASE_URL`,
 * `VITE_SUPABASE_ANON_KEY`). Service-role keys, gateway/webhook secrets, the
 * cron/worker shared secrets and the Vault-held scheduler secrets must never
 * appear in the browser bundle. Because Vite statically inlines `import.meta.env`
 * values at build time, the only trustworthy check is on the *output*: this
 * script greps the produced artifacts, not the source.
 *
 * The forbidden markers are matched case-sensitively as literal substrings.
 * They are secret NAMES / JWT role claims, not values, so a match is either a
 * genuine leak or (very rarely) a dead reference — both worth failing on.
 *
 * Exit code: 0 = clean, 1 = forbidden content found (or dist absent).
 */

const FORBIDDEN_MARKERS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  '"role":"service_role"',
  'role\\":\\"service_role', // minified/escaped variant
  "RAZORPAY_KEY_SECRET",
  "META_APP_SECRET",
  "CRON_SECRET",
  "WORKER_SECRET",
  "setura_scheduler_api_key",
  "setura_cron_secret",
] as const;

// Extensions whose contents are text and worth scanning.
const SCANNABLE = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".html",
  ".htm",
  ".json",
  ".txt",
  ".svg",
]);

const MAX_BYTES = 8 * 1024 * 1024; // skip anything larger than 8 MiB

interface Hit {
  file: string;
  marker: string;
}

async function walk(dir: URL, out: URL[]): Promise<void> {
  for await (const e of Deno.readDir(dir)) {
    const child = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) {
      await walk(child, out);
    } else if (e.isFile) {
      out.push(child);
    }
  }
}

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

/** Resolve a CLI dir argument (absolute or relative to cwd) to a file URL. */
function toDirUrl(p: string): URL {
  let abs = p.replace(/\\/g, "/");
  const winAbs = /^[A-Za-z]:\//.test(abs);
  if (!winAbs && !abs.startsWith("/")) {
    abs = Deno.cwd().replace(/\\/g, "/").replace(/\/+$/, "") + "/" + abs;
  }
  if (!abs.endsWith("/")) abs += "/";
  return new URL("file:///" + (winAbs ? abs : abs.replace(/^\/+/, "")));
}

const args = Deno.args.filter((a) => !a.startsWith("--"));
const denySourcemaps = Deno.args.includes("--deny-sourcemaps");
const distUrl = args[0]
  ? toDirUrl(args[0])
  : new URL("../apps/web/dist/", import.meta.url);

const files: URL[] = [];
try {
  await walk(distUrl, files);
} catch {
  console.error(
    `Frontend secret scan: BLOCKED — build output not found at ${distUrl}. ` +
      `Run the production build (npm run build) before this check.`,
  );
  Deno.exit(1);
}

const root = distUrl.pathname;
const hits: Hit[] = [];
const sourcemaps: string[] = [];

for (const f of files) {
  const rel = decodeURIComponent(f.pathname.slice(root.length));
  if (ext(f.pathname) === ".map") sourcemaps.push(rel);
  if (!SCANNABLE.has(ext(f.pathname))) continue;
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(f);
  } catch {
    continue;
  }
  if (bytes.length > MAX_BYTES) continue;
  // Latin-1 decode keeps every byte addressable for ASCII marker matching.
  const text = new TextDecoder("latin1").decode(bytes);
  for (const marker of FORBIDDEN_MARKERS) {
    if (text.includes(marker)) hits.push({ file: rel, marker });
  }
}

hits.sort((a, b) => (a.file + a.marker).localeCompare(b.file + b.marker));
sourcemaps.sort();

console.log(
  `Frontend secret scan: ${files.length} artifact(s) in dist, ` +
    `${sourcemaps.length} source map(s)`,
);
for (const h of hits) {
  console.log(`  ERROR [secret-leak] ${h.file} contains "${h.marker}"`);
}
if (sourcemaps.length > 0) {
  const line = `  ${
    denySourcemaps ? "ERROR" : "WARN "
  } [sourcemap] production build emitted ${sourcemaps.length} .map file(s): ${
    sourcemaps.slice(0, 5).join(", ")
  }${sourcemaps.length > 5 ? " …" : ""}`;
  console.log(
    line +
      (denySourcemaps
        ? " — set build.sourcemap=false or upload maps privately"
        : " — informational (document the production sourcemap policy)"),
  );
}

const fail = hits.length > 0 || (denySourcemaps && sourcemaps.length > 0);
console.log(
  `Result: ${hits.length} secret hit(s), ${sourcemaps.length} source map(s)` +
    (denySourcemaps ? " (sourcemaps denied)" : ""),
);
if (fail) Deno.exit(1);
