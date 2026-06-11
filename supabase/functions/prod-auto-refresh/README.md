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

Requires extensions `pg_cron` + `pg_net`. The job (`*/10 * * * *`) calls the
function with the project anon key; the function writes using its own
service-role key.

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
