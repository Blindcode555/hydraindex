-- Hydra Compass — Supabase schema
--
-- Run this once in the Supabase SQL editor (or via `supabase db push`) for a
-- fresh project. It creates exactly the three tables the backend already
-- expects (see api/lib/mission-store.js), a trigger that provisions a
-- `profiles` row the moment someone signs up, and Row Level Security
-- policies that are the ONLY thing actually preventing one user from
-- reading or writing another user's data — the API handlers rely entirely
-- on these policies rather than re-checking ownership themselves.
--
-- Nothing here touches auth.users directly beyond the trigger below;
-- Supabase Auth already manages that table.

-- ---------------------------------------------------------------------------
-- 1. profiles — one row per user, keyed by their auth.users id.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  plan text not null default 'free',
  hydra_credit_balance integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. projects — a saved mission workspace. One row per "Save Project".
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  original_idea text not null,
  type text,
  expertise text,
  budget text,
  status text not null default 'active',
  current_node integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_user_id_idx on public.projects (user_id);

-- ---------------------------------------------------------------------------
-- 3. missions — the generated workflow JSON snapshot(s) for a project.
--    A project can accumulate more than one snapshot over time; the API
--    always reads the most recently updated one (order by updated_at desc).
-- ---------------------------------------------------------------------------
create table if not exists public.missions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  workflow_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists missions_project_id_idx on public.missions (project_id);

-- ---------------------------------------------------------------------------
-- Keep updated_at current on every row update (projects/missions get PATCHed
-- via PostgREST, which does not do this for you).
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_updated_at on public.profiles;
create trigger set_updated_at before update on public.profiles
  for each row execute procedure public.set_updated_at();

drop trigger if exists set_updated_at on public.projects;
create trigger set_updated_at before update on public.projects
  for each row execute procedure public.set_updated_at();

drop trigger if exists set_updated_at on public.missions;
create trigger set_updated_at before update on public.missions
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Auto-provision a profile row the moment someone signs up, so
--    api/lib/mission-store.js's getProfile() never has to handle "no row
--    yet" as a special case.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, plan, hydra_credit_balance)
  values (new.id, new.email, 'free', 0)
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 5. Row Level Security — enable it and lock every table to its owner.
--    The browser only ever holds the anon/publishable key; it is these
--    policies, evaluated against the caller's auth.uid() from their JWT,
--    that make per-user isolation real. Nothing in the Vercel API layer
--    uses a service-role key, so there is no path that bypasses these.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.missions enable row level security;

-- profiles: a user may read and update only their own row. No insert/delete
-- policy is defined — rows are created solely by the handle_new_user
-- trigger (security definer), and there's no product reason to delete one
-- from the client.
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- projects: full CRUD, but only on rows the user owns.
drop policy if exists "projects_select_own" on public.projects;
create policy "projects_select_own" on public.projects
  for select using (auth.uid() = user_id);

drop policy if exists "projects_insert_own" on public.projects;
create policy "projects_insert_own" on public.projects
  for insert with check (auth.uid() = user_id);

drop policy if exists "projects_update_own" on public.projects;
create policy "projects_update_own" on public.projects
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "projects_delete_own" on public.projects;
create policy "projects_delete_own" on public.projects
  for delete using (auth.uid() = user_id);

-- missions: ownership is via the parent project, not a direct user_id
-- column, so every policy joins back to projects and checks that row's
-- user_id against the caller.
drop policy if exists "missions_select_own" on public.missions;
create policy "missions_select_own" on public.missions
  for select using (
    exists (
      select 1 from public.projects
      where projects.id = missions.project_id
        and projects.user_id = auth.uid()
    )
  );

drop policy if exists "missions_insert_own" on public.missions;
create policy "missions_insert_own" on public.missions
  for insert with check (
    exists (
      select 1 from public.projects
      where projects.id = missions.project_id
        and projects.user_id = auth.uid()
    )
  );

drop policy if exists "missions_update_own" on public.missions;
create policy "missions_update_own" on public.missions
  for update using (
    exists (
      select 1 from public.projects
      where projects.id = missions.project_id
        and projects.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.projects
      where projects.id = missions.project_id
        and projects.user_id = auth.uid()
    )
  );

drop policy if exists "missions_delete_own" on public.missions;
create policy "missions_delete_own" on public.missions
  for delete using (
    exists (
      select 1 from public.projects
      where projects.id = missions.project_id
        and projects.user_id = auth.uid()
    )
  );
