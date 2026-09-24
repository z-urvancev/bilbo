create index timer_state_user_active_timer_idx
  on public.timer_state (user_id, active_timer_id)
  where active_timer_id is not null;

create index timer_commands_user_timer_idx
  on public.timer_commands (user_id, timer_id)
  where timer_id is not null;

create index timer_commands_completed_interval_idx
  on public.timer_commands (completed_interval_id)
  where completed_interval_id is not null;
