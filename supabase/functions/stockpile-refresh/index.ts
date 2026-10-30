// stockpile-refresh
// Reads the "PLTU <nama>" sheets of Rekap Transport Biomass (one anonymous share link in
// secret STOCKPILE_XLSX_URL) and stores the mitra stockpile points per PLTU in the
// `stockpile_mitra` table (row id=1). Own table, never dashboard_data: see CLAUDE.md.
// Monthly cron + admin button (?dry=1 first). Parsing lives in parse.ts.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as XLSX from "npm:xlsx@0.18.5";
import { buildStockpile, cellText, collectShortLinks, pltuSheets, type Sheet } from "./parse.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const XLSX_URL = Deno.env.get("STOCKPILE_XLSX_URL") || "";
const FN = "stockpile-refresh";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MIN_POINTS = 200;
const SHORT_CONCURRENCY = 5;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const restHeaders = (extra: Record<string, string> = {}) => ({
  "apikey": SERVICE_KEY,
  "Authorization": `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  ...extra,
});

function sheetMatrix(ws: XLSX.WorkSheet): unknown[][] {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][];
  const start = XLSX.utils.decode_range(ws["!ref"] || "A1:A1").s;
  for (const addr of Object.keys(ws)) {
    const target = addr[0] === "!" ? undefined : ws[addr]?.l?.Target;
    // Maps links only: a mitra website linked in another column must stay plain text.
    if (!target || !/google\.|goo\.gl/i.test(target)) continue;
    const a = XLSX.utils.decode_cell(addr);
    const row = rows[a.r - start.r];
    if (row) row[a.c - start.c] = cellText(row[a.c - start.c], target);
  }
  return rows;
}

async function resolveShort(url: string): Promise<string> {
  let cur = url;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(cur, { redirect: "manual", headers: { "User-Agent": UA } });
    await res.body?.cancel();
    const loc = res.headers.get("location");
    if (!loc) break;
    cur = new URL(loc, cur).toString();
    if (/google\.[a-z.]+\/maps/.test(cur)) return cur;
  }
  return /google\.[a-z.]+\/maps/.test(cur) ? cur : "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const t0 = Date.now();
  const dry = new URL(req.url).searchParams.get("dry") === "1";
  const log: string[] = [];
  let wrote = false;

  const heartbeat = async (ok: boolean) => {
    if (dry) return;
    await fetch(`${SUPABASE_URL}/rest/v1/refresh_heartbeat?on_conflict=fn`, {
      method: "POST",
      headers: restHeaders({ "Prefer": "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        fn: FN, last_run_at: new Date().toISOString(), ok, wrote,
        duration_ms: Date.now() - t0, log: log.join("\n").slice(-4000),
      }),
    }).catch(() => {});
  };
  const out = (ok: boolean) => new Response(JSON.stringify({ ok, dry, log }), {
    status: ok ? 200 : 500, headers: { ...CORS, "Content-Type": "application/json" },
  });
  const fail = async (msg: string) => {
    // The log is public (anon response, refresh_heartbeat) and the share link opens the
    // whole workbook, so no URL may ever reach it, whatever a runtime error message holds.
    msg = msg.replace(/https?:\/\/\S+/g, "[url]");
    log.push("FAIL " + msg);
    if (!dry) {
      await fetch(`${SUPABASE_URL}/rest/v1/stockpile_mitra?id=eq.1`, {
        method: "PATCH",
        headers: restHeaders({ "Prefer": "return=minimal" }),
        body: JSON.stringify({ last_error: msg }),
      }).catch(() => {});
    }
    await heartbeat(false);
    return out(false);
  };

  try {
    if (!XLSX_URL) return await fail("Secret STOCKPILE_XLSX_URL belum diisi (butuh link 'Anyone with the link').");

    let dl: Response;
    try {
      dl = await fetch(XLSX_URL, { headers: { "User-Agent": UA } });
    } catch {
      return await fail("Download gagal (jaringan).");
    }
    if (!dl.ok) return await fail(`Download: HTTP ${dl.status}`);
    if ((dl.headers.get("content-type") || "").includes("text/html")) {
      await dl.body?.cancel();
      return await fail("SharePoint mengembalikan halaman HTML (login/izin). Link harus 'Anyone with the link'.");
    }
    const buf = new Uint8Array(await dl.arrayBuffer());
    log.push(`Downloaded ${buf.length} bytes`);

    // Only the PLTU sheets: the workbook also has heavy "Data <periode>" sheets.
    const names = pltuSheets(XLSX.read(buf, { type: "array", bookSheets: true }).SheetNames.map((name) => ({ name })))
      .map((s) => s.name);
    const wb = XLSX.read(buf, { type: "array", sheets: names });
    const sheets: Sheet[] = names.map((name) => ({ name, rows: sheetMatrix(wb.Sheets[name]) }));

    const curRes = await fetch(`${SUPABASE_URL}/rest/v1/dashboard_data?id=eq.1&select=plants:data->plants`, { headers: restHeaders() });
    if (!curRes.ok) return await fail(`Read dashboard_data: HTTP ${curRes.status}`);
    const plants = ((await curRes.json())?.[0]?.plants || []).filter((p: any) => p.code && p.lat && p.lon);
    if (!plants.length) return await fail("dashboard_data has no plants.");

    const prevRes = await fetch(`${SUPABASE_URL}/rest/v1/stockpile_mitra?id=eq.1&select=data,short_cache,n_titik,force_until`, { headers: restHeaders() });
    if (!prevRes.ok) return await fail(`Read stockpile_mitra: HTTP ${prevRes.status}`);
    const prev = (await prevRes.json())?.[0] || {};

    // Shortlinks never change target, so resolved ones are kept between runs.
    const shortMap: Record<string, string> = { ...(prev.short_cache || {}) };
    const todo = collectShortLinks(sheets).filter((u) => !shortMap[u]);
    for (let i = 0; i < todo.length; i += SHORT_CONCURRENCY) {
      await Promise.all(todo.slice(i, i + SHORT_CONCURRENCY).map(async (u) => {
        const r = await resolveShort(u).catch(() => "");
        if (r) shortMap[u] = r;
      }));
    }
    if (todo.length) log.push(`Shortlink baru: ${todo.length}`);

    const r = buildStockpile(sheets, plants, shortMap);
    const nPltu = Object.keys(r.data).length;
    const nTitik = Object.values(r.data).reduce((a, v) => a + v.length, 0);
    if (r.unmatchedSheets.length) log.push(`Sheet tidak cocok: ${r.unmatchedSheets.join(", ")}`);

    const force = prev.force_until && Date.parse(prev.force_until) > Date.now();
    if (nTitik < MIN_POINTS) return await fail(`Hanya ${nTitik} titik (min ${MIN_POINTS}), tidak ditimpa.`);
    if (!force && prev.n_titik && nTitik < Math.ceil(prev.n_titik * 0.9)) {
      return await fail(`Hanya ${nTitik} titik vs ${prev.n_titik} tersimpan, tidak ditimpa (layout sheet berubah?).`);
    }
    const prevPltu = Object.keys(prev.data || {}).length;
    if (!force && prevPltu && nPltu < prevPltu) {
      return await fail(`Hanya ${nPltu} PLTU vs ${prevPltu} tersimpan, tidak ditimpa (sheet diganti nama?).`);
    }

    // Counts only: this function answers anyone holding the public anon key, and
    // refresh_heartbeat keeps the log. The rows themselves go through stockpile-read.
    log.push(`Baris mitra ${r.rowsRead}, titik ${nTitik}, PLTU ${nPltu}, perlu dicek ${r.issues.length}`);
    if (dry) { log.push(`DRY RUN - tidak menulis. ${nTitik} titik, ${nPltu} PLTU.`); return out(true); }

    const nowIso = new Date().toISOString();
    const up = await fetch(`${SUPABASE_URL}/rest/v1/stockpile_mitra?on_conflict=id`, {
      method: "POST",
      headers: restHeaders({ "Prefer": "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        id: 1, data: r.data, issues: r.issues, short_cache: shortMap, n_pltu: nPltu, n_titik: nTitik,
        last_ok_at: nowIso, last_error: null, updated_at: nowIso,
        prev_data: prev.data && Object.keys(prev.data).length ? prev.data : null, prev_saved_at: nowIso, force_until: null,
      }),
    });
    if (!up.ok) return await fail(`Upsert stockpile_mitra: HTTP ${up.status} ${await up.text()}`);
    wrote = true;
    log.push(`OK ${nTitik} titik, ${nPltu} PLTU, ${r.issues.length} perlu dicek`);
    await heartbeat(true);
    return out(true);
  } catch (e) {
    return await fail("Exception: " + ((e as Error)?.message || String(e)));
  }
});
