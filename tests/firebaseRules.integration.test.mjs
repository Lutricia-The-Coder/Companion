import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { ref as dbRef, set, get, update } from 'firebase/database';
import { ref as storageRef, uploadBytes, getBytes } from 'firebase/storage';

const projectId = process.env.GCLOUD_PROJECT || 'companion-safety-rules-test';
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    database: { rules: await readFile(new URL('../database.rules.json', import.meta.url), 'utf8') },
    storage: { rules: await readFile(new URL('../storage.rules', import.meta.url), 'utf8') },
  });
});

after(async () => { await env?.cleanup(); });

test('Realtime Database restricts journey reads and protected emergency state', async () => {
  const owner = env.authenticatedContext('owner-1').database();
  const stranger = env.authenticatedContext('stranger-1').database();
  const anonymous = env.unauthenticatedContext().database();
  const journey = dbRef(owner, 'journeys/journey-1');

  await assertSucceeds(set(journey, {
    ownerUid: 'owner-1', destination: 'Home', status: 'active', startedAt: Date.now(), emergency: false,
  }));
  await assertSucceeds(get(dbRef(owner, 'journeys/journey-1')));
  await assertFails(get(dbRef(stranger, 'journeys/journey-1')));
  await assertFails(get(dbRef(anonymous, 'journeys/journey-1')));
  await assertFails(update(dbRef(owner, 'journeys/journey-1'), { emergency: true }));
  await assertFails(set(dbRef(owner, 'journeys/journey-1/emergencyActivation'), { eventId: 'forged-event' }));
  await assertFails(set(dbRef(stranger, 'journeys/journey-1/location'), {
    latitude: 0, longitude: 0, timestamp: Date.now(),
  }));
  await assertSucceeds(set(dbRef(owner, 'journeys/journey-1/location'), {
    latitude: -26.2, longitude: 28.0, timestamp: Date.now(),
  }));
});

test('evidence objects are owner-write-only and never directly readable', async () => {
  const owner = env.authenticatedContext('owner-1').storage();
  const stranger = env.authenticatedContext('stranger-1').storage();
  const anonymous = env.unauthenticatedContext().storage();
  const evidencePath = 'evidence/owner-1/journey-1/event-1/audio.m4a';
  const bytes = new Uint8Array([1, 2, 3, 4]);

  await assertSucceeds(uploadBytes(storageRef(owner, evidencePath), bytes, { contentType: 'audio/mp4' }));
  await assertFails(getBytes(storageRef(owner, evidencePath)));
  await assertFails(uploadBytes(storageRef(stranger, evidencePath), bytes, { contentType: 'audio/mp4' }));
  await assertFails(uploadBytes(storageRef(anonymous, evidencePath), bytes, { contentType: 'audio/mp4' }));
  await assertFails(uploadBytes(storageRef(owner, 'evidence/owner-1/journey-1/event-1/file.txt'), bytes, { contentType: 'text/plain' }));
});
