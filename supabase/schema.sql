-- Slate schema. Paste into the Supabase SQL editor and run once.
-- Every table is readable and writable only by signed-in users; with two accounts
-- on the project there is no need for per-row ownership.

-- ---------- documents ----------
-- One table for every collection. `collection` holds the full path string, so a
-- subcollection like 'notes/<id>/strokes' is just a longer value — no tree.
-- Documents are schemaless, so a new collection needs no migration: projects,
-- spaces, tasks, notes, schedules, prospects and meta all live here already,
-- and adding another means subscribing to it in the app, nothing more.
-- Writes upsert with onConflict "collection,id" because the key is composite.
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
  on public.docs for select to authenticated
  using (true);

create policy "signed in can write docs"
  on public.docs for all to authenticated
  using (true)
  with check (true);

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
  on public.profiles for select to authenticated
  using (true);

create policy "own profile is editable"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

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
  on storage.objects for select to public
  using (bucket_id = 'slate-assets');

create policy "signed in can upload slate assets"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'slate-assets');

create policy "signed in can delete slate assets"
  on storage.objects for delete to authenticated
  using (bucket_id = 'slate-assets');

-- ---------- push subscriptions ----------
-- One row per device that has enabled the notification briefs; both users may
-- have several (phone, laptop). Endpoint is unique so re-enabling from the same
-- device upserts instead of stacking duplicates. The /api functions read and
-- write this with the service role key; the policies below just let a signed-in
-- user manage their own rows directly if that's ever needed.
create table if not exists public.push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  endpoint        text not null unique,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_success_at timestamptz
);

create index if not exists idx_push_subscriptions_user on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "own subscriptions readable"  on public.push_subscriptions;
drop policy if exists "own subscriptions insertable" on public.push_subscriptions;
drop policy if exists "own subscriptions deletable"  on public.push_subscriptions;

create policy "own subscriptions readable"
  on public.push_subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "own subscriptions insertable"
  on public.push_subscriptions for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "own subscriptions deletable"
  on public.push_subscriptions for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------- accounts ----------
-- Create the two users under Authentication -> Users -> Add user (tick
-- "Auto Confirm User"), then give each one a display name:
--
--   insert into public.profiles (id, name)
--   select id, 'Dylan' from auth.users where email = 'you@example.com';
--
--   insert into public.profiles (id, name)
--   select id, 'Zac'   from auth.users where email = 'zac@example.com';
