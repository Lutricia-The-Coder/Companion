-- Retention and access controls for emergency evidence. Apply through the Supabase Dashboard SQL Editor.
alter table public.profiles
  add column if not exists evidence_retention_days integer not null default 30;
alter table public.profiles
  drop constraint if exists profiles_evidence_retention_days_check;
alter table public.profiles
  add constraint profiles_evidence_retention_days_check
  check (evidence_retention_days in (7, 30, 90));

alter table public.evidence
  add column if not exists recorded_at bigint not null
  default (extract(epoch from clock_timestamp()) * 1000)::bigint;

-- The previous object policy let any signed-in journey participant bypass metadata expiry
-- by downloading directly from Storage. Require a live metadata row for every object read.
drop policy if exists "authorized journey evidence read" on storage.objects;
create policy "authorized journey evidence read" on storage.objects
  for select to authenticated using (
    bucket_id = 'evidence'
    and exists (
      select 1
      from public.evidence e
      join public.journeys j on j.id = e.journey_id
      where e.object_path = storage.objects.name
        and e.expires_at > (extract(epoch from clock_timestamp()) * 1000)::bigint
        and (
          j.owner_id = (select auth.uid())
          or exists (
            select 1 from public.journey_access a
            where a.journey_id = j.id and a.user_id = (select auth.uid())
          )
        )
    )
  );
