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
  const rateError = await consumeSensitiveRateLimit(user, 'delete_evidence');
  if (rateError) return response({ error: rateError.message.includes('rate limit') ? 'Evidence deletion is temporarily rate limited.' : 'Evidence deletion is unavailable.' }, rateError.message.includes('rate limit') ? 429 : 503);
  const { data: record } = await user.from('evidence').select('id,object_path').eq('id', input.evidenceId).eq('event_id', input.eventId).eq('journey_id', input.journeyId).eq('owner_id', actor.id).single();
  if (!record) return response({ error: 'Only the evidence owner can delete this file' }, 403);
  const { error: storageError } = await admin.storage.from('evidence').remove([record.object_path]);
  if (storageError) return response({ error: 'Evidence file could not be deleted' }, 500);
  const { error } = await admin.from('evidence').delete().eq('id', record.id);
  if (error) return response({ error: 'Evidence metadata could not be deleted' }, 500);
  return response({ deleted: true });
});
