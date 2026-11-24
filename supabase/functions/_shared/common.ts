import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { EmailDeliveryError, emailTargets, retryEmailDelivery, sendEmailWithProvider } from './emailNotifications.ts';
import { sendExpoPushWithLimit } from './expoPush.mjs';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

export function clients(request: Request) {
  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authorization = request.headers.get('Authorization') ?? '';
  const user = createClient(url, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  return { user, admin };
}

export function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function readJsonBody(request: Request, maxBytes = 16 * 1024): Promise<{ value: Record<string, unknown> | null; error: string | null }> {
  const contentType = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return { value: null, error: 'Content-Type must be application/json' };
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > maxBytes) return { value: null, error: 'Request is too large' };
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) return { value: null, error: 'Request is too large' };
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { value: null, error: 'Request body must be an object' };
    return { value: value as Record<string, unknown>, error: null };
  } catch {
    return { value: null, error: 'Request body is not valid JSON' };
  }
}

export async function consumeSensitiveRateLimit(user: SupabaseClient, operation: 'register_evidence' | 'download_evidence' | 'delete_evidence' | 'delete_account') {
  const { error } = await user.rpc('consume_sensitive_rate_limit', { p_operation: operation });
  return error;
}

function maskedTarget(channel: string, target: string) {
  const [name = '', domain = ''] = target.split('@');
  return channel === 'email' && domain ? `${name.slice(0, 1)}***@${domain}` : 'email contact';
}

async function emailIdempotencyKey(eventId: string, kind: string, to: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${eventId}|${kind}|${to}`));
  return `companion-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function sendEmail(to: string, subject: string, text: string, idempotencyKey: string) {
  const provider = Deno.env.get('COMPANION_EMAIL_PROVIDER') ?? 'brevo';
  if (!['resend', 'brevo'].includes(provider)) throw new EmailDeliveryError(`Unsupported email provider: ${provider}`, false, 'failed');
  const keyName = provider === 'brevo' ? 'BREVO_API_KEY' : 'RESEND_API_KEY';
  const fromName = provider === 'brevo' ? 'BREVO_FROM_EMAIL' : 'RESEND_FROM_EMAIL';
  const key = Deno.env.get(keyName);
  const from = Deno.env.get(fromName);
  if (!key || !from) throw new EmailDeliveryError(`Email provider is not configured (missing ${keyName} or ${fromName}).`, false, 'failed');
  return sendEmailWithProvider(provider, { apiKey: key, from, to, subject, text, idempotencyKey });
}

async function recordNotificationAttempts(admin: SupabaseClient, eventId: string, outcomes: Array<Record<string, unknown>>) {
  const rows = outcomes.flatMap((outcome) => {
    if (!(Number(outcome.attempts) > 0)) return [];
    const responseMetadata = outcome.providerResponse && typeof outcome.providerResponse === 'object'
      ? outcome.providerResponse as Record<string, unknown> : {};
    if (responseMetadata.reusedAcceptedOutcome === true) return [];
    const channel = String(outcome.channel ?? '');
    const status = String(outcome.status ?? (outcome.accepted ? 'accepted' : 'failed'));
    if (!['email', 'push'].includes(channel) || !['accepted','failed','unknown'].includes(status)) return [];
    const providerResponse = outcome.providerResponse && typeof outcome.providerResponse === 'object'
      ? outcome.providerResponse as Record<string, unknown>
      : {};
    const providerReference = typeof outcome.providerReference === 'string'
      ? outcome.providerReference
      : typeof providerResponse.providerReference === 'string' ? providerResponse.providerReference : null;
    return [{
      event_id: eventId,
      channel,
      target_masked: typeof outcome.target === 'string' ? outcome.target : 'registered device',
      status,
      attempt_count: Math.max(1, Math.min(3, Number(outcome.attempts) || 1)),
      provider: typeof outcome.provider === 'string' ? outcome.provider : (channel === 'push' ? 'expo' : (Deno.env.get('COMPANION_EMAIL_PROVIDER') ?? 'brevo')),
      provider_reference: providerReference,
      provider_response: {
        ...providerResponse,
        ...(typeof outcome.idempotencyKey === 'string' ? { idempotencyKey: outcome.idempotencyKey } : {}),
        ...(typeof outcome.totalAttempts === 'number' ? { totalAttempts: outcome.totalAttempts } : {}),
        ...(typeof outcome.retryable === 'boolean' ? { retryable: outcome.retryable } : {}),
        ...(typeof outcome.error === 'string' ? { error: outcome.error.slice(0, 300) } : {}),
      },
    }];
  });
  if (rows.length > 0) {
    const { error } = await admin.from('notification_attempts').insert(rows);
    if (error) {
      console.error('Notification attempt recording failed');
      return false;
    }
  }
  return true;
}

async function pushIdempotencyKey(eventId: string, kind: string, token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${eventId}|${kind}|${token}`));
  return `companion-push-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function pushContactOutcomes(admin: SupabaseClient, journeyId: string, ownerId: string, contacts: unknown, routeEnabled: boolean, eventId: string, category: string, title: string, body: string, data: Record<string, unknown>, attemptsByKey: Map<string, { attempts: number; accepted: boolean; status: string }>) {
  if (!routeEnabled || !Array.isArray(contacts)) return [];
  const emails = [...new Set(
    contacts
      .map((contact) => contact && typeof contact === 'object'
        ? String((contact as Record<string, unknown>).email ?? '').trim().toLowerCase()
        : '')
      .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)),
  )];
  if (!emails.length) return [];
  const { data: profiles, error: profileLookupError } = await admin.from('profiles').select('id,email,notification_preferences').in('email', emails).neq('id', ownerId);
  if (profileLookupError) return [{ channel: 'push', target: 'authorized contact devices', accepted: false, status: 'unknown', attempts: 0, retryable: true, error: 'Could not check recipient push preferences.', provider: 'expo' }];
  const eligible = (profiles ?? []).filter((contact) => {
    const prefs = contact.notification_preferences && typeof contact.notification_preferences === 'object' ? contact.notification_preferences as Record<string, unknown> : {};
    return prefs.push === true;
  });
  if (!eligible.length) return [];
  const contactIds = eligible.map((contact) => contact.id);
  const [{ data: access, error: accessError }, { data: devices, error: deviceError }] = await Promise.all([
    admin.from('journey_access').select('user_id').eq('journey_id', journeyId).in('user_id', contactIds),
    admin.from('push_devices').select('owner_id,expo_push_token').in('owner_id', contactIds),
  ]);
  if (accessError || deviceError) return [{ channel: 'push', target: 'authorized contact devices', accepted: false, status: 'unknown', attempts: 0, retryable: true, error: 'Could not verify journey access or registered push devices.', provider: 'expo' }];
  const granted = new Set((access ?? []).map((row) => row.user_id));
  const validTokens = new Set(eligible.filter((contact) => granted.has(contact.id)).map((contact) => contact.id));
  const targets = (devices ?? []).filter((device) => validTokens.has(device.owner_id));
  return Promise.all(targets.map(async (device) => {
    const idempotencyKey = await pushIdempotencyKey(eventId, category, device.expo_push_token);
    const previous = attemptsByKey.get(idempotencyKey);
    if (previous?.accepted) return { channel: 'push', target: 'registered device', accepted: true, status: 'accepted', attempts: 0, totalAttempts: previous.attempts, retryable: false, idempotencyKey, providerResponse: { reusedAcceptedOutcome: true }, provider: 'expo' };
    if (previous && previous.attempts >= 6) return { channel: 'push', target: 'registered device', accepted: false, status: previous.status === 'unknown' ? 'unknown' : 'failed', attempts: 0, totalAttempts: previous.attempts, retryable: false, idempotencyKey, error: 'The six-attempt notification limit has been reached.', provider: 'expo' };
    const result = await sendExpoPushWithLimit(device.expo_push_token, title, body, data, { maxAttempts: Math.min(3, 6 - (previous?.attempts ?? 0)) });
    const providerResponse = { ...(result.providerResponse ?? {}), idempotencyKey };
    const totalAttempts = (previous?.attempts ?? 0) + result.attempts;
    const outcome = { channel: 'push', target: 'registered device', idempotencyKey, ...result, attempts: Math.min(3, result.attempts), totalAttempts, retryable: result.retryable && totalAttempts < 6, providerResponse };
    if (result.providerResponse && (result.providerResponse as Record<string, unknown>).errorCode === 'DeviceNotRegistered') {
      await admin.from('push_devices').delete().eq('owner_id', device.owner_id).eq('expo_push_token', device.expo_push_token);
    }
    return outcome;
  }));
}

export async function notifyContacts(admin: SupabaseClient, journeyId: string, eventId: string, title: string, reason: string, point?: { latitude: number; longitude: number }, category: 'emergency' | 'route_deviation' = 'emergency') {
  const { data: journey } = await admin.from('journeys').select('owner_id,destination,location').eq('id', journeyId).single();
  if (!journey) return { status: 'failed', accepted: 0, failures: 0, unknown: 0, retryable: false, outcomes: [] };
  const { data: profile } = await admin.from('profiles').select('display_name,trusted_contacts,notification_preferences').eq('id', journey.owner_id).single();
  const preferences = { email: true, route_deviation: true, ...(profile?.notification_preferences ?? {}) };
  const routeNotificationsEnabled = category !== 'route_deviation' || preferences.route_deviation !== false;
  const location = point ?? (journey.location as { latitude?: number; longitude?: number } | null);
  const { data: event } = await admin.from('safety_events').select('activated_at').eq('id', eventId).single();
  const eventTime = event?.activated_at ? new Date(Number(event.activated_at)).toISOString() : new Date().toISOString();
  const mapLink = location?.latitude != null && location.longitude != null ? `https://maps.google.com/?q=${location.latitude},${location.longitude}` : 'Location unavailable';
  const dashboard = Deno.env.get('COMPANION_DASHBOARD_URL') ?? '';
  const liveLink = dashboard ? `${dashboard.replace(/\/$/, '')}/?journeyId=${encodeURIComponent(journeyId)}` : 'Sign in to the Companion dashboard to view the journey.';
  const message = `${title}: ${profile?.display_name || 'A Companion user'} — ${reason}. Time: ${eventTime}. Current location: ${mapLink}. Live journey: ${liveLink}`;
  const targets = emailTargets(profile?.trusted_contacts, routeNotificationsEnabled && preferences.email !== false);
  const { data: eventBeforeSend } = await admin.from('safety_events').select('notifications').eq('id', eventId).maybeSingle();
  const existingNotifications = eventBeforeSend?.notifications && typeof eventBeforeSend.notifications === 'object'
    ? eventBeforeSend.notifications as Record<string, unknown> : {};
  const { error: queueError } = await admin.from('safety_events').update({ notifications: {
    ...existingNotifications, status: 'queued', accepted: 0, failures: 0, unknown: 0, retryable: true,
  } }).eq('id', eventId);
  if (queueError) console.error('Could not persist queued notification state');
  const { data: priorAttempts, error: priorError } = await admin.from('notification_attempts')
    .select('status,attempt_count,provider_response')
    .eq('event_id', eventId).in('channel', ['email', 'push']);
  if (priorError) console.error('Could not read previous notification attempts');
  const attemptsByKey = new Map<string, { attempts: number; accepted: boolean; status: string }>();
  for (const row of priorAttempts ?? []) {
    const providerResponse = row.provider_response && typeof row.provider_response === 'object'
      ? row.provider_response as Record<string, unknown> : {};
    const key = typeof providerResponse.idempotencyKey === 'string' ? providerResponse.idempotencyKey : '';
    if (!key) continue;
    const saved = attemptsByKey.get(key) ?? { attempts: 0, accepted: false, status: 'failed' };
    saved.attempts += Number(row.attempt_count) || 0;
    saved.accepted ||= row.status === 'accepted';
    saved.status = row.status;
    attemptsByKey.set(key, saved);
  }
  const emailOutcomes = await Promise.all(targets.map(async (email) => {
    const idempotencyKey = await emailIdempotencyKey(eventId, category, email);
    const previous = attemptsByKey.get(idempotencyKey);
    if (previous?.accepted) return {
      channel: 'email', target: maskedTarget('email', email), accepted: true, status: 'accepted',
      attempts: 0, totalAttempts: previous.attempts, retryable: false, idempotencyKey,
      providerResponse: { reusedAcceptedOutcome: true }, provider: Deno.env.get('COMPANION_EMAIL_PROVIDER') ?? 'brevo',
    };
    if (previous && previous.attempts >= 6) return {
      channel: 'email', target: maskedTarget('email', email), accepted: false,
      status: previous.status === 'unknown' ? 'unknown' : 'failed', attempts: 0,
      totalAttempts: previous.attempts, retryable: false, idempotencyKey,
      error: 'The six-attempt notification limit has been reached.',
      provider: Deno.env.get('COMPANION_EMAIL_PROVIDER') ?? 'brevo',
    };
    const retry = await retryEmailDelivery(
      () => sendEmail(email, title, message, idempotencyKey),
      undefined,
      { previousAttempts: previous?.attempts ?? 0, maxAttempts: 6, maxAttemptsPerRun: 3 },
    );
    return {
      channel: 'email', target: maskedTarget('email', email), ...retry, idempotencyKey,
      provider: Deno.env.get('COMPANION_EMAIL_PROVIDER') ?? 'brevo',
    };
  }));
  // Each recipient controls their own push preference; the owner's setting must not gate it.
  const pushOutcomes = await pushContactOutcomes(admin, journeyId, journey.owner_id, profile?.trusted_contacts, routeNotificationsEnabled, eventId, category, title, `${profile?.display_name || 'A trusted Companion contact'} needs safety assistance. ${reason}. Time: ${eventTime}. Open the Companion dashboard for the authorized live journey.`, { journeyId, eventId, liveLink, mapLink }, attemptsByKey);
  const outcomes = [...emailOutcomes, ...pushOutcomes];
  const accepted = outcomes.filter((item) => item.accepted).length;
  const unknown = outcomes.filter((item) => item.status === 'unknown').length;
  const failures = outcomes.filter((item) => item.status === 'failed').length;
  const retryable = outcomes.some((item) => item.retryable === true);
  const allOutcomes = outcomes;
  const attemptsRecorded = await recordNotificationAttempts(admin, eventId, allOutcomes);
  const status = allOutcomes.length === 0 ? 'no_recipients'
    : accepted === allOutcomes.length ? 'accepted'
    : accepted > 0 ? 'partial'
    : unknown > 0 ? 'unknown' : 'failed';
  // Audit persistence failure must not resend a message already accepted by its provider.
  const result = { status, accepted, failures, unknown, retryable, attemptsRecorded, outcomes: allOutcomes };
  const { error: updateError } = await admin.from('safety_events').update({ status: 'recorded', notifications: {
    ...existingNotifications, ...result,
  } }).eq('id', eventId);
  if (updateError) console.error('Could not save emergency notification summary');
  return { ...result, retryable: result.retryable, auditWarning: !attemptsRecorded || Boolean(updateError) };
}

/** Sends an expiring, bearer-protected evidence link only to the journey owner's saved trusted contacts. */
export async function notifyEvidenceContacts(admin: SupabaseClient, journeyId: string, eventId: string, mediaType: string, signedUrl: string) {
  const { data: journey } = await admin.from('journeys').select('owner_id').eq('id', journeyId).single();
  if (!journey) return { status: 'failed', accepted: 0, failures: 0, outcomes: [] };
  const { data: profile } = await admin.from('profiles').select('display_name,trusted_contacts,notification_preferences').eq('id', journey.owner_id).single();
  const preferences = { email: true, ...(profile?.notification_preferences ?? {}) };
  const title = `${mediaType === 'video' ? 'Video' : 'Audio'} evidence for Companion emergency`;
  const message = `${title} for ${profile?.display_name || 'a Companion user'}. This private link expires in 15 minutes: ${signedUrl}`;
  const targets = emailTargets(profile?.trusted_contacts, preferences.email !== false);
  const outcomes = await Promise.all(targets.map(async (email) => {
    const idempotencyKey = await emailIdempotencyKey(eventId, `evidence-${mediaType}`, email);
    return { channel: 'email', target: maskedTarget('email', email), idempotencyKey,
      provider: Deno.env.get('COMPANION_EMAIL_PROVIDER') ?? 'brevo',
      ...await retryEmailDelivery(() => sendEmail(email, title, message, idempotencyKey)) };
  }));
  const accepted = outcomes.filter((item) => item.accepted).length;
  const unknown = outcomes.filter((item) => item.status === 'unknown').length;
  const failures = outcomes.filter((item) => item.status === 'failed').length;
  const allOutcomes = outcomes;
  await recordNotificationAttempts(admin, eventId, allOutcomes);
  const result = { status: allOutcomes.length === 0 ? 'no_recipients' : accepted === allOutcomes.length ? 'accepted' : accepted > 0 ? 'partial' : unknown > 0 ? 'unknown' : 'failed', accepted, failures, unknown, retryable: outcomes.some((item) => item.retryable === true), outcomes: allOutcomes };
  // Preserve initial emergency notification results while recording delivery attempts for evidence.
  const { data: event } = await admin.from('safety_events').select('notifications').eq('id', eventId).single();
  await admin.from('safety_events').update({ notifications: { ...(event?.notifications ?? {}), evidence: result } }).eq('id', eventId);
  return result;
}
