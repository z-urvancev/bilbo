alter table public.habits
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists goal_period text not null default 'month',
  add column if not exists is_priority boolean not null default false,
  add column if not exists created_day date null,
  add column if not exists deleted_at timestamptz null;

alter table public.habits
  alter column updated_at set default now();

alter table public.habit_marks
  add column if not exists marked boolean not null default true,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists habits_user_live_idx
  on public.habits (user_id, deleted_at, updated_at);

create index if not exists habit_marks_user_marked_idx
  on public.habit_marks (user_id, marked, updated_at);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'habits_goal_period_check'
      and conrelid = 'public.habits'::regclass
  ) then
    alter table public.habits
      add constraint habits_goal_period_check
      check (goal_period in ('month', 'week'));
  end if;
end $$;

create table if not exists public.calendar_sync_meta (
  user_id uuid primary key references auth.users (id) on delete cascade,
  initialized_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.calendar_sync_meta enable row level security;

drop policy if exists "calendar_sync_meta_select_own" on public.calendar_sync_meta;
drop policy if exists "calendar_sync_meta_insert_own" on public.calendar_sync_meta;
drop policy if exists "calendar_sync_meta_update_own" on public.calendar_sync_meta;

create policy "calendar_sync_meta_select_own" on public.calendar_sync_meta
  for select using (auth.uid() = user_id);

create policy "calendar_sync_meta_insert_own" on public.calendar_sync_meta
  for insert with check (auth.uid() = user_id);

create policy "calendar_sync_meta_update_own" on public.calendar_sync_meta
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "marks_update_own" on public.habit_marks;

create policy "marks_update_own" on public.habit_marks
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'habits'
    ) then
      execute 'alter publication supabase_realtime add table public.habits';
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'habit_marks'
    ) then
      execute 'alter publication supabase_realtime add table public.habit_marks';
    end if;
  end if;
end $$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists habits_set_updated_at on public.habits;
create trigger habits_set_updated_at
  before insert or update on public.habits
  for each row
  execute function public.set_updated_at();

drop trigger if exists habit_marks_set_updated_at on public.habit_marks;
create trigger habit_marks_set_updated_at
  before insert or update on public.habit_marks
  for each row
  execute function public.set_updated_at();

drop trigger if exists calendar_sync_meta_set_updated_at on public.calendar_sync_meta;
create trigger calendar_sync_meta_set_updated_at
  before insert or update on public.calendar_sync_meta
  for each row
  execute function public.set_updated_at();
