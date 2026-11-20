-- Folio folders: lets you group books into folders in your library, and keeps the
-- folders the same on all your devices.
-- Run this once in your Supabase project's SQL Editor, after supabase-schema.sql
-- (Dashboard -> SQL Editor -> New query -> paste -> Run). Safe to run again.
--
-- Two small tables:
--   folders      one row per folder: its name and its place in the order. A deleted
--                folder is kept as a row marked deleted, so other devices learn of it.
--   book_folders one row per book that has been put in a folder (or taken out again):
--                which folder it is in, or null for "not in a folder".
-- Each row carries the time it was last changed, and the newest change wins when two
-- devices disagree. A signed-in user can only see and change their own rows.

create table if not exists folders (
  user_id uuid references auth.users(id) on delete cascade not null,
  id text not null,
  name text not null,
  position double precision not null default 0,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists book_folders (
  user_id uuid references auth.users(id) on delete cascade not null,
  book_id text not null,
  folder_id text,
  updated_at timestamptz not null default now(),
  primary key (user_id, book_id)
);

alter table folders enable row level security;
alter table book_folders enable row level security;

drop policy if exists "Users manage their own folders" on folders;
create policy "Users manage their own folders"
  on folders
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users manage their own book folders" on book_folders;
create policy "Users manage their own book folders"
  on book_folders
  for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
