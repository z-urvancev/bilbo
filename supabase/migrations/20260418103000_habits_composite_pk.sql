create table if not exists public.habits (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  emoji text not null default '🎯',
  negative boolean not null default false,
  monthly_goal integer not null default 0
);

create table if not exists public.habit_marks (
  habit_id text not null references public.habits (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  primary key (habit_id, day)
);

drop policy if exists "marks_select_own" on public.habit_marks;
drop policy if exists "marks_insert_own" on public.habit_marks;
drop policy if exists "marks_delete_own" on public.habit_marks;
drop policy if exists "habits_select_own" on public.habits;
drop policy if exists "habits_insert_own" on public.habits;
drop policy if exists "habits_update_own" on public.habits;
drop policy if exists "habits_delete_own" on public.habits;

alter table public.habit_marks drop constraint if exists habit_marks_habit_id_fkey;

alter table public.habit_marks drop constraint if exists habit_marks_pkey;

alter table public.habits drop constraint if exists habits_pkey;

alter table public.habits add primary key (user_id, id);

alter table public.habit_marks
  add primary key (user_id, habit_id, day);

alter table public.habit_marks
  add constraint habit_marks_habit_fk
  foreign key (user_id, habit_id) references public.habits (user_id, id) on delete cascade;

alter table public.habits enable row level security;
alter table public.habit_marks enable row level security;

create policy "habits_select_own" on public.habits for select using (auth.uid() = user_id);
create policy "habits_insert_own" on public.habits for insert with check (auth.uid() = user_id);
create policy "habits_update_own" on public.habits for update using (auth.uid() = user_id);
create policy "habits_delete_own" on public.habits for delete using (auth.uid() = user_id);

create policy "marks_select_own" on public.habit_marks for select using (auth.uid() = user_id);
create policy "marks_insert_own" on public.habit_marks for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.habits h
      where h.user_id = habit_marks.user_id and h.id = habit_marks.habit_id
    )
  );
create policy "marks_delete_own" on public.habit_marks for delete using (auth.uid() = user_id);
