create extension if not exists pgcrypto with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  email text not null default '',
  trusted_contacts jsonb not null default '[]'::jsonb check (jsonb_typeof(trusted_contacts) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.journeys (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  destination text not null default '',
  status text not null default 'active' check (status in ('active','ended')),
  started_at bigint not null default (extract(epoch from clock_timestamp()) * 1000)::bigint,
  ended_at bigint,
  location jsonb,
  route jsonb not null default '[]'::jsonb check (jsonb_typeof(route) = 'array'),
  emergency boolean not null default false,
  emergency_at bigint,
  route_alerted_at bigint,
  created_at timestamptz not null default now()
);

create table if not exists public.journey_access (
  journey_id uuid not null references public.journeys(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (journey_id, user_id)
);

create table if not exists public.safety_events (
  id uuid primary key default extensions.gen_random_uuid(),
  journey_id uuid not null references public.journeys(id) on delete cascade,
  event_type text not null check (event_type in ('emergency','route_deviation')),
  status text not null default 'recorded',
  reason text not null,
  activated_at bigint not null default (extract(epoch from clock_timestamp()) * 1000)::bigint,
  location jsonb,
  notifications jsonb not null default '{"status":"pending","accepted":0,"failures":0}'::jsonb
);

create table if not exists public.evidence (
  id uuid primary key default extensions.gen_random_uuid(),
  event_id uuid not null references public.safety_events(id) on delete cascade,
  journey_id uuid not null references public.journeys(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  object_path text not null unique,
  media_type text not null check (media_type in ('audio','video')),
  content_type text not null check (content_type in ('audio/mp4','audio/m4a','video/mp4')),
  duration_seconds integer not null check (duration_seconds between 1 and 30),
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  uploaded_at bigint not null default (extract(epoch from clock_timestamp()) * 1000)::bigint,
  expires_at bigint not null
);

create index if not exists journeys_owner_started_idx on public.journeys(owner_id, started_at desc);
create index if not exists events_journey_activated_idx on public.safety_events(journey_id, activated_at desc);
create index if not exists evidence_expires_idx on public.evidence(expires_at);

alter table public.profiles enable row level security;
alter table public.journeys enable row level security;
alter table public.journey_access enable row level security;
alter table public.safety_events enable row level security;
alter table public.evidence enable row level security;

drop policy if exists "profile owner read" on public.profiles;
create policy "profile owner read" on public.profiles for select to authenticated using (id = (select auth.uid()));
drop policy if exists "profile owner update" on public.profiles;
create policy "profile owner update" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
drop policy if exists "profile owner insert" on public.profiles;
create policy "profile owner insert" on public.profiles for insert to authenticated with check (id = (select auth.uid()));

drop policy if exists "journey owner or shared read" on public.journeys;
create policy "journey owner or shared read" on public.journeys for select to authenticated using (
  owner_id = (select auth.uid()) or exists (
    select 1 from public.journey_access a where a.journey_id = journeys.id and a.user_id = (select auth.uid())
  )
);
drop policy if exists "owner create journey" on public.journeys;
create policy "owner create journey" on public.journeys for insert to authenticated with check (owner_id = (select auth.uid()) and emergency = false and status = 'active');
drop policy if exists "owner update active journey" on public.journeys;
-- All journey updates go through narrow RPCs so the client cannot set emergency state.

drop policy if exists "journey participants can see access" on public.journey_access;
create policy "journey participants can see access" on public.journey_access for select to authenticated using (
  user_id = (select auth.uid())
);

drop policy if exists "journey participants read events" on public.safety_events;
create policy "journey participants read events" on public.safety_events for select to authenticated using (
  exists (select 1 from public.journeys j where j.id = journey_id and (j.owner_id = (select auth.uid()) or exists (
    select 1 from public.journey_access a where a.journey_id = j.id and a.user_id = (select auth.uid())
  )))
);
drop policy if exists "evidence authorized read" on public.evidence;
create policy "evidence authorized read" on public.evidence for select to authenticated using (
  owner_id = (select auth.uid()) or exists (select 1 from public.journey_access a where a.journey_id = evidence.journey_id and a.user_id = (select auth.uid()))
);

create or replace function public.create_journey(p_destination text, p_route jsonb default '[]'::jsonb)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  insert into public.journeys(owner_id, destination, route)
  values (auth.uid(), left(coalesce(p_destination, ''), 300), case when jsonb_typeof(p_route) = 'array' then p_route else '[]'::jsonb end)
  returning id into new_id;
  return new_id;
end; $$;

create or replace function public.publish_journey_location(p_journey_id uuid, p_location jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare lat numeric; lon numeric; point_time numeric;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  lat := (p_location->>'latitude')::numeric; lon := (p_location->>'longitude')::numeric; point_time := (p_location->>'timestamp')::numeric;
  if abs(lat) > 90 or abs(lon) > 180 or point_time is null or point_time > (extract(epoch from clock_timestamp()) * 1000) + 10000 then raise exception 'Location is invalid'; end if;
  update public.journeys set location=p_location where id=p_journey_id and owner_id=auth.uid() and status='active';
  if not found then raise exception 'Active journey not found'; end if;
end; $$;

create or replace function public.finish_journey(p_journey_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  update public.journeys set status='ended', ended_at=(extract(epoch from clock_timestamp()) * 1000)::bigint
  where id=p_journey_id and owner_id=auth.uid() and status='active';
  if not found then raise exception 'Active journey not found'; end if;
end; $$;

create or replace function public.grant_journey_access(p_journey_id uuid, p_contact_email text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare contact_uid uuid; contact_email text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if not exists (select 1 from public.journeys j where j.id = p_journey_id and j.owner_id = auth.uid()) then raise exception 'Only the journey owner can share it'; end if;
  contact_email := lower(trim(p_contact_email));
  if not exists (select 1 from public.profiles p, jsonb_array_elements(p.trusted_contacts) c where p.id = auth.uid() and lower(coalesce(c->>'email','')) = contact_email) then raise exception 'Email must be saved as a trusted contact'; end if;
  select u.id into contact_uid from auth.users u where lower(u.email) = contact_email limit 1;
  if contact_uid is null then raise exception 'Trusted contact must create a Companion account first'; end if;
  insert into public.journey_access(journey_id, user_id) values (p_journey_id, contact_uid) on conflict do nothing;
  return contact_uid;
end; $$;

create or replace function public.activate_emergency(p_journey_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.journeys%rowtype; event_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into j from public.journeys where id = p_journey_id for update;
  if not found or j.owner_id <> auth.uid() then raise exception 'Only the journey owner can activate an emergency'; end if;
  if j.emergency then return jsonb_build_object('eventId', null, 'duplicate', true); end if;
  if j.status <> 'active' then raise exception 'Journey is not active'; end if;
  update public.journeys set emergency = true, emergency_at = (extract(epoch from clock_timestamp()) * 1000)::bigint where id = p_journey_id;
  insert into public.safety_events(journey_id,event_type,status,reason,location)
  values (p_journey_id,'emergency','alerting',left(coalesce(p_reason,'Emergency'),500),j.location) returning id into event_id;
  return jsonb_build_object('eventId', event_id, 'duplicate', false);
end; $$;

create or replace function public.report_route_deviation(p_journey_id uuid, p_location jsonb, p_distance_meters integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.journeys%rowtype; now_ms bigint; event_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select * into j from public.journeys where id = p_journey_id for update;
  if not found or j.owner_id <> auth.uid() then raise exception 'Only the journey owner can report a route alert'; end if;
  now_ms := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  if j.status <> 'active' or j.emergency then return jsonb_build_object('eventId',null,'duplicate',true); end if;
  if j.route_alerted_at is not null and now_ms - j.route_alerted_at < 300000 then return jsonb_build_object('eventId',null,'duplicate',true); end if;
  if p_distance_meters < 100 or p_distance_meters > 100000 or abs((p_location->>'latitude')::numeric) > 90 or abs((p_location->>'longitude')::numeric) > 180 then raise exception 'Route alert location is invalid'; end if;
  update public.journeys set route_alerted_at = now_ms where id = p_journey_id;
  insert into public.safety_events(journey_id,event_type,status,reason,location)
  values (p_journey_id,'route_deviation','alerting','The active journey appears about '||p_distance_meters||' m from its planned route.',p_location) returning id into event_id;
  return jsonb_build_object('eventId',event_id,'duplicate',false);
end; $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id,display_name,email)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name',''), coalesce(new.email,''))
  on conflict (id) do update set email = excluded.email;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

revoke all on function public.grant_journey_access(uuid,text) from public, anon;
grant execute on function public.grant_journey_access(uuid,text) to authenticated;
revoke all on function public.publish_journey_location(uuid,jsonb) from public, anon;
grant execute on function public.publish_journey_location(uuid,jsonb) to authenticated;
revoke all on function public.finish_journey(uuid) from public, anon;
grant execute on function public.finish_journey(uuid) to authenticated;
revoke all on function public.activate_emergency(uuid,text) from public, anon;
grant execute on function public.activate_emergency(uuid,text) to authenticated;
revoke all on function public.report_route_deviation(uuid,jsonb,integer) from public, anon;
grant execute on function public.report_route_deviation(uuid,jsonb,integer) to authenticated;
revoke all on function public.create_journey(text,jsonb) from public, anon;
grant execute on function public.create_journey(text,jsonb) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('evidence','evidence',false,26214400,array['audio/mp4','audio/m4a','video/mp4'])
on conflict (id) do update set public=false,file_size_limit=26214400,allowed_mime_types=array['audio/mp4','audio/m4a','video/mp4'];

drop policy if exists "owner upload emergency evidence" on storage.objects;
create policy "owner upload emergency evidence" on storage.objects for insert to authenticated with check (
  bucket_id='evidence' and (storage.foldername(name))[1]=auth.uid()::text and exists (
    select 1 from public.journeys j where j.id=((storage.foldername(name))[2])::uuid and j.owner_id=auth.uid()
  )
);
drop policy if exists "authorized journey evidence read" on storage.objects;
create policy "authorized journey evidence read" on storage.objects for select to authenticated using (
  bucket_id='evidence' and ((storage.foldername(name))[1]=auth.uid()::text or exists (
    select 1 from public.journey_access a where a.journey_id=((storage.foldername(name))[2])::uuid and a.user_id=auth.uid()
  ))
);
drop policy if exists "owner delete emergency evidence" on storage.objects;
create policy "owner delete emergency evidence" on storage.objects for delete to authenticated using (
  bucket_id='evidence' and (storage.foldername(name))[1]=auth.uid()::text
);

do $$ begin
  alter publication supabase_realtime add table public.journeys;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.safety_events;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.evidence;
exception when duplicate_object then null; end $$;
