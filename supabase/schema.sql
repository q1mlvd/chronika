-- Хроника: схема базы для Supabase. Выполнить один раз в SQL Editor.

create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  text text not null,
  tag text,
  minutes integer not null default 0,
  starred boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists entries_user_date on public.entries (user_id, date);

create table if not exists public.days (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  mood smallint check (mood between 1 and 5),
  note text default '',
  primary key (user_id, date)
);

alter table public.entries enable row level security;
alter table public.days enable row level security;

-- Каждый видит и меняет только свои записи
drop policy if exists "own entries" on public.entries;
create policy "own entries" on public.entries for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own days" on public.days;
create policy "own days" on public.days for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
