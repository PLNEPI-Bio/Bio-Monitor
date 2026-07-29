// prod-auto-refresh
// Scheduled (pg_cron) Edge Function that downloads the
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
// Deterministic JSON with recursively sorted object keys — used to compare the
// freshly-parsed data against the stored copy (which JSONB returns with keys in
// a different order) without false "changed" results.
function stableStringify(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

// ---------------- prod parser (port of parseProdExcel, prod fields only) ----
function parseProdExcel(wb: XLSX.WorkBook, existingPlants: any[]) {
  const result: any = {
    plants: [],
    monthly: [],
    pembangkit: [],
    gcv: {},
    gcv_national: { "2023": 3008, "2024": 3093, "2025": 3137, "2026": 0 },
    target_fgd_2026: 0,
    target_fgd_2026_monthly: [] as number[],
    target_fgd_2026_plants: {} as Record<string, unknown>,
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
  // V66: The "Rekap" sheet layout can shift between source-file revisions
  // (e.g. a column inserted at the left pushes every column right by one,
  // which silently broke parsing → 0 plants). Detect the header row and the
  // "No" base column dynamically by locating the "No"/"PLTU" header pair, then
  // derive every column relative to it. Falls back to the historical layout.
  let baseCol = 1, headerRow = 3, found = false;
  for (let r = 0; r < 14 && r < rekap.length && !found; r++) {
    const row = rekap[r] || [];
    for (let c = 0; c < row.length - 1; c++) {
      if (_safeStr(row[c]).toLowerCase() === "no" && _safeStr(row[c + 1]).toLowerCase() === "pltu") {
        baseCol = c; headerRow = r; found = true; break;
      }
    }
  }
  const ROW_2026 = headerRow + 1;
  const ROW_2025 = ROW_2026 + 62, ROW_2024 = ROW_2026 + 124, ROW_2023 = ROW_2026 + 187;
  const COL_NO = baseCol, COL_NAME = baseCol + 1, COL_GENCO = baseCol + 2, COL_CODE = baseCol + 3, COL_BOILER = baseCol + 4, COL_REGIONAL = baseCol + 5;
  const COL_TARGET_JAN = baseCol + 6, COL_DO_JAN = baseCol + 19, COL_REAL_JAN = baseCol + 32, COL_GAP_JAN = baseCol + 46;
  const COL_SISA_KONTRAK = baseCol + 59, COL_KEBUTUHAN_BATUBARA = baseCol + 60;
  const COL_JUMLAH_UNIT = baseCol + 61, COL_KAPASITAS_PER_UNIT = baseCol + 62, COL_TOTAL_KAPASITAS = baseCol + 63;
  // Scalar "total"/"%" columns, relative to the No column.
  const COL_TARGET_TOTAL = baseCol + 18, COL_DO_TOTAL = baseCol + 31, COL_REAL_TOTAL = baseCol + 44, COL_REAL_PCT = baseCol + 45, COL_GAP_AKM = baseCol + 58;

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
  const COL_REAL_JAN_HISTORICAL = COL_TARGET_JAN;
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
    const target_total = _safeNum(noRow[COL_TARGET_TOTAL]);
    const do_total = _safeNum(noRow[COL_DO_TOTAL]);
    const real_2026 = reals2026[i];
    const real_total = _safeNum(noRow[COL_REAL_TOTAL]);
    const real_pct_raw = _safeNum(noRow[COL_REAL_PCT]);
    const gap_akm = _safeNum(noRow[COL_GAP_AKM]);
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

  // Target FGD nasional 2026 — sheet "Target 2026 FGD", baris grand-total (Excel row 55).
  // sheet_to_json({header:1}) meng-index RELATIF terhadap origin range sheet, dan
  // used-range sheet ini mulai di B2. Jadi: baris 55 → idx 55-2 = 53.
  //   Kolom bulanan Jan–Des = H..S (abs 7..18) → idx 6..17.
  //   Kolom total tahunan T (abs 19) → idx 18 (= SUM(T56:T58), dipakai kartu "Target FGD").
  // V71: sheet ini juga memuat RINCIAN PER-PLTU (baris 4–54, 51 PLTU) di atas baris
  // grand-total. Layout (idx relatif origin B2): B=No(0) · C=PLTU(1) · D=Genco(2) ·
  // E=Kode(3) · H..S=Jan..Des(6..17) · T=Total(18). Kode di kolom E identik dengan
  // kolom "Kode" sheet Rekap. MIRROR dari parseProdExcel di index.html — jaga tetap sama.
  if (wb.Sheets["Target 2026 FGD"]) {
    const fgd = _sheetToMatrix(wb.Sheets["Target 2026 FGD"]);
    // Header dicari dinamis supaya sisipan baris di atas tabel tidak menggeser parsing.
    let fgdHdr = -1;
    for (let r = 0; r < Math.min(12, fgd.length); r++) {
      const row = fgd[r] || [];
      if (_safeStr(row[1]).toLowerCase() === "pltu" && _safeStr(row[3]).toLowerCase() === "kode") { fgdHdr = r; break; }
    }
    // Hanya di-parse bila header ketemu — kalau layout berubah, lebih baik peta ini
    // kosong daripada memetakan kolom yang salah jadi angka target.
    let fgdTotalRow = -1;
    const fgdPlants: Record<string, unknown> = {};
    if (fgdHdr >= 0) {
      for (let r = fgdHdr + 1; r < fgd.length; r++) {
        const row = fgd[r] || [];
        if (_safeStr(row[0]).toLowerCase() === "total") { fgdTotalRow = r; break; }
        const code = _safeStr(row[3]);
        if (!code) continue;
        const monthly: number[] = [];
        for (let m = 0; m < 12; m++) monthly.push(_safeNum(row[6 + m]));
        const tot = _safeNum(row[18]);
        if (tot <= 0 && !monthly.some((v) => v > 0)) continue;
        fgdPlants[code] = { name: _safeStr(row[1]), total: Math.round(tot), monthly: monthly };
      }
    }
    if (Object.keys(fgdPlants).length) result.target_fgd_2026_plants = fgdPlants;
    const fgdRow = fgd[fgdTotalRow >= 0 ? fgdTotalRow : 53] || [];
    const fgdTotal = _safeNum(fgdRow[18]);
    if (fgdTotal > 0) result.target_fgd_2026 = Math.round(fgdTotal);
    const fgdMonthly: number[] = [];
    for (let m = 0; m < 12; m++) fgdMonthly.push(_safeNum(fgdRow[6 + m]));
    if (fgdMonthly.some((v) => v > 0)) result.target_fgd_2026_monthly = fgdMonthly;
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
    // Memory-frugal read: only the sheets the prod parser needs, and skip all
    // per-cell metadata (styles/number-formats/formulas/HTML). Parsing every
    // sheet of the full workbook blows the Edge Function memory limit.
    const wb = XLSX.read(buf, {
      type: "array",
      sheets: ["Rekap", "Data KIT", "Rekap Kalor", "Target 2026 FGD"],
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
    log.push(`Parsed: ${parsed.plants.length} plants · ${parsed.pembangkit.length} pembangkit · ${Object.keys(parsed.gcv).length} GCV · FGD ${parsed.target_fgd_2026}`);

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
      target_fgd_2026: (parsed.target_fgd_2026 && parsed.target_fgd_2026 > 0) ? parsed.target_fgd_2026 : (existing.target_fgd_2026 || 0),
      target_fgd_2026_monthly: (parsed.target_fgd_2026_monthly && parsed.target_fgd_2026_monthly.length) ? parsed.target_fgd_2026_monthly : (existing.target_fgd_2026_monthly || []),
      // V71: Target FGD per-PLTU (dipakai tooltip peta). Parse kosong tidak menimpa.
      // `kontrak_pasokan_2026` ikut terbawa lewat `...existing` — jangan disentuh di sini.
      target_fgd_2026_plants: (parsed.target_fgd_2026_plants && Object.keys(parsed.target_fgd_2026_plants).length) ? parsed.target_fgd_2026_plants : (existing.target_fgd_2026_plants || {}),
      last_updated: today,
    };

    const summary = `Auto-refresh (SharePoint) · ${merged.plants.length} plants, ${merged.pembangkit.length} pembangkit, ${Object.keys(merged.gcv || {}).length} GCV`;

    // 4b) EGRESS GUARD: skip the write entirely when the parsed data is identical
    // to what's already stored. Writing id=1 fires a Realtime broadcast of the full
    // ~860 KB row to every connected client, so an unconditional write every 10 min
    // burns egress even when SharePoint hasn't changed. We compare only the fields
    // this function actually refreshes (ignoring volatile last_updated / metadata).
    // NOTE: the stored copy comes back from JSONB with object keys re-ordered, so a
    // plain JSON.stringify never matches. stableStringify sorts keys recursively so
    // the comparison is key-order-independent (value-based).
    const sameData =
      stableStringify(merged.plants) === stableStringify(existing.plants) &&
      stableStringify(merged.monthly) === stableStringify(existing.monthly) &&
      stableStringify(merged.pembangkit) === stableStringify(existing.pembangkit) &&
      stableStringify(merged.gcv) === stableStringify(existing.gcv) &&
      stableStringify(merged.gcv_national) === stableStringify(existing.gcv_national) &&
      stableStringify(merged.target_fgd_2026) === stableStringify(existing.target_fgd_2026) &&
      stableStringify(merged.target_fgd_2026_monthly) === stableStringify(existing.target_fgd_2026_monthly) &&
      stableStringify(merged.target_fgd_2026_plants) === stableStringify(existing.target_fgd_2026_plants);
    if (sameData) {
      log.push(`↔ No change vs stored data — skipped write (saves egress). ${summary}`);
      return out(true);
    }

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
