import { clients, response, uuid, notifyEvidenceContacts, readJsonBody, consumeSensitiveRateLimit } from '../_shared/common.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return response({ ok: true });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  const { user, admin } = clients(request);
  const { data: { user: actor }, error: authError } = await user.auth.getUser();
  if (authError || !actor) return response({ error: 'Sign in required' }, 401);
  const body = await readJsonBody(request);
  if (body.error) return response({ error: body.error }, 400);
  const input = body.value!;
  if (!uuid(input.journeyId) || !uuid(input.eventId) || typeof input.evidenceId !== 'string'
    || !uuid(input.evidenceId) || typeof input.objectPath !== 'string'
    || !['audio/mp4', 'audio/m4a', 'video/mp4'].includes(input.contentType)
    || !Number.isInteger(input.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > 30
    || !Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 25 * 1024 * 1024
    || !Number.isSafeInteger(input.recordedAt) || input.recordedAt < Date.now() - 90 * 24 * 60 * 60_000 || input.recordedAt > Date.now() + 5_000) {
    return response({ error: 'Evidence metadata is invalid' }, 400);
  }
  const rateError = await consumeSensitiveRateLimit(user, 'register_evidence');
  if (rateError) return response({ error: rateError.message.includes('rate limit') ? 'Evidence uploads are temporarily rate limited.' : 'Evidence registration is unavailable.' }, rateError.message.includes('rate limit') ? 429 : 503);
  const prefix = `${actor.id}/${input.journeyId}/${input.eventId}/${input.evidenceId}`;
  if (input.objectPath !== prefix) return response({ error: 'Evidence path is invalid' }, 403);
  const { data: journey } = await user.from('journeys').select('id,owner_id').eq('id', input.journeyId).eq('owner_id', actor.id).single();
  if (!journey) return response({ error: 'Journey not found' }, 403);
  const { data: event } = await user.from('safety_events').select('id,event_type').eq('id', input.eventId).eq('journey_id', input.journeyId).single();
  if (!event || event.event_type !== 'emergency') return response({ error: 'Emergency event not found' }, 404);
  const { data: profile, error: profileError } = await user.from('profiles').select('evidence_retention_days').eq('id', actor.id).single();
  if (profileError || !profile) return response({ error: 'Evidence retention preference could not be loaded' }, 500);
  const requestedRetention = Number(profile.evidence_retention_days);
  const retentionDays = requestedRetention === 7 || requestedRetention === 90 ? requestedRetention : 30;
  // The object is not in public.evidence yet, so expiry-aware Storage SELECT RLS
  // intentionally denies the caller direct reads. Verify it with the service role
  // only after the authenticated owner and exact object path have been established.
  const { data: files, error: fileListError } = await admin.storage.from('evidence').list(`${actor.id}/${input.journeyId}/${input.eventId}`);
  if (fileListError) return response({ error: 'Uploaded evidence could not be verified' }, 500);
  const file = files?.find((item) => item.name === input.evidenceId);
  if (!file || Number(file.metadata?.size ?? input.sizeBytes) !== input.sizeBytes) return response({ error: 'Uploaded evidence file is missing or invalid' }, 400);
  const expiresAt = Date.now() + retentionDays * 24 * 60 * 60_000;
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
    recorded_at: input.recordedAt,
    expires_at: expiresAt,
  });
  if (error) {
    if (error.code === '23505') {
      const { data: existing } = await admin.from('evidence').select('id,expires_at,recorded_at').eq('event_id', input.eventId).eq('media_type', input.contentType.startsWith('video/') ? 'video' : 'audio').single();
      if (existing) return response({ evidenceId: existing.id, expiresAt: existing.expires_at, recordedAt: existing.recorded_at, notifications: { status: 'duplicate_suppressed' } });
    }
    return response({ error: 'Evidence metadata could not be registered' }, 400);
  }
  const linkLifetimeSeconds = Math.max(1, Math.floor(Math.min(15 * 60_000, expiresAt - Date.now()) / 1000));
  const { data: signed, error: signError } = await admin.storage.from('evidence').createSignedUrl(input.objectPath, linkLifetimeSeconds);
  const notifications = signed?.signedUrl
    ? await notifyEvidenceContacts(admin, input.journeyId, input.eventId, input.contentType.startsWith('video/') ? 'video' : 'audio', signed.signedUrl)
    : { status: 'link_unavailable', accepted: 0, failures: 0, reason: signError?.message ?? 'Could not create a temporary evidence link' };
  return response({ evidenceId: input.evidenceId, expiresAt, recordedAt: input.recordedAt, notifications });
});
