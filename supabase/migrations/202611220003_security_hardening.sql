-- Defense-in-depth for journey writes, evidence operations, and contact notifications.
-- Apply through Supabase Dashboard → SQL Editor; never run against production before review.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.rate_limit_counters (
  user_id uuid not null references auth.users(id) on delete cascade,
  operation text not null,
  window_started_at bigint not null,
  attempt_count integer not null check (attempt_count > 0),
  primary key (user_id, operation)
);
revoke all on table private.rate_limit_counters from public, anon, authenticated, service_role;

create or replace function private.consume_rate_limit(p_operation text, p_limit integer, p_window_seconds integer)
returns void language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid := auth.uid();
  now_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  window_ms bigint;
  bucket_start bigint;
  attempts integer;
begin
  if actor_id is null then raise exception 'Sign in required'; end if;
  if p_operation !~ '^[a-z_]{2,40}$' or p_limit < 1 or p_limit > 1000 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'Invalid rate limit policy';
  end if;
  window_ms := p_window_seconds::bigint * 1000;
  bucket_start := (now_ms / window_ms) * window_ms;
  insert into private.rate_limit_counters(user_id, operation, window_started_at, attempt_count)
  values (actor_id, p_operation, bucket_start, 1)
  on conflict (user_id, operation) do update
    set window_started_at = excluded.window_started_at,
        attempt_count = case when private.rate_limit_counters.window_started_at = excluded.window_started_at
          then private.rate_limit_counters.attempt_count + 1 else 1 end
  returning attempt_count into attempts;
  if attempts > p_limit then
    raise exception using errcode = 'P0001', message = 'Sensitive operation rate limit exceeded';
  end if;
end;
$$;
revoke all on function private.consume_rate_limit(text, integer, integer) from public, anon, authenticated, service_role;

-- Edge Functions use this narrow authenticated RPC for operations that do not have a
-- public SQL mutation RPC of their own. Limits are selected server-side, never by clients.
create or replace function public.consume_sensitive_rate_limit(p_operation text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  case p_operation
    when 'register_evidence' then perform private.consume_rate_limit('register_evidence', 12, 3600);
    when 'download_evidence' then perform private.consume_rate_limit('download_evidence', 60, 3600);
    when 'delete_evidence' then perform private.consume_rate_limit('delete_evidence', 20, 3600);
    when 'delete_account' then perform private.consume_rate_limit('delete_account', 2, 86400);
    else raise exception 'Unsupported rate limit operation';
  end case;
end;
$$;
revoke all on function public.consume_sensitive_rate_limit(text) from public, anon;
grant execute on function public.consume_sensitive_rate_limit(text) to authenticated;

alter table public.profiles drop constraint if exists profiles_trusted_contacts_limit;
alter table public.profiles add constraint profiles_trusted_contacts_limit
  check (case when jsonb_typeof(trusted_contacts) = 'array' then jsonb_array_length(trusted_contacts) <= 20 else false end);
alter table public.profiles drop constraint if exists profiles_notification_preferences_values;
alter table public.profiles add constraint profiles_notification_preferences_values check (coalesce(
  jsonb_typeof(notification_preferences) = 'object'
  and (not (notification_preferences ? 'email') or jsonb_typeof(notification_preferences->'email') = 'boolean')
  and (not (notification_preferences ? 'route_deviation') or jsonb_typeof(notification_preferences->'route_deviation') = 'boolean'), false
));

-- Do not rely on RLS alone for write denial. Clients read through RLS and mutate only
-- through the authenticated, owner-checked RPCs and server-side Edge Functions.
revoke all on table public.journeys, public.journey_access, public.safety_events, public.evidence from anon, authenticated;
grant select on table public.journeys, public.journey_access, public.safety_events, public.evidence to authenticated;
revoke all on table public.profiles from anon, authenticated;
grant select, insert, update on table public.profiles to authenticated;
revoke all on table public.notification_attempts from anon, authenticated;
grant select on table public.notification_attempts to authenticated;

create or replace function public.create_journey(p_destination text, p_route jsonb default '[]'::jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid; safe_route jsonb; route_point jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  perform private.consume_rate_limit('create_journey', 10, 3600);
  if length(coalesce(p_destination, '')) > 300 or p_route is null or jsonb_typeof(p_route) <> 'array' or jsonb_array_length(p_route) > 1000 then
    raise exception 'Journey details are invalid';
  end if;
  for route_point in select value from jsonb_array_elements(p_route) loop
    if jsonb_typeof(route_point) is distinct from 'object'
      or jsonb_typeof(route_point->'latitude') is distinct from 'number'
      or jsonb_typeof(route_point->'longitude') is distinct from 'number' then
      raise exception 'Journey route is invalid';
    end if;
    if abs((route_point->>'latitude')::numeric) > 90
      or abs((route_point->>'longitude')::numeric) > 180 then raise exception 'Journey route is invalid'; end if;
  end loop;
  safe_route := coalesce(p_route, '[]'::jsonb);
  insert into public.journeys(owner_id, destination, route)
  values (auth.uid(), left(trim(coalesce(p_destination, '')), 300), safe_route)
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.publish_journey_location(p_journey_id uuid, p_location jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare lat numeric; lon numeric; accuracy numeric; point_time numeric; current_location jsonb;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if p_location is null or jsonb_typeof(p_location) <> 'object' then raise exception 'Location must be an object'; end if;
  if jsonb_typeof(p_location->'latitude') is distinct from 'number'
    or jsonb_typeof(p_location->'longitude') is distinct from 'number'
    or jsonb_typeof(p_location->'accuracy') is distinct from 'number'
    or jsonb_typeof(p_location->'timestamp') is distinct from 'number' then raise exception 'Location is invalid'; end if;
  lat := (p_location->>'latitude')::numeric;
  lon := (p_location->>'longitude')::numeric;
  accuracy := (p_location->>'accuracy')::numeric;
  point_time := (p_location->>'timestamp')::numeric;
  if abs(lat) > 90 or abs(lon) > 180 or accuracy < 0 or accuracy > 100 or point_time < 0
    or point_time > (extract(epoch from clock_timestamp()) * 1000) + 10000 then raise exception 'Location is invalid'; end if;
  perform private.consume_rate_limit('publish_location', 60, 60);
  select j.location into current_location from public.journeys j
    where j.id=p_journey_id and j.owner_id=auth.uid() and j.status='active' for update;
  if not found then raise exception 'Active journey not found'; end if;
  if current_location is not null and coalesce((current_location->>'timestamp')::numeric, -1) >= point_time then return; end if;
  update public.journeys set location=p_location
    where id=p_journey_id and owner_id=auth.uid() and status='active';
end;
$$;

create or replace function public.finish_journey(p_journey_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  perform private.consume_rate_limit('finish_journey', 20, 3600);
  update public.journeys set status='ended', ended_at=(extract(epoch from clock_timestamp()) * 1000)::bigint
    where id=p_journey_id and owner_id=auth.uid() and status='active';
  if not found then raise exception 'Active journey not found'; end if;
end;
$$;

create or replace function public.grant_journey_access(p_journey_id uuid, p_contact_email text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare contact_uid uuid; normalized_email text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if length(trim(coalesce(p_contact_email,''))) > 254 or trim(coalesce(p_contact_email,'')) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Contact email is invalid'; end if;
  if not exists (select 1 from public.journeys j where j.id=p_journey_id and j.owner_id=auth.uid()) then raise exception 'Only the journey owner can share it'; end if;
  perform private.consume_rate_limit('grant_journey_access', 10, 3600);
  normalized_email := lower(trim(p_contact_email));
  if not exists (
    select 1 from public.profiles p, jsonb_array_elements(p.trusted_contacts) c
    where p.id=auth.uid() and lower(coalesce(c->>'email',''))=normalized_email
  ) then raise exception 'Email must be saved as a trusted contact'; end if;
  select u.id into contact_uid from auth.users u where lower(u.email)=normalized_email limit 1;
  if contact_uid is null then raise exception 'Trusted contact must create a Companion account first'; end if;
  if contact_uid = auth.uid() then raise exception 'You cannot share a journey with yourself'; end if;
  insert into public.journey_access(journey_id,user_id) values (p_journey_id,contact_uid) on conflict do nothing;
  return contact_uid;
end;
$$;

create or replace function public.revoke_journey_access(p_journey_id uuid, p_contact_email text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare removed_count integer; contact_uid uuid; normalized_email text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if length(trim(coalesce(p_contact_email,''))) > 254 or trim(coalesce(p_contact_email,'')) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Contact email is invalid'; end if;
  if not exists (select 1 from public.journeys j where j.id=p_journey_id and j.owner_id=auth.uid()) then raise exception 'Only the journey owner can change access'; end if;
  perform private.consume_rate_limit('revoke_journey_access', 20, 3600);
  normalized_email := lower(trim(p_contact_email));
  select u.id into contact_uid from auth.users u where lower(u.email)=normalized_email limit 1;
  if contact_uid is null or contact_uid=auth.uid() then return false; end if;
  delete from public.journey_access where journey_id=p_journey_id and user_id=contact_uid;
  get diagnostics removed_count = row_count;
  return removed_count > 0;
end;
$$;

create or replace function public.activate_emergency(p_journey_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.journeys%rowtype; event_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if length(trim(coalesce(p_reason,''))) > 500 then raise exception 'Emergency reason is invalid'; end if;
  select * into j from public.journeys where id=p_journey_id for update;
  if not found or j.owner_id <> auth.uid() then raise exception 'Only the journey owner can activate an emergency'; end if;
  perform private.consume_rate_limit('activate_emergency', 5, 600);
  if j.emergency then return jsonb_build_object('eventId',null,'duplicate',true); end if;
  if j.status <> 'active' then raise exception 'Journey is not active'; end if;
  update public.journeys set emergency=true, emergency_at=(extract(epoch from clock_timestamp()) * 1000)::bigint where id=p_journey_id;
  insert into public.safety_events(journey_id,event_type,status,reason,location)
    values (p_journey_id,'emergency','alerting',left(coalesce(nullif(trim(p_reason),''),'Emergency'),500),j.location) returning id into event_id;
  return jsonb_build_object('eventId',event_id,'duplicate',false);
end;
$$;

create or replace function public.report_route_deviation(p_journey_id uuid, p_location jsonb, p_distance_meters integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.journeys%rowtype; now_ms bigint; event_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into j from public.journeys where id=p_journey_id for update;
  if not found or j.owner_id <> auth.uid() then raise exception 'Only the journey owner can report a route alert'; end if;
  now_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  if j.status <> 'active' or j.emergency then return jsonb_build_object('eventId',null,'duplicate',true); end if;
  if j.route_alerted_at is not null and now_ms-j.route_alerted_at < 300000 then return jsonb_build_object('eventId',null,'duplicate',true); end if;
  if p_location is null or jsonb_typeof(p_location) <> 'object'
    or jsonb_typeof(p_location->'latitude') is distinct from 'number'
    or jsonb_typeof(p_location->'longitude') is distinct from 'number'
    or jsonb_typeof(p_location->'accuracy') is distinct from 'number'
    or jsonb_typeof(p_location->'timestamp') is distinct from 'number' then raise exception 'Route alert location is invalid'; end if;
  if abs((p_location->>'latitude')::numeric)>90 or abs((p_location->>'longitude')::numeric)>180
    or (p_location->>'accuracy')::numeric < 0 or (p_location->>'accuracy')::numeric > 100
    or (p_location->>'timestamp')::numeric < now_ms-120000 or (p_location->>'timestamp')::numeric > now_ms+10000
    or p_distance_meters < 100 or p_distance_meters > 100000 then raise exception 'Route alert location is invalid'; end if;
  perform private.consume_rate_limit('route_deviation', 12, 3600);
  update public.journeys set route_alerted_at=now_ms where id=p_journey_id;
  insert into public.safety_events(journey_id,event_type,status,reason,location)
    values (p_journey_id,'route_deviation','alerting','The active journey appears about '||p_distance_meters||' m from its planned route.',p_location) returning id into event_id;
  return jsonb_build_object('eventId',event_id,'duplicate',false);
end;
$$;

create or replace function public.resolve_emergency(p_journey_id uuid, p_event_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare event_journey_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select e.journey_id into event_journey_id from public.safety_events e
    where e.id=p_event_id and e.event_type='emergency' for update;
  if event_journey_id is null or event_journey_id <> p_journey_id then raise exception 'Emergency event not found for this journey'; end if;
  perform 1 from public.journeys j where j.id=p_journey_id and j.owner_id=auth.uid() for update;
  if not found then raise exception 'Only the journey owner can resolve this emergency'; end if;
  perform private.consume_rate_limit('resolve_emergency', 10, 600);
  update public.safety_events set status='resolved',resolved_at=(extract(epoch from clock_timestamp()) * 1000)::bigint where id=p_event_id and status <> 'resolved';
  update public.journeys set emergency=false,emergency_at=null where id=p_journey_id and owner_id=auth.uid();
end;
$$;

revoke all on function public.create_journey(text,jsonb) from public, anon;
grant execute on function public.create_journey(text,jsonb) to authenticated;
revoke all on function public.publish_journey_location(uuid,jsonb) from public, anon;
grant execute on function public.publish_journey_location(uuid,jsonb) to authenticated;
revoke all on function public.finish_journey(uuid) from public, anon;
grant execute on function public.finish_journey(uuid) to authenticated;
revoke all on function public.grant_journey_access(uuid,text) from public, anon;
grant execute on function public.grant_journey_access(uuid,text) to authenticated;
revoke all on function public.revoke_journey_access(uuid,text) from public, anon;
grant execute on function public.revoke_journey_access(uuid,text) to authenticated;
revoke all on function public.activate_emergency(uuid,text) from public, anon;
grant execute on function public.activate_emergency(uuid,text) to authenticated;
revoke all on function public.report_route_deviation(uuid,jsonb,integer) from public, anon;
grant execute on function public.report_route_deviation(uuid,jsonb,integer) to authenticated;
revoke all on function public.resolve_emergency(uuid,uuid) from public, anon;
grant execute on function public.resolve_emergency(uuid,uuid) to authenticated;

-- Uploads must belong to the signed-in owner and an actual emergency event on that journey.
drop policy if exists "owner upload emergency evidence" on storage.objects;
create policy "owner upload emergency evidence" on storage.objects for insert to authenticated with check (
  bucket_id='evidence'
  and cardinality(storage.foldername(name))=4
  and (storage.foldername(name))[1]=auth.uid()::text
  and (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and (storage.foldername(name))[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and (storage.foldername(name))[4] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and exists (
    select 1 from public.journeys j join public.safety_events e on e.journey_id=j.id
    where j.id::text=(storage.foldername(name))[2] and j.owner_id=auth.uid()
      and e.id::text=(storage.foldername(name))[3] and e.event_type='emergency'
  )
);
