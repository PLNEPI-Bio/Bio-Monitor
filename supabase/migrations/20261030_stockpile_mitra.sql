-- stockpile_mitra: titik penyimpanan mitra per PLTU, dari sheet "PLTU <nama>" Rekap
-- Transport Biomass (edge function stockpile-refresh, cron bulanan + tombol admin).
-- Tabel sendiri, bukan dashboard_data: blob itu ditulis ulang utuh tiap 20 menit.
-- Cron: job `stockpile-refresh-monthly`, '30 1 1 * *' (dipasang lewat SQL, memakai perintah
-- job kontrak-auto-refresh-monthly). Secret STOCKPILE_XLSX_URL menyimpan link sumber.
-- Lokasi stockpile mitra rahasia: beda dengan kontrak_pasokan, tabel ini TIDAK baca publik.

create table if not exists public.stockpile_mitra (
  id            integer primary key default 1 check (id = 1),
  data          jsonb not null default '{}'::jsonb,
  issues        jsonb not null default '[]'::jsonb,
  short_cache   jsonb not null default '{}'::jsonb,
  n_pltu        integer,
  n_titik       integer,
  last_ok_at    timestamptz,
  last_error    text,
  updated_at    timestamptz,
  prev_data     jsonb,
  prev_saved_at timestamptz,
  force_until   timestamptz
);

comment on column public.stockpile_mitra.data is
  '{ kode_pltu: [{ m: mitra, j: jenis, la, lo, km }] }';
comment on column public.stockpile_mitra.issues is
  'Baris yang dilewati atau dikoreksi otomatis: [{ pltu, mitra, titik, alasan }]';

-- RLS tanpa policy + revoke: anon key tidak bisa membaca apa pun. Baca hanya lewat edge
-- function stockpile-read (password dashboard dicek di server), tulis lewat stockpile-refresh.
alter table public.stockpile_mitra enable row level security;
revoke all on public.stockpile_mitra from anon, authenticated;
