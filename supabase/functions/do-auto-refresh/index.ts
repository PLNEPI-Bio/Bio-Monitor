// do-auto-refresh
// Scheduled (pg_cron, weekly) Edge Function that downloads the "Monitoring DO"
// (Delivery Order) Excel from a public SharePoint link, aggregates every DO row
// into a per-contract monthly map, and stores it in public.do_data (row id=1,
// column `auto`) — the client merges this with manual `overrides` at render time.
//
// Source workbook layout (per year sheet "2024" / "2025" / "2026"): one row per
// Delivery Order. Header row 0. Relevant columns (matched by header label, so a
// column insert/reorder won't silently break parsing):
//   "Nomor Kontrak" · "PLTU" · "Pemasok" · "Awal Pengiriman" (date serial) ·
//   "Bulan Rakor" (month name) · "Vol (MT)" · "Tanggal DO" (date serial).
// A DO is attributed to the month AND year of "Awal Pengiriman" (delivery start),
// falling back to "Bulan Rakor" + the sheet year, then to "Tanggal DO". This
// matches the previous hardcoded snapshot and handles year rollover: a DO issued
// in Dec (living in that year's sheet) whose delivery starts in January belongs
// to January of the NEXT year — e.g. contract 647.PJ/061/IP/2022 · Labuan ·
// Artha Daya Coalindo, 428 MT in the "2025" sheet with delivery starting Jan
// 2026 → 2026[Jan]=428 (not 2025[Jan]).
//
// Map key (signature) is IDENTICAL to the client's doSigForContract():
//   _doNormK(kontrak) + '|' + _doLoose(pltu) + '|' + _doLoose(pemasok)
//
// Safety: manual `overrides` are NEVER touched here. If the download fails, returns
// an HTML login page, or the parse yields zero contracts, `auto` is left intact and
// the function marks link_status='dead' (so the client can warn the admin).
//
// Auth model: invoked with the project's anon key (cron); writes with service-role.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as XLSX from "npm:xlsx@0.18.5";

// Public "anyone with the link" SharePoint share for the DO workbook. The reliable
// anonymous direct-download form is `_layouts/15/download.aspx?share=<token>`.
// Overridable via env so the link can be rotated without a redeploy.
const DEFAULT_DO_URL =
  "https://plnbatubaracoid-my.sharepoint.com/personal/ardan_saputro_plnepi_co_id/_layouts/15/download.aspx?share=IQCuSKUHhTsFRIHVJfhvFc_dAfMvINWLlcquvoMdwnJ-TOo";

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
// Contract-signature normalizers — MUST mirror index.html exactly.
function _doNormK(s: unknown): string { return String(s || "").toUpperCase().replace(/\s+/g, ""); }
function _doLoose(s: unknown): string { return String(s || "").toUpperCase().replace(/[ \-–—‑'’.()]/g, ""); }
function doSig(kontrak: unknown, pltu: unknown, pemasok: unknown): string {
  return _doNormK(kontrak) + "|" + _doLoose(pltu) + "|" + _doLoose(pemasok);
}
function stableStringify(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

const ID_MONTHS: Record<string, number> = {
  januari: 0, februari: 1, pebruari: 1, maret: 2, april: 3, mei: 4, juni: 5,
  juli: 6, agustus: 7, agus: 7, september: 8, oktober: 9, november: 10,
  nopember: 10, desember: 11,
};
function monthFromName(v: unknown): number {
  const s = _safeStr(v).toLowerCase();
  if (!s) return -1;
  if (s in ID_MONTHS) return ID_MONTHS[s];
  for (const k of Object.keys(ID_MONTHS)) { if (s.startsWith(k)) return ID_MONTHS[k]; }
  return -1;
}
// Excel serial date (1900 system) → { year, month 0..11 } or null. Serials below
// ~36526 (year 2000) are treated as junk.
function ymFromSerial(v: unknown): { year: number; month: number } | null {
  const n = _safeNum(v);
  if (!n || n < 36526) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
  const y = d.getUTCFullYear();
  if (y < 2000 || y > 2100) return null;
  return { year: y, month: d.getUTCMonth() };
}
function round2(n: number): number { return Math.round(n * 100) / 100; }

// ---------------- DO parser ----------------
// Returns { map: { sig: { "2024":[12], ... } }, rows, contracts, perYear }.
function parseDoExcel(wb: XLSX.WorkBook) {
  const map: Record<string, Record<string, number[]>> = {};
  let rowsUsed = 0;
  const perYear: Record<string, number> = {};

  const yearSheets = wb.SheetNames.filter((n) => /^\d{4}$/.test(String(n).trim()));
  for (const sheetName of yearSheets) {
    const year = String(sheetName).trim();
    const m = _sheetToMatrix(wb.Sheets[sheetName]);
    if (!m.length) continue;

    // Locate the header row (within the first 6 rows) and resolve columns by label.
    let headerRow = -1, col: Record<string, number> = {};
    for (let r = 0; r < Math.min(6, m.length); r++) {
      const row = m[r] || [];
      const idx: Record<string, number> = {};
      for (let c = 0; c < row.length; c++) {
        const h = _safeStr(row[c]).toLowerCase();
        if (!h) continue;
        if (idx.kontrak === undefined && h.includes("nomor kontrak")) idx.kontrak = c;
        else if (idx.pltu === undefined && h === "pltu") idx.pltu = c;
        else if (idx.pemasok === undefined && h === "pemasok") idx.pemasok = c;
        else if (idx.awal === undefined && h.includes("awal pengiriman")) idx.awal = c;
        else if (idx.bulan === undefined && h.includes("bulan rakor")) idx.bulan = c;
        else if (idx.vol === undefined && h.includes("vol")) idx.vol = c;
        else if (idx.tgldo === undefined && h.includes("tanggal do")) idx.tgldo = c;
      }
      if (idx.kontrak !== undefined && idx.pltu !== undefined && idx.pemasok !== undefined && idx.vol !== undefined) {
        headerRow = r; col = idx; break;
      }
    }
    if (headerRow < 0) continue;

    for (let r = headerRow + 1; r < m.length; r++) {
      const row = m[r] || [];
      const kontrak = _safeStr(row[col.kontrak]);
      const pltu = _safeStr(row[col.pltu]);
      const pemasok = _safeStr(row[col.pemasok]);
      if (!kontrak || !pltu || !pemasok) continue;
      const vol = _safeNum(row[col.vol]);
      if (!(vol > 0)) continue;
      // Month + year attribution: Awal Pengiriman date → Bulan Rakor + sheet
      // year → Tanggal DO date. Sanity guard: an Awal year further than ±1 from
      // the sheet year is a source typo (e.g. "2004" in the 2024 sheet) — ignore
      // it and fall through to Bulan Rakor.
      let yKey = "", mi = -1;
      const awal = (col.awal !== undefined) ? ymFromSerial(row[col.awal]) : null;
      if (awal && Math.abs(awal.year - Number(year)) <= 1) { yKey = String(awal.year); mi = awal.month; }
      if (mi < 0 && col.bulan !== undefined) {
        const bm = monthFromName(row[col.bulan]);
        if (bm >= 0) { yKey = year; mi = bm; }
      }
      if (mi < 0 && col.tgldo !== undefined) {
        const td = ymFromSerial(row[col.tgldo]);
        if (td) { yKey = String(td.year); mi = td.month; }
      }
      if (mi < 0 || !yKey) continue;
      const sig = doSig(kontrak, pltu, pemasok);
      if (!map[sig]) map[sig] = {};
      if (!map[sig][yKey]) map[sig][yKey] = new Array(12).fill(0);
      map[sig][yKey][mi] += vol;
      rowsUsed++;
      perYear[yKey] = (perYear[yKey] || 0) + vol;
    }
  }

  // Round accumulated sums to tame float noise.
  for (const sig of Object.keys(map)) {
    for (const y of Object.keys(map[sig])) {
      map[sig][y] = map[sig][y].map(round2);
    }
  }
  for (const y of Object.keys(perYear)) perYear[y] = round2(perYear[y]);

  return { map, rows: rowsUsed, contracts: Object.keys(map).length, perYear, yearSheets };
}

// ---------------- main handler ----------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DO_URL = Deno.env.get("DO_SHAREPOINT_DOWNLOAD_URL") || DEFAULT_DO_URL;

function restHeaders(extra: Record<string, string> = {}) {
  return {
    "apikey": SERVICE_KEY,
    "Authorization": `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

// PATCH only the given columns of do_data id=1 (never rewrites auto/overrides
// unless included). Best-effort; logs the HTTP status.
async function patchRow(fields: Record<string, unknown>, log: string[]) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/do_data?id=eq.1`, {
    method: "PATCH",
    headers: restHeaders({ "Prefer": "return=minimal" }),
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) log.push(`⚠ PATCH failed: HTTP ${res.status} ${await res.text()}`);
  return res.ok;
}

Deno.serve(async (_req: Request) => {
  const log: string[] = [];
  const t0 = Date.now();
  const out = (ok: boolean, status = 200) =>
    new Response(JSON.stringify({ ok, log, ms: Date.now() - t0 }, null, 2), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  // Record a failure without ever touching auto/overrides.
  const markDead = async (why: string) => {
    log.push("✗ " + why);
    await patchRow({ link_status: "dead", last_error: why, last_error_at: new Date().toISOString(), source_url: DO_URL }, log);
    return out(false, 200);
  };

  try {
    // 1) Download the DO Excel from SharePoint
    log.push(`Downloading: ${DO_URL}`);
    let dl: Response;
    try {
      dl = await fetch(DO_URL, {
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*",
        },
      });
    } catch (e) {
      return await markDead(`Download error: ${e instanceof Error ? e.message : String(e)}`);
    }
    const ct = (dl.headers.get("content-type") || "").toLowerCase();
    log.push(`HTTP ${dl.status} ${dl.statusText} · content-type: ${ct || "?"}`);
    if (!dl.ok) return await markDead(`Download failed (HTTP ${dl.status}). Link may be removed or access revoked.`);
    if (ct.includes("text/html")) return await markDead("Got an HTML page (SharePoint login/permission page). Link must be 'Anyone with the link'.");
    const buf = new Uint8Array(await dl.arrayBuffer());
    log.push(`Downloaded ${(buf.length / 1024).toFixed(0)} KB`);

    // 2) Parse (only the year sheets are needed; skip cell metadata to save memory)
    const wb = XLSX.read(buf, {
      type: "array",
      cellDates: false, cellFormula: false, cellHTML: false, cellStyles: false, cellNF: false,
      dense: true,
    });
    log.push(`Workbook sheets: [${wb.SheetNames.join(", ")}]`);
    const parsed = parseDoExcel(wb);
    log.push(`Parsed: ${parsed.contracts} contracts from ${parsed.rows} DO rows · sheets [${parsed.yearSheets.join(", ")}] · per-year ${JSON.stringify(parsed.perYear)}`);

    // SAFETY: never overwrite with an empty parse
    if (!parsed.contracts) return await markDead("Parsed 0 contracts — refusing to overwrite. Existing DO preserved.");

    // 3) Read current auto for the egress/no-op comparison
    const curRes = await fetch(`${SUPABASE_URL}/rest/v1/do_data?id=eq.1&select=auto`, { headers: restHeaders() });
    const curRows = curRes.ok ? await curRes.json() : [];
    const existingAuto = (Array.isArray(curRows) && curRows.length) ? (curRows[0].auto || {}) : {};

    const nowIso = new Date().toISOString();
    if (stableStringify(parsed.map) === stableStringify(existingAuto)) {
      log.push("↔ No change vs stored auto — only refreshing status/timestamp.");
      await patchRow({ link_status: "ok", last_ok_at: nowIso, last_error: null, source_url: DO_URL }, log);
      return out(true);
    }

    // 4) Write the fresh auto map (overrides untouched)
    await patchRow({ auto: parsed.map, link_status: "ok", last_ok_at: nowIso, last_error: null, source_url: DO_URL }, log);
    log.push(`✓ do_data.auto updated · ${parsed.contracts} contracts`);
    return out(true);
  } catch (e) {
    return await markDead("Exception: " + ((e as Error)?.message || String(e)));
  }
});
