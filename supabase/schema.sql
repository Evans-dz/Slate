-- Slate schema. Paste into the Supabase SQL editor and run once.
-- Every table is readable and writable only by signed-in users; with two accounts
-- on the project there is no need for per-row ownership.

-- ---------- documents ----------
-- One table for every collection. `collection` holds the full path string, so a
-- subcollection like 'notes/<id>/strokes' is just a longer value — no tree.
create table if not exists public.docs (
  collection  text        not null,
  id          text        not null,
  data        jsonb       not null,
  updated_at  timestamptz not null default now(),
  primary key (collection, id)
);

create index if not exists idx_docs_collection on public.docs (collection);

alter table public.docs enable row level security;

drop policy if exists "signed in can read docs"  on public.docs;
drop policy if exists "signed in can write docs" on public.docs;

create policy "signed in can read docs"
  on public.docs for select
  using (auth.role() = 'authenticated');

create policy "signed in can write docs"
  on public.docs for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- realtime: the client subscribes to this table and patches its cache per event
alter publication supabase_realtime add table public.docs;

-- ---------- profiles ----------
-- Display name and avatar for each account. The UI expects { id, name, avatarUrl };
-- a null avatar_url falls back to a generated initials circle in the client.
create table if not exists public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  name       text not null,
  avatar_url text
);

alter table public.profiles enable row level security;

drop policy if exists "signed in can read profiles" on public.profiles;
drop policy if exists "own profile is editable"     on public.profiles;

create policy "signed in can read profiles"
  on public.profiles for select
  using (auth.role() = 'authenticated');

create policy "own profile is editable"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ---------- storage ----------
-- Public bucket for pasted and dropped images. Reads are public so <img src> works
-- without a signed URL; only signed-in users can add or remove.
insert into storage.buckets (id, name, public)
values ('slate-assets', 'slate-assets', true)
on conflict (id) do nothing;

drop policy if exists "anyone can read slate assets"     on storage.objects;
drop policy if exists "signed in can upload slate assets" on storage.objects;
drop policy if exists "signed in can delete slate assets" on storage.objects;

create policy "anyone can read slate assets"
  on storage.objects for select
  using (bucket_id = 'slate-assets');

create policy "signed in can upload slate assets"
  on storage.objects for insert
  with check (bucket_id = 'slate-assets' and auth.role() = 'authenticated');

create policy "signed in can delete slate assets"
  on storage.objects for delete
  using (bucket_id = 'slate-assets' and auth.role() = 'authenticated');

-- ---------- accounts ----------
-- Create the two users under Authentication -> Users -> Add user (tick
-- "Auto Confirm User"), then give each one a display name:
--
--   insert into public.profiles (id, name)
--   select id, 'Dylan' from auth.users where email = 'you@example.com';
--
--   insert into public.profiles (id, name)
--   select id, 'Zac'   from auth.users where email = 'zac@example.com';
