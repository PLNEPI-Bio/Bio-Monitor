# checkpoint-pasokan

Menarik data harian pasokan biomassa dari Google Sheet rakor (PNP, PIP, UIW/UIK)
untuk halaman **Checkpoint** (V161, uji coba — Ctrl+K "Checkpoint").

- Satu panggilan = satu PLTU: `POST {code, year, month}`. Klien memanggil paralel
  (4 sekaligus) untuk semua PLTU di wilayah terpilih.
- Sheet diekspor per tab (`export?format=xlsx&gid=…`, ±330 KB). Workbook PNP utuh
  ±20 MB (sebagian besar gambar), jadi tidak pernah diunduh utuh.
- Semua blok bulanan di sheet itu di-parse dan di-upsert ke `checkpoint_pasokan`
  (kunci `code, year, month`). Respons berisi bulan yang diminta.
- `?list=1` → daftar tab per spreadsheet + kode PLTU hasil pemetaan (`code: null`
  = tab tidak dikenal, mis. REKAP, atau tab PLTU yang diganti nama).
- `?dry=1` → parse tanpa menulis cache.

## ID spreadsheet

Tersimpan di tabel `checkpoint_source` (RLS aktif, **tanpa policy** → hanya
service role). **Jangan** taruh ID di `index.html` atau file lain di repo — repo publik.

```sql
update checkpoint_source set sheet_id = '<id baru>', updated_at = now() where src = 'PIP';
```

Tab baru / tab diganti nama → tambah kunci di `SHEET_MAP` (nama tab dinormalisasi
jadi huruf besar + angka saja, mis. `TJ. BLAI KRMN` → `TJBLAIKRMN`) lalu deploy ulang.

## Aturan parse (dari data nyata, 2026-09-29)

| Hal | Aturan |
|---|---|
| Anchor blok | baris berlabel `Tanggal` diikuti label Plan/Confirm/Ready/Real |
| Nama mitra | baris `Pemasok` di atasnya; grup kolom mulai di sel nama (merge 4 kolom) |
| Label kolom | dibaca per label, bukan kelipatan 4 (ada grup tanpa Ready) |
| Bulan | judul blok dulu (tanggal sering tidak diganti saat blok disalin), tanggal sebagai cadangan |
| Tahun | dari **urutan blok**; judul maupun tanggal sama-sama bisa salah tahun |
| Blok ganda | pilih yang judul = tanggal, lalu yang paling banyak terisi; peringatan dicatat |
| Baris ke-31 di bulan 30 hari | ikut dijumlah bila berisi angka, kecuali ternyata subtotal atau bertanggal bulan lain |
| Kolom setelah grup Total | diabaikan (PEL RATU mengulang Ready/Real di sana) |
| Sel error (`#REF!`, `#VALUE!`) | kosong, bukan angka |

Semua anomali ditulis ke `data.warn` dan tampil di kartu PLTU.

## Verifikasi yang sudah dilakukan

Seluruh cache (51 PLTU × semua bulan, 11.701 sel Plan/Confirm/Ready/Real per mitra)
dibandingkan dengan baris **Jumlah** milik sheet sendiri. Selisih yang tersisa semuanya
kesalahan rumus di sheet (rentang `SUM` kurang 1–2 hari, satu angka diketik manual).
