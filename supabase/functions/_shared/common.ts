import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { emailTargets, retryEmailDelivery, sendResendEmail } from './emailNotifications.ts';

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

function maskedTarget(channel: string, target: string) {
  const [name = '', domain = ''] = target.split('@');
  return channel === 'email' && domain ? `${name.slice(0, 1)}***@${domain}` : 'email contact';
}

async function emailIdempotencyKey(eventId: string, kind: string, to: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${eventId}|${kind}|${to}`));
  return `companion-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function sendEmail(to: string, subject: string, text: string, idempotencyKey: string) {
  const key = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('RESEND_FROM_EMAIL');
  if (!key || !from) throw new Error('Email provider is not configured');
  return sendResendEmail({ apiKey: key, from, to, subject, text, idempotencyKey });
}

async function recordNotificationAttempts(admin: SupabaseClient, eventId: string, outcomes: Array<Record<string, unknown>>) {
  const rows = outcomes.flatMap((outcome) => {
    const channel = String(outcome.channel ?? '');
    const status = String(outcome.status ?? (outcome.accepted ? 'accepted' : 'failed'));
    if (channel !== 'email' || !['accepted','failed'].includes(status)) return [];
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
      provider: 'resend',
      provider_reference: providerReference,
      provider_response: providerResponse,
    }];
  });
  if (rows.length > 0) {
    const { error } = await admin.from('notification_attempts').insert(rows);
    if (error) console.error('Notification attempt recording failed', error.message);
  }
}

export async function notifyContacts(admin: SupabaseClient, journeyId: string, eventId: string, title: string, reason: string, point?: { latitude: number; longitude: number }, category: 'emergency' | 'route_deviation' = 'emergency') {
  const { data: journey } = await admin.from('journeys').select('owner_id,destination,location').eq('id', journeyId).single();
  if (!journey) return { status: 'failed', accepted: 0, failures: 0, outcomes: [] };
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
  const outcomes = await Promise.all(targets.map(async (email) => ({
    channel: 'email', target: maskedTarget('email', email),
    ...await retryEmailDelivery(async () => sendEmail(email, title, message, await emailIdempotencyKey(eventId, category, email))),
  })));
  const accepted = outcomes.filter((item) => item.accepted).length;
  const failures = outcomes.length - accepted;
  const allOutcomes = outcomes;
  await recordNotificationAttempts(admin, eventId, allOutcomes);
  const result = { status: allOutcomes.length === 0 ? 'no_recipients' : failures === 0 ? 'accepted' : accepted > 0 ? 'partial' : 'failed', accepted, failures, outcomes: allOutcomes };
  await admin.from('safety_events').update({ status: 'recorded', notifications: result }).eq('id', eventId);
  return result;
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
  const outcomes = await Promise.all(targets.map(async (email) => ({
    channel: 'email', target: maskedTarget('email', email),
    ...await retryEmailDelivery(async () => sendEmail(email, title, message, await emailIdempotencyKey(eventId, `evidence-${mediaType}`, email))),
  })));
  const accepted = outcomes.filter((item) => item.accepted).length;
  const failures = outcomes.length - accepted;
  const allOutcomes = outcomes;
  await recordNotificationAttempts(admin, eventId, allOutcomes);
  const result = { status: allOutcomes.length === 0 ? 'no_recipients' : failures === 0 ? 'accepted' : accepted > 0 ? 'partial' : 'failed', accepted, failures, outcomes: allOutcomes };
  // Preserve initial emergency notification results while recording delivery attempts for evidence.
  const { data: event } = await admin.from('safety_events').select('notifications').eq('id', eventId).single();
  await admin.from('safety_events').update({ notifications: { ...(event?.notifications ?? {}), evidence: result } }).eq('id', eventId);
  return result;
}
