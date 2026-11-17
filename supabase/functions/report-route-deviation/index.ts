import { clients, response, uuid, notifyContacts } from '../_shared/common.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return response({ ok: true });
  if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
  const { user, admin } = clients(request);
  const { data: { user: actor }, error: authError } = await user.auth.getUser();
  if (authError || !actor) return response({ error: 'Sign in required' }, 401);
  const input = await request.json().catch(() => ({}));
  const point = input.location;
  if (!uuid(input.journeyId) || !point || !Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90
    || !Number.isFinite(point.longitude) || Math.abs(point.longitude) > 180 || !Number.isFinite(point.timestamp)
    || Date.now() - point.timestamp > 120000 || point.timestamp > Date.now() + 10000
    || !Number.isInteger(input.distanceMeters) || input.distanceMeters < 100 || input.distanceMeters > 100000) {
    return response({ error: 'Invalid or stale route location' }, 400);
  }
  const { data, error } = await user.rpc('report_route_deviation', {
    p_journey_id: input.journeyId,
    p_location: point,
    p_distance_meters: input.distanceMeters,
  });
  if (error) return response({ error: error.message }, 403);
  if (data.duplicate || !data.eventId) return response(data);
  const notifications = await notifyContacts(admin, input.journeyId, data.eventId, 'Route deviation alert', `The active journey appears about ${input.distanceMeters} m from its planned route`, point, 'route_deviation');
  return response({ ...data, notifications });
});
