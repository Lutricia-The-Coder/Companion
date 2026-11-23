import { clients, response, uuid, notifyContacts, readJsonBody } from '../_shared/common.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return response({ ok: true });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  const { user, admin } = clients(request);
  const { data: { user: actor }, error: authError } = await user.auth.getUser();
  if (authError || !actor) return response({ error: 'Sign in required' }, 401);
  const body = await readJsonBody(request);
  if (body.error) return response({ error: body.error }, 400);
  const input = body.value!;
  if (!uuid(input.journeyId) || typeof input.reason !== 'string' || input.reason.length > 500) return response({ error: 'Invalid emergency request' }, 400);
  const { data, error } = await user.rpc('activate_emergency', { p_journey_id: input.journeyId, p_reason: input.reason });
  if (error) return response({ error: error.message.includes('rate limit') ? 'Too many emergency requests. Try again later.' : error.message }, error.message.includes('rate limit') ? 429 : 403);
  let eventId = data.eventId as string | null;
  let reason = input.reason as string;
  if (data.duplicate || !eventId) {
    // A repeated client request must not create a second event. It may, however, retry
    // recipients whose previous provider outcome was failed or unknown.
    const { data: existing } = await admin.from('safety_events')
      .select('id,reason').eq('journey_id', input.journeyId).eq('event_type', 'emergency')
      .neq('status', 'resolved').order('activated_at', { ascending: false }).limit(1).maybeSingle();
    if (!existing?.id) return response({ ...data, status: 'already_active', retryable: false });
    eventId = existing.id;
    reason = existing.reason ?? reason;
  }
  const notifications = await notifyContacts(admin, input.journeyId, eventId, 'Emergency alert', reason);
  return response({ eventId, duplicate: Boolean(data.duplicate), status: notifications.status, retryable: notifications.retryable, notifications });
});
