-- Store one-off Multitimer markers without turning them into zero-length intervals.
create table public.timer_events (
  user_id uuid not null references auth.users (id) on delete cascade,
  client_event_id text not null,
  kind text not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, client_event_id),
  constraint timer_events_client_id_check check (
    length(client_event_id) between 1 and 200
  ),
  constraint timer_events_kind_check check (
    kind in ('interruption', 'distraction')
  )
);

create index timer_events_user_occurred_idx
  on public.timer_events (user_id, occurred_at desc)
  include (kind);

alter table public.timer_events enable row level security;

revoke all on table public.timer_events from public, anon, authenticated;
grant select, insert on table public.timer_events to authenticated;

create policy "timer_events_select_own" on public.timer_events
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "timer_events_insert_own" on public.timer_events
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
