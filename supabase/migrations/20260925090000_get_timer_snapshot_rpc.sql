-- Read the complete Multitimer view in one round trip. Range-bound data is
-- limited to the requested day/week while definitions and active state remain
-- available for controls.
create or replace function public.get_timer_snapshot(
  p_start timestamptz,
  p_end timestamptz,
  p_start_day date,
  p_end_day date
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with requester as (
    select auth.uid() as user_id
  )
  select jsonb_build_object(
    'definitions', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', definition.id,
            'user_id', definition.user_id,
            'name', definition.name,
            'color', definition.color,
            'icon', definition.icon,
            'sort_order', definition.sort_order,
            'created_at', definition.created_at
          )
          order by definition.sort_order, definition.created_at
        )
        from public.timer_definitions as definition
        where definition.user_id = requester.user_id
          and definition.archived_at is null
      ),
      '[]'::jsonb
    ),
    'state', (
      select jsonb_build_object(
        'revision', state.revision,
        'active_timer_id', state.active_timer_id,
        'active_started_at', state.active_started_at,
        'updated_at', state.updated_at
      )
      from public.timer_state as state
      where state.user_id = requester.user_id
    ),
    'intervals', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', interval.id,
            'timer_id', interval.timer_id,
            'started_at', interval.started_at,
            'ended_at', interval.ended_at
          )
          order by interval.started_at desc
        )
        from public.timer_intervals as interval
        where interval.user_id = requester.user_id
          and interval.started_at < p_end
          and interval.ended_at > p_start
      ),
      '[]'::jsonb
    ),
    'events', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'client_event_id', event.client_event_id,
            'kind', event.kind,
            'occurred_at', event.occurred_at
          )
          order by event.occurred_at desc
        )
        from public.timer_events as event
        where event.user_id = requester.user_id
          and event.occurred_at >= p_start
          and event.occurred_at < p_end
      ),
      '[]'::jsonb
    ),
    'daily_totals', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'timer_id', total.timer_id,
            'day', total.day,
            'duration_ms', total.duration_ms,
            'source', total.source
          )
          order by total.day desc, total.timer_id
        )
        from public.timer_daily_totals as total
        where total.user_id = requester.user_id
          and total.day >= p_start_day
          and total.day < p_end_day
      ),
      '[]'::jsonb
    )
  )
  from requester
  where requester.user_id is not null;
$$;

revoke all on function public.get_timer_snapshot(timestamptz, timestamptz, date, date)
  from public, anon;
grant execute on function public.get_timer_snapshot(timestamptz, timestamptz, date, date)
  to authenticated;

comment on function public.get_timer_snapshot(timestamptz, timestamptz, date, date)
  is 'Returns authenticated Multitimer definitions, state, and range-bound activity in one request.';
