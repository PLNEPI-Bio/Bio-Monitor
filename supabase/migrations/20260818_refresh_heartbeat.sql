-- refresh_heartbeat
-- Satu baris per edge function terjadwal. Ditulis pada SETIAP run — sukses,
-- "tidak ada perubahan", maupun gagal.
--
-- Kenapa tabel ini ada:
-- `dashboard_data.uploaded_at` hanya maju ketika DATA berubah. Akibatnya
-- "sumber memang belum berubah selama 4 hari" dan "cron sudah mati selama
-- 4 hari" terlihat persis sama dari luar — tidak ada cara membedakannya
-- tanpa eksperimen manual. Itu yang terjadi pada 2026-08-18.
--
-- Baris ini memisahkan dua pertanyaan berbeda:
--   last_run_at  → kapan terakhir DICEK   (kesehatan cron)
--   wrote/ok     → apakah run itu menulis (perubahan data)

create table if not exists public.refresh_heartbeat (
  fn           text primary key,
  last_run_at  timestamptz not null default now(),
  ok           boolean     not null default false,
  wrote        boolean     not null default false,
  duration_ms  integer,
  source_etag  text,
  log          text
);

comment on column public.refresh_heartbeat.source_etag is
  'ETag SharePoint dari run sukses terakhir. Dipakai run berikutnya untuk melewati '
  'download 2,6 MB bila berkas tidak berubah. Sengaja dikosongkan saat run gagal, '
  'supaya kegagalan tidak pernah membuat perubahan terlewat diam-diam.';

alter table public.refresh_heartbeat enable row level security;

-- Dashboard (anon) boleh membaca untuk menampilkan "terakhir dicek".
-- service_role melewati RLS, jadi edge function tetap bisa menulis tanpa policy tulis.
drop policy if exists "anon read heartbeat" on public.refresh_heartbeat;
create policy "anon read heartbeat"
  on public.refresh_heartbeat for select to anon using (true);
