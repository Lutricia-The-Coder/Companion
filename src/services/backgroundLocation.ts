import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getPrivateItem, setPrivateItem } from './privateStorage';
import { publishLatestLocation } from './locationPublishing';
import { isRouteDeviation, parseRouteCoordinates, shouldAcceptLocationUpdate, type Coordinate, type TimestampedLocation } from './routeSafety';
import { reportRouteDeviation } from './sharing';

export const LOCATION_TASK = 'companion-background-location';
export const SESSION_KEY = 'companion-session-active';
export const LAST_LOCATION_KEY = 'companion-last-location';
export const ACTIVE_ROUTE_KEY = 'companion-active-route';
export const ROUTE_ORIGIN_KEY = 'companion-route-origin';
export const ROUTE_DEVIATION_COUNT_KEY = 'companion-route-deviation-count';
export const LAST_ROUTE_ALERT_KEY = 'companion-last-route-alert';
export const ROUTE_DEVIATION_THRESHOLD_KEY = 'companion-route-deviation-threshold-m';

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const locations = (data as { locations?: Location.LocationObject[] }).locations;
  const latest = locations?.[locations.length - 1];
  if (!latest) return;

  const point = {
    latitude: latest.coords.latitude,
    longitude: latest.coords.longitude,
    accuracy: latest.coords.accuracy,
    timestamp: latest.timestamp,
  };
  if (typeof point.accuracy !== 'number' || !Number.isFinite(point.accuracy)) return;
  const validPoint: TimestampedLocation = { ...point, accuracy: point.accuracy };
  const storedPoint = await getPrivateItem(LAST_LOCATION_KEY);
  let previous: TimestampedLocation | null = null;
  if (storedPoint) {
    try { previous = JSON.parse(storedPoint) as TimestampedLocation; }
    catch { previous = null; }
  }
  if (!shouldAcceptLocationUpdate(validPoint, previous, { maxAccuracyMeters: 100, now: Date.now(), maxAgeMs: 30_000 })) return;
  await setPrivateItem(LAST_LOCATION_KEY, JSON.stringify(validPoint)).catch(() => undefined);
  const journeyId = await AsyncStorage.getItem('companion-active-journey-id');
  if (journeyId) {
    await publishLatestLocation(journeyId, validPoint);

    try {
      const savedRoute = await getPrivateItem(ACTIVE_ROUTE_KEY);
      if (savedRoute) {
        const route = parseRouteCoordinates(JSON.parse(savedRoute));
        if (route.length > 0) {
          let origin: Coordinate | null = null;
          const savedOrigin = await getPrivateItem(ROUTE_ORIGIN_KEY);
          if (savedOrigin) origin = JSON.parse(savedOrigin) as Coordinate;
          if (!origin) {
            origin = { latitude: point.latitude, longitude: point.longitude };
            await setPrivateItem(ROUTE_ORIGIN_KEY, JSON.stringify(origin));
          }
          const configuredThreshold = Number(await AsyncStorage.getItem(ROUTE_DEVIATION_THRESHOLD_KEY));
          const thresholdMeters = Number.isFinite(configuredThreshold) && configuredThreshold >= 50 && configuredThreshold <= 500
            ? configuredThreshold
            : 100;
          const result = isRouteDeviation(validPoint, [origin, ...route], {
            thresholdMeters,
            accuracyMeters: latest.coords.accuracy ?? 0,
          });
          const count = result.deviated
            ? Number(await AsyncStorage.getItem(ROUTE_DEVIATION_COUNT_KEY) || '0') + 1
            : 0;
          await AsyncStorage.setItem(ROUTE_DEVIATION_COUNT_KEY, String(count));
          if (count >= 3) {
            const lastAlert = Number(await AsyncStorage.getItem(LAST_ROUTE_ALERT_KEY) || '0');
            if (Date.now() - lastAlert > 5 * 60_000) {
              await AsyncStorage.setItem(LAST_ROUTE_ALERT_KEY, String(Date.now()));
              await AsyncStorage.setItem(ROUTE_DEVIATION_COUNT_KEY, '0');
              await reportRouteDeviation(journeyId, validPoint, Math.round(result.distanceMeters));
            }
          }
        }
      }
    } catch {
      // Route alerts are best-effort while offline; live location remains available to authorized readers.
    }
  }
});
