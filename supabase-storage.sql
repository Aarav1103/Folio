-- Folio storage setup: lets imported books open on your other devices.
-- Run this once in your Supabase project's SQL Editor, after supabase-schema.sql
-- (Dashboard -> SQL Editor -> New query -> paste -> Run). Safe to run again.
--
-- It creates a private bucket called "books" that accepts only epub files up to
-- 50 MB (the free plan's cap; raise file_size_limit on a paid plan). Files live
-- at <user id>/<book id>.epub, and a signed-in user can only read, add, replace
-- or delete files in the folder named after their own user id.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('books', 'books', false, 52428800, array['application/epub+zip'])
on conflict (id) do nothing;

drop policy if exists "Users read their own book files" on storage.objects;
create policy "Users read their own book files"
  on storage.objects for select to authenticated
  using (bucket_id = 'books' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users add their own book files" on storage.objects;
create policy "Users add their own book files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'books' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users replace their own book files" on storage.objects;
create policy "Users replace their own book files"
  on storage.objects for update to authenticated
  using (bucket_id = 'books' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'books' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "Users delete their own book files" on storage.objects;
create policy "Users delete their own book files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'books' and (storage.foldername(name))[1] = (select auth.uid())::text);
