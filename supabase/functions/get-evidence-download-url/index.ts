import { clients, response, uuid } from '../_shared/common.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return response({ ok: true });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  const { user, admin } = clients(request);
  const { data: { user: actor }, error: authError } = await user.auth.getUser();
  if (authError || !actor) return response({ error: 'Sign in required' }, 401);
  const input = await request.json().catch(() => ({}));
  if (!uuid(input.journeyId) || !uuid(input.eventId) || typeof input.evidenceId !== 'string') return response({ error: 'Invalid evidence reference' }, 400);
  const { data: record } = await user.from('evidence').select('id,object_path,media_type,content_type,expires_at').eq('id', input.evidenceId).eq('event_id', input.eventId).eq('journey_id', input.journeyId).single();
  if (!record || record.expires_at <= Date.now()) return response({ error: 'Evidence is unavailable or expired' }, 404);
  const { data, error } = await admin.storage.from('evidence').createSignedUrl(record.object_path, 120);
  if (error) return response({ error: 'Could not authorize evidence download' }, 500);
  return response({ url: data.signedUrl, type: record.media_type, contentType: record.content_type, expiresAt: Date.now() + 120000 });
});
