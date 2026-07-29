// kontrak-auto-refresh
// Reads the per-PLTU "Profil Pasokan" workbooks from a shared SharePoint folder
// and stores one number per PLTU into the `kontrak_pasokan` table (row id=1).
//
// Storage: DELIBERATELY its own table, not a field inside dashboard_data.data.
// That blob (~900 KB) is rewritten WHOLESALE by prod-auto-refresh every 20 minutes
// via read-modify-write; when two writers overlap the later one writes a stale
// snapshot and another function's field disappears -- exactly what happened to
// kontrak_pasokan_2026 on 2026-07-29. A separate table removes that bug class.
// dashboard_data is still READ (only to map plant name -> code), never written.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as XLSX from "npm:xlsx@0.18.5";

const DEFAULT_SHARE_URL =
  "https://plnbatubaracoid-my.sharepoint.com/:f:/g/personal/ardan_saputro_plnepi_co_id/IgAkn9cA3bnpSLBva8YQYA-oAWrh0TMlCKPEV2GsYR9M3tY?e=6Fnebf";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const MIN_PLANTS = 20;

function _safeStr(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}
function _safeNum(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = (typeof v === "number") ? v : parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}
function _sheetToMatrix(ws: XLSX.WorkSheet): any[][] {
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as any[][];
}
function stableStringify(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
function round2(n: number): number { return Math.round(n * 100) / 100; }

function nameKey(s: unknown): string {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function plantNameFromFile(fn: string): string {
  let n = fn.replace(/\.xls[xmb]?$/i, "");
  n = n.replace(/^profil[_ ]pasokan[_ ]/i, "");
  n = n.replace(/[_ ](PIP|UIW|PNP|UIK)[_ ]\d{4}$/i, "");
  return n.replace(/_/g, " ").trim();
}

function shareToken(url: string): string {
  const b64 = btoa(url);
  return "u!" + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function redeemShare(shareUrl: string, log: string[]): Promise<string> {
  const jar = new Map<string, string>();
  let url = shareUrl;
  for (let hop = 0; hop < 10; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,*/*",
        ...(jar.size ? { "Cookie": cookieHeader(jar) } : {}),
      },
    });
    const setCookies = typeof (res.headers as any).getSetCookie === "function"
      ? (res.headers as any).getSetCookie() as string[]
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
    for (const raw of setCookies) {
      const eq = raw.indexOf("=");
      if (eq < 0) continue;
      const semi = raw.indexOf(";");
      const name = raw.slice(0, eq).trim();
      const val = raw.slice(eq + 1, semi < 0 ? undefined : semi);
      if (name) jar.set(name, val);
    }
    await res.body?.cancel();
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, url).toString(); continue; }
    break;
  }
  if (!jar.has("FedAuth")) log.push("WARN FedAuth cookie not issued - subfolder traversal will likely fail.");
  return cookieHeader(jar);
}

async function getJson(url: string, cookie: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "application/json", ...(cookie ? { "Cookie": cookie } : {}) },
  });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status} for ${url.slice(0, 120)}`); }
  return await res.json();
}

// "TOTAL RENCANA PASOKAN BULANAN" row is located by LABEL (col B), never by row
// number -- it sits at row 32/33/34 depending on how many mitra a plant has.
// Column S (idx 18) is the SUM; G..R (idx 6..17) are Jan..Des as a fallback.
function parseProfilPasokan(wb: XLSX.WorkBook): number | null {
  const ws = wb.Sheets["Profil Pasokan"] || wb.Sheets[wb.SheetNames[0]];
  if (!ws) return null;
  const m = _sheetToMatrix(ws);
  for (let r = 0; r < m.length; r++) {
    const row = m[r] || [];
    if (!/^TOTAL RENCANA PASOKAN BULANAN/i.test(_safeStr(row[1]))) continue;
    const s = _safeNum(row[18]);
    if (s > 0) return round2(s);
    let sum = 0;
    for (let c = 6; c <= 17; c++) sum += _safeNum(row[c]);
    return sum > 0 ? round2(sum) : null;
  }
  return null;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHARE_URL = Deno.env.get("KONTRAK_SHARE_URL") || DEFAULT_SHARE_URL;

function restHeaders(extra: Record<string, string> = {}) {
  return {
    "apikey": SERVICE_KEY,
    "Authorization": `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

Deno.serve(async (req: Request) => {
  const log: string[] = [];
  const t0 = Date.now();
  // ?dry=1 -> run the whole pipeline but write nothing.
  let dryRun = false;
  try { dryRun = new URL(req.url).searchParams.get("dry") === "1"; } catch { /* ignore */ }
  const out = (ok: boolean, status = 200) =>
    new Response(JSON.stringify({ ok, dryRun, log, ms: Date.now() - t0 }, null, 2), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const markError = async (why: string) => {
    log.push("FAIL " + why);
    if (!dryRun) {
      await fetch(`${SUPABASE_URL}/rest/v1/kontrak_pasokan?id=eq.1`, {
        method: "PATCH",
        headers: restHeaders({ "Prefer": "return=minimal" }),
        body: JSON.stringify({ last_error: why }),
      }).catch(() => {});
    }
    return out(false);
  };

  try {
    const origin = new URL(SHARE_URL).origin;

    const cookie = await redeemShare(SHARE_URL, log);
    log.push(`Share redeemed · cookies: ${cookie ? cookie.split(";").length : 0}`);

    const rootUrl = `${origin}/_api/v2.0/shares/${shareToken(SHARE_URL.split("?")[0])}/driveItem/children`;
    const root = await getJson(rootUrl, cookie);
    const rootItems: any[] = root.value || [];
    const folders = rootItems.filter((it) => it.folder);
    const driveId = rootItems[0]?.parentReference?.driveId;
    if (!driveId || !folders.length) {
      return await markError(`Share root has no subfolders (items=${rootItems.length}).`);
    }
    log.push(`Root: ${folders.map((f) => `${f.name}(${f.folder.childCount})`).join(", ")}`);

    const files: { name: string; url: string }[] = [];
    for (const f of folders) {
      const kids = await getJson(`${origin}/_api/v2.0/drives/${driveId}/items/${f.id}/children`, cookie);
      for (const it of (kids.value || [])) {
        const dl = it["@content.downloadUrl"];
        if (it.file && dl && /\.xls[xmb]?$/i.test(it.name)) files.push({ name: it.name, url: dl });
      }
    }
    log.push(`Found ${files.length} workbooks`);
    if (!files.length) return await markError("No workbooks found.");

    // Plant roster from dashboard_data -- READ ONLY, only to map file name -> code.
    // Selecting data->plants pulls ~109 KB instead of the whole ~900 KB blob.
    const curRes = await fetch(
      `${SUPABASE_URL}/rest/v1/dashboard_data?id=eq.1&select=plants:data->plants`,
      { headers: restHeaders() },
    );
    if (!curRes.ok) return await markError(`Read dashboard_data: HTTP ${curRes.status}`);
    const curRows = await curRes.json();
    const plants: any[] = (Array.isArray(curRows) && curRows.length && curRows[0].plants) || [];
    if (!plants.length) return await markError("dashboard_data has no plants - cannot map names to codes.");
    const byName = new Map<string, string>();
    for (const p of plants) { if (p.name && p.code) byName.set(nameKey(p.name), p.code); }

    const map: Record<string, number> = {};
    const unmatched: string[] = [];
    const unparsed: string[] = [];
    const CONC = 6;
    for (let i = 0; i < files.length; i += CONC) {
      await Promise.all(files.slice(i, i + CONC).map(async (f) => {
        const code = byName.get(nameKey(plantNameFromFile(f.name)));
        if (!code) { unmatched.push(f.name); return; }
        try {
          const dl = await fetch(f.url, { headers: { "User-Agent": UA, "Cookie": cookie } });
          if (!dl.ok) { await dl.body?.cancel(); unparsed.push(`${f.name} (HTTP ${dl.status})`); return; }
          const buf = new Uint8Array(await dl.arrayBuffer());
          const wb = XLSX.read(buf, {
            type: "array",
            cellDates: false, cellFormula: false, cellHTML: false, cellStyles: false, cellNF: false,
            dense: true,
          });
          const val = parseProfilPasokan(wb);
          if (val === null) { unparsed.push(f.name); return; }
          map[code] = val;
        } catch (e) {
          unparsed.push(`${f.name} (${e instanceof Error ? e.message : String(e)})`);
        }
      }));
    }
    const n = Object.keys(map).length;
    log.push(`Parsed ${n} plants · skipped ${unmatched.length} unmatched · ${unparsed.length} failed`);
    if (unmatched.length) log.push(`  unmatched: ${unmatched.join(", ")}`);
    if (unparsed.length) log.push(`  failed: ${unparsed.join(", ")}`);

    if (n < MIN_PLANTS) {
      return await markError(`Only ${n} plants parsed (min ${MIN_PLANTS}) - refusing to overwrite.`);
    }

    if (dryRun) {
      const codes = Object.keys(map).sort();
      log.push(`DRY RUN - no write performed. ${n} PLTU:`);
      for (const c of codes) log.push(`  ${c} = ${map[c]}`);
      return out(true);
    }

    // EGRESS GUARD - a write broadcasts the row over Realtime, so skip when identical.
    const prevRes = await fetch(`${SUPABASE_URL}/rest/v1/kontrak_pasokan?id=eq.1&select=data`, {
      headers: restHeaders(),
    });
    const prevRows = prevRes.ok ? await prevRes.json() : [];
    const prev = (Array.isArray(prevRows) && prevRows.length) ? (prevRows[0].data || {}) : {};
    if (stableStringify(map) === stableStringify(prev)) {
      log.push(`No change vs stored kontrak map - skipped write (saves egress). ${n} PLTU`);
      await fetch(`${SUPABASE_URL}/rest/v1/kontrak_pasokan?id=eq.1`, {
        method: "PATCH",
        headers: restHeaders({ "Prefer": "return=minimal" }),
        body: JSON.stringify({ last_ok_at: new Date().toISOString(), last_error: null }),
      });
      return out(true);
    }

    // Write to its own table. dashboard_data is never touched.
    const upRes = await fetch(`${SUPABASE_URL}/rest/v1/kontrak_pasokan?on_conflict=id`, {
      method: "POST",
      headers: restHeaders({ "Prefer": "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        id: 1,
        data: map,
        n_pltu: n,
        source_url: SHARE_URL.split("?")[0],
        last_ok_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!upRes.ok) {
      return await markError(`Upsert kontrak_pasokan: HTTP ${upRes.status} ${await upRes.text()}`);
    }
    log.push(`OK kontrak_pasokan.data updated · ${n} PLTU`);
    return out(true);
  } catch (e) {
    return await markError("Exception: " + ((e as Error)?.message || String(e)));
  }
});
