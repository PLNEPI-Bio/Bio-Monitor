# kontrak-auto-refresh

Scheduled Supabase Edge Function yang menarik **Daftar Kontrak / Rencana Pasokan** per
PLTU dari folder SharePoint dan menyimpannya ke tabel **`kontrak_pasokan`** row id=1,
kolom `data` (peta `{ kode_pltu: ton }`).

## Kenapa tabel sendiri

Awalnya data ini disimpan sebagai field di dalam `dashboard_data.data`. Itu keliru:
blob tersebut (~900 KB) ditulis ulang **utuh** oleh `prod-auto-refresh` tiap 20 menit
lewat baca-ubah-tulis. Bila dua penulis berjalan berdekatan, yang menulis belakangan
memakai snapshot usang dan field milik penulis lain lenyap — `kontrak_pasokan_2026`
benar-benar hilang karena ini pada 2026-07-29.

Tabel terpisah menghapus kelas bug itu sepenuhnya: `prod-auto-refresh` secara struktural
tidak bisa menyentuhnya. Fungsi ini tetap **membaca** `dashboard_data` (hanya
`data->plants`, ~109 KB, untuk memetakan nama file → kode PLTU) tetapi tidak pernah
menulisnya.

Skema:

| Kolom | Isi |
| :--- | :--- |
| `data` | `{ kode_pltu: ton }` |
| `n_pltu` | jumlah PLTU pada parse terakhir |
| `source_url` | link share yang dipakai |
| `last_ok_at` / `last_error` | kesehatan run terakhir |

RLS: baca publik (dashboard memakai anon key), **tanpa policy write** — penulisan hanya
lewat service-role di edge function. Klien memuatnya via `fetchKontrakPasokan()`.

Dipakai oleh tooltip Map Cofiring sebagai baris **"Kontrak 2026"**, dan menjadi dasar
**tanda seru** pada ikon PLTU (muncul bila Kontrak < Target FGD).

## Sumber data

Folder share anonim berisi dua subfolder:

| Subfolder | Isi | Konvensi nama |
| :--- | :--- | :--- |
| `PIP` | 28 workbook (PIP + UIW + 2 UIK) | `Profil_Pasokan_<Nama PLTU>_<GENCO>_2026.xlsx` |
| `PNP` | 20 workbook + 1 kertas kerja | `<NAMA PLTU>.xlsx` |

Di tiap workbook: sheet **"Profil Pasokan"**, bagian *"2. RENCANA PASOKAN BULANAN — per
Mitra"*. Baris totalnya berlabel **"TOTAL RENCANA PASOKAN BULANAN"** di kolom B; kolom
G–R = Jan–Des, kolom **S = SUM**.

Baris total **tidak berada di posisi tetap** (teramati di baris 32, 33, dan 34 tergantung
jumlah mitra), sehingga dicari berdasarkan **label**, bukan nomor baris. Kolom S dibaca
lebih dulu; bila kosong, G–R dijumlahkan sebagai cadangan.

3 dari 51 PLTU tidak punya workbook (unit ekspansi UIK: Lontar 4, Asam Asam 5-6,
Barru 3) — kodenya absen dari peta dan tooltip menampilkan "belum tersedia".

## Akses SharePoint

Link share anonim (`:f:/g/…`) **tidak bisa** langsung diunduh. Alurnya:

1. **Redeem** link share → SharePoint menerbitkan cookie `FedAuth`.
   Redirect harus diikuti **manual**; dengan `redirect: "follow"` header `Set-Cookie`
   perantara tidak terbaca.
2. **Listing root** via `/_api/v2.0/shares/u!<base64url>/driveItem/children` — jalan
   tanpa autentikasi sama sekali. Menghasilkan `driveId` + id subfolder.
3. **Turun ke subfolder** via `/_api/v2.0/drives/{driveId}/items/{id}/children` —
   langkah inilah yang memerlukan cookie tadi.
4. Unduh tiap file lewat `@content.downloadUrl` dari hasil listing. Token URL itu
   **cepat kedaluwarsa**, jadi listing dan unduhan harus terjadi dalam run yang sama.

Ganti link tanpa redeploy lewat function secret `KONTRAK_SHARE_URL`.

## Pengaman

- Peta dengan < 20 PLTU **ditolak** (`MIN_PLANTS`) — melindungi dari link dicabut atau
  folder diacak.
- Hanya field `kontrak_pasokan_2026` yang diganti; field lain diteruskan apa adanya.
- Peta yang tidak berubah → tulis dilewati (menghemat egress; tulis ke id=1 menyiarkan
  seluruh baris ~860 KB lewat Realtime).
- File yang namanya tidak cocok PLTU mana pun dilewati — inilah yang menyaring
  "Z Kertas Kerja FGD…".

## Dry run

Tambahkan `?dry=1` untuk menjalankan seluruh pipeline **tanpa menulis apa pun**. Berguna
untuk verifikasi dan diagnosis.

```sql
select net.http_post(
  url := 'https://emezjgefsgpsxucqfypa.supabase.co/functions/v1/kontrak-auto-refresh?dry=1',
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <ANON_KEY>'),
  body := '{}'::jsonb,
  timeout_milliseconds := 150000
);
-- lalu:
select status_code, content from net._http_response order by id desc limit 1;
```

## Jadwal (pg_cron)

Aktif sebagai `kontrak-auto-refresh-monthly`, **tanggal 1 tiap bulan pukul 01:10 UTC =
08:10 WIB**. Jam UTC sengaja dipilih agar tanggalnya tetap tanggal 1 di WIB maupun UTC.

> Menit 10 dipilih agar tidak berbarengan dengan `prod-auto-refresh` (menit 0, 20, 40 di
> jam UTC 23 dan 0–14). Sejak data pindah ke tabel sendiri, tabrakan jadwal **tidak lagi
> merusak data** — keduanya menulis tabel berbeda. Jarak ini sekarang sekadar menghindari
> dua fungsi berat berjalan serempak, bukan pengaman korupsi data.

```sql
select cron.schedule(
  'kontrak-auto-refresh-monthly',
  '10 1 1 * *',
  $job$
  select net.http_post(
    url := 'https://emezjgefsgpsxucqfypa.supabase.co/functions/v1/kontrak-auto-refresh',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer <ANON_KEY>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $job$
);
```

Runtime terukur: **~6 detik** untuk 48 workbook, jadi timeout 150 s sangat longgar.

## Operasional

```sql
-- riwayat eksekusi
select * from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'kontrak-auto-refresh-monthly')
order by start_time desc limit 20;

-- jeda / lanjutkan
select cron.alter_job((select jobid from cron.job where jobname='kontrak-auto-refresh-monthly'), active := false);

-- hapus
select cron.unschedule('kontrak-auto-refresh-monthly');
```

**Catatan:** jadwal bulanan berarti satu kegagalan = data basi sebulan penuh. Karena
tulis dilewati saat data tidak berubah, mengubah jadwal jadi `0 1 1-3 * *` (tanggal 1–3)
memberi percobaan ulang otomatis tanpa efek samping.
