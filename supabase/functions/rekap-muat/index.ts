// rekap-muat
// Reads the truck weighing log of a production facility and returns daily
// sums per month. Tasikmalaya: sheet "Rekap Muat", product (col N), limbah
// (col O), netto (col P = N + O); V196: + right block "Pengiriman PLTU" (date R,
// truck plate S, Netto Mix T) as months[k].mix. Ciamis (V178): sheet "Tally
// Harian", kotor (J), tara (L), netto (N); V191: + right block "Pengiriman ke PLTU" (date Q,
// truck plate R, Netto Mix T) returned as months[k].mix. Used by the Fasilitas
// Produksi tab to fill the current month of "Volume Terpasok" until Kontrak
// Auto Refresh has a value (V177).
//
// The spreadsheet ID lives in table `checkpoint_source` (RLS on, no policy ->
// service role only) under src = SITES[site].src. It is NOT in index.html
// because the repo is public, and the sheet holds truck plates and staff
// names. Only daily aggregates leave this function.
//
// Query/body: site=TSM|CMS -> { ok, fields, months: { "2026-10": { days:[...], total, mix? } } }
//
// Both sheets: one block per month. Weighing cells are stored in kg, so values
// >= 100 are divided by 1000. Columns are located by header text (the
// Tasikmalaya June block has a different layout); fixed columns are the fallback.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as XLSX from "npm:xlsx@0.18.5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// site code (client) -> checkpoint_source.src, sheet name, layout and the
// weight fields returned per day (netto feeds Real).
type Field = { key: string; label: string };
type Site = { src: string; sheet: string; layout: "rekap" | "tally"; fields: Field[] };
const SITES: Record<string, Site> = {
  TSM: {
    src: "REKAP_MUAT_TSM", sheet: "Rekap Muat", layout: "rekap",
    fields: [{ key: "product", label: "Product" }, { key: "limbah", label: "Limbah" }, { key: "netto", label: "Netto" }],
  },
  // V178: Ciamis — sheet "Tally Harian", left block (Netto Produk).
  // V191: only Netto shown ("Vol Produksi"); right block comes back as `mix`.
  CMS: {
    src: "REKAP_MUAT_CMS", sheet: "Tally Harian", layout: "tally",
    fields: [{ key: "netto", label: "Vol Produksi" }],
  },
};

const COL_N = 13, COL_O = 14, COL_P = 15;

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, JANUARI: 1, JANUARY: 1, FEB: 2, FEBRUARI: 2, FEBRUARY: 2, MAR: 3, MARET: 3, MARCH: 3,
  APR: 4, APRIL: 4, MEI: 5, MAY: 5, JUN: 6, JUNI: 6, JUNE: 6, JUL: 7, JULI: 7, JULY: 7,
  AGU: 8, AGT: 8, AGS: 8, AGUSTUS: 8, AUG: 8, AUGUST: 8, SEP: 9, SEPT: 9, SEPTEMBER: 9,
  OKT: 10, OKTOBER: 10, OCT: 10, OCTOBER: 10, NOV: 11, NOVEMBER: 11,
  DES: 12, DESEMBER: 12, DEC: 12, DECEMBER: 12,
};

const txt = (v: unknown) => (v === null || v === undefined ? "" : String(v)).trim();

// Number from a cell: numeric as-is, strings in Indonesian format ("7,940",
// "1.013,22"). Returns ton (kg values are scaled down).
function ton(v: unknown): number {
  let n: number;
  if (typeof v === "number") n = v;
  else {
    let s = txt(v).replace(/\s/g, "");
    if (!s || s === "-") return 0;
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(",", ".");
    n = Number(s);
  }
  if (!isFinite(n) || n <= 0) return 0;
  return n >= 100 ? n / 1000 : n;
}

// "01 Oktober 2026", " 22 JUNI 2026", or a Date cell -> { y, m, d }.
function parseDate(v: unknown): { y: number; m: number; d: number } | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    // +12h: SheetJS date cells can land a few seconds before midnight.
    const t = new Date(v.getTime() + 12 * 3600e3);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  const num = txt(v).match(/^(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{4})/); // "02.10.2026", "21/09/2026"
  if (num) {
    const d = Number(num[1]), mo = Number(num[2]);
    return d >= 1 && d <= 31 && mo >= 1 && mo <= 12 ? { y: Number(num[3]), m: mo, d } : null;
  }
  const m = txt(v).toUpperCase().match(/^(\d{1,2})[\s\-\/]+([A-Z]+)[\s\-\/]+(\d{4})/);
  if (!m) return null;
  const mon = MONTH_NAMES[m[2]];
  const d = Number(m[1]), y = Number(m[3]);
  if (!mon || !(d >= 1 && d <= 31)) return null;
  return { y, m: mon, d };
}

type Rec = { y: number; m: number; d: number; v: Record<string, number> };
type Day = { d: number; truk: number; [k: string]: number };

const findCol = (rw: unknown[], re: RegExp, last = true) => {
  let at = -1;
  rw.forEach((c, i) => { if (re.test(txt(c)) && (last || at < 0)) at = i; });
  return at;
};
// Day cell -> date, with month/year taken from the block when known.
function dayOf(cell: unknown, block: { y: number; m: number } | null) {
  const c = parseDate(cell);
  if (!c) return null;
  const dt = block ? { y: block.y, m: block.m, d: c.d } : c;
  return dt.d > new Date(Date.UTC(dt.y, dt.m, 0)).getUTCDate() ? null : dt;
}

// Shipment date: the cell's own month when it is the block month or the next
// (a truck loaded on the 31st ships on the 1st), else the block decides.
function shipDayOf(cell: unknown, block: { y: number; m: number } | null) {
  const c = parseDate(cell);
  if (!c || !block) return c ? dayOf(cell, block) : null;
  const nx = block.m === 12 ? { y: block.y + 1, m: 1 } : { y: block.y, m: block.m + 1 };
  return (c.y === block.y && c.m === block.m) || (c.y === nx.y && c.m === nx.m) ? c : dayOf(cell, block);
}

// Tasikmalaya "Rekap Muat": blocks start with "DATE OF WEIGHING", header row
// "No." + sub-header (Product / Limbah). Values in kg.
// V196: right block "Pengiriman PLTU" (date R, truck plate S, Netto Mix T) from
// the October block on -> `mix`. Only read when its headers are present: older
// blocks use column T for "% Produk".
function rowsRekap(rows: unknown[][]): { prod: Rec[]; mix: Rec[] } {
  const out: Rec[] = [], mix: Rec[] = [];
  let cols = { n: COL_N, o: COL_O, p: COL_P, q: -1, r: -1, x: -1 };
  let block: { y: number; m: number } | null = null;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const a = txt(row[0]).toUpperCase();
    if (a.startsWith("DATE OF WEIGHING")) {
      // "JULY 01-31, 2026" -> month/year of this block. Day cells inside a
      // block carry typos ("27 JUNI 2026", "24 JULI 2027" in the July block),
      // so the block decides the month and the cell only gives the day.
      const h = row.slice(1).map(txt).find((s) => /\d{4}/.test(s)) || "";
      const mon = MONTH_NAMES[(h.toUpperCase().match(/[A-Z]+/) || [""])[0]];
      const yr = Number((h.match(/(\d{4})/) || [])[1]);
      block = mon && yr ? { y: yr, m: mon } : null;
      continue;
    }
    if (a === "NO." || a === "NO") {
      const sub = rows[r + 1] || [];
      const p = findCol(row, /^netto/i), n = findCol(sub, /^product/i), o = findCol(sub, /^limbah/i);
      const pp = p >= 0 ? p : COL_P;
      const after = (re: RegExp) => row.findIndex((c, j) => j > pp && re.test(txt(c)));
      const q = after(/^tanggal/i), rr = after(/polisi/i), x = after(/^berat netto mix/i);
      const hasMix = q >= 0 && x >= 0;
      cols = { n: n >= 0 ? n : COL_N, o: o >= 0 ? o : COL_O, p: pp, q: hasMix ? q : -1, r: hasMix ? rr : -1, x: hasMix ? x : -1 };
      r++;
      continue;
    }
    const dt = dayOf(row[1], block);
    if (dt) {
      const product = ton(row[cols.n]), limbah = ton(row[cols.o]);
      const netto = ton(row[cols.p]) || product + limbah;
      if (netto) out.push({ ...dt, v: { product, limbah, netto } });
    }
    if (cols.q >= 0) {
      const dq = shipDayOf(row[cols.q], block);
      if (dq) {
        const m = ton(row[cols.x]);
        if (m || (cols.r >= 0 && txt(row[cols.r]))) mix.push({ ...dq, v: { mix: m } });
      }
    }
  }
  return { prod: out, mix };
}

// Ciamis "Tally Harian": blocks start with "Bulan Oktober 2026" in col B,
// header row "No" with Berat Kotor / Tara / Netto (kg). The same headers repeat
// in the right-hand "Pengiriman ke PLTU" block, so take the FIRST match (J/L/N).
// V191: right block — date Q, truck plate R (one row = one truck), Netto Mix T.
const MIX_FIELDS: Field[] = [{ key: "mix", label: "Vol Mixed Aren" }];
function rowsTally(rows: unknown[][]): { prod: Rec[]; mix: Rec[] } {
  const out: Rec[] = [], mix: Rec[] = [];
  let cols = { k: 9, t: 11, n: 13, q: 16, r: 17, x: 19 };
  let block: { y: number; m: number } | null = null;
  for (const row of rows) {
    if (!row) continue;
    const b = txt(row[1]).match(/^bulan\s+([a-z]+)\s+(\d{4})/i);
    if (b) {
      const mon = MONTH_NAMES[b[1].toUpperCase()];
      block = mon ? { y: Number(b[2]), m: mon } : null;
      continue;
    }
    if (txt(row[0]).toUpperCase().replace(".", "") === "NO") {
      const k = findCol(row, /^berat kotor/i, false), t = findCol(row, /^berat kosong|tara/i, false), n = findCol(row, /^berat netto/i, false);
      // Right block: header cells after the left block (col > Netto Produk).
      const after = (re: RegExp) => row.findIndex((c, j) => j > (n >= 0 ? n : 13) && re.test(txt(c)));
      const q = after(/^tanggal/i), rr = after(/polisi/i), x = after(/^berat netto mix/i);
      cols = { k: k >= 0 ? k : 9, t: t >= 0 ? t : 11, n: n >= 0 ? n : 13, q: q >= 0 ? q : 16, r: rr >= 0 ? rr : 17, x: x >= 0 ? x : 19 };
      continue;
    }
    const dt = dayOf(row[1], block);
    if (dt) {
      const kotor = ton(row[cols.k]), tara = ton(row[cols.t]);
      const netto = ton(row[cols.n]) || Math.max(0, kotor - tara);
      if (netto) out.push({ ...dt, v: { kotor, tara, netto } });
    }
    const dq = dayOf(row[cols.q], block);
    if (dq) {
      const m = ton(row[cols.x]);
      if (m || txt(row[cols.r])) mix.push({ ...dq, v: { mix: m } });
    }
  }
  return { prod: out, mix };
}

function aggregate(recs: Rec[], fields: Field[]) {
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const byMonth = new Map<string, Map<number, Day>>();
  for (const rc of recs) {
    const key = rc.y + "-" + String(rc.m).padStart(2, "0");
    if (!byMonth.has(key)) byMonth.set(key, new Map());
    const days = byMonth.get(key)!;
    const cur = days.get(rc.d) || { d: rc.d, truk: 0 };
    cur.truk += 1;
    for (const f of fields) cur[f.key] = (cur[f.key] || 0) + (rc.v[f.key] || 0);
    days.set(rc.d, cur);
  }
  const months: Record<string, { days: Day[]; total: Record<string, number> }> = {};
  for (const [k, days] of [...byMonth.entries()].sort()) {
    const list = [...days.values()].sort((a, b) => a.d - b.d);
    const total: Record<string, number> = { truk: 0 };
    for (const x of list) {
      total.truk += x.truk;
      for (const f of fields) { x[f.key] = r3(x[f.key] || 0); total[f.key] = (total[f.key] || 0) + x[f.key]; }
    }
    for (const f of fields) total[f.key] = r3(total[f.key] || 0);
    months[k] = { days: list, total };
  }
  return months;
}

function restHeaders() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
}
async function sheetId(src: string): Promise<string | null> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/checkpoint_source?select=sheet_id&src=eq.${encodeURIComponent(src)}`, { headers: restHeaders() });
  if (!r.ok) throw new Error(`checkpoint_source: HTTP ${r.status}`);
  const rows = await r.json() as { sheet_id: string }[];
  return rows[0]?.sheet_id || null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const t0 = Date.now();
  try {
    const u = new URL(req.url);
    let p: Record<string, unknown> = Object.fromEntries(u.searchParams);
    if (req.method === "POST") { try { p = { ...p, ...(await req.json()) }; } catch { /* no body */ } }
    const site = txt(p.site).toUpperCase();
    const cfg = SITES[site];
    if (!cfg) return json({ ok: false, error: `Site ${site} tidak dikenal.` }, 400);
    const sid = await sheetId(cfg.src);
    if (!sid) return json({ ok: false, error: `Sumber ${cfg.src} belum diisi di checkpoint_source.` }, 500);

    const xr = await fetch(`https://docs.google.com/spreadsheets/d/${sid}/export?format=xlsx`);
    if (!xr.ok) return json({ ok: false, error: `Export sheet: HTTP ${xr.status}` }, 502);
    const wb = XLSX.read(new Uint8Array(await xr.arrayBuffer()), { type: "array", cellDates: true, cellFormula: false, cellHTML: false, cellStyles: false });
    const name = wb.SheetNames.find((n) => n.trim().toLowerCase() === cfg.sheet.toLowerCase());
    if (!name) return json({ ok: false, error: `Sheet "${cfg.sheet}" tidak ditemukan. Sheet yang ada: ${wb.SheetNames.join(", ")}` }, 404);
    // Anchor at A1 so row[13] is always column N, whatever the sheet's used range.
    const ws = wb.Sheets[name];
    if (ws["!ref"]) { const rg = XLSX.utils.decode_range(ws["!ref"]); rg.s.r = 0; rg.s.c = 0; ws["!ref"] = XLSX.utils.encode_range(rg); }
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][];
    // V196: both layouts carry a right-hand shipment block -> months[k].mix.
    const t = cfg.layout === "tally" ? rowsTally(rows) : rowsRekap(rows);
    const months = aggregate(t.prod, cfg.fields) as Record<string, { days: Day[]; total: Record<string, number>; mix?: unknown }>;
    for (const [k, mo] of Object.entries(aggregate(t.mix, MIX_FIELDS))) {
      (months[k] ||= { days: [], total: { truk: 0 } }).mix = mo;
    }
    return json({ ok: true, site, sheet: name, fields: cfg.fields, fetched_at: new Date().toISOString(), months, ms: Date.now() - t0 });
  } catch (e) {
    return json({ ok: false, error: (e as Error)?.message || String(e) }, 500);
  }
});
