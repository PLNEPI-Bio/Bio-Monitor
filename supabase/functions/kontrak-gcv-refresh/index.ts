// kontrak-gcv-refresh
// Pulls column "GCV" from sheets "Terkontrak 2026/2025/2024" of the Google Sheet
// rekap kontrak biomassa and stores ONLY the matching keys + GCV in table
// `kontrak_gcv` (anon SELECT). The dashboard column "GCV Kontrak" (Daftar
// Kontrak) matches these rows by nomor kontrak + mitra + PLTU + jenis.
//
// The spreadsheet ID lives in `checkpoint_source` (src = 'KONTRAK_GCV'; RLS on,
// no policy -> service role only). It is NOT in index.html: the repo is public
// and the same sheet carries contract prices.
//
// Each sheet is replaced in one transaction by RPC `replace_kontrak_gcv`, and
// only when it parsed sanely (header found, row count not collapsed) -- a sheet
// that fails keeps its previous rows.
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

// Sheet gid per year. A sheet deleted and re-created gets a new gid -> the
// fetch/header check fails and that year is skipped (old rows kept); update here.
const SHEETS: { tahun: number; gid: string }[] = [
  { tahun: 2026, gid: "1053800538" },
  { tahun: 2025, gid: "228129806" },
  { tahun: 2024, gid: "1641513353" },
];

// RFC 4180 CSV (quoted fields may contain commas, quotes and newlines --
// the header row has "Denda Kekurangan\n(Biosys)").
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

// Export CSV carries the displayed value in the sheet's id-ID locale: "3.009"
// = 3009. GCV outside 1000..8000 kcal/kg is a typo, not a value -> null.
function gcvNum(v: string): number | null {
  let s = String(v ?? "").trim().replace(/\s/g, "");
  if (!s || !/^\d[\d.,]*$/.test(s)) return null;
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Number(s);
  return isFinite(n) && n >= 1000 && n <= 8000 ? Math.round(n) : null;
}

type Row = { no_kontrak: string; mitra: string; pltu: string; jenis: string; gcv: number | null };

function parseSheet(csv: string): { rows: Row[]; warn: string[] } {
  const M = parseCsv(csv);
  const warn: string[] = [];
  const hr = M.slice(0, 15).findIndex((r) => r.some((c) => c.trim() === "GCV"));
  if (hr < 0) throw new Error('header "GCV" tidak ditemukan');
  const h = M[hr].map((c) => c.trim().replace(/\s+/g, " "));
  const col = (p: string) => {
    const i = h.findIndex((c) => c.startsWith(p));
    if (i < 0) throw new Error(`kolom "${p}" tidak ditemukan`);
    return i;
  };
  // Exact "GCV": the 2026 sheet also has "GCV Typical (Biosys)" / "GCV Reject (Biosys)".
  const ig = h.indexOf("GCV");
  const ik = col("No Kontrak"), im = col("Mitra Pemasok"), ip = col("Unit PLTU"), ij = col("Jenis Biomassa");
  const rows: Row[] = [];
  for (let i = hr + 1; i < M.length; i++) {
    const r = M[i];
    const no = (r[ik] ?? "").trim();
    if (!no) continue;
    const raw = (r[ig] ?? "").trim();
    const gcv = gcvNum(raw);
    if (gcv === null && raw) warn.push(`Baris ${i + 1}: GCV "${raw}" tidak terbaca.`);
    rows.push({
      no_kontrak: no, mitra: (r[im] ?? "").trim(), pltu: (r[ip] ?? "").trim(),
      jenis: (r[ij] ?? "").trim(), gcv,
    });
  }
  return { rows, warn };
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
    const r = await fetch(`${SUPABASE_URL}/rest/v1/kontrak_gcv?tahun=eq.${s.tahun}&select=id`, {
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
        const { rows, warn } = parseSheet(await r.text());
        rep.rows = rows.length;
        rep.withGcv = rows.filter((x) => x.gcv !== null).length;
        if (warn.length) rep.warn = warn.slice(0, 20);
        // Guard: an emptied/broken sheet must not wipe what we had.
        if (!rows.length || rep.withGcv < rows.length * 0.5) throw new Error("hasil parse tidak wajar");
        if (rep.prev && rows.length < rep.prev * 0.5) throw new Error(`baris turun dari ${rep.prev} ke ${rows.length}`);
        if (dry) { rep.sample = rows.slice(0, 3); rep.status = "dry"; continue; }
        const w = await fetch(`${SUPABASE_URL}/rest/v1/rpc/replace_kontrak_gcv`, {
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
