-- kontrak_pasokan: backup sebelum timpa + override shrink guard (V134)
--
-- Latar: 2026-09-11 satu run kontrak-auto-refresh hanya mencocokkan 20/48 file
-- (nama berubah di SharePoint) dan menimpa peta 48 PLTU. Pemulihan harus dari
-- snapshot manual. V133 menambah shrink guard; kolom di bawah menutup dua celah
-- yang tersisa.
--
--   prev_data / prev_saved_at
--     Peta yang tersimpan tepat sebelum tulis terakhir. Revert satu langkah: lihat
--     supabase/functions/kontrak-auto-refresh/README.md (jeda cron dulu).
--
--   force_until
--     Override untuk shrink guard + carry-over, bila guard memblokir perubahan yang
--     sah (mis. PLTU dikeluarkan dari roster). Berlaku selama now() < force_until,
--     direset ke null oleh run live yang sukses. Sengaja BERBATAS WAKTU, bukan boolean:
--     boolean yang tertinggal menyala setelah run paksa gagal akan mematikan semua
--     guard pada run tak diawasi berikutnya (cron, atau siapa pun yang memanggil
--     fungsi dengan anon key publik). Hanya bisa diset lewat SQL / service role: RLS
--     tabel ini tidak punya policy tulis.
--
-- Diterapkan ke produksi sebagai dua migrasi (kontrak_pasokan_backup_force lalu
-- kontrak_pasokan_force_until, yang mengganti force_next_run boolean awal). File ini
-- memuat bentuk akhirnya dan idempoten.

alter table public.kontrak_pasokan
  add column if not exists prev_data     jsonb,
  add column if not exists prev_saved_at timestamptz,
  add column if not exists force_until   timestamptz;

alter table public.kontrak_pasokan
  drop column if exists force_next_run;

comment on column public.kontrak_pasokan.prev_data is
  'Isi data tepat sebelum tulis terakhir oleh kontrak-auto-refresh. Untuk revert satu langkah.';
comment on column public.kontrak_pasokan.force_until is
  'Override shrink guard + carry-over selama now() < force_until. Direset ke null oleh run live yang sukses; kedaluwarsa sendiri bila run gagal. Set hanya via SQL.';
