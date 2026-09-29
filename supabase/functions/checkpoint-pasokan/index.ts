// checkpoint-pasokan
// Pulls ONE PLTU sheet from the rakor "monitoring pasokan harian" Google Sheets
// (PNP / PIP / DWP), parses every monthly block in it, caches each block into
// `checkpoint_pasokan` (code, year, month) and returns the requested month.
//
// Called by the client (Checkpoint page) once per PLTU, a few in parallel. One
// sheet per invocation keeps CPU per request small: the whole PNP workbook is
// ~20 MB (mostly images) and parsing several sheets in one worker risks
// WORKER_RESOURCE_LIMIT (kontrak-auto-refresh has hit it before).
//
// The three spreadsheet IDs live in table `checkpoint_source` (RLS on, no
// policy -> service role only). They are NOT in index.html because the repo is
// public.
//
// Query/body: code=<plant code>&year=2026&month=10   [&dry=1 -> no cache write]
//             list=1 -> diagnostics: sheets found per source + mapping status.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as XLSX from "npm:xlsx@0.18.5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Sheet name (normalised: A-Z0-9 only) -> dashboard plant code, per source.
// A renamed sheet shows up as "unmapped" in ?list=1; add the new key here.
const SHEET_MAP: Record<string, Record<string, string>> = {
  DWP: {
    SUGE: "SGE", AIRANYIR: "ANY", ROPA: "RPA", BOLOK: "BLK", SUMBAWA: "SBW",
    JERANJANG: "JRJ", HOLTEKAMP: "HTK", TIDORE: "TDR", MALINAU: "MLN",
    TJJATIB: "TJB", NIITANASA3: "UPKD EXT", ASAMASAM56: "ASM EXT",
    LONTAR4: "BLT EXT", BARRU3: "BRU EXT",
  },
  PIP: {
    SRLYA17: "SLA 1-7", SRLYA8: "SLA 8", LONTAR: "BLT", LABUAN: "BLB",
    ADIPALA: "ADP", PELRATU: "JPR", TLKSRH: "TIR", LBANGN: "LBA",
    TJBLAIKRMN: "TBK", PANGSU: "PNS", OMBILIN: "OMB", SINTANG: "STG",
    SANGGAU: "SGU", ASAM2: "ASM", BERAU: "BEU", BENGKAYANG: "BKY", BARRU: "BRU",
  },
  PNP: {
    INDRAMAYU: "UPID", REMBANG: "UPRB", PAITON12: "UPTN 1-2", PAITON9: "UPTN 9",
    PACITAN: "UPCT", NIITANASA: "UPKD", ANGGREK: "UPGT", AMPANA: "UPMN",
    PUNAGAYA: "UPPY", TJAWAR: "UPTA", BUKITASAM: "UPBA", TARAHAN: "UPTH",
    SEBALANG: "UPSB", AMURANG: "UPMH", TEMBILAHAN: "UPTBH", NAGANRAYA: "UPNR",
    TENAYAN: "UPTY", PULPIS: "UPPS", TELUKBALIKPAPAN: "UPKT", KETAPANG: "UPKS",
  },
};

const MONTHS: Record<string, number> = {
  JANUARI: 1, JANUARY: 1, FEBRUARI: 2, FEBRUARY: 2, MARET: 3, MARCH: 3, APRIL: 4,
  MEI: 5, MAY: 5, JUNI: 6, JUNE: 6, JULI: 7, JULY: 7, AGUSTUS: 8, AUGUST: 8,
  SEPTEMBER: 9, OKTOBER: 10, OCTOBER: 10, NOVEMBER: 11, DESEMBER: 12, DECEMBER: 12,
};
// Short forms seen in text dates ("1 Agu 2026", "1 Des 25").
const MON3: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MEI: 5, MAY: 5, JUN: 6, JUL: 7, AGU: 8, AGS: 8,
  AUG: 8, SEP: 9, OKT: 10, OCT: 10, NOV: 11, NOP: 11, DES: 12, DEC: 12,
};

function nameKey(s: unknown): string {
  return String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function txt(v: unknown): string {
  return (v === null || v === undefined) ? "" : String(v).trim();
}
function low(v: unknown): string { return txt(v).toLowerCase(); }

// Numbers: sheet cells are mostly numeric already; strings are "-", "  - ",
// "1.234,5" (id-ID) or junk. Empty / non-numeric -> null (distinct from 0).
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  if (typeof v === "boolean" || v instanceof Date) return null;
  let s = String(v).trim().replace(/\s/g, "");
  if (!/^-?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

type YMD = { y: number; m: number; d: number };
function parseDate(v: unknown): YMD | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    // SheetJS builds cellDates in local time; the edge runtime runs in UTC.
    const t = new Date(v.getTime() + 12 * 3600 * 1000);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  }
  if (typeof v !== "string") return null;
  const s = v.trim();
  let r = /^(\d{1,2})[\s\-\/.]+([A-Za-z]+)[\s\-\/.,]+(\d{2,4})$/.exec(s);
  if (r) {
    const w = r[2].toUpperCase();
    const m = MONTHS[w] ?? MON3[w.slice(0, 3)];
    if (!m) return null;
    let y = +r[3]; if (y < 100) y += 2000;
    return { y, m, d: +r[1] };
  }
  r = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s);
  if (r) { let y = +r[3]; if (y < 100) y += 2000; return { y, m: +r[2], d: +r[1] }; }
  return null;
}

// Build a plain matrix from the sheet. Not sheet_to_json(raw): for error cells
// (#REF!, #VALUE!, #DIV/0!) that returns the numeric error code, which would
// be read as a real quantity.
function sheetMatrix(ws: XLSX.WorkSheet): unknown[][] {
  const ref = ws["!ref"];
  if (!ref) return [];
  const rg = XLSX.utils.decode_range(ref);
  const out: unknown[][] = [];
  for (let r = rg.s.r; r <= rg.e.r; r++) {
    const row: unknown[] = [];
    for (let c = 0; c <= rg.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
      if (!cell || cell.t === "e" || cell.t === "z") { row.push(null); continue; }
      row.push(cell.v ?? null);
    }
    out.push(row);
  }
  return out;
}

type Kind = "plan" | "confirm" | "ready" | "real";
type Group = {
  name: string; col: number; total: boolean;
  cols: Partial<Record<Kind, number>>;
  jenis?: string; akhir?: string; minDo?: number | null; sisa?: number | null;
};
type Block = {
  row: number; title: string;
  tMonth: number | null; tYear: number | null;
  dMonth: number | null; dYear: number | null;
  nDates: number;
  days: number;
  mitra: any[]; total: any | null; pemakaian: (number | null)[] | null; stock: (number | null)[] | null;
  warn: string[];
};

function kindOf(label: string): Kind | "pemakaian" | "stock" | null {
  const l = label.toLowerCase().replace(/[^a-z]/g, "");
  if (!l) return null;
  if (l === "plan" || l === "rencana") return "plan";
  if (l.startsWith("confirm") || l.startsWith("konfirm")) return "confirm";
  if (l === "ready") return "ready";
  if (l === "real" || l.startsWith("realisasi")) return "real";
  if (l.startsWith("pemakaian")) return "pemakaian";
  if (l.startsWith("stock") || l.startsWith("stok")) return "stock";
  return null;
}

function daysIn(y: number, m: number): number { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

function parseBlocks(M: unknown[][]): Block[] {
  const blocks: Block[] = [];
  let prevHdr = -1;
  for (let i = 0; i < M.length; i++) {
    const row = M[i] || [];
    let tcol = -1;
    for (let c = 0; c < Math.min(5, row.length); c++) {
      const l = low(row[c]);
      if (l === "tanggal" || l === "tgl" || l === "tgl." || l === "date") { tcol = c; break; }
    }
    if (tcol < 0) continue;
    // Only a header if at least one Plan/Real label follows on the same row.
    if (!row.slice(tcol + 1).some((v) => { const k = kindOf(txt(v)); return k === "plan" || k === "real"; })) continue;

    const warn: string[] = [];
    // Title: nearest row above containing "PLTU" and a month word.
    let title = "", tMonth: number | null = null, tYear: number | null = null;
    for (let k = i - 1; k > prevHdr && k >= i - 45; k--) {
      const t = (M[k] || []).slice(0, 4).map(txt).filter(Boolean).join(" ").toUpperCase();
      if (!t.includes("PLTU") || t.length > 110) continue;
      const words = t.match(/[A-Z]+|\d{2,4}/g) || [];
      const mi = words.findIndex((w) => MONTHS[w] !== undefined);
      if (mi < 0) continue;
      title = t; tMonth = MONTHS[words[mi]];
      const yw = words[mi + 1];
      if (yw && /^\d{4}$/.test(yw)) tYear = +yw;
      break;
    }
    // Supplier row: within 10 rows above, "Pemasok"/"Mitra" label in first cols.
    let sup = -1;
    for (let k = i - 1; k > prevHdr && k >= i - 10; k--) {
      if ((M[k] || []).slice(0, tcol + 2).some((v) => /pemasok|mitra|supplier/i.test(txt(v)))) { sup = k; break; }
    }
    if (sup < 0) warn.push("Baris 'Pemasok' tidak ditemukan — nama mitra kosong.");

    // Column groups.
    const groups: Group[] = [];
    let cur: Group | null = null;
    let pemCol = -1, stkCol = -1;
    for (let c = tcol + 1; c < row.length; c++) {
      const nm = sup >= 0 ? txt((M[sup] || [])[c]) : "";
      const k = kindOf(txt(row[c]));
      // Everything right of the Total group is helper columns (PEL RATU repeats
      // Ready/Real there) -- except Pemakaian/Stock, handled below.
      if (cur && cur.total && !nm && k !== "pemakaian" && k !== "stock") {
        if (k && cur.cols[k] === undefined) cur.cols[k] = c;
        continue;
      }
      if (nm && !/^pemakaian|^stock|^stok/i.test(nm)) {
        cur = { name: nm, col: c, total: /^total/i.test(nm), cols: {} };
        groups.push(cur);
      }
      if (k === "pemakaian" || /^pemakaian/i.test(nm)) { pemCol = c; continue; }
      if (k === "stock" || /^stock|^stok/i.test(nm)) { stkCol = c; continue; }
      if (!k) continue;
      // Same label twice in one group -> an unnamed slot group (merged header spilling over).
      if (!cur || cur.cols[k] !== undefined) {
        cur = { name: "", col: c, total: false, cols: {} };
        groups.push(cur);
      }
      cur.cols[k] = c;
    }
    // Metadata rows between supplier row and header.
    if (sup >= 0) {
      for (let k = sup; k < i; k++) {
        const r = M[k] || [];
        const lab = r.slice(0, tcol + 1).map(low).join(" ");
        for (const g of groups) {
          const v = r[g.col];
          if (v === null || v === undefined || v === "") continue;
          if (/jenis/.test(lab)) {
            // Tanggal yang salah ketik di baris Jenis (LB.ANGN) = tanggal berakhir.
            const d = v instanceof Date ? parseDate(v) : null;
            if (!d) g.jenis = txt(v);
            else if (!g.akhir) g.akhir = `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
          } else if (/berakhir|akhir kontrak/.test(lab)) {
            const d = parseDate(v);
            g.akhir = d ? `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}` : txt(v);
          } else if (/min(imal)?\s*do|do\s*min/.test(lab)) g.minDo = num(v);
          else if (/sisa/.test(lab)) g.sisa = num(v);
        }
      }
    }

    // Daily rows.
    type DayRow = { d: number; ymd: YMD | null; r: unknown[] };
    // Non-zero only, and mitra columns only: Total columns hold formulas that
    // evaluate to 0 on the spare 31st row of every 30-day month.
    const dataCols = groups.filter((g) => !g.total).flatMap((g) => Object.values(g.cols) as number[]);
    const hasNum = (r: unknown[]) => dataCols.some((c) => { const v = num(r[c]); return v !== null && v !== 0; });
    const dayRows: DayRow[] = [];
    let blank = 0;
    for (let k = i + 1; k < Math.min(M.length, i + 40); k++) {
      const r = M[k] || [];
      if (/^(jumlah|total)/.test(low(r[0])) || /^(jumlah|total)/.test(low(r[tcol]))) break;
      const ymd = parseDate(r[tcol]);
      const no = typeof r[0] === "number" ? r[0] as number : null;
      if (!ymd && no === null && !hasNum(r)) {
        if (r.every((v) => v === null || v === "")) { if (++blank >= 3) break; }
        continue;
      }
      blank = 0;
      // A row with numbers but no date/No. (day 31 of a 30-day month, a stray
      // line) is still inside the sheet's SUM range -> keep it as the next day.
      const prev = dayRows.length ? dayRows[dayRows.length - 1].d : 0;
      dayRows.push({ d: ymd ? ymd.d : (no ?? prev + 1), ymd, r });
    }
    // Month from the dates (mode).
    const cnt = new Map<string, number>();
    for (const dr of dayRows) if (dr.ymd) { const key = dr.ymd.y + "-" + dr.ymd.m; cnt.set(key, (cnt.get(key) || 0) + 1); }
    let dYear: number | null = null, dMonth: number | null = null, best = 0;
    for (const [key, n] of cnt) if (n > best) { best = n; [dYear, dMonth] = key.split("-").map(Number); }
    const nDates = [...cnt.values()].reduce((a, b) => a + b, 0);

    // The day grid follows the date column when it has one: a block titled "JUNI"
    // over May dates has 31 filled rows, and its Jumlah sums all 31.
    const gridY = dYear ?? tYear ?? 2026;
    const gridM = dMonth ?? tMonth ?? 1;
    const dim = daysIn(gridY, gridM);
    // Rows past the calendar end that still carry numbers extend the array, so the
    // sums match the sheet's "Jumlah" row (whose SUM covers 31 rows every month).
    // Not when that row is a stray subtotal: ADIPALA June has a "31 Mei" row whose
    // cells equal the column sums (and its Jumlah formula skips it).
    const colSum = (c: number) => dayRows.reduce((s, dr) => s + (dr.d <= dim ? (num(dr.r[c]) ?? 0) : 0), 0);
    const isSubtotal = (r: unknown[]) => {
      const cells = dataCols.map((c) => [c, num(r[c])] as const).filter(([, v]) => v !== null && v !== 0);
      return cells.length > 0 && cells.every(([c, v]) => Math.abs(colSum(c) - (v as number)) <= 0.5);
    };
    const extra = dayRows.filter((dr) => dr.d > dim && dr.d <= 31 && hasNum(dr.r) &&
      !(dr.ymd && dr.ymd.m !== gridM) && !isSubtotal(dr.r));
    const nd = extra.length ? Math.max(...extra.map((dr) => dr.d)) : dim;
    if (extra.length) warn.push(`Baris hari ke-${extra.map((dr) => dr.d).join(", ")} berisi angka padahal bulan ini ${dim} hari — tetap dijumlah seperti di sheet.`);
    const arr = () => new Array(nd).fill(null) as (number | null)[];
    const series = (col: number | undefined) => {
      if (col === undefined) return null;
      const a = arr();
      for (const dr of dayRows) {
        if (dr.d > dim && !extra.includes(dr)) continue;
        if (dr.d >= 1 && dr.d <= nd) { const v = num(dr.r[col]); if (v !== null) a[dr.d - 1] = (a[dr.d - 1] ?? 0) + v; }
      }
      return a;
    };
    const mitra: any[] = [];
    let total: any = null;
    for (const g of groups) {
      // "Keterangan" and similar side columns carry no Plan/Confirm/Ready/Real.
      if (!Object.keys(g.cols).length) continue;
      const o: any = {
        name: g.name, col: XLSX.utils.encode_col(g.col),
        jenis: g.jenis ?? null, akhir: g.akhir ?? null, minDo: g.minDo ?? null, sisa: g.sisa ?? null,
        plan: series(g.cols.plan), confirm: series(g.cols.confirm), ready: series(g.cols.ready), real: series(g.cols.real),
      };
      if (g.total) { total = o; continue; }
      const any = ["plan", "confirm", "ready", "real"].some((k) => (o[k] || []).some((v: number | null) => v !== null && v !== 0));
      // Unnamed / placeholder slots only kept when they carry numbers.
      const placeholder = !g.name || /^(PT|CV)?[\s._-]*$/i.test(g.name.replace(/_+/g, ""));
      if (placeholder && !any) continue;
      if (placeholder) { o.name = ""; warn.push(`Kolom ${o.col}: ada angka tanpa nama mitra.`); }
      mitra.push(o);
    }
    if (tMonth && dMonth && tMonth !== dMonth) warn.push(`Judul blok "${title}" tidak sama dengan bulan di kolom tanggal (${dMonth}/${dYear}).`);
    if (!nDates) warn.push("Kolom tanggal tidak terbaca sebagai tanggal; hari diambil dari nomor urut.");

    blocks.push({
      row: i + 1, title, tMonth, tYear, dMonth, dYear, nDates, days: nd,
      mitra, total, pemakaian: series(pemCol >= 0 ? pemCol : undefined), stock: series(stkCol >= 0 ? stkCol : undefined),
      warn,
    });
    prevHdr = i;
  }
  return blocks;
}

// Which (year, month) each block represents. Month: title first (dates are often
// left unchanged when a block is copied forward), dates as fallback. Year: from
// the block ORDER -- neither title nor dates can be trusted alone ("FEBRUARI 2025"
// titles over 2026 dates, 2026 titles over 2025 dates copied from last year's
// template). The first block takes its stated year (title first); each next block
// keeps the year unless its month drops by 6+ (Dec -> Jan). A small step back is
// a copied block out of order (ADIPALA has "AGUSTUS" blocks after September),
// not a new year.
function assignYM(blocks: Block[]): { y: number | null; m: number | null; warn: string | null }[] {
  let prevY: number | null = null, prevM = 0;
  return blocks.map((b) => {
    const m = b.tMonth ?? b.dMonth;
    if (!m) return { y: null, m: null, warn: null };
    let y: number | null;
    if (prevY === null) y = b.tYear ?? b.dYear;
    else y = prevM - m >= 6 ? prevY + 1 : prevY;
    if (y === null) return { y: null, m: null, warn: null };
    // prevM only moves forward within a year, so a stray back-step block does
    // not make the next real month look like a wrap.
    if (y !== prevY || m > prevM) prevM = m;
    prevY = y;
    const stated = [b.tYear, b.dYear].filter((v): v is number => v !== null);
    const warn = stated.length && !stated.includes(y)
      ? `Tahun di judul/tanggal blok (${[...new Set(stated)].join("/")}) tidak sesuai urutan blok; dianggap ${y}.`
      : null;
    return { y, m, warn };
  });
}
function filled(b: Block): number {
  let n = 0;
  for (const mt of b.mitra) for (const k of ["plan", "confirm", "ready", "real"]) for (const v of (mt[k] || [])) if (v !== null) n++;
  return n;
}
function pickBlocks(blocks: Block[]): Map<string, { b: Block; warn: string[] }> {
  const byKey = new Map<string, Block[]>();
  const ym = assignYM(blocks);
  blocks.forEach((b, i) => {
    const { y, m, warn } = ym[i];
    if (!y || !m) return;
    if (warn) b.warn.push(warn);
    const k = y + "-" + m;
    (byKey.get(k) || byKey.set(k, []).get(k)!).push(b);
  });
  // A month nobody titled, but whose dates say so (e.g. December block still
  // titled "NOVEMBER"): fall back to the date month, in the block's own year.
  blocks.forEach((b, i) => {
    const y = ym[i].y;
    if (!y || !b.dMonth || b.tMonth === b.dMonth) return;
    const k = y + "-" + b.dMonth;
    if (!byKey.has(k)) byKey.set(k, [b]);
  });
  const out = new Map<string, { b: Block; warn: string[] }>();
  for (const [k, list] of byKey) {
    const score = (b: Block) => (b.tMonth && b.tMonth === b.dMonth ? 1e6 : 0) + filled(b);
    const sorted = list.slice().sort((a, b) => score(b) - score(a));
    const w: string[] = [];
    if (sorted.length > 1) {
      w.push(`Ada ${sorted.length} blok untuk bulan ini (baris ${sorted.map((b) => b.row).join(", ")}); dipakai baris ${sorted[0].row}.`);
    }
    out.set(k, { b: sorted[0], warn: w });
  }
  return out;
}

function restHeaders(extra: Record<string, string> = {}) {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...extra };
}
async function sources(): Promise<Record<string, string>> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/checkpoint_source?select=src,sheet_id`, { headers: restHeaders() });
  if (!r.ok) throw new Error(`checkpoint_source: HTTP ${r.status}`);
  const rows = await r.json() as { src: string; sheet_id: string }[];
  return Object.fromEntries(rows.map((x) => [x.src, x.sheet_id]));
}
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// Sheet names + gids from the public htmlview page.
async function listSheets(id: string): Promise<{ name: string; gid: string }[]> {
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/htmlview`, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`htmlview HTTP ${r.status}`);
  const html = await r.text();
  const out: { name: string; gid: string }[] = [];
  const re = /items\.push\(\{name: "((?:[^"\\]|\\.)*)", pageUrl: "[^"]*", gid: "(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = m[1]
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\(.)/g, "$1");
    out.push({ name, gid: m[2] });
  }
  return out;
}
function codeLocation(code: string): { src: string; key: string } | null {
  for (const src of Object.keys(SHEET_MAP)) {
    for (const [key, c] of Object.entries(SHEET_MAP[src])) if (c === code) return { src, key };
  }
  return null;
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
    const src = await sources();

    if (p.list) {
      const res: Record<string, unknown> = {};
      for (const s of Object.keys(SHEET_MAP)) {
        if (!src[s]) { res[s] = "no sheet_id"; continue; }
        const sh = await listSheets(src[s]);
        res[s] = sh.map((x) => ({ name: x.name, code: SHEET_MAP[s][nameKey(x.name)] || null }));
      }
      return json({ ok: true, sheets: res, ms: Date.now() - t0 });
    }

    const code = txt(p.code);
    const year = Number(p.year) || 2026;
    const month = Number(p.month);
    const dry = String(p.dry || "") === "1";
    const loc = codeLocation(code);
    if (!loc) return json({ ok: false, error: `Kode PLTU ${code} tidak dikenal.` }, 400);
    if (!(month >= 1 && month <= 12)) return json({ ok: false, error: "month 1-12" }, 400);
    const sid = src[loc.src];
    if (!sid) return json({ ok: false, error: `Sumber ${loc.src} belum diisi di checkpoint_source.` }, 500);

    const sheets = await listSheets(sid);
    const sh = sheets.find((x) => nameKey(x.name) === loc.key);
    if (!sh) {
      return json({ ok: false, error: `Sheet untuk ${code} tidak ditemukan di ${loc.src}. Sheet yang ada: ${sheets.map((x) => x.name).join(", ")}` }, 404);
    }
    const xr = await fetch(`https://docs.google.com/spreadsheets/d/${sid}/export?format=xlsx&gid=${sh.gid}`);
    if (!xr.ok) return json({ ok: false, error: `Export sheet ${sh.name}: HTTP ${xr.status}` }, 502);
    const buf = new Uint8Array(await xr.arrayBuffer());
    const wb = XLSX.read(buf, { type: "array", cellDates: true, cellFormula: false, cellHTML: false, cellStyles: false });
    const ws = wb.Sheets[wb.SheetNames.find((n) => nameKey(n) === loc.key) || wb.SheetNames[0]];
    const blocks = parseBlocks(sheetMatrix(ws));
    const picked = pickBlocks(blocks);
    const fetchedAt = new Date().toISOString();

    const rows = [...picked.entries()].map(([k, { b, warn }]) => {
      const [y, m] = k.split("-").map(Number);
      return {
        code, year: y, month: m, src: loc.src, sheet: sh.name, fetched_at: fetchedAt,
        data: { ...b, warn: [...warn, ...b.warn], gid: sh.gid },
      };
    });
    if (!dry && rows.length) {
      const up = await fetch(`${SUPABASE_URL}/rest/v1/checkpoint_pasokan?on_conflict=code,year,month`, {
        method: "POST",
        headers: restHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify(rows),
      });
      if (!up.ok) return json({ ok: false, error: `Simpan cache: HTTP ${up.status} ${await up.text()}` }, 500);
    }
    const hit = rows.find((r) => r.year === year && r.month === month) || null;
    return json({
      ok: true, code, src: loc.src, sheet: sh.name, fetched_at: fetchedAt, year, month,
      found: !!hit, data: hit ? hit.data : null,
      blocks: blocks.map((b) => ({ row: b.row, t: b.tMonth, ty: b.tYear, d: b.dMonth, dy: b.dYear, n: b.nDates, mitra: b.mitra.length })),
      ms: Date.now() - t0,
    });
  } catch (e) {
    return json({ ok: false, error: (e as Error)?.message || String(e) }, 500);
  }
});
