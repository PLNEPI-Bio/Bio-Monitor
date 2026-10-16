-- V199: GCV bulanan per kontrak (sheet "Kontrak 2024/2025/2026", SharePoint),
-- ditulis edge function kontrak-gcv-bulanan-refresh (cron mingguan Senin 02:30 WIB).
-- Hanya kunci + GCV + Vol, tanpa harga. URL sumber ada di checkpoint_source
-- (src = 'KONTRAK_GCV_BULANAN'), tidak di repo karena workbook memuat harga.
-- Sudah diterapkan ke project 2026-10-16; file ini untuk audit.

create table if not exists public.kontrak_gcv_bulanan (
  id bigserial primary key,
  tahun int not null,
  no_kontrak text not null,
  mitra text,
  pltu text,
  jenis text,
  gcv numeric[] not null,
  vol numeric[] not null,
  updated_at timestamptz not null default now()
);
create index if not exists kontrak_gcv_bulanan_tahun_idx on public.kontrak_gcv_bulanan(tahun);
alter table public.kontrak_gcv_bulanan enable row level security;
create policy kontrak_gcv_bulanan_read on public.kontrak_gcv_bulanan for select to anon, authenticated using (true);

create or replace function public.replace_kontrak_gcv_bulanan(p_tahun integer, p_rows jsonb)
returns integer language plpgsql set search_path to 'public' as $$
declare n int;
begin
  delete from kontrak_gcv_bulanan where tahun = p_tahun;
  insert into kontrak_gcv_bulanan(tahun, no_kontrak, mitra, pltu, jenis, gcv, vol)
  select p_tahun, r->>'no_kontrak', r->>'mitra', r->>'pltu', r->>'jenis',
    array(select nullif(x, 'null')::numeric from jsonb_array_elements_text(r->'gcv') with ordinality t(x, i) order by i),
    array(select nullif(x, 'null')::numeric from jsonb_array_elements_text(r->'vol') with ordinality t(x, i) order by i)
  from jsonb_array_elements(p_rows) r
  where coalesce(r->>'no_kontrak','') <> '';
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.replace_kontrak_gcv_bulanan(integer, jsonb) from public, anon, authenticated;

-- Cron (dijalankan terpisah, header Authorization disalin dari job kontrak-gcv-refresh-daily):
-- select cron.schedule('kontrak-gcv-bulanan-weekly', '30 19 * * 0', <net.http_post ke /functions/v1/kontrak-gcv-bulanan-refresh>);
