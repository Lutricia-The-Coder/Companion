import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { initializeApp, deleteApp } from 'firebase/app';
import { connectAuthEmulator, createUserWithEmailAndPassword, getAuth, signOut } from 'firebase/auth';
import { connectDatabaseEmulator, get, getDatabase, push, ref, set } from 'firebase/database';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

const projectId = process.env.GCLOUD_PROJECT || 'demo-companion-safety';
let app;
let auth;
let database;
let functions;
let activateEmergency;
let reportRouteDeviation;
let ownerUid;

before(async () => {
  app = initializeApp({
    apiKey: 'emulator-test-key',
    projectId,
    databaseURL: `https://${projectId}.firebaseio.com`,
    appId: '1:123456789:web:emulator-test',
  }, `callable-tests-${Date.now()}`);
  auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  database = getDatabase(app);
  connectDatabaseEmulator(database, '127.0.0.1', 9000);
  functions = getFunctions(app, 'us-central1');
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  activateEmergency = httpsCallable(functions, 'activateEmergency');
  reportRouteDeviation = httpsCallable(functions, 'reportRouteDeviation');
  const credential = await createUserWithEmailAndPassword(auth, `owner-${Date.now()}@example.test`, 'test-password-123');
  ownerUid = credential.user.uid;
});

after(async () => {
  await signOut(auth).catch(() => {});
  if (app) await deleteApp(app);
});

async function createJourney(status = 'active') {
  const journeyRef = push(ref(database, 'journeys'));
  await set(journeyRef, {
    ownerUid,
    destination: 'Test destination',
    status: 'active',
    startedAt: Date.now(),
    emergency: false,
  });
  await set(ref(database, `journeys/${journeyRef.key}/location`), {
    latitude: -26.2041, longitude: 28.0473, timestamp: Date.now(),
  });
  if (status === 'ended') await set(ref(database, `journeys/${journeyRef.key}/status`), 'ended');
  return journeyRef;
}

test('emergency callable authenticates, records event, and suppresses a duplicate SOS', async () => {
  const journeyRef = await createJourney();
  const journeyId = journeyRef.key;
  const initialJourney = await get(journeyRef);
  assert.equal(initialJourney.child('emergency').val(), false);
  assert.equal(initialJourney.child('ownerUid').val(), ownerUid);

  const first = await activateEmergency({ journeyId, reason: 'Secret phrase' });
  assert.equal(first.data.duplicate, false);
  assert.equal(first.data.status, 'activated');

  const duplicate = await activateEmergency({ journeyId, reason: 'Secret phrase' });
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(duplicate.data.eventId, first.data.eventId);

  const snapshot = await get(journeyRef);
  assert.equal(snapshot.child('emergency').val(), true);
  assert.equal(snapshot.child(`events/${first.data.eventId}/status`).val(), 'activated');
  assert.deepEqual(snapshot.child(`events/${first.data.eventId}/location`).val(), {
    latitude: -26.2041, longitude: 28.0473, timestamp: snapshot.child('location/timestamp').val(),
  });
});

test('emergency callable rejects inactive and malformed requests; route callable suppresses inactive journeys', async () => {
  const inactive = await createJourney('ended');
  await assert.rejects(activateEmergency({ journeyId: inactive.key }), (error) => error.code === 'functions/failed-precondition');
  await assert.rejects(activateEmergency({ journeyId: 'bad' }), (error) => error.code === 'functions/invalid-argument');
  const route = await reportRouteDeviation({
    journeyId: inactive.key,
    location: { latitude: -26.2, longitude: 28.0, timestamp: Date.now() },
    distanceMeters: 150,
  });
  assert.equal(route.data.duplicate, true);
});

test('route callable records a deviation and applies its cooldown', async () => {
  const journeyRef = await createJourney();
  const request = {
    journeyId: journeyRef.key,
    location: { latitude: -26.21, longitude: 28.06, timestamp: Date.now() },
    distanceMeters: 350,
  };
  const first = await reportRouteDeviation(request);
  assert.equal(first.data.duplicate, false);
  assert.ok(first.data.eventId);
  const duplicate = await reportRouteDeviation(request);
  assert.equal(duplicate.data.duplicate, true);

  const snapshot = await get(journeyRef);
  assert.equal(snapshot.child(`events/${first.data.eventId}/type`).val(), 'route_deviation');
  assert.equal(snapshot.child(`events/${first.data.eventId}/status`).val(), 'recorded');
});

test('emergency callable rejects unauthenticated callers', async () => {
  await signOut(auth);
  await assert.rejects(activateEmergency({ journeyId: 'validJourney123' }), (error) => error.code === 'functions/unauthenticated');
  const credential = await createUserWithEmailAndPassword(auth, `owner-${Date.now()}@example.test`, 'test-password-123');
  ownerUid = credential.user.uid;
});
