// rekap-muat
// Reads the "Rekap Muat" sheet (truck weighing log) of a production facility
// and returns daily sums per month: product (col N), limbah (col O) and netto
// (col P = N + O). Used by the Fasilitas Produksi tab to fill the current
// month of "Volume Terpasok" until Kontrak Auto Refresh has a value (V177).
//
// The spreadsheet ID lives in table `checkpoint_source` (RLS on, no policy ->
// service role only) under src = SITES[site].src. It is NOT in index.html
// because the repo is public, and the sheet holds truck plates and staff
// names. Only daily aggregates leave this function.
//
// Query/body: site=TSM   -> { ok, months: { "2026-10": { days:[...], total } } }
//
// Sheet layout: one block per month, each with "DATE OF WEIGHING" and a header
// row starting with "No.". Weighing cells are stored in kg (formatted as ton),
// so values >= 100 are divided by 1000. Columns are located by header text
// ("Product", "Limbah", "Netto") because the June block has a different layout;
// N/O/P is the fallback.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as XLSX from "npm:xlsx@0.18.5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// site code (client) -> checkpoint_source.src + sheet name in that workbook.
const SITES: Record<string, { src: string; sheet: string }> = {
  TSM: { src: "REKAP_MUAT_TSM", sheet: "Rekap Muat" },
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
  const m = txt(v).toUpperCase().match(/^(\d{1,2})[\s\-\/]+([A-Z]+)[\s\-\/]+(\d{4})/);
  if (!m) return null;
  const mon = MONTH_NAMES[m[2]];
  const d = Number(m[1]), y = Number(m[3]);
  if (!mon || !(d >= 1 && d <= 31)) return null;
  return { y, m: mon, d };
}

type Day = { d: number; truk: number; product: number; limbah: number; netto: number };

function parse(rows: unknown[][]) {
  const byMonth = new Map<string, Map<number, Day>>();
  let cols = { n: COL_N, o: COL_O, p: COL_P };
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
      // Header row (Netto) + sub-header row below it (Product / Limbah).
      const sub = rows[r + 1] || [];
      const find = (rw: unknown[], re: RegExp) => {
        let at = -1;
        rw.forEach((c, i) => { if (re.test(txt(c))) at = i; });
        return at;
      };
      const p = find(row, /^netto/i), n = find(sub, /^product/i), o = find(sub, /^limbah/i);
      cols = { n: n >= 0 ? n : COL_N, o: o >= 0 ? o : COL_O, p: p >= 0 ? p : COL_P };
      r++;
      continue;
    }
    const cell = parseDate(row[1]);
    if (!cell) continue;
    const dt = block ? { y: block.y, m: block.m, d: cell.d } : cell;
    if (dt.d > new Date(Date.UTC(dt.y, dt.m, 0)).getUTCDate()) continue;
    const product = ton(row[cols.n]), limbah = ton(row[cols.o]);
    let netto = ton(row[cols.p]);
    if (!netto) netto = product + limbah;
    if (!netto) continue;
    const key = dt.y + "-" + String(dt.m).padStart(2, "0");
    if (!byMonth.has(key)) byMonth.set(key, new Map());
    const days = byMonth.get(key)!;
    const cur = days.get(dt.d) || { d: dt.d, truk: 0, product: 0, limbah: 0, netto: 0 };
    cur.truk += 1;
    cur.product += product;
    cur.limbah += limbah;
    cur.netto += netto;
    days.set(dt.d, cur);
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const months: Record<string, { days: Day[]; total: Omit<Day, "d"> }> = {};
  for (const [k, days] of [...byMonth.entries()].sort()) {
    const list = [...days.values()].sort((a, b) => a.d - b.d)
      .map((x) => ({ d: x.d, truk: x.truk, product: r3(x.product), limbah: r3(x.limbah), netto: r3(x.netto) }));
    const total = list.reduce((t, x) => ({
      truk: t.truk + x.truk, product: t.product + x.product, limbah: t.limbah + x.limbah, netto: t.netto + x.netto,
    }), { truk: 0, product: 0, limbah: 0, netto: 0 });
    months[k] = { days: list, total: { truk: total.truk, product: r3(total.product), limbah: r3(total.limbah), netto: r3(total.netto) } };
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
    return json({ ok: true, site, sheet: name, fetched_at: new Date().toISOString(), months: parse(rows), ms: Date.now() - t0 });
  } catch (e) {
    return json({ ok: false, error: (e as Error)?.message || String(e) }, 500);
  }
});
