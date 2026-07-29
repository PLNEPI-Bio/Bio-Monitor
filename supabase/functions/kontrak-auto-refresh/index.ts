// kontrak-auto-refresh
// Scheduled (pg_cron) Edge Function that reads the per-PLTU "Profil Pasokan"
// workbooks from a shared SharePoint folder and stores one number per PLTU —
// the total Rencana Pasokan Bulanan for the running year — into
// `dashboard_data` row id=1 under `kontrak_pasokan_2026`.
//
// The map is keyed by plant CODE ({ "LBA": 26495, ... }) and is what the map
// tooltip renders as "Kontrak 2026", and what drives the "!" badge on a plant
// icon (badge shows when Kontrak < Target FGD).
//
// ---------------------------------------------------------------------------
// Source folder layout (anonymous "anyone with the link" share):
//   <share root>/
//     PIP/   28 files  "Profil_Pasokan_<Nama PLTU>_<GENCO>_2026.xlsx"  (PIP+UIW+2 UIK)
//     PNP/   20 files  "<NAMA PLTU>.xlsx"                              (+1 kertas kerja, ignored)
// Two naming conventions, so the plant name is derived from the filename and
// matched loosely (case/punctuation-insensitive) against `plants[].name` that
// is already stored in dashboard_data — a file that matches nothing is skipped.
//
// Inside each workbook, sheet "Profil Pasokan", section "2. RENCANA PASOKAN
// BULANAN — per Mitra": one row per mitra, then a total row labelled
// "TOTAL RENCANA PASOKAN BULANAN" in column B. Columns G..R = Jan..Des, column
// S = the SUM. The total row is NOT at a fixed position (observed at rows 32,
// 33 and 34 depending on how many mitra a plant has), so it is located by its
// LABEL, never by row number. Column S is read first; if it is empty the row's
// G..R are summed as a fallback. Verified across all 48 workbooks: column S
// equals SUM(G:R) in every one.
//
// Note: 3 of the 51 plants have no workbook in the folder (the UIK expansion
// units — Lontar 4, Asam Asam 5-6, Barru 3). They are simply absent from the
// map and the tooltip renders "belum tersedia" for them.
//
// ---------------------------------------------------------------------------
// Access model: the share is an anonymous link. Listing the share ROOT works
// unauthenticated via /_api/v2.0/shares/u!<base64url>/driveItem/children, but
// descending into subfolders does NOT — that needs the `FedAuth` guest cookie
// that SharePoint issues while redeeming the share link. So: redeem the link
// first (following redirects MANUALLY, because a followed redirect hides the
// intermediate Set-Cookie), keep the cookie, then traverse with it.
//
// Safety: reads existing dashboard_data and rewrites it with only
// `kontrak_pasokan_2026` replaced — every other field is passed through
// untouched. A parse yielding too few plants is refused rather than written,
// and an unchanged map skips the write entirely (id=1 writes broadcast the
// whole ~860 KB row over Realtime).
//
// Auth model: invoked with the project's anon key (cron); writes with service-role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as XLSX from "npm:xlsx@0.18.5";

// Anonymous share link for the folder holding the per-PLTU workbooks.
// Overridable via env so it can be rotated without a redeploy.
const DEFAULT_SHARE_URL =
  "https://plnbatubaracoid-my.sharepoint.com/:f:/g/personal/ardan_saputro_plnepi_co_id/IgAkn9cA3bnpSLBva8YQYA-oAWrh0TMlCKPEV2GsYR9M3tY?e=6Fnebf";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Refuse to overwrite if fewer than this many plants parsed — guards against a
// revoked link or a folder reorganisation silently emptying the map.
const MIN_PLANTS = 20;

// ---------------- helpers ----------------
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

// Loose plant-name key: case- and punctuation-insensitive, so "Suralaya 1-7",
// "SURALAYA 1-7" and "Suralaya_1-7" all collapse to the same key.
function nameKey(s: unknown): string {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Filename → plant name. Handles both folder conventions:
//   "Profil_Pasokan_Labuhan_Angin_PIP_2026.xlsx" → "Labuhan Angin"
//   "TANJUNG AWAR-AWAR.xlsx"                     → "TANJUNG AWAR-AWAR"
function plantNameFromFile(fn: string): string {
  let n = fn.replace(/\.xls[xmb]?$/i, "");
  n = n.replace(/^profil[_ ]pasokan[_ ]/i, "");
  n = n.replace(/[_ ](PIP|UIW|PNP|UIK)[_ ]\d{4}$/i, "");
  return n.replace(/_/g, " ").trim();
}

// base64url of the sharing URL, per the /_api/v2.0/shares/u!<token> convention.
function shareToken(url: string): string {
  const b64 = btoa(url);
  return "u!" + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------- SharePoint access ----------------
// Redeem the anonymous share link and return a Cookie header string.
// Redirects are followed MANUALLY: with redirect:"follow" the intermediate
// Set-Cookie (which is where FedAuth is issued) is not observable.
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
    // getSetCookie() memisahkan beberapa Set-Cookie dengan benar; headers.get() akan
    // menggabungkannya jadi satu string. Fallback dipakai kalau runtime belum punya API-nya.
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
  if (!jar.has("FedAuth")) log.push("⚠ FedAuth cookie not issued — subfolder traversal will likely fail.");
  return cookieHeader(jar);
}
function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function getJson(url: string, cookie: string): Promise<any> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "application/json", ...(cookie ? { "Cookie": cookie } : {}) },
  });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status} for ${url.slice(0, 120)}`); }
  return await res.json();
}

// ---------------- workbook parser ----------------
// Returns the "TOTAL RENCANA PASOKAN BULANAN" figure, or null when the section
// or its total row can't be found (never guesses a row number).
function parseProfilPasokan(wb: XLSX.WorkBook): number | null {
  const ws = wb.Sheets["Profil Pasokan"] || wb.Sheets[wb.SheetNames[0]];
  if (!ws) return null;
  const m = _sheetToMatrix(ws);
  for (let r = 0; r < m.length; r++) {
    const row = m[r] || [];
    if (!/^TOTAL RENCANA PASOKAN BULANAN/i.test(_safeStr(row[1]))) continue;
    // Column S (idx 18) holds the SUM; G..R (idx 6..17) are Jan..Des.
    const s = _safeNum(row[18]);
    if (s > 0) return round2(s);
    let sum = 0;
    for (let c = 6; c <= 17; c++) sum += _safeNum(row[c]);
    return sum > 0 ? round2(sum) : null;
  }
  return null;
}

// ---------------- main handler ----------------
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
  // ?dry=1 → jalankan seluruh pipeline (redeem, traversal, unduh, parse) tetapi JANGAN
  // menulis ke dashboard_data. Dipakai untuk memverifikasi hasil parse terhadap produksi
  // tanpa risiko, dan untuk mendiagnosis bila suatu saat cron-nya gagal.
  let dryRun = false;
  try { dryRun = new URL(req.url).searchParams.get("dry") === "1"; } catch { /* ignore */ }
  const out = (ok: boolean, status = 200) =>
    new Response(JSON.stringify({ ok, log, ms: Date.now() - t0 }, null, 2), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const origin = new URL(SHARE_URL).origin;

    // 1) Redeem the share link → guest cookie
    const cookie = await redeemShare(SHARE_URL, log);
    log.push(`Share redeemed · cookies: ${cookie ? cookie.split(";").length : 0}`);

    // 2) List the share root (works even unauthenticated) → subfolders + driveId
    const rootUrl = `${origin}/_api/v2.0/shares/${shareToken(SHARE_URL.split("?")[0])}/driveItem/children`;
    const root = await getJson(rootUrl, cookie);
    const rootItems: any[] = root.value || [];
    const folders = rootItems.filter((it) => it.folder);
    const driveId = rootItems[0]?.parentReference?.driveId;
    if (!driveId || !folders.length) {
      log.push(`✗ Share root has no subfolders (items=${rootItems.length}) — refusing to overwrite.`);
      return out(false);
    }
    log.push(`Root: ${folders.map((f) => `${f.name}(${f.folder.childCount})`).join(", ")}`);

    // 3) Enumerate every file in every subfolder (needs the guest cookie)
    const files: { name: string; url: string }[] = [];
    for (const f of folders) {
      const kids = await getJson(`${origin}/_api/v2.0/drives/${driveId}/items/${f.id}/children`, cookie);
      for (const it of (kids.value || [])) {
        const dl = it["@content.downloadUrl"];
        if (it.file && dl && /\.xls[xmb]?$/i.test(it.name)) files.push({ name: it.name, url: dl });
      }
    }
    log.push(`Found ${files.length} workbooks`);
    if (!files.length) { log.push("✗ No workbooks found — refusing to overwrite."); return out(false); }

    // 4) Read the plant roster already in dashboard_data, to resolve name → code
    const curRes = await fetch(
      `${SUPABASE_URL}/rest/v1/dashboard_data?id=eq.1&select=data,uploaded_by,uploaded_at,source_filename,data_summary`,
      { headers: restHeaders() },
    );
    if (!curRes.ok) { log.push(`✗ Read dashboard_data failed: HTTP ${curRes.status}`); return out(false); }
    const curRows = await curRes.json();
    const currentRow = Array.isArray(curRows) && curRows.length ? curRows[0] : null;
    const existing = (currentRow && currentRow.data) || {};
    const plants: any[] = existing.plants || [];
    if (!plants.length) { log.push("✗ dashboard_data has no plants — cannot map names to codes."); return out(false); }
    const byName = new Map<string, string>();
    for (const p of plants) { if (p.name && p.code) byName.set(nameKey(p.name), p.code); }

    // 5) Download + parse, modest concurrency to stay inside the function's budget
    const map: Record<string, number> = {};
    const unmatched: string[] = [];
    const unparsed: string[] = [];
    const CONC = 6;
    for (let i = 0; i < files.length; i += CONC) {
      await Promise.all(files.slice(i, i + CONC).map(async (f) => {
        const code = byName.get(nameKey(plantNameFromFile(f.name)));
        if (!code) { unmatched.push(f.name); return; }   // e.g. the "Z Kertas Kerja FGD" file
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

    // SAFETY: never overwrite a healthy map with a suspiciously small one
    if (n < MIN_PLANTS) {
      log.push(`✗ Only ${n} plants parsed (min ${MIN_PLANTS}) — refusing to overwrite. Existing data preserved.`);
      return out(false);
    }

    // 5b) DRY RUN — berhenti sebelum menyentuh dashboard_data sama sekali.
    if (dryRun) {
      const codes = Object.keys(map).sort();
      log.push(`DRY RUN — tidak ada penulisan. ${n} PLTU:`);
      for (const c of codes) log.push(`  ${c} = ${map[c]}`);
      return out(true);
    }

    // 6) EGRESS GUARD — id=1 writes broadcast the whole row over Realtime
    if (stableStringify(map) === stableStringify(existing.kontrak_pasokan_2026 || null)) {
      log.push(`↔ No change vs stored kontrak map — skipped write (saves egress). ${n} plants`);
      return out(true);
    }

    // 7) Rewrite id=1 with ONLY kontrak_pasokan_2026 replaced
    const merged = { ...existing, kontrak_pasokan_2026: map };
    const summary = `Kontrak auto-refresh (SharePoint) · ${n} PLTU`;
    const upRes = await fetch(`${SUPABASE_URL}/rest/v1/dashboard_data?on_conflict=id`, {
      method: "POST",
      headers: restHeaders({ "Prefer": "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        id: 1,
        data: merged,
        uploaded_by: currentRow?.uploaded_by || "auto-refresh",
        uploaded_at: new Date().toISOString(),
        source_filename: currentRow?.source_filename || "SharePoint: Profil Pasokan",
        data_summary: currentRow?.data_summary || summary,
      }),
    });
    if (!upRes.ok) {
      log.push(`✗ Upsert failed: HTTP ${upRes.status} ${await upRes.text()}`);
      return out(false);
    }
    log.push(`✓ dashboard_data.kontrak_pasokan_2026 updated · ${summary}`);
    return out(true);
  } catch (e) {
    log.push("✗ Exception: " + ((e as Error)?.message || String(e)));
    return out(false);
  }
});
