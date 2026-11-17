const JOURNEY_ID = /^[A-Za-z0-9_-]{8,128}$/;

async function activateEmergency(request, { db, HttpsError, now = Date.now }) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to activate an emergency alert.');
  const journeyId = request.data?.journeyId;
  if (typeof journeyId !== 'string' || !JOURNEY_ID.test(journeyId)) {
    throw new HttpsError('invalid-argument', 'A valid journey ID is required.');
  }

  const journeyRef = db.ref(`journeys/${journeyId}`);
  const journeySnapshot = await journeyRef.get();
  const journey = journeySnapshot.val();
  if (!journey || journey.ownerUid !== request.auth.uid) {
    throw new HttpsError('permission-denied', 'Only the journey owner can activate an emergency.');
  }
  if (journey.status !== 'active') {
    throw new HttpsError('failed-precondition', 'Start a journey before activating an emergency.');
  }
  if (journey.emergency === true) {
    return { eventId: typeof journey.emergencyEventId === 'string' ? journey.emergencyEventId : null, duplicate: true };
  }

  const eventRef = journeyRef.child('events').push();
  const eventId = eventRef.key;
  if (!eventId) throw new HttpsError('internal', 'Could not create an emergency event ID.');
  const activatedAt = now();
  await eventRef.set({
    eventId,
    type: 'emergency_activated',
    status: 'activating',
    reason: typeof request.data?.reason === 'string' ? request.data.reason.slice(0, 240) : 'Manual SOS',
    activatedAt,
    location: journey.location || null,
    locationTimestamp: journey.location?.timestamp || null,
  });
  const reservation = await journeyRef.child('emergencyActivation').transaction((current) => {
    if (current) return;
    return { eventId, activatedAt };
  });

  if (!reservation.committed) {
    await eventRef.remove();
    const currentEventId = reservation.snapshot.child('eventId').val();
    return { eventId: typeof currentEventId === 'string' ? currentEventId : null, duplicate: true };
  }

  await journeyRef.update({ emergency: true, emergencyAt: activatedAt, emergencyEventId: eventId });
  await eventRef.update({ status: 'activated' });
  return { eventId, duplicate: false, status: 'activated' };
}

module.exports = { activateEmergency };
