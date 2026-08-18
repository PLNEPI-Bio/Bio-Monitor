# prod-auto-refresh

Scheduled Supabase Edge Function that refreshes the **Produksi** dataset of the
dashboard (`dashboard_data` row `id=1`) every 10 minutes from a public SharePoint
Excel link — the same data the in-browser **Update Data → Produksi** upload writes.

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

> ⚠️ **Jadwal yang sebenarnya aktif belum terverifikasi.** Berkas ini menyebut
> `*/10 * * * *` (tiap 10 menit, 24 jam), sedangkan
> [kontrak-auto-refresh/README.md](../kontrak-auto-refresh/README.md) menyebut
> job ini berjalan "menit 0, 20, 40 di jam UTC 23 dan 0–14" (tiap 20 menit, hanya
> jam kerja WIB). Keduanya tidak bisa benar sekaligus, dan tidak ada di repo ini
> yang bisa menyelesaikannya — `cron.job` adalah satu-satunya sumber kebenaran.
> **Jalankan query di bawah lebih dulu, lalu betulkan salah satu README.**
>
> Kalau yang aktif ternyata jendela WIB 06:00–22:00, itu berarti perubahan
> workbook di luar jam tersebut memang tidak pernah ditarik sampai pagi — bukan
> kerusakan, tapi perlu diketahui.

```sql
-- SUMBER KEBENARAN: jadwal apa yang benar-benar terpasang?
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
dilewati seluruhnya (~200 ms, bukan ~7 detik). Run yang **gagal** sengaja
mengosongkan kolom ini, supaya kegagalan tidak pernah membuat satu perubahan
workbook terlewat diam-diam.

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
