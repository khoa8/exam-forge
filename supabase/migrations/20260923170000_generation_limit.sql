-- Bound repeated expensive generation attempts per anonymous learner. The
-- counter also advances for non-viable material, before generation starts.
create table public.ef_generation_limits (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null,
  uses integer not null check (uses between 0 and 5)
);
alter table public.ef_generation_limits enable row level security;
revoke all on public.ef_generation_limits from anon, authenticated;
grant select, insert, update, delete on public.ef_generation_limits to service_role;

create function public.ef_take_generation_slot(p_owner_id uuid) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_limit public.ef_generation_limits%rowtype;
begin
  insert into public.ef_generation_limits(owner_id, window_started_at, uses)
  values (p_owner_id, now(), 0)
  on conflict (owner_id) do nothing;
  select * into v_limit from public.ef_generation_limits
    where owner_id = p_owner_id for update;
  if v_limit.window_started_at <= now() - interval '1 hour' then
    update public.ef_generation_limits set window_started_at = now(), uses = 1
      where owner_id = p_owner_id;
    return true;
  end if;
  if v_limit.uses >= 5 then return false; end if;
  update public.ef_generation_limits set uses = uses + 1
    where owner_id = p_owner_id;
  return true;
end;
$$;
revoke all on function public.ef_take_generation_slot(uuid) from public, anon, authenticated;
grant execute on function public.ef_take_generation_slot(uuid) to service_role;
