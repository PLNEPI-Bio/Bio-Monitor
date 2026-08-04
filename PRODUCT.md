# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Pengguna utama:** tim operasional biomassa PT PLN EPI, bekerja harian di desktop kantor.
Pekerjaannya: memantau apakah pasokan biomassa cofiring di 51 PLTU mengejar target, dan bila
tertinggal — menemukan di mana serta mengapa.

**Penerima keluaran (bukan pengguna harian):** manajemen. Mereka menerima laporan yang
dihasilkan dari tab Laporan, bukan membuka dashboard-nya sendiri.

Peran yang ada di kode, dari yang paling berwenang:

| Peran | Siapa | Kewenangan |
| :--- | :--- | :--- |
| Admin | `Maulana - Admin` | Seluruh akses, termasuk upload & revert |
| Upload | `Namira`, `Isna`, `Mahmut` | Upload data Excel, revert versi |
| DO editor | `Ridho - Upload` | Hanya override Delivery Order di popup kontrak |
| Usulan | daftar `USULAN_ALLOWED_NAMES` | Mengisi usulan kontrak |
| Akses umum | selain di atas | Baca saja |

## Product Purpose

Satu tempat untuk memantau realisasi pasokan biomassa cofiring 51 PLTU terhadap target
2023–2026, menemukan penyebab kekurangan pasokan, dan menghasilkan laporan yang dikirim ke atas.

Berhasil bila tim tahu PLTU mana yang tertinggal dan apa penyebabnya tanpa harus membuka
belasan workbook Excel terlebih dahulu.

## Positioning

Menyatukan data yang sebelumnya tersebar — data produksi, Delivery Order dari SharePoint,
48 workbook "Profil Pasokan" per PLTU, dan kontrak mitra — ke dalam satu tampilan yang
menyegarkan dirinya otomatis.

Yang tidak bisa ditiru begitu saja oleh spreadsheet atau BI tool umum: kosakata, satuan, dan
hierarki informasinya mengikuti alur kerja biomassa PLN EPI secara spesifik — cofiring, GCV,
DO, MoU, usulan kontrak — bukan abstraksi generik "metrik dan dimensi".

## Operating Context

- Desktop kantor, dipakai harian. Mobile bottom nav ada (map, realisasi, bottleneck, kontrak,
  more) tetapi merupakan surface sekunder, bukan yang utama.
- Data masuk lewat dua jalur: tiga cron edge function otomatis, dan upload Excel manual oleh
  peran Upload. Keduanya menulis ke tabel berbeda dan tidak boleh saling menimpa.
- Keluaran tab Laporan (infografis, PDF) dipresentasikan ke atas. Tab itu karena itu adalah
  produk komunikasi, bukan sekadar alat kerja internal — beda dari sepuluh tab lainnya.
- Login berbasis nama di sisi klien. Penjagaan yang sebenarnya ada di RLS Supabase.
- Dijalankan dengan membuka `index.html` langsung di browser; deploy statis.

## Capabilities and Constraints

**Sebelas tab:** Map Cofiring · Overview Pembangkit · Fasilitas Produksi · Realisasi 2023–2026 ·
Bottleneck · Pareto Loss · Daftar Kontrak · Monitoring MoU · Usulan Kontrak · Berita · Laporan.

**Sumber data (Supabase):** `dashboard_data`, `do_data`, `kontrak_pasokan`, `upload_log`,
`bottleneck_entries`, `laporan_arsip`, `usulan_base`/`usulan_tahap`, `app_control`.

**Jalur otomatis:** tiga Deno edge function — DO dari SharePoint, data produksi (tiap 20 menit),
dan 48 workbook Profil Pasokan per PLTU.

**Kosakata wajib** — istilah ini adalah bahasa kerja tim, jangan diterjemahkan atau diganti
istilah BI generik: PLTU, cofiring, biomassa, realisasi, target, gap, achievement ratio,
pareto loss, bottleneck, DO (Delivery Order), MoU, GCV, kontrak pasokan, usulan kontrak, mitra.

**Batasan teknis yang mengikat:**

- Seluruh aplikasi satu file statis (`index.html`). Tanpa framework, bundler, atau build step —
  ini keputusan arsitektur, bukan utang teknis.
- Library hanya lewat tag CDN dengan versi terkunci. Tanpa dependensi npm.
- Tidak ada test runner, linter, maupun type checker. Review manual adalah satu-satunya gate.

**Fakta yang sengaja belum diputuskan** — jangan diasumsikan ke salah satu arah:

- Status kerahasiaan data (nilai kontrak, nama mitra, angka pasokan) belum ditetapkan.
- Standar aksesibilitas formal belum ditetapkan.

## Brand Commitments

- Nama produk dan pemilik: PT PLN EPI (PLN Energi Primer Indonesia).
- **Identitas korporat PLN bersifat mengikat.** Warna, logo, dan penggunaan identitas tidak
  bebas ditafsirkan ulang oleh pekerjaan desain berikutnya.
- Seluruh teks antarmuka berbahasa Indonesia.

Nilai warna, font, dan token visual yang saat ini dipakai ada di dalam kode, tetapi belum
dicatat sebagai sistem. Itu urusan DESIGN.md, bukan berkas ini.

## Evidence on Hand

- Data realisasi dan produksi 51 PLTU, live di Supabase (bukan data contoh).
- `preview.png` dan `preview.jpg` di root repo.
- `CLAUDE.md` — konvensi kode dan aturan kerja pada file 21.541 baris ini.
- `docs/agent-teams.md` — referensi agent teams.

**Yang tidak ada, dan tidak boleh dikarang oleh pekerjaan berikutnya:** tidak ada testimoni,
studi kasus, benchmark, liputan pers, data harga, atau klaim lisensi. Angka PLTU, kapasitas,
dan realisasi harus berasal dari data Supabase — tidak pernah diisi contoh.

## Product Principles

1. **Angka yang salah lebih berbahaya daripada tampilan yang jelek.** Repo ini tidak punya
   jaring pengaman otomatis; perubahan yang menyentuh perhitungan diverifikasi sebelum tampil.
2. **Operate dulu, presentasi kemudian — kecuali tab Laporan.** Sepuluh tab melayani
   penyelesaian tugas: kepadatan, konsistensi, keterbacaan cepat. Tab Laporan melayani
   pembaca di luar tim dan boleh menuntut standar komunikasi yang berbeda.
3. **Jalur data otomatis dan manual tidak boleh saling menimpa.** Dua penulis
   baca-ubah-tulis pada baris yang sama pernah menghilangkan field; pemisahan tabel adalah
   pelajaran yang dibayar mahal, bukan preferensi.
4. **Kosakata tim menang atas istilah generik.** Antarmuka memakai bahasa yang dipakai orang
   biomassa PLN EPI di ruangan, bukan padanan BI-nya.
5. **Satu file statis adalah keputusan, bukan kekurangan.** Usulan yang mensyaratkan build
   step bukan peningkatan bagi produk ini.
