import { requireSupabase } from '../lib/supabase';
import type { Coordinate } from './routeSafety';

export const ACTIVE_JOURNEY_KEY = 'companion-active-journey-id';
export type LivePoint = { latitude: number; longitude: number; accuracy: number | null; timestamp: number };
const MAX_REMOTE_ROUTE_POINTS = 1000;

function limitRoutePoints(route: Coordinate[]): Coordinate[] {
  if (route.length <= MAX_REMOTE_ROUTE_POINTS) return route;
  const lastIndex = route.length - 1;
  return Array.from({ length: MAX_REMOTE_ROUTE_POINTS }, (_, index) =>
    route[Math.round(index * lastIndex / (MAX_REMOTE_ROUTE_POINTS - 1))],
  );
}

export async function createJourney(_ownerUid: string, destination: string, route: Coordinate[] = []) {
  const trimmedDestination = destination.trim();
  if (trimmedDestination.length > 300) {
    throw new Error('The destination must be 300 characters or fewer.');
  }
  if (!Array.isArray(route)) {
    throw new Error('The saved route is invalid. Clear the route checkpoints and try again.');
  }
  const remoteRoute = limitRoutePoints(route);

  const client = requireSupabase();
  const parameters: { p_destination: string; p_route?: Coordinate[] } = {
    p_destination: trimmedDestination,
  };
  // Let Postgres apply its [] default for route-less journeys. This also keeps
  // empty-route journeys compatible with the deployed RPC signature.
  if (remoteRoute.length > 0) parameters.p_route = remoteRoute;

  const { data, error } = await client.rpc('create_journey', {
    ...parameters,
  });
  if (error) {
    const code = error.code ? ` (${error.code})` : '';
    throw new Error(`Journey creation was rejected${code}: ${error.message}`);
  }
  return data as string;
}

export async function publishLocation(journeyId: string, point: LivePoint) {
  const { error } = await requireSupabase().rpc('publish_journey_location', {
    p_journey_id: journeyId,
    p_location: point,
  });
  if (error) throw error;
}

export async function finishJourney(journeyId: string) {
  const { error } = await requireSupabase().rpc('finish_journey', { p_journey_id: journeyId });
  if (error) throw error;
}
