-- Record ambiguous provider/network results and allow bounded retries across invocations.
-- Apply with Supabase Dashboard → SQL Editor before deploying the updated functions.
alter table public.notification_attempts
  drop constraint if exists notification_attempts_status_check;
alter table public.notification_attempts
  add constraint notification_attempts_status_check
  check (status in ('accepted', 'failed', 'unknown'));

alter table public.notification_attempts
  drop constraint if exists notification_attempts_attempt_count_check;
alter table public.notification_attempts
  add constraint notification_attempts_attempt_count_check
  check (attempt_count between 1 and 3);
