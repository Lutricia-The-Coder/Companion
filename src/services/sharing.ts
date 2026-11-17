import { requireSupabase } from '../lib/supabase';

export async function grantTrustedContactAccess(journeyId: string, contactEmail: string) {
  const { data: contactUid, error } = await requireSupabase().rpc('grant_journey_access', {
    p_journey_id: journeyId,
    p_contact_email: contactEmail.trim().toLowerCase(),
  });
  if (error) throw error;
  return { contactUid: contactUid as string, monitorPath: `/monitor/${journeyId}` };
}

export async function activateEmergency(journeyId: string, reason = 'Manual SOS') {
  const { data, error } = await requireSupabase().functions.invoke('activate-emergency', { body: { journeyId, reason } });
  if (error) throw error;
  return data as { eventId: string | null; duplicate?: boolean; status?: string };
}

export async function reportRouteDeviation(
  journeyId: string,
  location: { latitude: number; longitude: number; timestamp: number },
  distanceMeters: number,
) {
  const { data, error } = await requireSupabase().functions.invoke('report-route-deviation', {
    body: { journeyId, location, distanceMeters },
  });
  if (error) throw error;
  return data as { eventId: string | null; duplicate: boolean };
}
