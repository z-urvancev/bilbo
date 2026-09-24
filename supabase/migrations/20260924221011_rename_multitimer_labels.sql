do $$
declare
  target_user_id uuid;
  changed_rows integer;
begin
  select id
  into strict target_user_id
  from auth.users
  where lower(email) = lower('zahvinar358@gmail.com');

  update public.timer_definitions
  set name = case id
    when 'meeting' then 'Meet'
    when 'break' then 'Break'
    else name
  end
  where user_id = target_user_id
    and id in ('meeting', 'break');

  get diagnostics changed_rows = row_count;
  if changed_rows <> 2 then
    raise exception 'Expected to rename 2 timer rows, renamed %', changed_rows;
  end if;
end
$$;
