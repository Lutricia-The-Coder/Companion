import { requireSupabase } from '../lib/supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import CompanionMonitor from '../../modules/companion-monitor';
import { LOCATION_TASK, SESSION_KEY } from './backgroundLocation';
import { ACTIVE_JOURNEY_KEY } from './journeys';
import { saveTriggerPhrases } from './triggerPhrases';
import { clearLocalEmergencyEvidence } from './evidence';
import { clearPendingLocationUpload } from './locationPublishing';
import { removePrivateItems } from './privateStorage';

export type TrustedContact = { name: string; phone?: string; email?: string };
export type NotificationPreferences = { email: boolean; route_deviation: boolean; push: boolean };
export type EvidenceRetentionDays = 7 | 30 | 90;

export async function loadEvidenceRetentionDays(uid: string): Promise<EvidenceRetentionDays> {
  const { data, error } = await requireSupabase().from('profiles').select('evidence_retention_days').eq('id', uid).single();
  if (error) throw error;
  const days = Number(data.evidence_retention_days);
  return days === 7 || days === 90 ? days : 30;
}

export async function saveEvidenceRetentionDays(uid: string, days: EvidenceRetentionDays) {
  const { error } = await requireSupabase().from('profiles').update({
    evidence_retention_days: days,
    updated_at: new Date().toISOString(),
  }).eq('id', uid);
  if (error) throw error;
}

export async function saveTrustedContacts(uid: string, contacts: TrustedContact[]) {
  const client = requireSupabase();
  const { error } = await client.from('profiles').update({
    trusted_contacts: contacts,
    updated_at: new Date().toISOString(),
  }).eq('id', uid);
  if (error) throw error;
}

export async function saveNotificationPreferences(uid: string, preferences: NotificationPreferences) {
  const { error } = await requireSupabase().from('profiles').update({
    notification_preferences: preferences,
    updated_at: new Date().toISOString(),
  }).eq('id', uid);
  if (error) throw error;
}

export async function rememberJourneyId(_uid: string, _journeyId: string) {
  // Journey history is queried by owner_id, so a separate per-profile ID list is unnecessary.
}

export async function loadTrustedContacts(uid: string) {
  const { data, error } = await requireSupabase().from('profiles').select('trusted_contacts').eq('id', uid).single();
  if (error) throw error;
  return Array.isArray(data.trusted_contacts) ? data.trusted_contacts as TrustedContact[] : [];
}

export async function deleteAccount() {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
  await CompanionMonitor?.stopMonitoring().catch(() => undefined);
  const { data, error } = await requireSupabase().functions.invoke('delete-account', { body: {} });
  if (error) throw error;
  if (data?.deleted !== true) throw new Error('The server did not confirm account deletion.');
  await Promise.all([
    AsyncStorage.multiRemove([
      ACTIVE_JOURNEY_KEY, SESSION_KEY, 'companion-contacts', 'companion-destination',
      'companion-route-waypoints', 'companion-emergency-event-id', 'companion-evidence-consent',
      'companion-background-audio-enabled', 'companion-motion-enabled', 'companion-phrase-monitor-enabled',
      'companion-share-journey-default', 'companion-notification-preferences-pending',
      'companion-route-deviation-threshold-m',
      'companion-evidence-retention-days',
      'companion-background-location-emergency-cadence',
      'companion-emergency-audio-evidence-v1',
    ]),
    saveTriggerPhrases([]),
    clearLocalEmergencyEvidence(),
    clearPendingLocationUpload(),
    removePrivateItems(['companion-contacts', 'companion-destination', 'companion-route-waypoints', 'companion-last-location', 'companion-active-route', 'companion-route-origin', 'companion-pending-location-upload']),
  ]);
}
