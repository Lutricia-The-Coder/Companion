create or replace function public.publish_journey_location(p_journey_id uuid, p_location jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  lat numeric;
  lon numeric;
  accuracy numeric;
  point_time numeric;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if p_location is null or jsonb_typeof(p_location) <> 'object' then raise exception 'Location must be an object'; end if;
  lat := (p_location->>'latitude')::numeric;
  lon := (p_location->>'longitude')::numeric;
  point_time := (p_location->>'timestamp')::numeric;
  accuracy := nullif(p_location->>'accuracy', '')::numeric;
  if abs(lat) > 90 or abs(lon) > 180 or point_time is null
    or point_time < 0 or point_time > (extract(epoch from clock_timestamp()) * 1000) + 10000
    or (accuracy is not null and (accuracy < 0 or accuracy > 100000)) then
    raise exception 'Location is invalid';
  end if;
  update public.journeys set location=p_location
    where id=p_journey_id and owner_id=auth.uid() and status='active';
  if not found then raise exception 'Active journey not found'; end if;
end; $$;

revoke all on function public.publish_journey_location(uuid,jsonb) from public, anon;
grant execute on function public.publish_journey_location(uuid,jsonb) to authenticated;

create unique index if not exists evidence_one_recording_per_type_per_event_idx
  on public.evidence(event_id, media_type);
