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

// Two naming schemes live side by side in the share:
//   "Profil_Pasokan_Adipala_PIP_2026.xlsx"                (old)
//   "Profil Pasokan PLTU Adipala per Agustus 2026.xlsx"   (V133: PIP folder, Sep 2026)
function plantNameFromFile(fn: string): string {
  let n = fn.replace(/\.xls[xmb]?$/i, "");
  n = n.replace(/^profil[_ ]+pasokan[_ ]+/i, "");
  n = n.replace(/^PLTU[_ ]+/i, "");
  n = n.replace(/[_ ]+(PIP|UIW|PNP|UIK)[_ ]+\d{4}$/i, "");
  n = n.replace(/[_ ]+per[_ ]+[A-Za-z]+[_ ]+\d{4}$/i, "");
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

// A cell counts as a value only when SheetJS hands back a number. Excel's SUM ignores
// text, and a formula saved without a cached result arrives as null.
function _cellNum(v: unknown): number | null {
  return (typeof v === "number" && isFinite(v)) ? v : null;
}

// Total rows are located by their LABEL in column B, never by row number -- they sit
// at different rows per plant depending on how many mitra it has (observed 32/33/34).
// Column S (idx 18) holds the SUM; G..R (idx 6..17) are Jan..Des as a fallback.
//
// Labels used (all four exist in the sheet; the first two are what we need):
//   "TOTAL RENCANA PASOKAN BULANAN"  <- section 2, the contracted supply plan
//   "TOTAL REALISASI DO"             <- section 4, actually delivered
//   "TOTAL DO"                       <- section 3, DO issued. NOT used; note that a
//                                       /^TOTAL DO/ test does not match "TOTAL REALISASI
//                                       DO", so the two never collide.
//   "TOTAL RENCANA TAMBAHAN"         <- section 5, not used.
//
// null means "total could not be determined" -- callers treat that differently from 0
// (a plant with no realisasi yet is a legitimate 0).
function totalByLabel(m: any[][], labelRe: RegExp): number | null {
  for (let r = 0; r < m.length; r++) {
    const row = m[r] || [];
    if (!labelRe.test(_safeStr(row[1]))) continue;
    // Cached total in S is taken as-is, 0 included.
    const s = _cellNum(row[18]);
    if (s !== null) return round2(s);
    // S has no value: Jan..Des on the label row, if any of them carries one.
    let sum = 0, any = false;
    for (let c = 6; c <= 17; c++) {
      const v = _cellNum(row[c]);
      if (v !== null) { sum += v; any = true; }
    }
    if (any) return round2(sum);
    // V133: the "per <Bulan>" workbooks are written by a script, not saved by Excel,
    // so the TOTAL row holds =SUM(G13:G33) with NO cached value and reads as empty.
    // Sum the mitra rows instead: in all 28 such files that formula range is exactly
    // "row after the section header" .. "row before the TOTAL label".
    const sec = sumSectionRows(m, r);
    return sec === null ? null : round2(sec);
  }
  return null;
}

// Sums Jan..Des of the rows between the section header above `labelRow` (col A like
// "2. RENCANA PASOKAN BULANAN") and the label row. null when the walk reaches another
// TOTAL row (the previous section's) or the top of the sheet before any header -- a
// layout surprise must never fold section 1 targets or section 3 DO into this total.
function sumSectionRows(m: any[][], labelRow: number): number | null {
  let sum = 0;
  for (let r = labelRow - 1; r >= 0; r--) {
    const row = m[r] || [];
    if (typeof row[0] === "string" && /^\d+\.\s/.test(row[0].trim())) return sum;
    if (/^TOTAL/i.test(_safeStr(row[1]))) return null;
    for (let c = 6; c <= 17; c++) sum += _cellNum(row[c]) ?? 0;
  }
  return null;
}

// { rencana, realisasiDo } — either may be null when its total row is absent.
function parseProfilPasokan(wb: XLSX.WorkBook): { rencana: number | null; realisasiDo: number | null } {
  const ws = wb.Sheets["Profil Pasokan"] || wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { rencana: null, realisasiDo: null };
  const m = _sheetToMatrix(ws);
  return {
    rencana: totalByLabel(m, /^TOTAL RENCANA PASOKAN BULANAN/i),
    realisasiDo: totalByLabel(m, /^TOTAL REALISASI DO/i),
  };
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
  // V134: heartbeat in refresh_heartbeat on every live exit path (same table and
  // pattern as prod-auto-refresh). A blocked or failed run used to leave its log
  // only in net._http_response, whose retention is short. Dry-run writes nothing.
  let hbWrote = false;
  const beat = async (ok: boolean) => {
    if (dryRun) return;
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/refresh_heartbeat?on_conflict=fn`, {
        method: "POST",
        headers: restHeaders({ "Prefer": "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify({
          fn: "kontrak-auto-refresh",
          last_run_at: new Date().toISOString(),
          ok,
          wrote: hbWrote,
          duration_ms: Date.now() - t0,
          // Tail, not head: the verdict (FAIL/OK) is always the last line.
          log: log.join("\n").slice(-4000),
        }),
      });
    } catch (_e) {
      // A heartbeat failure must never turn a good refresh into a bad one.
    }
  };
  const out = async (ok: boolean, status = 200) => {
    await beat(ok);
    return new Response(JSON.stringify({ ok, dryRun, log, ms: Date.now() - t0 }, null, 2), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };

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
    // Attempt beat before the 48 downloads: a worker killed mid-run (this function has
    // hit WORKER_RESOURCE_LIMIT before) never reaches out(), and without this the row
    // would keep showing the previous run's verdict.
    log.push("started");
    await beat(false);

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

    type SrcFile = { name: string; url: string; modified: string };
    const files: SrcFile[] = [];
    for (const f of folders) {
      const kids = await getJson(`${origin}/_api/v2.0/drives/${driveId}/items/${f.id}/children`, cookie);
      for (const it of (kids.value || [])) {
        const dl = it["@content.downloadUrl"];
        if (it.file && dl && /\.xls[xmb]?$/i.test(it.name)) {
          files.push({ name: it.name, url: dl, modified: _safeStr(it.lastModifiedDateTime) });
        }
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

    // V133: pick ONE file per plant before downloading. Names now carry the month, so
    // "per Agustus" and "per September" (or a leftover old-scheme file) can sit side by
    // side for the same PLTU; parsing both let whichever download finished last win,
    // at random, with every guard passing. Newest lastModifiedDateTime wins, then name.
    const unmatched: string[] = [];
    const duplicates: string[] = [];
    const groups = new Map<string, SrcFile[]>();
    for (const f of files) {
      const code = byName.get(nameKey(plantNameFromFile(f.name)));
      if (!code) { unmatched.push(f.name); continue; }
      if (!groups.has(code)) groups.set(code, []);
      groups.get(code)!.push(f);
    }
    const picked: (SrcFile & { code: string })[] = [];
    for (const [code, fs] of groups) {
      fs.sort((a, b) => b.modified.localeCompare(a.modified) || b.name.localeCompare(a.name));
      picked.push({ ...fs[0], code });
      if (fs.length > 1) {
        duplicates.push(`${code} -> ${fs[0].name} (ignored: ${fs.slice(1).map((x) => x.name).join(" | ")})`);
      }
    }

    // data[kode] = { r: total rencana pasokan, d: total realisasi DO }.
    // Klien memakai r sebagai "Kontrak <tahun>" dan r-d sebagai "Sisa Kontrak <tahun>".
    const map: Record<string, { r: number; d: number | null }> = {};
    const unparsed: string[] = [];
    const noRealisasi: string[] = [];
    // V78: turun dari 6 ke 4. Bersama pembatasan `sheets` di XLSX.read, ini menjaga
    // fungsi tetap di bawah batas memori edge runtime (pernah kena
    // WORKER_RESOURCE_LIMIT saat masih 6 + parse seluruh sheet).
    const CONC = 4;
    for (let i = 0; i < picked.length; i += CONC) {
      await Promise.all(picked.slice(i, i + CONC).map(async (f) => {
        const code = f.code;
        try {
          const dl = await fetch(f.url, { headers: { "User-Agent": UA, "Cookie": cookie } });
          if (!dl.ok) { await dl.body?.cancel(); unparsed.push(`${f.name} (HTTP ${dl.status})`); return; }
          const buf = new Uint8Array(await dl.arrayBuffer());
          // Hanya sheet "Profil Pasokan" yang di-parse. Tiap workbook juga punya
          // "Grafik" dan "Profil Pasokan FGD"; mem-parse semuanya untuk 48 file
          // menembus batas memori edge runtime. Nama sheet ini konsisten di ke-48 file.
          const wb = XLSX.read(buf, {
            type: "array",
            sheets: ["Profil Pasokan"],
            cellDates: false, cellFormula: false, cellHTML: false, cellStyles: false, cellNF: false,
            dense: true,
          });
          const val = parseProfilPasokan(wb);
          // Tanpa total rencana, entri ini tidak berguna — lewati sepenuhnya.
          if (val.rencana === null) { unparsed.push(f.name); return; }
          // Total realisasi DO boleh absen: "Sisa Kontrak" akan tampil "—", tetapi
          // "Kontrak" tetap terisi. Dicatat supaya terlihat di log.
          if (val.realisasiDo === null) noRealisasi.push(f.name);
          map[code] = { r: val.rencana, d: val.realisasiDo };
        } catch (e) {
          unparsed.push(`${f.name} (${e instanceof Error ? e.message : String(e)})`);
        }
      }));
    }
    const n = Object.keys(map).length;
    log.push(`Parsed ${n} plants · skipped ${unmatched.length} unmatched · ${unparsed.length} failed`);
    if (unmatched.length) log.push(`  unmatched: ${unmatched.join(", ")}`);
    if (duplicates.length) log.push(`  duplicate: ${duplicates.join("; ")}`);
    if (unparsed.length) log.push(`  failed: ${unparsed.join(", ")}`);
    if (noRealisasi.length) log.push(`  no "TOTAL REALISASI DO" row: ${noRealisasi.join(", ")}`);

    if (n < MIN_PLANTS) {
      return await markError(`Only ${n} plants parsed (min ${MIN_PLANTS}) - refusing to overwrite.`);
    }

    // Read BEFORE the dry-run branch so ?dry=1 evaluates the same guards a live run
    // would (markError writes nothing in dry-run).
    const prevRes = await fetch(`${SUPABASE_URL}/rest/v1/kontrak_pasokan?id=eq.1&select=data,force_until`, {
      headers: restHeaders(),
    });
    if (!prevRes.ok) return await markError(`Read kontrak_pasokan: HTTP ${prevRes.status}`);
    const prevRows = await prevRes.json();
    const prevRow: any = (Array.isArray(prevRows) && prevRows.length) ? prevRows[0] : {};
    const prev: Record<string, any> = prevRow.data || {};
    // V134: time-boxed override, set only via SQL (the table has no RLS write policy, so
    // the public anon key cannot set it). Skips the shrink guards AND carry-over: the
    // point is to accept this parse as the truth, e.g. after a PLTU leaves the roster.
    // MIN_PLANTS still applies. Cleared by the next successful live run. Deliberately a
    // deadline, not a boolean: a flag left on after a FAILED forced run would silently
    // disable every guard on the next unattended run (cron, or anyone with the anon key).
    const forceUntil = prevRow.force_until ? Date.parse(prevRow.force_until) : NaN;
    const force = forceUntil > Date.now();
    if (force) log.push(`FORCE force_until=${prevRow.force_until} - shrink guards and carry-over skipped for this run.`);
    else if (prevRow.force_until) log.push(`force_until=${prevRow.force_until} has expired - ignored, guards active.`);

    // V133: SHRINK GUARDS, measured on this run's fresh parse (before carry-over below).
    // MIN_PLANTS alone let a run through that matched only 20 of 48 PLTU (files renamed
    // on SharePoint) and wiped 28 plants from the dashboard. The other counts catch a
    // layout change that matches every file yet reads nothing: r > 0, and d present
    // (totalByLabel returns null, not 0, when it cannot find a total). d > 0 is
    // deliberately NOT guarded -- every plant legitimately has 0 realisasi in January.
    const guards: [string, (e: any) => boolean][] = [
      ["plants", () => true],
      ["plants with rencana > 0", (e) => _safeNum(e?.r) > 0],
      ["plants with realisasi DO", (e) => e?.d !== null && e?.d !== undefined],
    ];
    for (const [label, ok] of (force ? [] : guards)) {
      const was = Object.values(prev).filter(ok).length;
      const now = Object.values(map).filter(ok).length;
      if (was > 0 && now < Math.ceil(was * 0.9)) {
        return await markError(`Only ${now} ${label} vs ${was} stored - refusing to overwrite (file rename or layout change on SharePoint?).`);
      }
    }

    // V133: CARRY-OVER. A PLTU that is still in the roster but produced no entry this run
    // (file renamed, unparseable) keeps its last stored entry instead of vanishing from
    // the tooltip -- and so the stored count cannot ratchet down 10% per run under the
    // guard above. Recorded in last_error so it is not silent even when the run is ok.
    const rosterCodes = new Set(byName.values());
    const carried = force ? [] : Object.keys(prev).filter((c) => !(c in map) && rosterCodes.has(c));
    for (const c of carried) map[c] = prev[c];
    if (carried.length) log.push(`  carried over from stored map (no fresh entry): ${carried.join(", ")}`);
    const warn = carried.length ? `WARN carried ${carried.length} PLTU without a fresh entry: ${carried.join(", ")}` : null;
    const total = Object.keys(map).length;

    if (dryRun) {
      const codes = Object.keys(map).sort();
      log.push(`DRY RUN - no write performed. ${total} PLTU (rencana / realisasiDO / sisa):`);
      for (const c of codes) {
        const e = map[c];
        const sisa = (e.d === null) ? "-" : round2(e.r - e.d);
        log.push(`  ${c} = ${e.r} / ${e.d === null ? "-" : e.d} / ${sisa}${carried.includes(c) ? "  (carried)" : ""}`);
      }
      return out(true);
    }

    // EGRESS GUARD - a write broadcasts the row over Realtime, so skip when identical.
    if (stableStringify(map) === stableStringify(prev)) {
      log.push(`No change vs stored kontrak map - skipped write (saves egress). ${total} PLTU`);
      const okRes = await fetch(`${SUPABASE_URL}/rest/v1/kontrak_pasokan?id=eq.1`, {
        method: "PATCH",
        headers: restHeaders({ "Prefer": "return=minimal" }),
        body: JSON.stringify({ last_ok_at: new Date().toISOString(), last_error: warn, force_until: null }),
      });
      // This PATCH is also what clears force_until when the map is unchanged.
      if (!okRes.ok) return await markError(`Update kontrak_pasokan status: HTTP ${okRes.status} ${await okRes.text()}`);
      return out(true);
    }

    // Write to its own table. dashboard_data is never touched.
    // V134: the map being replaced goes to prev_data in the SAME statement, so a bad
    // write can always be reverted one step with SQL (see README) -- no manual snapshot.
    const nowIso = new Date().toISOString();
    const upRes = await fetch(`${SUPABASE_URL}/rest/v1/kontrak_pasokan?on_conflict=id`, {
      method: "POST",
      headers: restHeaders({ "Prefer": "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        id: 1,
        data: map,
        n_pltu: total,
        source_url: SHARE_URL.split("?")[0],
        last_ok_at: nowIso,
        last_error: warn,
        updated_at: nowIso,
        // null, not {}: an empty backup must not pass the README revert's null check.
        prev_data: Object.keys(prev).length ? prev : null,
        prev_saved_at: nowIso,
        force_until: null,
      }),
    });
    if (!upRes.ok) {
      return await markError(`Upsert kontrak_pasokan: HTTP ${upRes.status} ${await upRes.text()}`);
    }
    hbWrote = true;
    log.push(`OK kontrak_pasokan.data updated · ${total} PLTU (${carried.length} carried) · previous map kept in prev_data`);
    return out(true);
  } catch (e) {
    return await markError("Exception: " + ((e as Error)?.message || String(e)));
  }
});
