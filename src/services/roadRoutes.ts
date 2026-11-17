import type { Coordinate } from './routeSafety';

type GeocodingFeature = {
  geometry?: { coordinates?: unknown[] };
};

type OsrmRouteResponse = {
  code?: string;
  routes?: { geometry?: { coordinates?: unknown[] } }[];
};

function parseLonLat(value: unknown): Coordinate | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [longitude, latitude] = value;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

/** Resolve a textual destination and request a road-following route from OSRM's public demo service. */
export async function planRoadRoute(
  origin: Coordinate,
  destination: string,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Coordinate[]> {
  const query = destination.trim();
  if (!query) throw new Error('Enter a destination before planning a route.');
  if (!Number.isFinite(origin.latitude) || Math.abs(origin.latitude) > 90
    || !Number.isFinite(origin.longitude) || Math.abs(origin.longitude) > 180) {
    throw new Error('The current GPS location is not valid for route planning.');
  }
  const fetcher = options.fetcher ?? fetch;
  const geocodeUrl = new URL('https://nominatim.openstreetmap.org/search');
  geocodeUrl.searchParams.set('format', 'geojson');
  geocodeUrl.searchParams.set('limit', '1');
  geocodeUrl.searchParams.set('q', query);

  let geocodeResponse: Response;
  try {
    geocodeResponse = await fetcher(geocodeUrl, {
      signal: options.signal,
      headers: { Accept: 'application/geo+json', 'User-Agent': 'CompanionSafety/1.0 (mobile route lookup)' },
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error('Could not look up that destination. Check your connection and try again.');
  }
  if (!geocodeResponse.ok) throw new Error('Destination search is temporarily unavailable.');
  const geocode = await geocodeResponse.json() as { features?: GeocodingFeature[] };
  const destinationPoint = parseLonLat(geocode.features?.[0]?.geometry?.coordinates);
  if (!destinationPoint) throw new Error('No matching destination was found. Add a city or region to make it more specific.');

  const coordinates = `${origin.longitude},${origin.latitude};${destinationPoint.longitude},${destinationPoint.latitude}`;
  const routeUrl = new URL(`https://router.project-osrm.org/route/v1/driving/${coordinates}`);
  routeUrl.searchParams.set('overview', 'full');
  routeUrl.searchParams.set('geometries', 'geojson');
  let routeResponse: Response;
  try {
    routeResponse = await fetcher(routeUrl, { signal: options.signal, headers: { Accept: 'application/json' } });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error('Could not load road directions. Check your connection and try again.');
  }
  if (!routeResponse.ok) throw new Error('Road directions are temporarily unavailable.');
  const route = await routeResponse.json() as OsrmRouteResponse;
  const points = route.code === 'Ok' ? route.routes?.[0]?.geometry?.coordinates : null;
  if (!Array.isArray(points) || points.length < 2) throw new Error('No drivable route was found for that destination.');
  const routePoints = points.map(parseLonLat).filter((point): point is Coordinate => point !== null);
  if (routePoints.length < 2) throw new Error('The directions service returned an invalid road route.');
  return routePoints;
}
