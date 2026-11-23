import { clients, response, uuid, readJsonBody, consumeSensitiveRateLimit } from '../_shared/common.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return response({ ok: true });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  const { user, admin } = clients(request);
  const { data: { user: actor }, error: authError } = await user.auth.getUser();
  if (authError || !actor) return response({ error: 'Sign in required' }, 401);
  const body = await readJsonBody(request, 8 * 1024);
  if (body.error) return response({ error: body.error }, 400);
  const input = body.value!;
  if (!uuid(input.journeyId) || !uuid(input.eventId) || typeof input.evidenceId !== 'string') return response({ error: 'Invalid evidence reference' }, 400);
  const rateError = await consumeSensitiveRateLimit(user, 'download_evidence');
  if (rateError) return response({ error: rateError.message.includes('rate limit') ? 'Evidence downloads are temporarily rate limited.' : 'Evidence access is unavailable.' }, rateError.message.includes('rate limit') ? 429 : 503);
  const { data: record } = await user.from('evidence').select('id,object_path,media_type,content_type,expires_at').eq('id', input.evidenceId).eq('event_id', input.eventId).eq('journey_id', input.journeyId).single();
  if (!record || record.expires_at <= Date.now()) return response({ error: 'Evidence is unavailable or expired' }, 404);
  const linkLifetimeSeconds = Math.max(1, Math.floor(Math.min(120_000, Number(record.expires_at) - Date.now()) / 1000));
  const { data, error } = await admin.storage.from('evidence').createSignedUrl(record.object_path, linkLifetimeSeconds);
  if (error) return response({ error: 'Could not authorize evidence download' }, 500);
  return response({ url: data.signedUrl, type: record.media_type, contentType: record.content_type, expiresAt: Date.now() + linkLifetimeSeconds * 1000 });
});
