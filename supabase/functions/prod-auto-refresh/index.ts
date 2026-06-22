// prod-auto-refresh
// Scheduled (pg_cron, every 10 min) Edge Function that downloads the
// "Monitoring Produksi" Excel from a public SharePoint link, parses the
// Produksi dataset (plants, monthly, pembangkit, gcv, gcv_national) and
// merges it into the `dashboard_data` row id=1 — exactly mirroring what the
// in-browser "Update Data" flow does for a prod-only upload.
//
// Safety: all other dashboard fields (bottlenecks, pareto, contracts, usulan,
// diesel, mou, …) are preserved untouched. If the download fails or the parse
// yields zero plants (e.g. SharePoint returned a login page), the existing
// data is left intact and the function returns an error — it never wipes data.
//
// Auth model: invoked with the project's anon key (passed by the cron job);
// writes to the DB using the service-role key from the function environment.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as XLSX from "npm:xlsx@0.18.5";

// Public "anyone with the link" SharePoint share. The reliable anonymous
// direct-download form is `_layouts/15/download.aspx?share=<token>`, which
// returns the raw .xlsx bytes (the `:x:/g/...?download=1` form returns an HTML
// app-shell instead). Overridable via env so the link can be rotated without
// a redeploy.
const DEFAULT_SHAREPOINT_URL =
  "https://plnbatubaracoid-my.sharepoint.com/personal/m_maulana_plnepi_co_id/_layouts/15/download.aspx?share=IQBcjyPF88MOS58A9xUlUFpEAZuGR3K87gBB--m32ya8jeI";

// ---------------- parsing helpers (ported from index.html) ----------------
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

// ---------------- prod parser (port of parseProdExcel, prod fields only) ----
function parseProdExcel(wb: XLSX.WorkBook, existingPlants: any[]) {
  const result: any = {
    plants: [],
    monthly: [],
    pembangkit: [],
    gcv: {},
    gcv_national: { "2023": 3008, "2024": 3093, "2025": 3137, "2026": 0 },
  };

  // Preserve lat/lon/meta from existing plants so coordinates aren't lost.
  const coordMap: Record<string, any> = {};
  (existingPlants || []).forEach((p: any) => {
    if (p.name && (p.lat !== undefined || p.lon !== undefined)) {
      coordMap[p.name] = { lat: p.lat, lon: p.lon, regional: p.regional, genco: p.genco, code: p.code, boiler: p.boiler };
    }
  });

  if (!wb.Sheets["Rekap"]) {
    throw new Error('Sheet "Rekap" tidak ditemukan dalam workbook');
  }
  const rekap = _sheetToMatrix(wb.Sheets["Rekap"]);

  function extractMonthBlock(rowStart: number, monthsCol0: number, count: number) {
    const out: number[][] = [];
    for (let i = 0; i < count; i++) {
      const r = rekap[rowStart + i] || [];
      const months: number[] = [];
      for (let m = 0; m < 12; m++) months.push(_safeNum(r[monthsCol0 + m]));
      out.push(months);
    }
    return out;
  }
  function extractCol(rowStart: number, col: number, count: number) {
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const r = rekap[rowStart + i] || [];
      out.push(_safeNum(r[col]));
    }
    return out;
  }

  const PLANT_COUNT = 51;
  const ROW_2026 = 4, ROW_2025 = 66, ROW_2024 = 128, ROW_2023 = 191;
  const COL_NO = 1, COL_NAME = 2, COL_GENCO = 3, COL_CODE = 4, COL_BOILER = 5, COL_REGIONAL = 6;
  const COL_TARGET_JAN = 7, COL_DO_JAN = 20, COL_REAL_JAN = 33, COL_GAP_JAN = 47;
  const COL_SISA_KONTRAK = 60, COL_KEBUTUHAN_BATUBARA = 61;
  const COL_JUMLAH_UNIT = 62, COL_KAPASITAS_PER_UNIT = 63, COL_TOTAL_KAPASITAS = 64;

  const targets2026 = extractMonthBlock(ROW_2026, COL_TARGET_JAN, PLANT_COUNT);
  const dos2026 = extractMonthBlock(ROW_2026, COL_DO_JAN, PLANT_COUNT);
  const reals2026 = extractMonthBlock(ROW_2026, COL_REAL_JAN, PLANT_COUNT);
  const gaps2026 = extractMonthBlock(ROW_2026, COL_GAP_JAN, PLANT_COUNT);
  const sisaKontrak = extractCol(ROW_2026, COL_SISA_KONTRAK, PLANT_COUNT);
  const kebButubara = extractCol(ROW_2026, COL_KEBUTUHAN_BATUBARA, PLANT_COUNT);
  const jumlahUnitArr = extractCol(ROW_2026, COL_JUMLAH_UNIT, PLANT_COUNT);
  const kapasitasPerUnitArr = extractCol(ROW_2026, COL_KAPASITAS_PER_UNIT, PLANT_COUNT);
  const totalKapasitasArr = extractCol(ROW_2026, COL_TOTAL_KAPASITAS, PLANT_COUNT);

  const targets2025 = extractMonthBlock(ROW_2025, COL_TARGET_JAN, PLANT_COUNT);

  const NAT_TARGET_2023 = 1_080_000;
  const NAT_TARGET_2024 = 2_500_000;
  let total2025 = 0;
  for (let i = 0; i < PLANT_COUNT; i++) {
    total2025 += (targets2025[i] || []).reduce((s, v) => s + (v || 0), 0);
  }
  const target2023PerPlant = new Array(PLANT_COUNT).fill(null).map(() => new Array(12).fill(0));
  const target2024PerPlant = new Array(PLANT_COUNT).fill(null).map(() => new Array(12).fill(0));
  if (total2025 > 0) {
    for (let i = 0; i < PLANT_COUNT; i++) {
      const t25 = targets2025[i] || [];
      const t25Sum = t25.reduce((s, v) => s + (v || 0), 0);
      if (t25Sum > 0) {
        const share = t25Sum / total2025;
        const plantNat23 = NAT_TARGET_2023 * share;
        const plantNat24 = NAT_TARGET_2024 * share;
        for (let m = 0; m < 12; m++) {
          const monthShare = (t25[m] || 0) / t25Sum;
          target2023PerPlant[i][m] = plantNat23 * monthShare;
          target2024PerPlant[i][m] = plantNat24 * monthShare;
        }
      }
    }
  }
  const dos2025 = extractMonthBlock(ROW_2025, COL_DO_JAN, PLANT_COUNT);
  const reals2025 = extractMonthBlock(ROW_2025, COL_REAL_JAN, PLANT_COUNT);
  const COL_REAL_JAN_HISTORICAL = 7;
  const reals2024 = extractMonthBlock(ROW_2024, COL_REAL_JAN_HISTORICAL, PLANT_COUNT);
  const reals2023 = extractMonthBlock(ROW_2023, COL_REAL_JAN_HISTORICAL, PLANT_COUNT);

  for (let i = 0; i < PLANT_COUNT; i++) {
    const noRow = rekap[ROW_2026 + i] || [];
    const noVal = noRow[COL_NO];
    if (noVal === null || noVal === undefined || noVal === "") continue;
    const noNum = _safeNum(noVal);
    if (!noNum) continue;
    const name = _safeStr(noRow[COL_NAME]);
    if (!name) continue;
    const genco = _safeStr(noRow[COL_GENCO]);
    const code = _safeStr(noRow[COL_CODE]) || ("P" + String(noNum).padStart(3, "0"));
    const boiler = _safeStr(noRow[COL_BOILER]) || "N/A";
    const regional = _safeStr(noRow[COL_REGIONAL]);
    const target_2026 = targets2026[i];
    const target_total = _safeNum(noRow[19]);
    const do_total = _safeNum(noRow[32]);
    const real_2026 = reals2026[i];
    const real_total = _safeNum(noRow[45]);
    const real_pct_raw = _safeNum(noRow[46]);
    const gap_akm = _safeNum(noRow[59]);
    const existing = coordMap[name];
    const lat = existing ? existing.lat : null;
    const lon = existing ? existing.lon : null;
    const plant = {
      no: noNum,
      name,
      genco,
      code,
      boiler,
      regional,
      target_2026,
      target_2026_total: target_total,
      do_2026: dos2026[i],
      do_2026_total: do_total,
      real_2026,
      real_2026_total: real_total,
      real_pct: real_pct_raw,
      gap_2026: gaps2026[i],
      gap_akm,
      sisa_kontrak: sisaKontrak[i],
      kebutuhan_batubara: kebButubara[i],
      jumlah_unit: _safeNum(jumlahUnitArr[i]) || 0,
      kapasitas_per_unit: _safeNum(kapasitasPerUnitArr[i]) || 0,
      total_kapasitas: _safeNum(totalKapasitasArr[i]) || 0,
      historical_real: { "2023": reals2023[i], "2024": reals2024[i], "2025": reals2025[i], "2026": real_2026 },
      historical_target: { "2023": target2023PerPlant[i], "2024": target2024PerPlant[i], "2025": targets2025[i], "2026": target_2026 },
      historical_do: { "2025": dos2025[i], "2026": dos2026[i] },
      lat,
      lon,
      status: (() => {
        if (!target_total) return "no_data";
        const ratio = real_total / target_total;
        if (ratio >= 0.95) return "on_track";
        if (ratio >= 0.70) return "at_risk";
        return "behind";
      })(),
    };
    result.plants.push(plant);
  }

  // monthly aggregate
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (let m = 0; m < 12; m++) {
    let t = 0, r = 0, d = 0;
    for (let i = 0; i < result.plants.length; i++) {
      t += result.plants[i].target_2026[m] || 0;
      r += result.plants[i].real_2026[m] || 0;
      d += result.plants[i].do_2026[m] || 0;
    }
    result.monthly.push({ month: months[m], target: t, real: r, do: d });
  }

  // Pembangkit (Data KIT)
  if (wb.Sheets["Data KIT"]) {
    const kit = _sheetToMatrix(wb.Sheets["Data KIT"]);
    for (let i = 1; i < kit.length; i++) {
      const r = kit[i];
      if (!r) continue;
      const name = _safeStr(r[1]);
      if (!name) continue;
      const lat = _safeNum(r[7]);
      const lon = _safeNum(r[8]);
      if (lat === 0 && lon === 0) continue;
      if (Math.abs(lat) < 1 && Math.abs(lon) < 1) continue;
      result.pembangkit.push({
        no: _safeNum(r[0]) || i,
        nama: name,
        jenis: _safeStr(r[2]),
        unit_induk: _safeStr(r[3]),
        ket: _safeStr(r[4]),
        jumlah_unit: _safeNum(r[5]) || 0,
        total_capacity: _safeNum(r[6]) || 0,
        lat,
        lon,
        sistem: _safeStr(r[9]),
      });
    }
  }

  // GCV (Rekap Kalor)
  if (wb.Sheets["Rekap Kalor"]) {
    const kl = _sheetToMatrix(wb.Sheets["Rekap Kalor"]);
    const GCV_YEARS = [
      { yr: "2023", start: 6, akum: 18 },
      { yr: "2024", start: 19, akum: 31 },
      { yr: "2025", start: 32, akum: 44 },
      { yr: "2026", start: 45, akum: 57 },
    ];
    for (let i = 4; i < Math.min(50, kl.length); i++) {
      const r = kl[i];
      if (!r) continue;
      const name = _safeStr(r[2]);
      if (!name) continue;
      const plant: any = {};
      for (const cfg of GCV_YEARS) {
        const monthly: (number | null)[] = [];
        for (let m = 0; m < 12; m++) {
          const v = _safeNum(r[cfg.start + m]);
          monthly.push(v > 0 ? Math.round(v * 10) / 10 : null);
        }
        const ak = _safeNum(r[cfg.akum]);
        plant[cfg.yr] = { monthly, akum: ak > 0 ? Math.round(ak * 10) / 10 : null };
      }
      result.gcv[name] = plant;
    }
    const totalRow = kl[50];
    if (totalRow) {
      result.gcv_national = {
        "2023": 3008,
        "2024": 3093,
        "2025": 3137,
        "2026": _safeNum(totalRow[57]) > 0 ? Math.round(_safeNum(totalRow[57])) : 0,
      };
    }
  }

  return result;
}

// ---------------- main handler ----------------
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SHAREPOINT_URL = Deno.env.get("SHAREPOINT_DOWNLOAD_URL") || DEFAULT_SHAREPOINT_URL;

function restHeaders(extra: Record<string, string> = {}) {
  return {
    "apikey": SERVICE_KEY,
    "Authorization": `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

Deno.serve(async (_req: Request) => {
  const log: string[] = [];
  const t0 = Date.now();
  const out = (ok: boolean, status = ok ? 200 : 500) =>
    new Response(JSON.stringify({ ok, log, ms: Date.now() - t0 }, null, 2), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  try {
    // 0) Honour the admin pause switch (public.app_control id=1). When paused,
    //    skip the refresh entirely so existing data is preserved until resumed.
    try {
      const pcRes = await fetch(
        `${SUPABASE_URL}/rest/v1/app_control?id=eq.1&select=auto_refresh_paused,updated_by,updated_at`,
        { headers: restHeaders() },
      );
      if (pcRes.ok) {
        const pcRows = await pcRes.json();
        const pc = Array.isArray(pcRows) && pcRows.length ? pcRows[0] : null;
        if (pc && pc.auto_refresh_paused === true) {
          log.push(`⏸ Auto-refresh is PAUSED (by ${pc.updated_by || "?"} at ${pc.updated_at || "?"}). Skipping. Existing data preserved.`);
          return out(true);
        }
      } else {
        log.push(`(app_control check skipped: HTTP ${pcRes.status})`);
      }
    } catch (e) {
      log.push(`(app_control check failed, continuing: ${e instanceof Error ? e.message : String(e)})`);
    }

    // 1) Download the Excel from SharePoint
    log.push(`Downloading: ${SHAREPOINT_URL}`);
    const dl = await fetch(SHAREPOINT_URL, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*",
      },
    });
    log.push(`HTTP ${dl.status} ${dl.statusText} · content-type: ${dl.headers.get("content-type") || "?"}`);
    if (!dl.ok) {
      log.push("✗ Download failed (non-200). Aborting, existing data preserved.");
      return out(false);
    }
    const ct = (dl.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("text/html")) {
      log.push("✗ Got an HTML page (likely a SharePoint login/permission page). The link must be 'Anyone with the link'. Aborting.");
      return out(false);
    }
    const buf = new Uint8Array(await dl.arrayBuffer());
    log.push(`Downloaded ${(buf.length / 1024).toFixed(0)} KB`);

    // 2) Parse
    // Memory-frugal read: only the 3 sheets the prod parser needs, and skip all
    // per-cell metadata (styles/number-formats/formulas/HTML). Parsing every
    // sheet of the full workbook blows the Edge Function memory limit.
    const wb = XLSX.read(buf, {
      type: "array",
      sheets: ["Rekap", "Data KIT", "Rekap Kalor"],
      cellDates: false,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      cellNF: false,
      dense: true,
    });
    log.push(`Workbook sheets parsed: [${Object.keys(wb.Sheets).join(", ")}]`);

    // 3) Fetch current dashboard_data (for coordMap + merge base)
    const curRes = await fetch(
      `${SUPABASE_URL}/rest/v1/dashboard_data?id=eq.1&select=data,uploaded_by,uploaded_at,source_filename,data_summary`,
      { headers: restHeaders() },
    );
    if (!curRes.ok) {
      log.push(`✗ Could not read current dashboard_data: HTTP ${curRes.status}. Aborting.`);
      return out(false);
    }
    const curRows = await curRes.json();
    const currentRow = Array.isArray(curRows) && curRows.length ? curRows[0] : null;
    const existing = (currentRow && currentRow.data) || {};
    const existingPlants = existing.plants || [];

    // 4) Parse prod fields
    const parsed = parseProdExcel(wb, existingPlants);
    log.push(`Parsed: ${parsed.plants.length} plants · ${parsed.pembangkit.length} pembangkit · ${Object.keys(parsed.gcv).length} GCV`);

    // SAFETY: never overwrite with an empty parse
    if (!parsed.plants.length) {
      log.push("✗ Parsed 0 plants — refusing to overwrite. Existing data preserved.");
      return out(false);
    }

    const today = new Date().toISOString().slice(0, 10);
    const merged = {
      ...existing,
      plants: parsed.plants,
      monthly: (parsed.monthly && parsed.monthly.length) ? parsed.monthly : (existing.monthly || []),
      pembangkit: (parsed.pembangkit && parsed.pembangkit.length) ? parsed.pembangkit : (existing.pembangkit || []),
      gcv: (parsed.gcv && Object.keys(parsed.gcv).length) ? parsed.gcv : (existing.gcv || {}),
      gcv_national: parsed.gcv_national || existing.gcv_national,
      last_updated: today,
    };

    const summary = `Auto-refresh (SharePoint) · ${merged.plants.length} plants, ${merged.pembangkit.length} pembangkit, ${Object.keys(merged.gcv || {}).length} GCV`;

    // 5) Backup current → id=2 (best-effort)
    if (currentRow && currentRow.data) {
      const bkRes = await fetch(`${SUPABASE_URL}/rest/v1/dashboard_data?on_conflict=id`, {
        method: "POST",
        headers: restHeaders({ "Prefer": "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify({
          id: 2,
          data: currentRow.data,
          uploaded_by: currentRow.uploaded_by || "",
          uploaded_at: currentRow.uploaded_at || new Date().toISOString(),
          source_filename: currentRow.source_filename || "",
          data_summary: "BACKUP: " + (currentRow.data_summary || ""),
        }),
      });
      log.push(bkRes.ok ? "✓ Backup saved (id=2)" : `⚠ Backup failed: HTTP ${bkRes.status}`);
    }

    // 6) Upsert id=1
    const upRes = await fetch(`${SUPABASE_URL}/rest/v1/dashboard_data?on_conflict=id`, {
      method: "POST",
      headers: restHeaders({ "Prefer": "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        id: 1,
        data: merged,
        uploaded_by: "auto-refresh",
        uploaded_at: new Date().toISOString(),
        source_filename: "SharePoint: Monitoring Produksi",
        data_summary: summary,
      }),
    });
    if (!upRes.ok) {
      const txt = await upRes.text();
      log.push(`✗ Upsert failed: HTTP ${upRes.status} ${txt}`);
      return out(false);
    }
    log.push(`✓ dashboard_data id=1 updated · ${summary}`);
    return out(true);
  } catch (e) {
    log.push("✗ Exception: " + ((e as Error)?.message || String(e)));
    return out(false);
  }
});
