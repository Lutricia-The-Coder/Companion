export type Coordinate = { latitude: number; longitude: number };
export type TimestampedLocation = Coordinate & { accuracy: number; timestamp: number };

/** Parses user-entered route points (`latitude,longitude; ...`) or stored point arrays. */
export function parseRouteCoordinates(input: unknown): Coordinate[] {
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return [];
    const points = text.split(/[;\n]+/).map((entry) => {
      const parts = entry.trim().split(/[,\s]+/).filter(Boolean);
      if (parts.length !== 2) throw new Error('Enter route points as latitude, longitude separated by semicolons.');
      return { latitude: Number(parts[0]), longitude: Number(parts[1]) };
    });
    return validateRoute(points);
  }
  if (Array.isArray(input)) return validateRoute(input as Coordinate[]);
  throw new Error('Route data must be a list of coordinate points.');
}

function validateRoute(points: Coordinate[]): Coordinate[] {
  if (points.length > 10_000) throw new Error('A route can contain at most 10,000 road points.');
  for (const point of points) {
    if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)
      || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) {
      throw new Error('Each route point must use a valid latitude and longitude.');
    }
  }
  return points.map(({ latitude, longitude }) => ({ latitude, longitude }));
}

const EARTH_RADIUS_METERS = 6_371_008.8;

function radians(degrees: number) { return degrees * (Math.PI / 180); }

export function distanceMeters(a: Coordinate, b: Coordinate): number {
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const dLat = lat2 - lat1;
  const dLon = radians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Returns distance from a coordinate to a route polyline using a local tangent-plane projection. */
export function distanceToRouteMeters(point: Coordinate, route: Coordinate[]): number {
  if (route.length === 0) return Number.POSITIVE_INFINITY;
  if (route.length === 1) return distanceMeters(point, route[0]);

  const originLat = radians(point.latitude);
  const metersPerLongitudeDegree = Math.cos(originLat) * Math.PI * EARTH_RADIUS_METERS / 180;
  const toLocal = (coordinate: Coordinate) => ({
    x: (coordinate.longitude - point.longitude) * metersPerLongitudeDegree,
    y: (coordinate.latitude - point.latitude) * Math.PI * EARTH_RADIUS_METERS / 180,
  });

  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = toLocal(route[index]);
    const end = toLocal(route[index + 1]);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const segmentLengthSquared = dx * dx + dy * dy;
    const projection = segmentLengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, -(start.x * dx + start.y * dy) / segmentLengthSquared));
    const nearestX = start.x + projection * dx;
    const nearestY = start.y + projection * dy;
    minimum = Math.min(minimum, Math.hypot(nearestX, nearestY));
  }
  return minimum;
}

export function isLocationStale(timestamp: number, now = Date.now(), staleAfterMs = 30_000): boolean {
  return !Number.isFinite(timestamp) || timestamp <= 0 || now < timestamp || now - timestamp > staleAfterMs;
}

export function shouldAcceptLocationUpdate(
  next: TimestampedLocation,
  previous: TimestampedLocation | null,
  options: { maxAccuracyMeters?: number; now?: number; maxAgeMs?: number } = {},
): boolean {
  const maxAccuracyMeters = options.maxAccuracyMeters ?? 100;
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 30_000;
  if (![next.latitude, next.longitude, next.accuracy, next.timestamp].every(Number.isFinite)) return false;
  if (Math.abs(next.latitude) > 90 || Math.abs(next.longitude) > 180 || next.accuracy < 0 || next.accuracy > maxAccuracyMeters) return false;
  if (now < next.timestamp || now - next.timestamp > maxAgeMs) return false;
  return !previous || next.timestamp > previous.timestamp;
}

export function isRouteDeviation(
  point: Coordinate,
  route: Coordinate[],
  options: { thresholdMeters?: number; accuracyMeters?: number; accuracyMultiplier?: number } = {},
): { deviated: boolean; distanceMeters: number; thresholdMeters: number } {
  const baseThreshold = options.thresholdMeters ?? 75;
  const accuracyAllowance = Math.max(0, options.accuracyMeters ?? 0) * (options.accuracyMultiplier ?? 1.5);
  const thresholdMeters = Math.max(baseThreshold, accuracyAllowance);
  const distance = distanceToRouteMeters(point, route);
  return { deviated: Number.isFinite(distance) && distance > thresholdMeters, distanceMeters: distance, thresholdMeters };
}
