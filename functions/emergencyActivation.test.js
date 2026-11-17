const assert = require('node:assert/strict');
const test = require('node:test');
const { activateEmergency } = require('./emergencyActivation');

class CallableError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fakeDatabase(initialJourney) {
  const state = { journey: structuredClone(initialJourney), events: {}, emergencyActivation: null };
  let nextId = 0;
  const snapshot = (value) => ({
    val: () => value == null ? null : structuredClone(value),
    child: (key) => ({ val: () => value?.[key] ?? null }),
  });
  const eventRef = (id) => ({
    key: id,
    set: async (value) => { state.events[id] = structuredClone(value); },
    update: async (value) => { state.events[id] = { ...state.events[id], ...structuredClone(value) }; },
    remove: async () => { delete state.events[id]; },
  });
  const journeyRef = {
    get: async () => snapshot(state.journey),
    child: (path) => {
      if (path === 'events') return { push: () => eventRef(`event-${++nextId}`) };
      if (path === 'emergencyActivation') return {
        transaction: async (update) => {
          const updated = update(state.emergencyActivation == null ? null : structuredClone(state.emergencyActivation));
          if (updated === undefined) return { committed: false, snapshot: snapshot(state.emergencyActivation) };
          state.emergencyActivation = structuredClone(updated);
          return { committed: true, snapshot: snapshot(state.emergencyActivation) };
        },
      };
      throw new Error(`Unexpected journey child: ${path}`);
    },
    update: async (value) => { state.journey = { ...state.journey, ...structuredClone(value) }; },
  };
  return { db: { ref: () => journeyRef }, state };
}

const activeJourney = () => ({
  ownerUid: 'owner-1',
  status: 'active',
  location: { latitude: -26.2, longitude: 28.0, timestamp: 1234 },
});

test('emergency callable rejects unauthenticated and malformed requests', async () => {
  const { db } = fakeDatabase(activeJourney());
  await assert.rejects(activateEmergency({ data: { journeyId: 'journey-123' } }, { db, HttpsError: CallableError }), { code: 'unauthenticated' });
  await assert.rejects(activateEmergency({ auth: { uid: 'owner-1' }, data: { journeyId: 'bad' } }, { db, HttpsError: CallableError }), { code: 'invalid-argument' });
});

test('emergency callable verifies owner and active journey before changing state', async () => {
  const { db } = fakeDatabase(activeJourney());
  await assert.rejects(activateEmergency({ auth: { uid: 'other' }, data: { journeyId: 'journey-123' } }, { db, HttpsError: CallableError }), { code: 'permission-denied' });
  const inactive = fakeDatabase({ ...activeJourney(), status: 'ended' });
  await assert.rejects(activateEmergency({ auth: { uid: 'owner-1' }, data: { journeyId: 'journey-123' } }, { db: inactive.db, HttpsError: CallableError }), { code: 'failed-precondition' });
});

test('emergency callable records event and activates journey with latest location', async () => {
  const { db, state } = fakeDatabase(activeJourney());
  const result = await activateEmergency({
    auth: { uid: 'owner-1' },
    data: { journeyId: 'journey-123', reason: 'Personal SOS' },
  }, { db, HttpsError: CallableError, now: () => 4567 });

  assert.deepEqual(result, { eventId: 'event-1', duplicate: false, status: 'activated' });
  assert.equal(state.journey.emergency, true);
  assert.equal(state.journey.emergencyAt, 4567);
  assert.equal(state.events['event-1'].reason, 'Personal SOS');
  assert.deepEqual(state.events['event-1'].location, activeJourney().location);
  assert.equal(state.events['event-1'].status, 'activated');
});

test('emergency callable suppresses duplicate activation without leaving a duplicate event', async () => {
  const { db, state } = fakeDatabase({ ...activeJourney(), emergency: true, emergencyEventId: 'prior-event' });
  const result = await activateEmergency({ auth: { uid: 'owner-1' }, data: { journeyId: 'journey-123' } }, { db, HttpsError: CallableError });
  assert.deepEqual(result, { eventId: 'prior-event', duplicate: true });
  assert.deepEqual(state.events, {});
});
