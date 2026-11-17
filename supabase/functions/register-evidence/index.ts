import { clients, response, uuid, notifyEvidenceContacts } from '../_shared/common.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return response({ ok: true });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  const { user, admin } = clients(request);
  const { data: { user: actor }, error: authError } = await user.auth.getUser();
  if (authError || !actor) return response({ error: 'Sign in required' }, 401);
  const input = await request.json().catch(() => ({}));
  if (!uuid(input.journeyId) || !uuid(input.eventId) || typeof input.evidenceId !== 'string'
    || !uuid(input.evidenceId) || typeof input.objectPath !== 'string'
    || !['audio/mp4', 'audio/m4a', 'video/mp4'].includes(input.contentType)
    || !Number.isInteger(input.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > 30
    || !Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 25 * 1024 * 1024) {
    return response({ error: 'Evidence metadata is invalid' }, 400);
  }
  const prefix = `${actor.id}/${input.journeyId}/${input.eventId}/${input.evidenceId}`;
  if (input.objectPath !== prefix) return response({ error: 'Evidence path is invalid' }, 403);
  const { data: journey } = await user.from('journeys').select('id,owner_id').eq('id', input.journeyId).eq('owner_id', actor.id).single();
  if (!journey) return response({ error: 'Journey not found' }, 403);
  const { data: event } = await user.from('safety_events').select('id,event_type').eq('id', input.eventId).eq('journey_id', input.journeyId).single();
  if (!event || event.event_type !== 'emergency') return response({ error: 'Emergency event not found' }, 404);
  const { data: files } = await user.storage.from('evidence').list(`${actor.id}/${input.journeyId}/${input.eventId}`);
  const file = files?.find((item) => item.name === input.evidenceId);
  if (!file || Number(file.metadata?.size ?? input.sizeBytes) !== input.sizeBytes) return response({ error: 'Uploaded evidence file is missing or invalid' }, 400);
  const expiresAt = Date.now() + 30 * 24 * 60 * 60_000;
  const { error } = await admin.from('evidence').insert({
    id: input.evidenceId,
    event_id: input.eventId,
    journey_id: input.journeyId,
    owner_id: actor.id,
    object_path: input.objectPath,
    media_type: input.contentType.startsWith('video/') ? 'video' : 'audio',
    content_type: input.contentType,
    duration_seconds: input.durationSeconds,
    size_bytes: input.sizeBytes,
    expires_at: expiresAt,
  });
  if (error) {
    if (error.code === '23505') {
      const { data: existing } = await admin.from('evidence').select('id,expires_at').eq('event_id', input.eventId).eq('media_type', input.contentType.startsWith('video/') ? 'video' : 'audio').single();
      if (existing) return response({ evidenceId: existing.id, expiresAt: existing.expires_at, notifications: { status: 'duplicate_suppressed' } });
    }
    return response({ error: 'Evidence metadata could not be registered' }, 400);
  }
  const { data: signed, error: signError } = await admin.storage.from('evidence').createSignedUrl(input.objectPath, 15 * 60);
  const notifications = signed?.signedUrl
    ? await notifyEvidenceContacts(admin, input.journeyId, input.eventId, input.contentType.startsWith('video/') ? 'video' : 'audio', signed.signedUrl)
    : { status: 'link_unavailable', accepted: 0, failures: 0, reason: signError?.message ?? 'Could not create a temporary evidence link' };
  return response({ evidenceId: input.evidenceId, expiresAt, notifications });
});
