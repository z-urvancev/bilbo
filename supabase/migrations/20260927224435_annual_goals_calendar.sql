-- Add the annual goals calendar with monthly tasks and per-user isolation.
create table public.annual_goals (
  user_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  year smallint not null,
  title text not null,
  category text not null,
  priority text not null,
  status text not null,
  deadline date not null,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint annual_goals_year_check check (year between 2000 and 2100),
  constraint annual_goals_title_check check (
    length(btrim(title)) between 1 and 160
  ),
  constraint annual_goals_category_check check (
    category in (
      'career',
      'finance',
      'health_sport',
      'self_development',
      'education'
    )
  ),
  constraint annual_goals_priority_check check (
    priority in ('high', 'medium', 'low')
  ),
  constraint annual_goals_status_check check (
    status in ('not_started', 'in_progress', 'completed', 'paused')
  ),
  constraint annual_goals_deadline_year_check check (
    extract(year from deadline)::integer = year
  )
);

create index annual_goals_user_year_category_idx
  on public.annual_goals (user_id, year, category, status);

create table public.goal_tasks (
  user_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  goal_id uuid not null,
  title text not null,
  month smallint not null,
  completed boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint goal_tasks_goal_fk foreign key (user_id, goal_id)
    references public.annual_goals (user_id, id) on delete cascade,
  constraint goal_tasks_title_check check (
    length(btrim(title)) between 1 and 200
  ),
  constraint goal_tasks_month_check check (month between 1 and 12),
  constraint goal_tasks_sort_order_check check (sort_order >= 0)
);

create index goal_tasks_user_goal_month_idx
  on public.goal_tasks (user_id, goal_id, month, sort_order);

create index goal_tasks_user_month_completed_idx
  on public.goal_tasks (user_id, month, completed);

alter table public.annual_goals enable row level security;
alter table public.goal_tasks enable row level security;

revoke all on table public.annual_goals from public, anon, authenticated;
revoke all on table public.goal_tasks from public, anon, authenticated;

grant select, insert, update, delete on table public.annual_goals
  to authenticated;
grant select, insert, update, delete on table public.goal_tasks
  to authenticated;

create policy "annual_goals_select_own" on public.annual_goals
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "annual_goals_insert_own" on public.annual_goals
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "annual_goals_update_own" on public.annual_goals
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "annual_goals_delete_own" on public.annual_goals
  for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "goal_tasks_select_own" on public.goal_tasks
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "goal_tasks_insert_own" on public.goal_tasks
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "goal_tasks_update_own" on public.goal_tasks
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "goal_tasks_delete_own" on public.goal_tasks
  for delete to authenticated
  using ((select auth.uid()) = user_id);

drop trigger if exists annual_goals_set_updated_at on public.annual_goals;
create trigger annual_goals_set_updated_at
  before insert or update on public.annual_goals
  for each row execute function public.set_updated_at();

drop trigger if exists goal_tasks_set_updated_at on public.goal_tasks;
create trigger goal_tasks_set_updated_at
  before insert or update on public.goal_tasks
  for each row execute function public.set_updated_at();
