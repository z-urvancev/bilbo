-- Divide each task's month into four optional planning blocks.
-- Existing tasks stay unassigned until the user chooses a block.
alter table public.goal_tasks
  add column month_block smallint;

alter table public.goal_tasks
  add constraint goal_tasks_month_block_check
  check (month_block between 1 and 4);
