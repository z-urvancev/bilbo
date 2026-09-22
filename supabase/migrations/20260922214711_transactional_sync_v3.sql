-- Transactional, idempotent synchronization with optimistic concurrency control.
alter table public.calendar_sync_meta
  add column if not exists revision bigint not null default 0;

alter table public.sync_events
  add column if not exists server_revision bigint null;

alter function public.set_updated_at() set search_path = '';

create unique index if not exists sync_events_user_revision_idx
  on public.sync_events (user_id, server_revision)
  where server_revision is not null;

revoke all on table public.habits from anon;
revoke all on table public.habit_marks from anon;
revoke all on table public.calendar_sync_meta from anon;
revoke all on table public.sync_events from anon;
revoke all on table public.habits from authenticated;
revoke all on table public.habit_marks from authenticated;
revoke all on table public.calendar_sync_meta from authenticated;
revoke all on table public.sync_events from authenticated;
grant select, insert, update, delete on table public.habits to authenticated;
grant select, insert, update, delete on table public.habit_marks to authenticated;
grant select, insert, update on table public.calendar_sync_meta to authenticated;
grant select, insert on table public.sync_events to authenticated;
revoke all on sequence public.sync_events_seq_seq from anon, authenticated;
grant usage, select on sequence public.sync_events_seq_seq to authenticated;

drop policy if exists "habits_select_own" on public.habits;
create policy "habits_select_own" on public.habits
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "marks_select_own" on public.habit_marks;
create policy "marks_select_own" on public.habit_marks
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "calendar_sync_meta_select_own" on public.calendar_sync_meta;
create policy "calendar_sync_meta_select_own" on public.calendar_sync_meta
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "sync_events_select_own" on public.sync_events;
create policy "sync_events_select_own" on public.sync_events
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "habits_insert_own" on public.habits;
drop policy if exists "habits_update_own" on public.habits;
drop policy if exists "habits_delete_own" on public.habits;
create policy "habits_insert_via_sync_rpc" on public.habits
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (select current_setting('app.habit_sync_rpc', true)) = 'on'
  );
create policy "habits_update_via_sync_rpc" on public.habits
  for update to authenticated
  using (
    (select auth.uid()) = user_id
    and (select current_setting('app.habit_sync_rpc', true)) = 'on'
  )
  with check (
    (select auth.uid()) = user_id
    and (select current_setting('app.habit_sync_rpc', true)) = 'on'
  );
create policy "habits_delete_via_sync_rpc" on public.habits
  for delete to authenticated
  using (
    (select auth.uid()) = user_id
    and (select current_setting('app.habit_sync_rpc', true)) = 'on'
  );

drop policy if exists "marks_insert_own" on public.habit_marks;
drop policy if exists "marks_update_own" on public.habit_marks;
drop policy if exists "marks_delete_own" on public.habit_marks;
create policy "marks_insert_via_sync_rpc" on public.habit_marks
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (select current_setting('app.habit_sync_rpc', true)) = 'on'
  );
create policy "marks_update_via_sync_rpc" on public.habit_marks
  for update to authenticated
  using (
    (select auth.uid()) = user_id
    and (select current_setting('app.habit_sync_rpc', true)) = 'on'
  )
  with check (
    (select auth.uid()) = user_id
    and (select current_setting('app.habit_sync_rpc', true)) = 'on'
  );
create policy "marks_delete_via_sync_rpc" on public.habit_marks
  for delete to authenticated
  using (
    (select auth.uid()) = user_id
    and (select current_setting('app.habit_sync_rpc', true)) = 'on'
  );

drop policy if exists "calendar_sync_meta_insert_own" on public.calendar_sync_meta;
drop policy if exists "calendar_sync_meta_update_own" on public.calendar_sync_meta;
create policy "calendar_sync_meta_insert_via_sync_rpc" on public.calendar_sync_meta
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (select current_setting('app.habit_sync_rpc', true)) = 'on'
  );
create policy "calendar_sync_meta_update_via_sync_rpc" on public.calendar_sync_meta
  for update to authenticated
  using (
    (select auth.uid()) = user_id
    and (select current_setting('app.habit_sync_rpc', true)) = 'on'
  )
  with check (
    (select auth.uid()) = user_id
    and (select current_setting('app.habit_sync_rpc', true)) = 'on'
  );

drop policy if exists "sync_events_insert_own" on public.sync_events;
create policy "sync_events_insert_via_sync_rpc" on public.sync_events
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (select current_setting('app.habit_sync_rpc', true)) = 'on'
  );

create or replace function public.apply_habit_sync_event(
  p_user_id uuid,
  p_client_event_id text,
  p_kind text,
  p_payload jsonb,
  p_expected_revision bigint
)
returns table (
  applied boolean,
  server_revision bigint,
  server_updated_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_auth_user_id uuid := (select auth.uid());
  v_revision bigint;
  v_updated_at timestamptz;
  v_existing_revision bigint;
  v_next_revision bigint;
  v_applied boolean := true;
  v_row_count integer;
  v_habit jsonb;
  v_changes jsonb;
  v_habit_id text;
  v_habit_ids text[] := array[]::text[];
  v_goal_period text;
  v_monthly_goal integer;
  v_completion record;
  v_day record;
begin
  if v_auth_user_id is null or v_auth_user_id <> p_user_id then
    raise exception using
      errcode = '42501',
      message = 'authenticated user does not match p_user_id';
  end if;

  perform pg_catalog.set_config('app.habit_sync_rpc', 'on', true);

  if p_client_event_id is null
    or length(p_client_event_id) = 0
    or length(p_client_event_id) > 200
  then
    raise exception using errcode = '22023', message = 'invalid client_event_id';
  end if;

  if p_kind not in (
    'state_snapshot',
    'habit_upsert',
    'habit_patch',
    'habit_delete',
    'mark_set'
  ) then
    raise exception using errcode = '22023', message = 'unsupported sync event kind';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'payload must be an object';
  end if;

  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'invalid expected revision';
  end if;

  insert into public.calendar_sync_meta (user_id, revision)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  select meta.revision, meta.updated_at
    into v_revision, v_updated_at
  from public.calendar_sync_meta as meta
  where meta.user_id = p_user_id
  for update;

  select event.server_revision
    into v_existing_revision
  from public.sync_events as event
  where event.user_id = p_user_id
    and event.client_event_id = p_client_event_id;

  if found then
    return query select false, v_revision, v_updated_at;
    return;
  end if;

  if p_expected_revision <> v_revision then
    raise exception using
      errcode = '40001',
      message = 'sync revision conflict',
      detail = format(
        'expected revision %s, current revision %s',
        p_expected_revision,
        v_revision
      );
  end if;

  if p_kind = 'state_snapshot' then
    if jsonb_typeof(p_payload -> 'habits') is distinct from 'array'
      or jsonb_typeof(p_payload -> 'completions') is distinct from 'object'
    then
      raise exception using errcode = '22023', message = 'invalid state_snapshot payload';
    end if;

    for v_habit in
      select value from jsonb_array_elements(p_payload -> 'habits')
    loop
      if jsonb_typeof(v_habit) <> 'object'
        or jsonb_typeof(v_habit -> 'id') <> 'string'
        or jsonb_typeof(v_habit -> 'name') <> 'string'
        or jsonb_typeof(v_habit -> 'emoji') <> 'string'
        or jsonb_typeof(v_habit -> 'negative') <> 'boolean'
        or jsonb_typeof(v_habit -> 'monthlyGoal') <> 'number'
      then
        raise exception using errcode = '22023', message = 'invalid habit in snapshot';
      end if;

      v_habit_id := v_habit ->> 'id';
      v_goal_period := coalesce(v_habit ->> 'goalPeriod', 'month');
      if length(v_habit_id) = 0
        or length(v_habit_id) > 200
        or length(v_habit ->> 'name') = 0
        or length(v_habit ->> 'name') > 500
        or length(v_habit ->> 'emoji') = 0
        or length(v_habit ->> 'emoji') > 64
        or v_goal_period not in ('month', 'week')
        or (v_habit ->> 'monthlyGoal') !~ '^[0-9]+$'
      then
        raise exception using errcode = '22023', message = 'invalid habit fields';
      end if;

      v_monthly_goal := (v_habit ->> 'monthlyGoal')::integer;
      if v_monthly_goal < 0
        or v_monthly_goal > (case when v_goal_period = 'week' then 7 else 31 end)
      then
        raise exception using errcode = '22023', message = 'monthlyGoal is out of range';
      end if;

      if v_habit_id = any(v_habit_ids) then
        raise exception using errcode = '22023', message = 'duplicate habit id in snapshot';
      end if;
      v_habit_ids := array_append(v_habit_ids, v_habit_id);

      insert into public.habits (
        id,
        user_id,
        name,
        emoji,
        negative,
        monthly_goal,
        goal_period,
        is_priority,
        created_day,
        archived,
        deadline,
        postponed_until,
        deleted_at
      ) values (
        v_habit_id,
        p_user_id,
        v_habit ->> 'name',
        v_habit ->> 'emoji',
        (v_habit ->> 'negative')::boolean,
        v_monthly_goal,
        v_goal_period,
        coalesce((v_habit ->> 'isPriority')::boolean, false),
        (v_habit ->> 'createdAt')::date,
        coalesce((v_habit ->> 'archived')::boolean, false),
        (v_habit ->> 'deadline')::date,
        (v_habit ->> 'postponedUntil')::date,
        null
      )
      on conflict (user_id, id) do update set
        name = excluded.name,
        emoji = excluded.emoji,
        negative = excluded.negative,
        monthly_goal = excluded.monthly_goal,
        goal_period = excluded.goal_period,
        is_priority = excluded.is_priority,
        created_day = excluded.created_day,
        archived = excluded.archived,
        deadline = excluded.deadline,
        postponed_until = excluded.postponed_until
      where habits.deleted_at is null;

      get diagnostics v_row_count = row_count;
      if v_row_count = 0 then v_applied := false; end if;
    end loop;

    update public.habits
    set deleted_at = coalesce(deleted_at, now()), archived = true
    where user_id = p_user_id
      and deleted_at is null
      and not (id = any(v_habit_ids));

    update public.habit_marks
    set marked = false
    where user_id = p_user_id and marked = true;

    for v_completion in
      select key, value from jsonb_each(p_payload -> 'completions')
    loop
      if not (v_completion.key = any(v_habit_ids))
        or jsonb_typeof(v_completion.value) <> 'object'
      then
        raise exception using errcode = '22023', message = 'invalid completions habit';
      end if;

      for v_day in select key, value from jsonb_each(v_completion.value)
      loop
        if jsonb_typeof(v_day.value) <> 'boolean' then
          raise exception using errcode = '22023', message = 'invalid completion value';
        end if;
        if v_day.value = 'true'::jsonb then
          insert into public.habit_marks (user_id, habit_id, day, marked)
          select p_user_id, v_completion.key, v_day.key::date, true
          from public.habits as habit
          where habit.user_id = p_user_id
            and habit.id = v_completion.key
            and habit.deleted_at is null
          on conflict (user_id, habit_id, day) do update
            set marked = excluded.marked;
          get diagnostics v_row_count = row_count;
          if v_row_count = 0 then v_applied := false; end if;
        end if;
      end loop;
    end loop;

  elsif p_kind = 'habit_upsert' then
    v_habit := p_payload;
    if jsonb_typeof(v_habit -> 'id') <> 'string'
      or jsonb_typeof(v_habit -> 'name') <> 'string'
      or jsonb_typeof(v_habit -> 'emoji') <> 'string'
      or jsonb_typeof(v_habit -> 'negative') <> 'boolean'
      or jsonb_typeof(v_habit -> 'monthlyGoal') <> 'number'
    then
      raise exception using errcode = '22023', message = 'invalid habit_upsert payload';
    end if;

    v_habit_id := v_habit ->> 'id';
    v_goal_period := coalesce(v_habit ->> 'goalPeriod', 'month');
    if length(v_habit_id) = 0
      or length(v_habit_id) > 200
      or length(v_habit ->> 'name') = 0
      or length(v_habit ->> 'name') > 500
      or length(v_habit ->> 'emoji') = 0
      or length(v_habit ->> 'emoji') > 64
      or v_goal_period not in ('month', 'week')
      or (v_habit ->> 'monthlyGoal') !~ '^[0-9]+$'
    then
      raise exception using errcode = '22023', message = 'invalid habit fields';
    end if;
    v_monthly_goal := (v_habit ->> 'monthlyGoal')::integer;
    if v_monthly_goal < 0
      or v_monthly_goal > (case when v_goal_period = 'week' then 7 else 31 end)
    then
      raise exception using errcode = '22023', message = 'monthlyGoal is out of range';
    end if;

    insert into public.habits (
      id,
      user_id,
      name,
      emoji,
      negative,
      monthly_goal,
      goal_period,
      is_priority,
      created_day,
      archived,
      deadline,
      postponed_until,
      deleted_at
    ) values (
      v_habit_id,
      p_user_id,
      v_habit ->> 'name',
      v_habit ->> 'emoji',
      (v_habit ->> 'negative')::boolean,
      v_monthly_goal,
      v_goal_period,
      coalesce((v_habit ->> 'isPriority')::boolean, false),
      (v_habit ->> 'createdAt')::date,
      coalesce((v_habit ->> 'archived')::boolean, false),
      (v_habit ->> 'deadline')::date,
      (v_habit ->> 'postponedUntil')::date,
      null
    )
    on conflict (user_id, id) do nothing;

    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then v_applied := false; end if;

  elsif p_kind = 'habit_patch' then
    if jsonb_typeof(p_payload -> 'id') <> 'string'
      or length(p_payload ->> 'id') = 0
      or length(p_payload ->> 'id') > 200
      or jsonb_typeof(p_payload -> 'changes') <> 'object'
      or p_payload -> 'changes' = '{}'::jsonb
      or exists (
        select 1
        from jsonb_object_keys(p_payload -> 'changes') as field(name)
        where field.name not in (
          'name',
          'emoji',
          'negative',
          'monthlyGoal',
          'goalPeriod',
          'isPriority',
          'createdAt',
          'archived',
          'deadline',
          'postponedUntil'
        )
      )
    then
      raise exception using errcode = '22023', message = 'invalid habit_patch payload';
    end if;

    v_changes := p_payload -> 'changes';
    if (v_changes ? 'name') and (
      jsonb_typeof(v_changes -> 'name') <> 'string'
      or length(v_changes ->> 'name') = 0
      or length(v_changes ->> 'name') > 500
    ) then
      raise exception using errcode = '22023', message = 'invalid patched name';
    end if;
    if (v_changes ? 'emoji') and (
      jsonb_typeof(v_changes -> 'emoji') <> 'string'
      or length(v_changes ->> 'emoji') = 0
      or length(v_changes ->> 'emoji') > 64
    ) then
      raise exception using errcode = '22023', message = 'invalid patched emoji';
    end if;
    if (v_changes ? 'negative')
      and jsonb_typeof(v_changes -> 'negative') <> 'boolean'
    then
      raise exception using errcode = '22023', message = 'invalid patched negative';
    end if;
    if (v_changes ? 'monthlyGoal') and (
      jsonb_typeof(v_changes -> 'monthlyGoal') <> 'number'
      or (v_changes ->> 'monthlyGoal') !~ '^[0-9]+$'
      or (v_changes ->> 'monthlyGoal')::integer < 0
      or (v_changes ->> 'monthlyGoal')::integer > 31
    ) then
      raise exception using errcode = '22023', message = 'invalid patched monthlyGoal';
    end if;
    if (v_changes ? 'goalPeriod') and (
      jsonb_typeof(v_changes -> 'goalPeriod') <> 'string'
      or (v_changes ->> 'goalPeriod') not in ('month', 'week')
    ) then
      raise exception using errcode = '22023', message = 'invalid patched goalPeriod';
    end if;
    if (v_changes ? 'isPriority')
      and jsonb_typeof(v_changes -> 'isPriority') <> 'boolean'
    then
      raise exception using errcode = '22023', message = 'invalid patched isPriority';
    end if;
    if (v_changes ? 'archived')
      and jsonb_typeof(v_changes -> 'archived') <> 'boolean'
    then
      raise exception using errcode = '22023', message = 'invalid patched archived';
    end if;
    if (v_changes ? 'createdAt')
      and jsonb_typeof(v_changes -> 'createdAt') not in ('string', 'null')
    then
      raise exception using errcode = '22023', message = 'invalid patched createdAt';
    end if;
    if (v_changes ? 'deadline')
      and jsonb_typeof(v_changes -> 'deadline') not in ('string', 'null')
    then
      raise exception using errcode = '22023', message = 'invalid patched deadline';
    end if;
    if (v_changes ? 'postponedUntil')
      and jsonb_typeof(v_changes -> 'postponedUntil') not in ('string', 'null')
    then
      raise exception using errcode = '22023', message = 'invalid patched postponedUntil';
    end if;

    update public.habits
    set
      name = case when v_changes ? 'name' then v_changes ->> 'name' else name end,
      emoji = case when v_changes ? 'emoji' then v_changes ->> 'emoji' else emoji end,
      negative = case
        when v_changes ? 'negative' then (v_changes ->> 'negative')::boolean
        else negative
      end,
      monthly_goal = case
        when v_changes ? 'monthlyGoal' then (v_changes ->> 'monthlyGoal')::integer
        else monthly_goal
      end,
      goal_period = case
        when v_changes ? 'goalPeriod' then v_changes ->> 'goalPeriod'
        else goal_period
      end,
      is_priority = case
        when v_changes ? 'isPriority' then (v_changes ->> 'isPriority')::boolean
        else is_priority
      end,
      created_day = case
        when v_changes ? 'createdAt' then (v_changes ->> 'createdAt')::date
        else created_day
      end,
      archived = case
        when v_changes ? 'archived' then (v_changes ->> 'archived')::boolean
        else archived
      end,
      deadline = case
        when v_changes ? 'deadline' then (v_changes ->> 'deadline')::date
        else deadline
      end,
      postponed_until = case
        when v_changes ? 'postponedUntil'
          then (v_changes ->> 'postponedUntil')::date
        else postponed_until
      end
    where user_id = p_user_id
      and id = p_payload ->> 'id'
      and deleted_at is null;

    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then
      v_applied := false;
    elsif exists (
      select 1
      from public.habits as habit
      where habit.user_id = p_user_id
        and habit.id = p_payload ->> 'id'
        and (
          habit.monthly_goal < 0
          or habit.monthly_goal > (
            case when habit.goal_period = 'week' then 7 else 31 end
          )
        )
    ) then
      raise exception using errcode = '22023', message = 'patched monthlyGoal is out of range';
    end if;

  elsif p_kind = 'habit_delete' then
    if jsonb_typeof(p_payload -> 'id') <> 'string'
      or length(p_payload ->> 'id') = 0
      or length(p_payload ->> 'id') > 200
    then
      raise exception using errcode = '22023', message = 'invalid habit_delete payload';
    end if;

    update public.habits
    set deleted_at = coalesce(deleted_at, now()), archived = true
    where user_id = p_user_id and id = p_payload ->> 'id';

    update public.habit_marks
    set marked = false
    where user_id = p_user_id and habit_id = p_payload ->> 'id';

  elsif p_kind = 'mark_set' then
    if jsonb_typeof(p_payload -> 'habitId') <> 'string'
      or jsonb_typeof(p_payload -> 'dayKey') <> 'string'
      or jsonb_typeof(p_payload -> 'marked') <> 'boolean'
      or length(p_payload ->> 'habitId') = 0
      or length(p_payload ->> 'habitId') > 200
    then
      raise exception using errcode = '22023', message = 'invalid mark_set payload';
    end if;

    insert into public.habit_marks (user_id, habit_id, day, marked)
    select
      p_user_id,
      p_payload ->> 'habitId',
      (p_payload ->> 'dayKey')::date,
      (p_payload ->> 'marked')::boolean
    from public.habits as habit
    where habit.user_id = p_user_id
      and habit.id = p_payload ->> 'habitId'
      and habit.deleted_at is null
    on conflict (user_id, habit_id, day) do update
      set marked = excluded.marked;

    get diagnostics v_row_count = row_count;
    if v_row_count = 0 then v_applied := false; end if;
  end if;

  v_next_revision := v_revision + 1;

  update public.calendar_sync_meta
  set revision = v_next_revision, updated_at = now()
  where user_id = p_user_id
  returning updated_at into v_updated_at;

  insert into public.sync_events (
    user_id,
    client_event_id,
    kind,
    payload,
    server_revision
  ) values (
    p_user_id,
    p_client_event_id,
    p_kind,
    p_payload,
    v_next_revision
  );

  return query select v_applied, v_next_revision, v_updated_at;
end;
$$;

revoke execute on function public.apply_habit_sync_event(uuid, text, text, jsonb, bigint)
  from public, anon;
grant execute on function public.apply_habit_sync_event(uuid, text, text, jsonb, bigint)
  to authenticated;

comment on function public.apply_habit_sync_event(uuid, text, text, jsonb, bigint)
  is 'Atomically applies one idempotent calendar sync event with optimistic concurrency control.';
