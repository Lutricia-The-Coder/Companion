create or replace function public.publish_journey_location(p_journey_id uuid, p_location jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  lat numeric;
  lon numeric;
  accuracy numeric;
  point_time numeric;
  current_location jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if p_location is null or jsonb_typeof(p_location) <> 'object' then raise exception 'Location must be an object'; end if;

  lat := (p_location->>'latitude')::numeric;
  lon := (p_location->>'longitude')::numeric;
  point_time := (p_location->>'timestamp')::numeric;
  accuracy := nullif(p_location->>'accuracy', '')::numeric;
  if abs(lat) > 90 or abs(lon) > 180 or point_time is null
    or point_time < 0 or point_time > (extract(epoch from clock_timestamp()) * 1000) + 10000
    or accuracy is null or accuracy < 0 or accuracy > 100 then
    raise exception 'Location is invalid';
  end if;

  select j.location into current_location
    from public.journeys j
    where j.id = p_journey_id and j.owner_id = auth.uid() and j.status = 'active'
    for update;
  if not found then raise exception 'Active journey not found'; end if;

  -- Two location streams can report the same fix concurrently. Ignore duplicates and
  -- delayed older writes so the shared dashboard never regresses to a stale coordinate.
  if current_location is not null
    and coalesce((current_location->>'timestamp')::numeric, -1) >= point_time then
    return;
  end if;

  update public.journeys set location = p_location
    where id = p_journey_id and owner_id = auth.uid() and status = 'active';
end; $$;

revoke all on function public.publish_journey_location(uuid,jsonb) from public, anon;
grant execute on function public.publish_journey_location(uuid,jsonb) to authenticated;
