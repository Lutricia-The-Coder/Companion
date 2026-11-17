import { clients, response, uuid, notifyContacts } from '../_shared/common.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return response({ ok: true });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  const { user, admin } = clients(request);
  const { data: { user: actor }, error: authError } = await user.auth.getUser();
  if (authError || !actor) return response({ error: 'Sign in required' }, 401);
  const input = await request.json().catch(() => ({}));
  if (!uuid(input.journeyId) || typeof input.reason !== 'string' || input.reason.length > 500) return response({ error: 'Invalid emergency request' }, 400);
  const { data, error } = await user.rpc('activate_emergency', { p_journey_id: input.journeyId, p_reason: input.reason });
  if (error) return response({ error: error.message }, 403);
  if (data.duplicate || !data.eventId) return response({ ...data, status: 'already_active' });
  const notifications = await notifyContacts(admin, input.journeyId, data.eventId, 'Emergency alert', input.reason);
  return response({ ...data, status: notifications.status, notifications });
});
