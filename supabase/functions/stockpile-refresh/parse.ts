// parse.ts - pure parsing for stockpile-refresh (no Deno/network), so it can be run
// against the real workbook locally. Input: the "PLTU <nama>" sheets of Rekap Transport
// Biomass as matrices. Column positions are found from the header row, never assumed.

export type Sheet = { name: string; rows: unknown[][] };
export type Plant = { code: string; name: string; lat: number; lon: number };
export type Point = { m: string; j: string; la: number; lo: number; km: number | null };
export type Issue = { pltu: string; mitra: string; titik: string; alasan: string };

const HEADER = "titik penyimpanan";
// The source sheet is one plant; the dashboard splits some of them or names them differently.
const SHEET_ALIAS: Record<string, string[]> = {
  "ASAMASAM": ["ASM"],
  "LABUANBANTEN": ["BLB"],
  "SUMBAWA": ["SBW"],
  "TANJUNGJATI": ["TJB"],
  "PAITON": ["UPTN 1-2", "UPTN 9"],
};
const LAT_MIN = -11.5, LAT_MAX = 7, LON_MIN = 94, LON_MAX = 142;
// A /dir/ link holds both ends; anything this close to the plant is the plant itself.
const SAME_AS_PLANT_KM = 2;
// Lintang tanpa minus: hanya dibalik bila titik jauh dan versi baliknya jelas lebih dekat.
const FLIP_MIN_KM = 150, FLIP_RATIO = 0.5;

const nameKey = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const str = (v: unknown) => (v === null || v === undefined) ? "" : String(v).trim();

export function normJenis(raw: string): string {
  const k = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (!k) return "Lainnya";
  if (k.includes("cangkang") || k === "pks" || k.includes("palmkernel")) return "Cangkang Sawit";
  if (k.includes("sawdust") || k.includes("serbuk")) return "Sawdust";
  if (k.includes("woodchip") || k.includes("serpih")) return "Woodchip";
  if (k.includes("sekam")) return "Sekam Padi";
  if (k.includes("bagas")) return "Bagasse";
  if (k.includes("jagung")) return "Tongkol Jagung";
  if (k.includes("efb") || k.includes("tandan") || k.includes("tankos")) return "Tandan Kosong";
  if (k.includes("pelet") || k.includes("pellet")) return "Wood Pellet";
  return raw.trim();
}

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const dLa = (bLat - aLat) * r, dLo = (bLon - aLon) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLo / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function inBox(la: number, lo: number) {
  return la >= LAT_MIN && la <= LAT_MAX && lo >= LON_MIN && lo <= LON_MAX;
}
function pair(la: number, lo: number): [number, number] | null {
  if (!isFinite(la) || !isFinite(lo)) return null;
  if (inBox(la, lo)) return [la, lo];
  if (inBox(lo, la)) return [lo, la];
  // Tanda salah tetap dikembalikan bila bujurnya masuk Indonesia; lihat fixSign().
  if (Math.abs(la) <= 15 && lo >= LON_MIN && lo <= LON_MAX) return [la, lo];
  return null;
}

// "0°30'04.5\"S 110°21'32.0\"E", "N4.26682979 E96.07626651", "3.8151845N, 96.7649492E",
// "0,718854, 124,299455", "-7.66,109.12".
export function coordFromText(input: string): [number, number] | null {
  const s = input.replace(/[’′`]/g, "'").replace(/[”″]|''/g, '"').replace(/[⁰º˚]/g, "°")
    .replace(/\s+/g, " ").replace(/-\s+(?=\d)/g, "-").trim();
  const dms = [...s.matchAll(/(\d{1,3})\s*°\s*(\d{1,2})\s*'\s*(\d{1,2}(?:[.,]\d+)?)\s*"?\s*([NSEWnsew])/g)];
  if (dms.length >= 2) {
    const val = (m: RegExpMatchArray) => {
      const v = Number(m[1]) + Number(m[2]) / 60 + Number(m[3].replace(",", ".")) / 3600;
      return /[SWsw]/.test(m[4]) ? -v : v;
    };
    const a = dms[0], b = dms[1];
    return /[NSns]/.test(a[4]) ? pair(val(a), val(b)) : pair(val(b), val(a));
  }
  let m = /(\d+(?:\.\d+)?)\s*[EWew][,\s]+(\d+(?:\.\d+)?)\s*([NSns])/.exec(s);
  if (m) return pair((/[Ss]/.test(m[3]) ? -1 : 1) * Number(m[2]), Number(m[1]));
  m = /^[^\d-]*([NSns])\s*(\d+(?:\.\d+)?)[,\s]+([EWew])\s*(\d+(?:\.\d+)?)/.exec(s);
  if (m) return pair((/[Ss]/.test(m[1]) ? -1 : 1) * Number(m[2]), Number(m[4]));
  m = /(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])[,\s]+(\d+(?:\.\d+)?)\s*°?\s*[EWew]/.exec(s);
  if (m) return pair((/[Ss]/.test(m[2]) ? -1 : 1) * Number(m[1]), Number(m[3]));
  m = /(-?\d{1,3}),(\d{3,})[,;\s]+(-?\d{1,3}),(\d{3,})/.exec(s);
  if (m) return pair(Number(`${m[1]}.${m[2]}`), Number(`${m[3]}.${m[4]}`));
  m = /(-?\d{1,3}\.\d+)\s*°?\s*[,;\s]\s*(-?\d{1,3}\.\d+)/.exec(s);
  if (m) return pair(Number(m[1]), Number(m[2]));
  return null;
}

const isUrl = (s: string) => /google\.[a-z.]+\/maps|maps\.google|goo\.gl|maps\.app/i.test(s);
export const isShortLink = (s: string) => /(^|\/\/)(maps\.app\.goo\.gl|goo\.gl)\//i.test(s);

function safeDecode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s.replace(/\+/g, " "); }
}

// Waypoints/places of a long Google Maps URL, most trustworthy first.
export function coordsFromUrl(url: string): [number, number][] {
  const out: [number, number][] = [];
  const add = (c: [number, number] | null) => { if (c) out.push(c); };
  const path = url.split(/[?#]/)[0];
  const dir = /\/maps\/dir\/(.*)$/.exec(path);
  if (dir) {
    for (const seg of dir[1].split("/")) {
      if (!seg || seg.startsWith("@") || seg.startsWith("data=")) continue;
      add(coordFromText(safeDecode(seg)));
    }
    // Place-name waypoints carry their position as !1d<lon>!2d<lat> inside data=.
    for (const m of url.matchAll(/!1d(-?\d+\.\d+)!2d(-?\d+\.\d+)/g)) add(pair(Number(m[2]), Number(m[1])));
    return out;
  }
  const place = /\/maps\/place\/([^/]*)/.exec(path);
  if (place) add(coordFromText(safeDecode(place[1])));
  const pin = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(url);
  if (pin) add(pair(Number(pin[1]), Number(pin[2])));
  const q = /[?&](?:q|query|ll|destination)=([^&]+)/.exec(url);
  if (q) add(coordFromText(safeDecode(q[1])));
  // @lat,lon is only the viewport centre: the last resort.
  const at = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(url);
  if (at) add(pair(Number(at[1]), Number(at[2])));
  return out;
}

function fixSign(c: [number, number], p: Plant): { c: [number, number]; flipped: boolean } {
  const d = haversineKm(c[0], c[1], p.lat, p.lon);
  const f = haversineKm(-c[0], c[1], p.lat, p.lon);
  if (d > FLIP_MIN_KM && f < d * FLIP_RATIO) return { c: [-c[0], c[1]], flipped: true };
  return { c, flipped: false };
}

// "2,9" -> 2.9; "70,55 NM" -> 130.66; "1.234,5" tidak dipakai di sumber.
export function parseKm(v: unknown): number | null {
  if (typeof v === "number") return isFinite(v) && v > 0 ? v : null;
  const s = str(v);
  const m = /(\d+(?:[.,]\d+)?)/.exec(s);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  if (!isFinite(n) || n <= 0) return null;
  return /\bNM\b/i.test(s) ? Math.round(n * 1.852 * 100) / 100 : n;
}

function findHeader(rows: unknown[][]): { r: number; titik: number; mitra: number; jenis: number; jarak: number } | null {
  for (let r = 0; r < Math.min(rows.length, 8); r++) {
    const cells = (rows[r] || []).map((c) => str(c).toLowerCase());
    const titik = cells.indexOf(HEADER);
    if (titik < 0) continue;
    const at = (n: string) => cells.findIndex((c) => c.startsWith(n));
    return { r, titik, mitra: at("mitra"), jenis: at("biomassa"), jarak: at("jarak") };
  }
  return null;
}

// Some cells show a place name and keep the real link as an Excel hyperlink.
export function cellText(value: unknown, hyperlink?: string): unknown {
  if (!hyperlink || typeof value !== "string") return value;
  const v = value.trim().toLowerCase();
  return (v.startsWith("http") || v.startsWith("google.") || v.startsWith("maps.") || /\d/.test(v.slice(0, 4))) ? value : hyperlink;
}

export function pltuSheets<T extends { name: string }>(sheets: T[]): T[] {
  return sheets.filter((s) => /^PLTU\s/i.test(s.name));
}

export function collectShortLinks(sheets: Sheet[]): string[] {
  const set = new Set<string>();
  for (const s of pltuSheets(sheets)) {
    const h = findHeader(s.rows);
    if (!h) continue;
    for (const row of s.rows.slice(h.r + 1)) {
      const t = str(row?.[h.titik]);
      if (isShortLink(t)) set.add(t);
    }
  }
  return [...set];
}

export function buildStockpile(sheets: Sheet[], plants: Plant[], shortMap: Record<string, string>) {
  const byName = new Map<string, Plant>();
  for (const p of plants) byName.set(nameKey(p.name), p);
  const byCode = new Map(plants.map((p) => [p.code, p]));
  const data: Record<string, Point[]> = {};
  const issues: Issue[] = [];
  const unmatchedSheets: string[] = [];
  let rowsRead = 0, flipped = 0;

  for (const s of pltuSheets(sheets)) {
    const label = s.name.replace(/^PLTU\s+/i, "").trim();
    const key = nameKey(label);
    const targets = (SHEET_ALIAS[key] || []).map((c) => byCode.get(c)).filter(Boolean) as Plant[];
    if (!targets.length && byName.has(key)) targets.push(byName.get(key)!);
    const h = findHeader(s.rows);
    if (!targets.length || !h) { unmatchedSheets.push(s.name); continue; }
    const plant = targets[0];
    const points: Point[] = [];
    // Mitra & Biomassa are merged downward in the sheet; merged cells arrive empty.
    let mitra = "", jenis = "";
    for (const row of s.rows.slice(h.r + 1)) {
      const rowMitra = h.mitra >= 0 ? str(row?.[h.mitra]) : "";
      const rowJenis = h.jenis >= 0 ? str(row?.[h.jenis]) : "";
      if (rowMitra) mitra = rowMitra;
      if (rowJenis) jenis = rowJenis;
      const titik = str(row?.[h.titik]).replace(/^titik koordinat\s*:\s*/i, "");
      if (!titik) continue;
      rowsRead++;
      const report = (alasan: string) => issues.push({ pltu: label, mitra, titik: titik.slice(0, 200), alasan });
      let source = titik;
      if (isShortLink(titik)) {
        source = shortMap[titik] || "";
        if (!source) { report("Shortlink gagal dibuka"); continue; }
      }
      let cand: [number, number][];
      if (isUrl(source)) cand = coordsFromUrl(source);
      else { const c = coordFromText(source); cand = c ? [c] : []; }
      if (!cand.length) { report("Koordinat tidak terbaca"); continue; }
      // Only a /dir/ link has the plant as its other end; a lone point near the plant is
      // a real stockpile at the site.
      const isDir = isUrl(source) && /\/maps\/dir\//.test(source);
      const pick = isDir ? cand.find((c) => haversineKm(c[0], c[1], plant.lat, plant.lon) > SAME_AS_PLANT_KM) : cand[0];
      if (!pick) { report("Link hanya berisi lokasi PLTU"); continue; }
      // Google URLs carry the correct sign; only hand-typed coordinates can lose it.
      const fx = isUrl(source) ? { c: pick, flipped: false } : fixSign(pick, plant);
      if (!inBox(fx.c[0], fx.c[1])) { report("Koordinat di luar Indonesia"); continue; }
      if (fx.flipped) { flipped++; report("Tanda lintang dibalik otomatis, mohon cek"); }
      const km = h.jarak >= 0 ? parseKm(row?.[h.jarak]) : null;
      const la = Math.round(fx.c[0] * 1e5) / 1e5, lo = Math.round(fx.c[1] * 1e5) / 1e5;
      if (points.some((p) => p.la === la && p.lo === lo && p.m === mitra)) continue;
      const straight = haversineKm(la, lo, plant.lat, plant.lon);
      // Garis lurus tidak mungkin jauh lebih panjang dari jarak tempuh tercatat: koordinat salah.
      if (km !== null && straight > km * 1.5 + 50) { report(`Dilewati: titik ${Math.round(straight)} km dari PLTU, jarak tercatat ${km} km`); continue; }
      points.push({ m: mitra, j: normJenis(jenis), la, lo, km });
    }
    for (const p of targets) data[p.code] = points;
  }
  return { data, issues, unmatchedSheets, rowsRead, flipped };
}
