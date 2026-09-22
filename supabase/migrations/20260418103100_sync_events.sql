create table if not exists public.sync_events (
  seq bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  occurred_at timestamptz not null default now(),
  client_event_id text not null,
  kind text not null,
  payload jsonb not null,
  unique (user_id, client_event_id)
);

create index if not exists sync_events_user_seq_idx on public.sync_events (user_id, seq);

alter table public.sync_events enable row level security;

drop policy if exists "sync_events_select_own" on public.sync_events;
drop policy if exists "sync_events_insert_own" on public.sync_events;

create policy "sync_events_select_own" on public.sync_events for select using (auth.uid() = user_id);
create policy "sync_events_insert_own" on public.sync_events for insert with check (auth.uid() = user_id);
