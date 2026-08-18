# prod-auto-refresh

Scheduled Supabase Edge Function that refreshes the **Produksi** dataset of the
dashboard (`dashboard_data` row `id=1`) every 20 minutes during WIB working hours
from a public SharePoint Excel link — the same data the in-browser
**Update Data → Produksi** upload writes.

## What it does

1. Downloads the "Monitoring Produksi" workbook from SharePoint.
2. Parses **only** the prod fields (a faithful port of `parseProdExcel` in
   `index.html`): `plants`, `monthly`, `pembangkit`, `gcv`, `gcv_national`.
3. Merges them into `dashboard_data` id=1, **preserving every other field**
   (bottlenecks, pareto, contracts, usulan, diesel, mou, …). Backs the previous
   row up to id=2 first.
4. **Safety:** if the download returns an HTML/login page or the parse yields
   zero plants, it aborts and leaves the existing data untouched — it never wipes.

The dashboard already subscribes to `dashboard_data` realtime changes, so open
browsers update automatically after each refresh.

## SharePoint link

The reliable anonymous direct-download form for an "Anyone with the link" share is:

```
https://<tenant>-my.sharepoint.com/personal/<user>/_layouts/15/download.aspx?share=<TOKEN>
```

where `<TOKEN>` is the `IQB…` segment of the `:x:/g/personal/…/IQB…` share URL.
The `:x:/g/…?download=1` form returns an HTML app-shell, not the file.

Override without redeploying by setting the `SHAREPOINT_DOWNLOAD_URL` function secret.

## Schedule (pg_cron)

**Terverifikasi 2026-08-18 dari `cron.job`** (kontradiksi antar-README sudah selesai):

```
jobid 1 · prod-auto-refresh-10min · */20 23,0-14 * * * · active
```

Jadi: **tiap 20 menit, hanya pada jam UTC 23 dan 0–14 = 06:00–21:40 WIB.** Nama
job masih mengandung "10min" — itu sisa jadwal lama, bukan jadwal yang berjalan.
Konsekuensinya perubahan workbook di luar jam tersebut memang baru ditarik pagi
berikutnya; itu perilaku yang dipilih, bukan kerusakan.

```sql
-- SUMBER KEBENARAN, kalau jadwalnya diubah lagi:
select jobid, jobname, schedule, active from cron.job order by jobname;
```

Requires extensions `pg_cron` + `pg_net`. The job calls the function with the
project anon key; the function writes using its own service-role key.

```sql
select cron.schedule(
  'prod-auto-refresh-10min',
  '*/10 * * * *',
  $job$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/prod-auto-refresh',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer <ANON_KEY>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $job$
);
```

## Heartbeat — cara tahu fungsi ini masih hidup

Sebelum 2026-08-18 tidak ada cara membedakan **"sumber memang belum berubah"**
dari **"cron sudah mati"**: `dashboard_data.uploaded_at` hanya maju kalau data
berubah, dan run yang tidak menulis tidak meninggalkan jejak apa pun. Ini nyata —
data terlihat basi 4 hari dan tidak seorang pun bisa memastikan penyebabnya
tanpa eksperimen manual.

Tabel [`refresh_heartbeat`](../../migrations/20260818_refresh_heartbeat.sql)
sekarang ditulis pada **setiap** run, termasuk yang gagal:

```sql
-- Masih hidup? Kalau `menit_sejak_dicek` jauh melebihi interval cron, cron-nya bermasalah.
select fn,
       last_run_at,
       round(extract(epoch from (now() - last_run_at)) / 60) as menit_sejak_dicek,
       ok, wrote, duration_ms, source_etag
from public.refresh_heartbeat;

-- Kenapa run terakhir gagal?
select log from public.refresh_heartbeat where fn = 'prod-auto-refresh';
```

Bacanya: **`last_run_at` = kapan terakhir dicek** (kesehatan cron) — terpisah dari
**`dashboard_data.uploaded_at` = kapan data terakhir berubah**. Dua pertanyaan
berbeda yang dulu tercampur jadi satu angka.

`source_etag` menyimpan ETag SharePoint dari run konklusif terakhir. Run berikutnya
melakukan `HEAD` lebih dulu; kalau ETag-nya sama, download 2,6 MB dan parsing XLSX
dilewati seluruhnya. Terukur 2026-08-18: **886 ms** di jalur lewat vs **4,8 detik**
di jalur penuh. Run yang **gagal** sengaja mengosongkan kolom ini, supaya kegagalan
tidak pernah membuat satu perubahan workbook terlewat diam-diam.

### Kenapa ini penting: batas CPU, bukan memori

Jalur penuh (download + parse XLSX) melewati **anggaran CPU per-request** Edge
Runtime. Dibuktikan 2026-08-18 lewat `function_logs`:

```
event_type Shutdown · reason "CPUTime" · "CPU Time exceeded" → HTTP 546 WORKER_RESOURCE_LIMIT
```

Sekitar separuh run mati begini — worker dibunuh di tengah jalan, jadi run itu
**tidak pernah sampai ke penulisan heartbeat di akhir**. Karena itu ada dua
penulisan heartbeat:

| Kapan | Isi | Gunanya |
| :--- | :--- | :--- |
| sebelum download | `ok=false`, log berakhir `⏳ started` | bukti run sempat jalan meski worker dibunuh |
| di setiap exit | verdict sebenarnya + `source_etag` | hasil akhir |

Baris yang lognya berhenti di `⏳ started` = **worker dibunuh CPU**, bukan cron mati.
Beat pertama sengaja tidak mengirim `source_etag` — PostgREST hanya meng-`SET` kolom
yang ada di body, jadi ETag tersimpan selamat dari percobaan yang tidak selesai.

Setelah ETag pertama tersimpan, run normal tidak lagi menyentuh jalur berat sama
sekali, sehingga 546 hanya mungkin muncul pada run setelah workbook benar-benar
berubah. Kalau run seperti itu mati, tidak ada data yang rusak: ETag lama tetap
tersimpan sehingga run berikutnya mencoba lagi.

## Operations

```sql
-- inspect recent runs
select * from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'prod-auto-refresh-10min')
order by start_time desc limit 20;

-- pause / resume
select cron.alter_job((select jobid from cron.job where jobname='prod-auto-refresh-10min'), active := false);

-- remove
select cron.unschedule('prod-auto-refresh-10min');
```

Manual invoke (returns a JSON log of each step):

```sql
select net.http_post(
  url := 'https://<project-ref>.supabase.co/functions/v1/prod-auto-refresh',
  headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <ANON_KEY>'),
  body := '{}'::jsonb
);
-- then: select status_code, content from net._http_response order by id desc limit 1;
```
