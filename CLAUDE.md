# Bioenergy Dashboard — PLN EPI

Dashboard monitoring biomassa 51 PLTU untuk PT PLN EPI: map cofiring, realisasi 2023–2026,
bottleneck, pareto loss, kontrak mitra, generator laporan infografis, dan upload data Excel
ke Supabase.

## Struktur

**Seluruh aplikasi ada di satu file.** Tidak ada `package.json`, framework, bundler, atau build step.

```
index.html                                    ← 21.786 baris / 1,6 MB — SELURUH app
  ~60–4700    <style>  CSS
  ~4700–6440  markup   gate auth, header, tab bar, panel, modal
  ~6440–akhir <script> vanilla JS, semua fungsi global
supabase/functions/do-auto-refresh/index.ts   ← Deno cron: SharePoint DO → tabel do_data
supabase/functions/prod-auto-refresh/index.ts ← Deno cron: data produksi
supabase/functions/kontrak-auto-refresh/index.ts ← Deno cron: 48 workbook "Profil Pasokan"
                                                   per PLTU → dashboard_data.kontrak_pasokan_2026
docs/agent-teams.md                           ← referensi agent teams
```

Dijalankan dengan membuka `index.html` langsung di browser (`.vscode/launch.json`). Deploy statis.

**Library via CDN, versi terkunci:** Leaflet 1.9.4 + leaflet.heat, Chart.js 4.4.0,
supabase-js 2.45.4, xlsx 0.18.5, xlsx-js-style 1.2.0, jsPDF 2.5.1. Font Plus Jakarta Sans.

## Aturan kerja di file sebesar ini

1. **Jangan pernah `Read` `index.html` utuh** — grep dulu untuk nomor baris, baca jendela ±40 baris.
2. **Jangan pernah `Write` `index.html`** — hanya `Edit` dengan `old_string` unik dan sempit.
3. **Jangan usulkan React/Vue/Tailwind/build step.** Single-file statis adalah keputusan arsitektur.
4. **Jangan tambah dependensi npm** — library masuk lewat tag CDN di `<head>`.
5. Grep kata umum (`target`, `filter`, `weight`) akan tertimbun match CSS — batasi ke zona JS.

## Konvensi

- Fungsi global `camelCase`; helper privat prefix `_` (`_lpNum`, `_doNormK`, `_pickPareto`).
- Fungsi render: `render<Area><Bagian>` — `renderParetoMainChart`, `renderLaporanArsip`.
- Handler dipasang inline di markup: `onclick="switchTab('pareto')"`.
- Penanda revisi `// V63:` pada perubahan non-sepele (kini kisaran V60-an, nomor menaik).
- Warna lewat CSS custom property (`var(--accent)`, `var(--panel-2)`); status: `#10b981` aman,
  `#f59e0b` waspada, `#ef4444` kritis.
- Teks UI bahasa Indonesia. Commit: `Area: deskripsi singkat` (mis. `Kontrak: sorting di tabel popup`).

## Pola inti

- Global `state` (tab aktif + semua filter) dan `DATA` (plants, monthly, bottlenecks, pareto,
  contracts, pembangkit, mou, gcv).
- **Tidak ada reaktivitas.** Ubah `state` → panggil `render*` terkait secara manual.
- 11 tab. Desktop `.tab[data-tab]` → `switchTab()`. Mobile `.mobile-nav-item[data-mob-tab]` →
  `mobNav()`. **Menambah tab berarti mengurus keduanya.**
- Chart.js: instance di registry `realCharts.*`, `paretoCharts.*`, `insightsCharts.*`,
  `trendChart`, `kontrakJenisPieChart`. **Selalu `.destroy()` sebelum `new Chart()` di canvas sama.**
- Supabase: `dashboard_data`, `upload_log`, `bottleneck_entries`, `laporan_arsip`,
  `usulan_base`/`usulan_tahap`, `do_data`, `kontrak_pasokan`, `app_control`.
- **`dashboard_data.data` (~900 KB) ditulis ulang UTUH oleh `prod-auto-refresh` tiap 20
  menit.** Jangan menaruh data yang ditulis proses lain di dalamnya — dua penulis
  baca-ubah-tulis akan saling menimpa dan field bisa lenyap (terjadi 2026-07-29). Data
  milik proses lain masuk tabel sendiri: `do_data`, `kontrak_pasokan`.
- `do_data`: kolom `auto` (hasil cron) + `overrides` (manual admin) digabung saat render.
  **Jalur otomatis tidak boleh menyentuh `overrides`.**
- Auth berbasis nama di klien (`UPDATE_ADMIN_NAMES`, `isAdminRole()`). Keamanan sebenarnya
  bergantung pada RLS Supabase — anon key memang ada di sumber, service-role key **tidak boleh**.

## Subagent

Lima subagent di [.claude/agents/](.claude/agents/):

| Agent | Model | Akses | Kapan dipanggil |
| :--- | :--- | :--- | :--- |
| **marco** | haiku | read-only | Sebelum agent lain menyentuh apa pun — cari nomor baris fungsi, canvas id, tabel, blok CSS |
| **leo** | sonnet | tulis | Peta, chart, modal, filter, tabel, layout responsif |
| **atlas** | sonnet | tulis | Parser Excel, skema & query Supabase, versioning/revert, edge function SharePoint DO |
| **gauss** | sonnet | read-only | Setiap perubahan yang menyentuh angka: target, realisasi, gap, achievement ratio, pareto loss, pembobotan |
| **sherlock** | **opus** | read-only | Sebelum commit. **Wajib** untuk perubahan auth/login dan upload/revert data |

Asal nama: **marco** = Marco Polo, penjelajah · **leo** = Leonardo da Vinci, pelukis ·
**atlas** = titan yang memikul dunia (fondasi data) · **gauss** = Carl F. Gauss, ahli hitung ·
**sherlock** = Sherlock Holmes, detektif pencari kesalahan sebelum commit.

**Dipanggil dengan nama.** Bila user menyebut nama agent ("Marco, cari ...", "minta Sherlock
review"), itu permintaan eksplisit untuk menjalankan agent tersebut lewat Agent tool.

Model bukan seragam karena taruhannya tidak seragam. `marco` cuma grep-and-report → haiku. Penulis
dapat sonnet. `sherlock` dapat opus karena **repo ini tidak punya test/linter/type checker** —
review manual adalah gate terakhir, dan kesalahan yang lolos di sini tidak punya jaring kedua.

**Eskalasi per-pemanggilan.** Parameter `model` pada Agent tool menang atas frontmatter. Naikkan
`atlas` ke opus untuk tiga area blast-radius tinggi: penulisan `dashboard_data`, alur
upload/revert, dan edge function cron di `supabase/functions/`. Default tetap sonnet.

### Urutan kerja yang disarankan

```
marco  →  leo / atlas  →  [gauss]  →  sherlock  →  commit
                           ↑ bila menyentuh perhitungan
```

1. **marco** dulu, selalu. Dapatkan lokasi persis sebelum ada yang mengedit — ini yang
   mencegah agent lain membaca file 1,6 MB dan kehabisan context.
2. **leo** atau **atlas** mengerjakan perubahan sesuai lapisannya.
3. **gauss** bila perubahan menyentuh rumus perhitungan. Read-only: ia melaporkan,
   tidak memperbaiki. Temuan metodologi yang ambigu dikembalikan sebagai **isu terbuka untuk
   didiskusikan** — bukan diputuskan sendiri oleh agent.
4. **sherlock** sebelum commit. Untuk perubahan auth/login atau timpa data (upload/revert),
   ia memberi peringatan eksplisit dan meminta review manual tambahan.

Untuk perubahan sepele satu baris, urutan penuh ini berlebihan — kerjakan langsung, tetap lewat
sherlock bila menyentuh area sensitif.

## Verifikasi

**Tidak ada test runner, linter, atau type checker.** Review manual adalah satu-satunya gate.
Karena itu: nyatakan dengan jujur apa yang belum diuji di browser. Jangan mengklaim "sudah dites"
kalau hanya membaca kode.
