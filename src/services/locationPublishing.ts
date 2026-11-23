import AsyncStorage from '@react-native-async-storage/async-storage';
import { publishLocation, type LivePoint } from './journeys';
import { getPrivateItem, removePrivateItem, setPrivateItem } from './privateStorage';

export const PENDING_LOCATION_UPLOAD_KEY = 'companion-pending-location-upload';
export const LOCATION_UPLOAD_STATUS_KEY = 'companion-location-upload-status';

type PendingLocation = { journeyId: string; point: LivePoint; attemptedAt: number };

/** Publish the newest accepted fix. If offline, retain only the newest fix and retry on the next location update. */
export async function publishLatestLocation(journeyId: string, point: LivePoint): Promise<boolean> {
  try {
    await publishLocation(journeyId, point);
  } catch {
    const pending: PendingLocation = { journeyId, point, attemptedAt: Date.now() };
    await setPrivateItem(PENDING_LOCATION_UPLOAD_KEY, JSON.stringify(pending)).catch(() => undefined);
    await AsyncStorage.setItem(LOCATION_UPLOAD_STATUS_KEY, JSON.stringify({ state: 'pending', journeyId, timestamp: point.timestamp })).catch(() => undefined);
    return false;
  }

  try {
    const pendingRaw = await getPrivateItem(PENDING_LOCATION_UPLOAD_KEY);
    if (pendingRaw) {
      try {
        const pending = JSON.parse(pendingRaw) as PendingLocation;
        if (pending.journeyId === journeyId) await removePrivateItem(PENDING_LOCATION_UPLOAD_KEY);
      } catch {
        await removePrivateItem(PENDING_LOCATION_UPLOAD_KEY);
      }
    }
    await AsyncStorage.setItem(LOCATION_UPLOAD_STATUS_KEY, JSON.stringify({ state: 'synced', journeyId, timestamp: point.timestamp }));
  } catch { /* The server accepted this fix; local UI bookkeeping can recover on the next callback. */ }
  return true;
}

export async function clearPendingLocationUpload(journeyId?: string) {
  const pendingRaw = await getPrivateItem(PENDING_LOCATION_UPLOAD_KEY);
  if (pendingRaw) {
    try {
      const pending = JSON.parse(pendingRaw) as PendingLocation;
      if (!journeyId || pending.journeyId === journeyId) await removePrivateItem(PENDING_LOCATION_UPLOAD_KEY);
    } catch {
      await removePrivateItem(PENDING_LOCATION_UPLOAD_KEY);
    }
  }
  const statusRaw = await AsyncStorage.getItem(LOCATION_UPLOAD_STATUS_KEY);
  if (statusRaw) {
    try {
      const status = JSON.parse(statusRaw) as { journeyId?: string };
      if (!journeyId || status.journeyId === journeyId) await AsyncStorage.removeItem(LOCATION_UPLOAD_STATUS_KEY);
    } catch {
      await AsyncStorage.removeItem(LOCATION_UPLOAD_STATUS_KEY);
    }
  }
}
