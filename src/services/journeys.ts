import { requireSupabase } from '../lib/supabase';
import type { Coordinate } from './routeSafety';

export const ACTIVE_JOURNEY_KEY = 'companion-active-journey-id';
export type LivePoint = { latitude: number; longitude: number; accuracy: number | null; timestamp: number };

export async function createJourney(_ownerUid: string, destination: string, route: Coordinate[] = []) {
  const client = requireSupabase();
  const { data, error } = await client.rpc('create_journey', {
    p_destination: destination.trim(),
    p_route: route,
  });
  if (error) throw error;
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
