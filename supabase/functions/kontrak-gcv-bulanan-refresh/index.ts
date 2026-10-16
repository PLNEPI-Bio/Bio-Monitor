// kontrak-gcv-bulanan-refresh
// V199: pulls the MONTHLY GCV (kcal/kg) per contract from sheets "Kontrak 2026",
// "Kontrak 2025" and "Kontrak 2024" of the rekap kontrak workbook on SharePoint,
// and stores ONLY the matching keys + 12 monthly GCV + 12 monthly Vol in table
// `kontrak_gcv_bulanan` (anon SELECT). The dashboard (Daftar Kontrak -> detail
// per mitra) matches these rows by nomor kontrak + mitra + PLTU + jenis and shows
// DO | Real | %SR | GCV per year. Vol is kept to weight the yearly/total GCV.
//
// The download URL lives in `checkpoint_source` (src = 'KONTRAK_GCV_BULANAN',
// column sheet_id; RLS on, no policy -> service role only). It is NOT in
// index.html: the repo is public and the same workbook carries contract prices.
// Price columns are never read.
//
// Layout (all three sheets): row 2 = header, data rows have a number in col A
// (the "Ringkasan" table below them does not). Identity: C PLTU, D Mitra,
// E Jenis Biomassa, F Nomor Kontrak. Month m (0..11) is a 6-column block from
// col N: Vol, Sisa Vol, GCV, Harga, Harga (inc PPN), Total -> Vol = 13 + 6m,
// GCV = 15 + 6m. Block positions are checked against the header.
//
// Each sheet is replaced in one transaction by RPC `replace_kontrak_gcv_bulanan`,
// only when it parsed sanely -- a sheet that fails keeps its previous rows.
//
// Query: ?dry=1 -> parse and report, no write.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as XLSX from "npm:xlsx@0.18.5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SHEETS = [2026, 2025, 2024].map((tahun) => ({ tahun, name: `Kontrak ${tahun}` }));
const C_PLTU = 2, C_MITRA = 3, C_JENIS = 4, C_NO = 5, C_M0 = 13;

const txt = (v: unknown) => (v === null || v === undefined ? "" : String(v)).trim();
const norm = (v: unknown) => txt(v).toLowerCase().replace(/\s+/g, " ");

// GCV outside 1000..8000 kcal/kg is a typo, not a value -> null.
function gcvNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(txt(v).replace(/\./g, "").replace(",", "."));
  return isFinite(n) && n >= 1000 && n <= 8000 ? Math.round(n) : null;
}
function volNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(txt(v).replace(",", "."));
  return isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : null;
}

type Row = { no_kontrak: string; mitra: string; pltu: string; jenis: string; gcv: (number | null)[]; vol: (number | null)[] };

function parseSheet(ws: XLSX.WorkSheet): { rows: Row[]; warn: string[] } {
  const M = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][];
  const warn: string[] = [];
  const hr = M.slice(0, 10).findIndex((r) => norm((r || [])[C_NO]) === "nomor kontrak");
  if (hr < 0) throw new Error('header "Nomor Kontrak" (kolom F) tidak ditemukan');
  const h = M[hr];
  const ident: [number, string][] = [[C_PLTU, "pltu"], [C_MITRA, "mitra"], [C_JENIS, "jenis biomassa"]];
  for (const [c, want] of ident) if (norm(h[c]) !== want) throw new Error(`kolom ${XLSX.utils.encode_col(c)} bukan "${want}"`);
  for (let m = 0; m < 12; m++) {
    const v = norm(h[C_M0 + 6 * m]), g = norm(h[C_M0 + 6 * m + 2]);
    if (v !== "vol" || g !== "gcv") throw new Error(`blok bulan ${m + 1} bergeser (${XLSX.utils.encode_col(C_M0 + 6 * m)}="${v}", ${XLSX.utils.encode_col(C_M0 + 6 * m + 2)}="${g}")`);
  }
  const rows: Row[] = [];
  for (let i = hr + 1; i < M.length; i++) {
    const r = M[i] || [];
    if (typeof r[0] !== "number") continue;   // data rows only, not "Ringkasan"
    const no = txt(r[C_NO]);
    if (!no) continue;
    const gcv: (number | null)[] = [], vol: (number | null)[] = [];
    for (let m = 0; m < 12; m++) {
      const raw = r[C_M0 + 6 * m + 2];
      const g = gcvNum(raw);
      if (g === null && txt(raw)) warn.push(`Baris ${i + 1} bulan ${m + 1}: GCV "${txt(raw)}" tidak terbaca.`);
      gcv.push(g);
      vol.push(volNum(r[C_M0 + 6 * m]));
    }
    rows.push({ no_kontrak: no, mitra: txt(r[C_MITRA]), pltu: txt(r[C_PLTU]), jenis: txt(r[C_JENIS]), gcv, vol });
  }
  return { rows, warn };
}

function restHeaders() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
}
async function sourceUrl(): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/checkpoint_source?src=eq.KONTRAK_GCV_BULANAN&select=sheet_id`, { headers: restHeaders() });
  if (!r.ok) throw new Error(`checkpoint_source: HTTP ${r.status}`);
  const d = await r.json();
  if (!d[0]?.sheet_id) throw new Error("checkpoint_source KONTRAK_GCV_BULANAN kosong");
  return d[0].sheet_id;
}
async function prevCount(tahun: number): Promise<number> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/kontrak_gcv_bulanan?tahun=eq.${tahun}&select=id`, {
    method: "HEAD", headers: { ...restHeaders(), Prefer: "count=exact" },
  });
  const m = /\/(\d+)$/.exec(r.headers.get("content-range") || "");
  return m ? +m[1] : 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b, null, 1), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const xr = await fetch(await sourceUrl(), { redirect: "follow" });
    if (!xr.ok) throw new Error(`unduh workbook: HTTP ${xr.status}`);
    if ((xr.headers.get("content-type") || "").includes("text/html")) {
      throw new Error("SharePoint mengembalikan halaman HTML (login/izin). Tautan harus 'Anyone with the link'.");
    }
    // Only the three sheets are parsed (the workbook has ~20, CPU per request is limited).
    const wb = XLSX.read(new Uint8Array(await xr.arrayBuffer()), {
      type: "array", sheets: SHEETS.map((s) => s.name), cellFormula: false, cellHTML: false, cellStyles: false, cellDates: false,
    });
    const report: any[] = [];
    for (const s of SHEETS) {
      const rep: any = { tahun: s.tahun, prev: await prevCount(s.tahun) };
      report.push(rep);
      try {
        const ws = wb.Sheets[s.name];
        if (!ws) throw new Error(`sheet "${s.name}" tidak ada`);
        const { rows, warn } = parseSheet(ws);
        rep.rows = rows.length;
        rep.withGcv = rows.filter((x) => x.gcv.some((g) => g !== null)).length;
        rep.gcvCells = rows.reduce((a, x) => a + x.gcv.filter((g) => g !== null).length, 0);
        if (warn.length) rep.warn = warn.slice(0, 20);
        // Guard: an emptied/broken sheet must not wipe what we had.
        if (!rows.length || !rep.gcvCells) throw new Error("hasil parse tidak wajar");
        if (rep.prev && rows.length < rep.prev * 0.5) throw new Error(`baris turun dari ${rep.prev} ke ${rows.length}`);
        if (dry) { rep.sample = rows.slice(0, 2); rep.status = "dry"; continue; }
        const w = await fetch(`${SUPABASE_URL}/rest/v1/rpc/replace_kontrak_gcv_bulanan`, {
          method: "POST", headers: restHeaders(), body: JSON.stringify({ p_tahun: s.tahun, p_rows: rows }),
        });
        if (!w.ok) throw new Error(`tulis gagal: HTTP ${w.status} ${await w.text()}`);
        rep.status = "ok";
      } catch (e) {
        rep.status = "skip";
        rep.error = String((e as Error).message || e);
      }
    }
    return json({ dry, at: new Date().toISOString(), sheets: report });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
