-- Daily Stand-Down: database setup.
-- Paste this whole file into the Supabase SQL Editor and press Run. It is safe
-- to run more than once.

-- One row per person per day. `data` holds the whole day's entry.
create table if not exists public.entries (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day date not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (owner, day)
);

alter table public.entries enable row level security;

-- Only the signed-in owner can read or change their own entries.
drop policy if exists "entries owner select" on public.entries;
create policy "entries owner select" on public.entries
  for select to authenticated using (owner = (select auth.uid()));

drop policy if exists "entries owner insert" on public.entries;
create policy "entries owner insert" on public.entries
  for insert to authenticated with check (owner = (select auth.uid()));

drop policy if exists "entries owner update" on public.entries;
create policy "entries owner update" on public.entries
  for update to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

drop policy if exists "entries owner delete" on public.entries;
create policy "entries owner delete" on public.entries
  for delete to authenticated using (owner = (select auth.uid()));

-- The secret code behind the owner's read-only link. Deleting the row turns
-- the link off; replacing the code makes the old link stop working.
create table if not exists public.share_links (
  owner uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  code text not null unique check (length(code) >= 24),
  created_at timestamptz not null default now()
);

alter table public.share_links enable row level security;

drop policy if exists "share owner all" on public.share_links;
create policy "share owner all" on public.share_links
  for all to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

-- The only thing a read-only link can do: fetch the entries that belong to
-- the owner of that code. There is no matching function for writing, so
-- people with the link cannot change anything.
create or replace function public.shared_entries(share_code text)
returns table (day date, data jsonb, updated_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select e.day, e.data, e.updated_at
  from public.entries e
  join public.share_links s on s.owner = e.owner
  where s.code = share_code
  order by e.day;
$$;

revoke all on function public.shared_entries(text) from public;
grant execute on function public.shared_entries(text) to anon, authenticated;
