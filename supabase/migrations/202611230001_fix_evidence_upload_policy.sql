-- Fix the emergency evidence upload policy path shape.
-- For uid/journey/event/evidence-id, foldername(name) returns only the three
-- folders (uid, journey, event); storage.filename(name) returns evidence-id.
drop policy if exists "owner upload emergency evidence" on storage.objects;
create policy "owner upload emergency evidence" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'evidence'
    and cardinality(storage.foldername(name)) = 3
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and (storage.foldername(name))[3] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and storage.filename(name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and exists (
      select 1
      from public.journeys j
      join public.safety_events e on e.journey_id = j.id
      where j.id::text = (storage.foldername(name))[2]
        and j.owner_id = (select auth.uid())
        and e.id::text = (storage.foldername(name))[3]
        and e.event_type = 'emergency'
    )
  );
