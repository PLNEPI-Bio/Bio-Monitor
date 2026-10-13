// kontrak-harga-refresh
// Pulls contract unit prices from sheets "Terkontrak 2026/2025/2024" of the
// Google Sheet rekap kontrak biomassa (the same sheet kontrak-gcv-refresh
// reads) into table `kontrak_harga` (anon SELECT), read by the dashboard's
// fetchKontrakHarga() -> column "Harga" in Daftar Kontrak / Ringkasan Mitra.
//
// Harga (Rp/ton, excl. PPN):
//   - "Harga Satuan Molekul" and "Harga Satuan Transport" both filled -> their sum
//     ("Harga Satuan Exc PPN" in the sheet is that same sum; a mismatch is reported).
//   - otherwise -> "Harga Satuan Exc PPN" as-is. Sheet 2024 has no molekul/transport
//     columns, so it is always this branch.
//
// The spreadsheet ID lives in `checkpoint_source` (src = 'KONTRAK_GCV'; service
// role only). It is NOT in index.html: the repo is public.
//
// Each sheet is replaced in one transaction by RPC `replace_kontrak_harga`,
// only when it parsed sanely -- a sheet that fails keeps its previous rows.
//
// Query: ?dry=1 -> parse and report, no write.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Same gids as kontrak-gcv-refresh -- update both if a sheet is re-created.
const SHEETS: { tahun: number; gid: string }[] = [
  { tahun: 2026, gid: "1053800538" },
  { tahun: 2025, gid: "228129806" },
  { tahun: 2024, gid: "1641513353" },
];

// RFC 4180 CSV (quoted fields may contain commas, quotes and newlines).
function parseCsv(s: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], f = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(f); out.push(row); row = []; f = "";
    } else f += ch;
  }
  if (f !== "" || row.length) { row.push(f); out.push(row); }
  return out;
}

// Export CSV carries the displayed value in the sheet's id-ID locale:
// "1.075.000" = 1075000, "393.190" = 393190. "-" / blank -> null.
function num(v: string): number | null {
  let s = String(v ?? "").trim().replace(/\s|Rp/g, "");
  if (!s || !/^\d[\d.,]*$/.test(s)) return null;
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return isFinite(n) ? n : null;
}

// Rp/ton outside this band is a typo or a total in the wrong column, not a price.
const HARGA_MIN = 50_000, HARGA_MAX = 5_000_000;

type Row = {
  no_kontrak: string; mitra: string; pltu: string; jenis: string; volume: number | null;
  harga_molekul: number | null; harga_transport: number | null; harga: number;
};

function parseSheet(csv: string): { rows: Row[]; skipped: number; warn: string[] } {
  const M = parseCsv(csv);
  const warn: string[] = [];
  const isHdr = (r: string[]) => r.some((c) => c.trim().replace(/\s+/g, " ") === "Harga Satuan Exc PPN");
  const hr = M.slice(0, 15).findIndex(isHdr);
  if (hr < 0) throw new Error('header "Harga Satuan Exc PPN" tidak ditemukan');
  const h = M[hr].map((c) => c.trim().replace(/\s+/g, " "));
  const col = (p: string, opt = false) => {
    const i = h.findIndex((c) => c.startsWith(p));
    if (i < 0 && !opt) throw new Error(`kolom "${p}" tidak ditemukan`);
    return i;
  };
  const ik = col("No Kontrak"), im = col("Mitra Pemasok"), ip = col("Unit PLTU"), ij = col("Jenis Biomassa");
  const iv = col("Volume"), ie = col("Harga Satuan Exc PPN");
  const ihm = col("Harga Satuan Molekul", true), iht = col("Harga Satuan Transport", true);
  const rows: Row[] = [];
  let skipped = 0;
  for (let i = hr + 1; i < M.length; i++) {
    const r = M[i];
    const g = (j: number) => (j >= 0 ? (r[j] ?? "").trim() : "");
    const no = g(ik);
    if (!no) continue;
    const hm = num(g(ihm)), ht = num(g(iht)), ex = num(g(ie));
    let harga: number | null;
    if (hm !== null && ht !== null) {
      harga = hm + ht;
      if (ex !== null && Math.abs(harga - ex) > 0.5) {
        warn.push(`Baris ${i + 1} (${no}): molekul+transport ${harga} ≠ Exc PPN ${ex} — dipakai jumlahnya.`);
      }
    } else {
      harga = ex;
      if ((hm === null) !== (ht === null)) warn.push(`Baris ${i + 1} (${no}): molekul/transport hanya terisi satu — dipakai Exc PPN.`);
    }
    if (harga === null || harga < HARGA_MIN || harga > HARGA_MAX) {
      skipped++;
      if (harga !== null || g(ie)) warn.push(`Baris ${i + 1} (${no}): harga "${harga ?? g(ie)}" di luar wajar — dilewati.`);
      continue;
    }
    rows.push({
      no_kontrak: no, mitra: g(im), pltu: g(ip), jenis: g(ij), volume: num(g(iv)),
      harga_molekul: hm, harga_transport: ht, harga,
    });
  }
  return { rows, skipped, warn };
}

function restHeaders() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
}

async function sheetId(): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/checkpoint_source?src=eq.KONTRAK_GCV&select=sheet_id`, { headers: restHeaders() });
  if (!r.ok) throw new Error(`checkpoint_source: HTTP ${r.status}`);
  const d = await r.json();
  if (!d[0]?.sheet_id) throw new Error("checkpoint_source KONTRAK_GCV kosong");
  return d[0].sheet_id;
}

async function prevCounts(): Promise<Record<number, number>> {
  const out: Record<number, number> = {};
  for (const s of SHEETS) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/kontrak_harga?tahun=eq.${s.tahun}&select=id`, {
      method: "HEAD", headers: { ...restHeaders(), Prefer: "count=exact" },
    });
    const m = /\/(\d+)$/.exec(r.headers.get("content-range") || "");
    out[s.tahun] = m ? +m[1] : 0;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b, null, 1), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const id = await sheetId();
    const prev = await prevCounts();
    const report: any[] = [];
    for (const s of SHEETS) {
      const rep: any = { tahun: s.tahun, prev: prev[s.tahun] ?? 0 };
      report.push(rep);
      try {
        const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${s.gid}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { rows, skipped, warn } = parseSheet(await r.text());
        rep.rows = rows.length;
        rep.viaSum = rows.filter((x) => x.harga_molekul !== null && x.harga_transport !== null).length;
        rep.skipped = skipped;
        if (warn.length) rep.warn = warn.slice(0, 30);
        // Guard: an emptied/broken sheet must not wipe what we had.
        if (!rows.length || rows.length < (rows.length + skipped) * 0.5) throw new Error("hasil parse tidak wajar");
        if (rep.prev && rows.length < rep.prev * 0.5) throw new Error(`baris turun dari ${rep.prev} ke ${rows.length}`);
        if (dry) { rep.status = "dry"; continue; }
        const w = await fetch(`${SUPABASE_URL}/rest/v1/rpc/replace_kontrak_harga`, {
          method: "POST", headers: restHeaders(),
          body: JSON.stringify({ p_tahun: s.tahun, p_rows: rows, p_sumber: `Google Sheet rekap kontrak / Terkontrak ${s.tahun}` }),
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
