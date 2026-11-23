-- Owner-controlled Expo push registration and attempt history.
-- Apply through Supabase Dashboard -> SQL Editor before deploying the updated functions.

alter table public.profiles
  drop constraint if exists profiles_notification_preferences_values;
alter table public.profiles
  add constraint profiles_notification_preferences_values check (coalesce(
    jsonb_typeof(notification_preferences) = 'object'
    and (not (notification_preferences ? 'email') or jsonb_typeof(notification_preferences->'email') = 'boolean')
    and (not (notification_preferences ? 'route_deviation') or jsonb_typeof(notification_preferences->'route_deviation') = 'boolean')
    and (not (notification_preferences ? 'push') or jsonb_typeof(notification_preferences->'push') = 'boolean'), false
  ));

create table if not exists public.push_devices (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  expo_push_token text not null unique check (length(expo_push_token) between 25 and 512),
  platform text not null check (platform in ('android','ios')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_devices_owner_idx on public.push_devices(owner_id);
alter table public.push_devices enable row level security;
drop policy if exists "push device owner read" on public.push_devices;
create policy "push device owner read" on public.push_devices for select to authenticated using (owner_id = (select auth.uid()));
revoke all on table public.push_devices from anon, authenticated;
grant select on table public.push_devices to authenticated;

create or replace function public.register_push_device(p_expo_push_token text, p_platform text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare device_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if p_platform is distinct from 'android' and p_platform is distinct from 'ios' or p_expo_push_token is null
    or length(p_expo_push_token) not between 25 and 512
    or p_expo_push_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$' then
    raise exception 'Push registration is invalid';
  end if;
  perform private.consume_rate_limit('register_push_device', 20, 3600);
  insert into public.push_devices(owner_id,expo_push_token,platform)
  values (auth.uid(),p_expo_push_token,p_platform)
  on conflict (expo_push_token) do update set platform=excluded.platform,updated_at=now()
    where public.push_devices.owner_id=auth.uid()
  returning id into device_id;
  if device_id is null then raise exception 'Push token is already registered to another account'; end if;
  return device_id;
end;
$$;
revoke all on function public.register_push_device(text,text) from public, anon;
grant execute on function public.register_push_device(text,text) to authenticated;

create or replace function public.unregister_push_device(p_expo_push_token text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare removed_count integer;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if p_expo_push_token is null or length(p_expo_push_token) not between 25 and 512
    or p_expo_push_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$' then raise exception 'Push registration is invalid'; end if;
  perform private.consume_rate_limit('unregister_push_device', 20, 3600);
  delete from public.push_devices where owner_id=auth.uid() and expo_push_token=p_expo_push_token;
  get diagnostics removed_count = row_count;
  return removed_count > 0;
end;
$$;
revoke all on function public.unregister_push_device(text) from public, anon;
grant execute on function public.unregister_push_device(text) to authenticated;

create or replace function public.consume_sensitive_rate_limit(p_operation text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  case p_operation
    when 'register_evidence' then perform private.consume_rate_limit('register_evidence', 12, 3600);
    when 'download_evidence' then perform private.consume_rate_limit('download_evidence', 60, 3600);
    when 'delete_evidence' then perform private.consume_rate_limit('delete_evidence', 20, 3600);
    when 'delete_account' then perform private.consume_rate_limit('delete_account', 2, 86400);
    when 'register_push_device' then perform private.consume_rate_limit('register_push_device', 20, 3600);
    when 'unregister_push_device' then perform private.consume_rate_limit('unregister_push_device', 20, 3600);
    else raise exception 'Unsupported rate limit operation';
  end case;
end;
$$;
revoke all on function public.consume_sensitive_rate_limit(text) from public, anon;
grant execute on function public.consume_sensitive_rate_limit(text) to authenticated;

alter table public.notification_attempts drop constraint if exists notification_attempts_channel_check;
alter table public.notification_attempts drop constraint if exists notification_attempts_channel_check1;
alter table public.notification_attempts add constraint notification_attempts_channel_check
  check (channel in ('email','push'));
