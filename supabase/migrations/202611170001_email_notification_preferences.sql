create table if not exists public.notification_attempts (
  id uuid primary key default extensions.gen_random_uuid(),
  event_id uuid not null references public.safety_events(id) on delete cascade,
  channel text not null check (channel = 'email'),
  target_masked text not null default '',
  status text not null check (status in ('accepted','failed')),
  attempt_count integer not null check (attempt_count between 1 and 3),
  provider text not null,
  provider_reference text,
  provider_response jsonb not null default '{}'::jsonb check (jsonb_typeof(provider_response) = 'object'),
  attempted_at timestamptz not null default now()
);

create index if not exists notification_attempts_event_idx on public.notification_attempts(event_id, attempted_at desc);
alter table public.notification_attempts enable row level security;
revoke all on public.notification_attempts from anon;
grant select on public.notification_attempts to authenticated;

drop policy if exists "participants read notification attempts" on public.notification_attempts;
create policy "participants read notification attempts" on public.notification_attempts
  for select to authenticated using (
    exists (select 1 from public.safety_events e join public.journeys j on j.id=e.journey_id
      where e.id=notification_attempts.event_id and (j.owner_id=(select auth.uid()) or exists (
        select 1 from public.journey_access a where a.journey_id=j.id and a.user_id=(select auth.uid())
      )))
  );

alter table public.profiles add column if not exists notification_preferences jsonb not null
  default '{"email":true,"route_deviation":true}'::jsonb;
alter table public.profiles drop constraint if exists profiles_notification_preferences_object;
alter table public.profiles add constraint profiles_notification_preferences_object
  check (jsonb_typeof(notification_preferences) = 'object');

update public.profiles
set notification_preferences = jsonb_build_object(
  'email', coalesce((notification_preferences->>'email')::boolean, true),
  'route_deviation', coalesce((notification_preferences->>'route_deviation')::boolean, true)
);
