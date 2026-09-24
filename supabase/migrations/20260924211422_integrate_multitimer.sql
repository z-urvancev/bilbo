-- Integrate the authenticated Multitimer data model and cleaned local history.
create table public.timer_definitions (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null,
  name text not null,
  color text not null,
  icon text not null,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz null,
  primary key (user_id, id),
  constraint timer_definitions_id_check check (length(id) between 1 and 200),
  constraint timer_definitions_name_check check (length(btrim(name)) between 1 and 80),
  constraint timer_definitions_color_check check (color ~ '^#[0-9a-fA-F]{6}$'),
  constraint timer_definitions_icon_check check (length(icon) between 1 and 32),
  constraint timer_definitions_sort_order_check check (sort_order >= 0)
);

create unique index timer_definitions_user_live_name_idx
  on public.timer_definitions (user_id, lower(btrim(name)))
  where archived_at is null;

create table public.timer_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  active_timer_id text null,
  active_started_at timestamptz null,
  revision bigint not null default 0,
  updated_at timestamptz not null default now(),
  constraint timer_state_active_pair_check check (
    (active_timer_id is null and active_started_at is null)
    or (active_timer_id is not null and active_started_at is not null)
  ),
  constraint timer_state_revision_check check (revision >= 0),
  constraint timer_state_active_timer_fk foreign key (user_id, active_timer_id)
    references public.timer_definitions (user_id, id)
);

create table public.timer_intervals (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  timer_id text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  client_command_id text not null,
  created_at timestamptz not null default now(),
  constraint timer_intervals_timer_fk foreign key (user_id, timer_id)
    references public.timer_definitions (user_id, id),
  constraint timer_intervals_time_check check (ended_at > started_at),
  constraint timer_intervals_command_check check (
    length(client_command_id) between 1 and 200
  ),
  unique (user_id, client_command_id)
);

create index timer_intervals_user_started_idx
  on public.timer_intervals (user_id, started_at desc)
  include (ended_at, timer_id);

create index timer_intervals_user_timer_started_idx
  on public.timer_intervals (user_id, timer_id, started_at desc);

create table public.timer_daily_totals (
  user_id uuid not null references auth.users (id) on delete cascade,
  timer_id text not null,
  day date not null,
  duration_ms bigint not null,
  source text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, timer_id, day, source),
  constraint timer_daily_totals_timer_fk foreign key (user_id, timer_id)
    references public.timer_definitions (user_id, id),
  constraint timer_daily_totals_duration_check check (duration_ms >= 0),
  constraint timer_daily_totals_source_check check (length(source) between 1 and 120)
);

create index timer_daily_totals_user_day_idx
  on public.timer_daily_totals (user_id, day, timer_id);

create table public.timer_commands (
  user_id uuid not null references auth.users (id) on delete cascade,
  client_command_id text not null,
  action text not null,
  timer_id text null,
  applied boolean not null,
  applied_revision bigint not null,
  result_active_timer_id text null,
  result_active_started_at timestamptz null,
  completed_interval_id bigint null references public.timer_intervals (id),
  created_at timestamptz not null default now(),
  primary key (user_id, client_command_id),
  constraint timer_commands_action_check check (action in ('start', 'stop')),
  constraint timer_commands_id_check check (length(client_command_id) between 1 and 200),
  constraint timer_commands_revision_check check (applied_revision >= 0),
  constraint timer_commands_timer_fk foreign key (user_id, timer_id)
    references public.timer_definitions (user_id, id),
  constraint timer_commands_result_pair_check check (
    (result_active_timer_id is null and result_active_started_at is null)
    or (result_active_timer_id is not null and result_active_started_at is not null)
  )
);

alter table public.timer_definitions enable row level security;
alter table public.timer_state enable row level security;
alter table public.timer_intervals enable row level security;
alter table public.timer_daily_totals enable row level security;
alter table public.timer_commands enable row level security;

revoke all on table public.timer_definitions from public, anon, authenticated;
revoke all on table public.timer_state from public, anon, authenticated;
revoke all on table public.timer_intervals from public, anon, authenticated;
revoke all on table public.timer_daily_totals from public, anon, authenticated;
revoke all on table public.timer_commands from public, anon, authenticated;

grant select, insert, update on table public.timer_definitions to authenticated;
grant select, insert, update on table public.timer_state to authenticated;
grant select, insert on table public.timer_intervals to authenticated;
grant select on table public.timer_daily_totals to authenticated;
grant select, insert on table public.timer_commands to authenticated;
revoke all on sequence public.timer_intervals_id_seq from public, anon, authenticated;
grant usage, select on sequence public.timer_intervals_id_seq to authenticated;

create policy "timer_definitions_select_own" on public.timer_definitions
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "timer_definitions_insert_own" on public.timer_definitions
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "timer_definitions_update_own" on public.timer_definitions
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "timer_state_select_own" on public.timer_state
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "timer_state_insert_via_rpc" on public.timer_state
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (select current_setting('app.multitimer_rpc', true)) = 'on'
  );

create policy "timer_state_update_via_rpc" on public.timer_state
  for update to authenticated
  using (
    (select auth.uid()) = user_id
    and (select current_setting('app.multitimer_rpc', true)) = 'on'
  )
  with check (
    (select auth.uid()) = user_id
    and (select current_setting('app.multitimer_rpc', true)) = 'on'
  );

create policy "timer_intervals_select_own" on public.timer_intervals
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "timer_intervals_insert_via_rpc" on public.timer_intervals
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (select current_setting('app.multitimer_rpc', true)) = 'on'
  );

create policy "timer_daily_totals_select_own" on public.timer_daily_totals
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "timer_commands_select_own" on public.timer_commands
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "timer_commands_insert_via_rpc" on public.timer_commands
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (select current_setting('app.multitimer_rpc', true)) = 'on'
  );

drop trigger if exists timer_definitions_set_updated_at on public.timer_definitions;
create trigger timer_definitions_set_updated_at
  before insert or update on public.timer_definitions
  for each row execute function public.set_updated_at();

drop trigger if exists timer_state_set_updated_at on public.timer_state;
create trigger timer_state_set_updated_at
  before insert or update on public.timer_state
  for each row execute function public.set_updated_at();

create or replace function public.apply_timer_command(
  p_client_command_id text,
  p_action text,
  p_timer_id text,
  p_expected_revision bigint
)
returns table (
  applied boolean,
  revision bigint,
  active_timer_id text,
  active_started_at timestamptz,
  completed_interval_id bigint,
  server_updated_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_revision bigint;
  v_active_timer_id text;
  v_active_started_at timestamptz;
  v_completed_interval_id bigint;
  v_updated_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_applied boolean := false;
  v_command record;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  if p_client_command_id is null
    or length(p_client_command_id) = 0
    or length(p_client_command_id) > 200
  then
    raise exception using errcode = '22023', message = 'invalid client_command_id';
  end if;

  if p_action not in ('start', 'stop') then
    raise exception using errcode = '22023', message = 'unsupported timer action';
  end if;

  if p_action = 'start' and (
    p_timer_id is null or length(p_timer_id) = 0 or length(p_timer_id) > 200
  ) then
    raise exception using errcode = '22023', message = 'start requires timer_id';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'invalid expected revision';
  end if;

  perform pg_catalog.set_config('app.multitimer_rpc', 'on', true);

  insert into public.timer_state (user_id)
  values (v_user_id)
  on conflict (user_id) do nothing;

  select state.revision, state.active_timer_id, state.active_started_at, state.updated_at
    into v_revision, v_active_timer_id, v_active_started_at, v_updated_at
  from public.timer_state as state
  where state.user_id = v_user_id
  for update;

  select command.* into v_command
  from public.timer_commands as command
  where command.user_id = v_user_id
    and command.client_command_id = p_client_command_id;

  if found then
    return query select
      false,
      v_command.applied_revision,
      v_command.result_active_timer_id,
      v_command.result_active_started_at,
      v_command.completed_interval_id,
      v_command.created_at;
    return;
  end if;

  if p_expected_revision <> v_revision then
    raise exception using
      errcode = '40001',
      message = 'timer revision conflict',
      detail = format(
        'expected revision %s, current revision %s',
        p_expected_revision,
        v_revision
      );
  end if;

  if p_action = 'start' then
    if not exists (
      select 1
      from public.timer_definitions as timer
      where timer.user_id = v_user_id
        and timer.id = p_timer_id
        and timer.archived_at is null
    ) then
      raise exception using errcode = '22023', message = 'timer does not exist';
    end if;

    if v_active_timer_id is distinct from p_timer_id then
      if v_active_timer_id is not null and v_active_started_at < v_now then
        insert into public.timer_intervals (
          user_id,
          timer_id,
          started_at,
          ended_at,
          client_command_id
        ) values (
          v_user_id,
          v_active_timer_id,
          v_active_started_at,
          v_now,
          p_client_command_id
        )
        returning id into v_completed_interval_id;
      end if;

      v_active_timer_id := p_timer_id;
      v_active_started_at := v_now;
      v_revision := v_revision + 1;
      v_applied := true;
    end if;
  else
    if v_active_timer_id is not null then
      if p_timer_id is not null and p_timer_id <> v_active_timer_id then
        raise exception using errcode = '40001', message = 'active timer changed';
      end if;

      if v_active_started_at < v_now then
        insert into public.timer_intervals (
          user_id,
          timer_id,
          started_at,
          ended_at,
          client_command_id
        ) values (
          v_user_id,
          v_active_timer_id,
          v_active_started_at,
          v_now,
          p_client_command_id
        )
        returning id into v_completed_interval_id;
      end if;

      v_active_timer_id := null;
      v_active_started_at := null;
      v_revision := v_revision + 1;
      v_applied := true;
    end if;
  end if;

  if v_applied then
    update public.timer_state as state
    set
      active_timer_id = v_active_timer_id,
      active_started_at = v_active_started_at,
      revision = v_revision,
      updated_at = v_now
    where state.user_id = v_user_id
    returning state.updated_at into v_updated_at;
  end if;

  insert into public.timer_commands (
    user_id,
    client_command_id,
    action,
    timer_id,
    applied,
    applied_revision,
    result_active_timer_id,
    result_active_started_at,
    completed_interval_id
  ) values (
    v_user_id,
    p_client_command_id,
    p_action,
    p_timer_id,
    v_applied,
    v_revision,
    v_active_timer_id,
    v_active_started_at,
    v_completed_interval_id
  );

  return query select
    v_applied,
    v_revision,
    v_active_timer_id,
    v_active_started_at,
    v_completed_interval_id,
    v_updated_at;
end;
$$;

revoke execute on function public.apply_timer_command(text, text, text, bigint)
  from public, anon;
grant execute on function public.apply_timer_command(text, text, text, bigint)
  to authenticated;

comment on function public.apply_timer_command(text, text, text, bigint)
  is 'Atomically and idempotently starts, switches, or stops one user timer.';

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'timer_definitions'
    ) then
      execute 'alter publication supabase_realtime add table public.timer_definitions';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'timer_state'
    ) then
      execute 'alter publication supabase_realtime add table public.timer_state';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'timer_intervals'
    ) then
      execute 'alter publication supabase_realtime add table public.timer_intervals';
    end if;
  end if;
end $$;

with target_user as (
  select id
  from auth.users
  where lower(email) = lower('zahvinar358@gmail.com')
  limit 1
), seed (id, name, color, icon, sort_order) as (
  values
    ('deep-work', 'Deep work', '#6d5dfc', '✦', 0::smallint),
    ('meeting', 'Коммуникации/встречи', '#f06f4f', '◎', 1::smallint),
    ('ad-hoc', 'Ad-hoc', '#22a67a', '↗', 2::smallint),
    ('break', 'Перерыв', '#e8a632', '☕', 3::smallint),
    ('chill-work', 'Chill work', '#3e8ee8', '◇', 4::smallint)
)
insert into public.timer_definitions (
  user_id,
  id,
  name,
  color,
  icon,
  sort_order
)
select target_user.id, seed.id, seed.name, seed.color, seed.icon, seed.sort_order
from target_user cross join seed
on conflict (user_id, id) do update set
  name = excluded.name,
  color = excluded.color,
  icon = excluded.icon,
  sort_order = excluded.sort_order,
  archived_at = null;

insert into public.timer_state (user_id)
select id
from auth.users
where lower(email) = lower('zahvinar358@gmail.com')
on conflict (user_id) do nothing;

with target_user as (
  select id
  from auth.users
  where lower(email) = lower('zahvinar358@gmail.com')
  limit 1
), seed (day, timer_id, duration_ms) as (
  values
    ('2026-08-27'::date, 'deep-work', 16362882::bigint),
    ('2026-08-27'::date, 'meeting', 1630601::bigint),
    ('2026-08-27'::date, 'break', 8394814::bigint),
    ('2026-08-27'::date, 'chill-work', 5821502::bigint),
    ('2026-08-28'::date, 'deep-work', 10178296::bigint),
    ('2026-08-28'::date, 'break', 7464843::bigint),
    ('2026-08-28'::date, 'chill-work', 5152692::bigint),
    ('2026-08-31'::date, 'meeting', 5104228::bigint),
    ('2026-08-31'::date, 'break', 12686454::bigint),
    ('2026-08-31'::date, 'chill-work', 2061588::bigint),
    ('2026-09-02'::date, 'deep-work', 4606159::bigint),
    ('2026-09-02'::date, 'meeting', 9244665::bigint),
    ('2026-09-02'::date, 'break', 13750096::bigint),
    ('2026-09-02'::date, 'chill-work', 8394320::bigint),
    ('2026-09-03'::date, 'meeting', 10570567::bigint),
    ('2026-09-03'::date, 'break', 2943326::bigint),
    ('2026-09-03'::date, 'chill-work', 7012330::bigint),
    ('2026-09-08'::date, 'deep-work', 8731716::bigint),
    ('2026-09-08'::date, 'meeting', 835743::bigint),
    ('2026-09-08'::date, 'ad-hoc', 935895::bigint),
    ('2026-09-08'::date, 'break', 18891757::bigint),
    ('2026-09-08'::date, 'chill-work', 6783007::bigint),
    ('2026-09-09'::date, 'meeting', 2293517::bigint),
    ('2026-09-09'::date, 'break', 8800894::bigint),
    ('2026-09-09'::date, 'chill-work', 20421943::bigint),
    ('2026-09-10'::date, 'meeting', 4099151::bigint),
    ('2026-09-10'::date, 'ad-hoc', 2465252::bigint),
    ('2026-09-10'::date, 'break', 2561131::bigint),
    ('2026-09-10'::date, 'chill-work', 34358701::bigint),
    ('2026-09-11'::date, 'meeting', 1302340::bigint),
    ('2026-09-11'::date, 'ad-hoc', 1970390::bigint),
    ('2026-09-11'::date, 'break', 3358669::bigint),
    ('2026-09-11'::date, 'chill-work', 33192294::bigint),
    ('2026-09-14'::date, 'meeting', 785031::bigint),
    ('2026-09-14'::date, 'break', 10964162::bigint),
    ('2026-09-14'::date, 'chill-work', 16035837::bigint)
)
insert into public.timer_daily_totals (
  user_id,
  timer_id,
  day,
  duration_ms,
  source
)
select
  target_user.id,
  seed.timer_id,
  seed.day,
  seed.duration_ms,
  'multitimer-cleaned-2026-09-15'
from target_user cross join seed
on conflict (user_id, timer_id, day, source) do update
set duration_ms = excluded.duration_ms;
