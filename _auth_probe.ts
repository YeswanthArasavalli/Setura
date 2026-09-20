// TEMP: isolate the GoTrue 500 — probe auth health/settings/signin paths.
const REF = "gzcqasntcbqqmgsoikms";
const BASE = `https://${REF}.supabase.co`;
const rawAll = Deno.readTextFileSync("./_keys.json");
const keys = JSON.parse(rawAll.slice(rawAll.indexOf("["), rawAll.lastIndexOf("]") + 1)) as { name: string; type: string; api_key: string }[];
const ANON = keys.find((k) => k.type === "publishable")?.api_key || "";
const hit = async (path: string, opt: RequestInit = {}) => {
  const r = await fetch(BASE + path, { ...opt, headers: { apikey: ANON, ...(opt.headers || {}) } });
  return `HTTP ${r.status} :: ${(await r.text()).slice(0, 220).replace(/\s+/g, " ")}`;
};
console.log("health   :", await hit("/auth/v1/health"));
console.log("settings :", await hit("/auth/v1/settings"));
console.log(
  "bogus  :",
  await hit("/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "nobody@nowhere.test", password: "Nope@1234" }),
  }),
);
