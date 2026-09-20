// TEMPORARY hosted-staging runtime probe. Proves auth / RLS / tenant isolation /
// Edge Function enforcement against the real staging HTTPS endpoints.
// Prints only non-secret signals (statuses, counts, masked key prefixes).
const REF = "gzcqasntcbqqmgsoikms";
const BASE = `https://${REF}.supabase.co`;
const HOSP = "00000000-0000-4000-8000-000000000001";
const FOREIGN = "00000000-0000-4000-8000-00000000b002";

// tolerate PowerShell redirection junk: slice first '[' to last ']'
const rawAll = Deno.readTextFileSync("./_keys.json");
const raw = rawAll.slice(rawAll.indexOf("["), rawAll.lastIndexOf("]") + 1);
type K = { name: string; type: string; api_key: string };
const keys = JSON.parse(raw) as K[];
const ANON = keys.find((k) => k.type === "publishable")?.api_key || keys.find((k) => k.name === "anon")?.api_key || "";
const SERVICE = keys.find((k) => k.type === "secret")?.api_key || keys.find((k) => k.name === "service_role")?.api_key || "";
const mask = (s: string) => (s ? `${s.slice(0, 6)}…(${s.length})` : "<none>");
console.log("anon_key:", mask(ANON), "| service_key:", mask(SERVICE));

const out: Record<string, string> = {};
async function hit(path: string, opt: RequestInit, key = ANON) {
  const res = await fetch(BASE + path, { ...opt, headers: { apikey: key, ...(opt.headers || {}) } });
  const text = await res.text();
  return { status: res.status, text };
}

// 1 reachability
{ const r = await hit("/rest/v1/", { headers: { Authorization: `Bearer ${ANON}` } }); out["1_restgrest_reachable"] = `HTTP ${r.status}`; }
// 2 hosted password auth (seeded reception staff account)
let JWT = "";
{
  const r = await hit("/auth/v1/token?grant_type=password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "reception@surya.test", password: "Setura@123" }) });
  let p: any = {}; try { p = JSON.parse(r.text); } catch {}
  JWT = p.access_token || "";
  out["2_auth_login"] = `HTTP ${r.status} access_token=${JWT ? "yes" : "no"} uid=${p.user?.id ? "yes" : "no"} body=${r.text.slice(0, 180).replace(/\s+/g, " ")}`;
}
// 3 authenticated RLS-scoped read
{
  const r = await hit("/rest/v1/patients?select=hospital_id", { headers: { Authorization: `Bearer ${JWT || ANON}` } });
  let rows: any[] = []; try { rows = JSON.parse(r.text); } catch {}
  const foreign = Array.isArray(rows) ? rows.filter((x) => x.hospital_id && x.hospital_id !== HOSP).length : -1;
  out["3_auth_scoped_read"] = `HTTP ${r.status} rows=${Array.isArray(rows) ? rows.length : "n/a"} foreign_rows=${foreign}`;
}
// 4 anon must not see tenant patient data
{
  const r = await hit("/rest/v1/patients?select=id", { headers: { Authorization: `Bearer ${ANON}` } });
  let n = "?"; try { const j = JSON.parse(r.text); n = Array.isArray(j) ? `array(${j.length})` : "obj"; } catch { n = r.status === 401 || r.status === 403 ? "denied" : "nonjson"; }
  out["4_anon_read"] = `HTTP ${r.status} payload=${n}`;
}
// 5 cross-tenant explicit filter -> empty
{
  const r = await hit(`/rest/v1/patients?select=id&hospital_id=eq.${FOREIGN}`, { headers: { Authorization: `Bearer ${JWT || ANON}` } });
  let n = "?"; try { const j = JSON.parse(r.text); n = Array.isArray(j) ? String(j.length) : "obj"; } catch { n = "nonjson"; }
  out["5_cross_tenant_filter"] = `HTTP ${r.status} foreign_rows=${n}`;
}
// 6 Edge Function JWT enforcement (no user token)
{ const r = await hit("/functions/v1/create-booking", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); out["6_fn_no_jwt"] = `HTTP ${r.status} ${r.status === 401 ? "denied" : r.text.slice(0, 100)}`; }
// 7 Edge Function hosted execution with valid JWT + minimal body
{
  const idem = crypto.randomUUID();
  const r = await hit("/functions/v1/create-booking", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${JWT}`, "idempotency-key": idem }, body: JSON.stringify({ hospital_id: HOSP }) });
  out["7_fn_with_jwt"] = `HTTP ${r.status} body=${r.text.slice(0, 200).replace(/\s+/g, " ")}`;
}

console.log("\n=== HOSTED STAGING PROBE ===");
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(22), ":", v);
console.log("==========================\n");
