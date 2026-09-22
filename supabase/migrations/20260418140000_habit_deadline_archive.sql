alter table public.habits add column if not exists archived boolean not null default false;
alter table public.habits add column if not exists deadline date null;
alter table public.habits add column if not exists postponed_until date null;
