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

-- Доступ к таблицам через API только для вошедших пользователей
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.entries, public.days to authenticated;
revoke all on public.entries, public.days from anon;

-- ---------- Деньги: доходы и расходы ----------
create table if not exists public.money (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  type text not null check (type in ('income', 'expense')),
  amount numeric(14, 2) not null check (amount > 0),
  category text,
  note text default '',
  created_at timestamptz not null default now()
);
create index if not exists money_user_date on public.money (user_id, date);
alter table public.money enable row level security;
drop policy if exists "own money" on public.money;
create policy "own money" on public.money for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.money to authenticated;
revoke all on public.money from anon;
