alter table public.safety_events
  add column if not exists resolved_at bigint;

create or replace function public.resolve_emergency(p_journey_id uuid, p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_journey_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;

  select e.journey_id into event_journey_id
  from public.safety_events e
  where e.id = p_event_id and e.event_type = 'emergency'
  for update;
  if event_journey_id is null or event_journey_id <> p_journey_id then
    raise exception 'Emergency event not found for this journey';
  end if;

  perform 1 from public.journeys j
  where j.id = p_journey_id and j.owner_id = auth.uid()
  for update;
  if not found then raise exception 'Only the journey owner can resolve this emergency'; end if;

  update public.safety_events
  set status = 'resolved', resolved_at = (extract(epoch from clock_timestamp()) * 1000)::bigint
  where id = p_event_id and status <> 'resolved';
  update public.journeys set emergency = false, emergency_at = null
  where id = p_journey_id and owner_id = auth.uid();
end;
$$;

revoke all on function public.resolve_emergency(uuid,uuid) from public, anon;
grant execute on function public.resolve_emergency(uuid,uuid) to authenticated;
