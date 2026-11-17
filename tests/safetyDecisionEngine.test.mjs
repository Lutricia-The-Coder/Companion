import test from 'node:test';
import assert from 'node:assert/strict';
import { SafetyDecisionEngine } from '../src/services/safetyDecisionEngine.ts';
import { matchTriggerPhrase } from '../src/services/triggerPhraseMatcher.ts';
import { distanceToRouteMeters, isLocationStale, isRouteDeviation, shouldAcceptLocationUpdate } from '../src/services/routeSafety.ts';
import { parseRouteCoordinates } from '../src/services/routeSafety.ts';
import { planRoadRoute } from '../src/services/roadRoutes.ts';
import { FallDetector } from '../src/services/fallDetector.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProviderError, withRetry } = require('../functions/notificationRetry.js');

function actionTypes(actions) { return actions.map(({ type }) => type); }

test('personal SOS phrase can independently activate an emergency', () => {
  const engine = new SafetyDecisionEngine({ independentPhraseEnabled: true });
  engine.startJourney();
  const actions = engine.observe({ kind: 'private_phrase', exactPhraseMatch: true, confidence: 0.98, timestamp: 1000, signalId: 'phrase-1' });
  assert.deepEqual(actionTypes(actions), ['state_changed', 'activate_emergency']);
  assert.equal(engine.state, 'EMERGENCY_ACTIVATED');
});

test('phrase match follows configured non-independent behavior', () => {
  const engine = new SafetyDecisionEngine({ independentPhraseEnabled: false });
  engine.startJourney();
  const actions = engine.observe({ kind: 'private_phrase', exactPhraseMatch: true, confidence: 0.98, timestamp: 1000 });
  assert.ok(actionTypes(actions).includes('request_check_in'));
  assert.equal(engine.state, 'POSSIBLE_DISTRESS');
});

test('high-confidence fall and scream together activate immediately', () => {
  const engine = new SafetyDecisionEngine();
  engine.startJourney();
  engine.observe({ kind: 'fall', confidence: 0.97, timestamp: 1000, signalId: 'fall-1' });
  const actions = engine.observe({ kind: 'scream', confidence: 0.96, timestamp: 2000, signalId: 'scream-1' });
  assert.ok(actionTypes(actions).includes('activate_emergency'));
  assert.equal(engine.state, 'EMERGENCY_ACTIVATED');
});

test('single high sound asks for check-in before escalating', () => {
  const engine = new SafetyDecisionEngine({ confirmationWindowMs: 5000 });
  engine.startJourney();
  const actions = engine.observe({ kind: 'shouting', confidence: 0.96, timestamp: 1000 });
  assert.ok(actionTypes(actions).includes('request_check_in'));
  assert.equal(engine.state, 'POSSIBLE_DISTRESS');
  assert.deepEqual(engine.tick(5999), []);
  assert.ok(actionTypes(engine.tick(6000)).includes('activate_emergency'));
});

test('a microphone volume cue can only request a check-in, not classify a scream or activate SOS', () => {
  const engine = new SafetyDecisionEngine();
  engine.startJourney();
  const actions = engine.observe({ kind: 'loud_audio', confidence: 0.9, timestamp: 1000, signalId: 'volume-1' });
  assert.ok(actionTypes(actions).includes('request_check_in'));
  assert.ok(!actionTypes(actions).includes('activate_emergency'));
  assert.equal(engine.state, 'POSSIBLE_DISTRESS');
});

test('user confirmation cancels timeout escalation', () => {
  const engine = new SafetyDecisionEngine({ confirmationWindowMs: 1000 });
  engine.startJourney();
  engine.observe({ kind: 'fall', confidence: 0.98, timestamp: 1000 });
  assert.equal(engine.confirmSafe()[0].to, 'MONITORING');
  assert.deepEqual(engine.tick(5000), []);
  assert.equal(engine.state, 'MONITORING');
});

test('duplicate signal IDs and later detections do not duplicate emergency activation', () => {
  const engine = new SafetyDecisionEngine();
  engine.startJourney();
  const signal = { kind: 'private_phrase', exactPhraseMatch: true, confidence: 1, timestamp: 1000, signalId: 'same' };
  const first = engine.observe(signal);
  assert.ok(actionTypes(first).includes('activate_emergency'));
  assert.deepEqual(engine.observe(signal), []);
  assert.deepEqual(engine.observe({ ...signal, signalId: 'another' }), []);
});

test('emergency lifecycle allows alerts, live tracking, and resolution in order', () => {
  const engine = new SafetyDecisionEngine();
  engine.startJourney();
  engine.observe({ kind: 'private_phrase', exactPhraseMatch: true, confidence: 1, timestamp: 1 });
  assert.deepEqual(engine.markAlertsSent().map((item) => item.to), ['ALERTS_SENT']);
  assert.deepEqual(engine.startEmergencyTracking().map((item) => item.to), ['LIVE_EMERGENCY_TRACKING']);
  assert.deepEqual(engine.resolve().map((item) => item.to), ['RESOLVED']);
  assert.equal(engine.state, 'RESOLVED');
});

test('expired evidence is not combined with a later signal', () => {
  const engine = new SafetyDecisionEngine({ evidenceWindowMs: 1000, confirmationWindowMs: 50_000 });
  engine.startJourney();
  engine.observe({ kind: 'fall', confidence: 0.8, timestamp: 1000 });
  const actions = engine.observe({ kind: 'scream', confidence: 0.8, timestamp: 3000 });
  assert.equal(engine.state, 'MONITORING');
  assert.ok(!actionTypes(actions).includes('activate_emergency'));
});

test('personal trigger matching normalizes punctuation and matches phrase boundaries', () => {
  const phrases = [
    { id: 'private', phrase: 'Call the blue taxi', enabled: true, independentActivation: true },
    { id: 'disabled', phrase: 'help me now', enabled: false, independentActivation: true },
  ];
  assert.equal(matchTriggerPhrase('Please, CALL the blue taxi!', phrases)?.id, 'private');
  assert.equal(matchTriggerPhrase('I called the blue taxi yesterday', phrases), null);
  assert.equal(matchTriggerPhrase('help me now', phrases), null);
});

test('phrase matching ignores disabled phrases and empty transcripts', () => {
  assert.equal(matchTriggerPhrase('call me', [{ id: 'x', phrase: 'call me', enabled: false, independentActivation: true }]), null);
  assert.equal(matchTriggerPhrase('   ', [{ id: 'x', phrase: 'call me', enabled: true, independentActivation: true }]), null);
});

test('route distance detects points near a segment and outside deviation threshold', () => {
  const route = [{ latitude: -26.2, longitude: 28.0 }, { latitude: -26.2, longitude: 28.01 }];
  const onRoute = { latitude: -26.2, longitude: 28.005 };
  const offRoute = { latitude: -26.203, longitude: 28.005 };
  assert.ok(distanceToRouteMeters(onRoute, route) < 1);
  assert.equal(isRouteDeviation(onRoute, route).deviated, false);
  assert.equal(isRouteDeviation(offRoute, route).deviated, true);
});

test('route deviation threshold accounts for GPS accuracy', () => {
  const route = [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0.01 }];
  const point = { latitude: 0.001, longitude: 0.005 };
  assert.equal(isRouteDeviation(point, route, { thresholdMeters: 50, accuracyMeters: 20 }).deviated, true);
  assert.equal(isRouteDeviation(point, route, { thresholdMeters: 50, accuracyMeters: 100 }).deviated, false);
});

test('route coordinate parser accepts bounded coordinate pairs and rejects malformed points', () => {
  assert.deepEqual(parseRouteCoordinates('-26.2, 28.0; -26.21, 28.02'), [
    { latitude: -26.2, longitude: 28 },
    { latitude: -26.21, longitude: 28.02 },
  ]);
  assert.deepEqual(parseRouteCoordinates([]), []);
  assert.throws(() => parseRouteCoordinates('100, 0'), /valid latitude/);
  assert.throws(() => parseRouteCoordinates('26.2'), /latitude, longitude/);
});

test('road route planner geocodes a destination and returns a road-following route', async () => {
  const requests = [];
  const fetcher = async (url) => {
    requests.push(new URL(url));
    if (requests.length === 1) return Response.json({ features: [{ geometry: { coordinates: [28.1, -26.1] } }] });
    return Response.json({ code: 'Ok', routes: [{ geometry: { coordinates: [[28, -26], [28.05, -26.05], [28.1, -26.1]] } }] });
  };
  const route = await planRoadRoute({ latitude: -26, longitude: 28 }, 'Pretoria, South Africa', { fetcher });
  assert.deepEqual(route, [
    { latitude: -26, longitude: 28 },
    { latitude: -26.05, longitude: 28.05 },
    { latitude: -26.1, longitude: 28.1 },
  ]);
  assert.equal(requests[0].searchParams.get('q'), 'Pretoria, South Africa');
  assert.match(requests[1].pathname, /route\/v1\/driving/);
});

test('road route planner rejects unknown destination and failed directions', async () => {
  const noDestination = async () => Response.json({ features: [] });
  await assert.rejects(planRoadRoute({ latitude: 0, longitude: 0 }, 'Unknown place', { fetcher: noDestination }), /No matching destination/);
  const noRoute = async (url) => new URL(url).pathname.includes('/search')
    ? Response.json({ features: [{ geometry: { coordinates: [28, -26] } }] })
    : Response.json({ code: 'NoRoute', routes: [] });
  await assert.rejects(planRoadRoute({ latitude: -26, longitude: 28 }, 'Town', { fetcher: noRoute }), /No drivable route/);
});

test('fall detector requires a free-fall interval followed by an impact', () => {
  const detector = new FallDetector();
  assert.equal(detector.observe({ x: 0, y: 0, z: 0, timestamp: 1000 }), null);
  assert.equal(detector.observe({ x: 0, y: 0, z: 0, timestamp: 1200 }), null);
  const signal = detector.observe({ x: 0, y: 0, z: 26, timestamp: 1450 });
  assert.equal(signal?.timestamp, 1450);
  assert.equal(typeof signal?.confidence, 'number');
  assert.equal(detector.observe({ x: 0, y: 0, z: 0, timestamp: 1500 }), null);
});

test('stale location detection handles age, invalid, and future timestamps', () => {
  assert.equal(isLocationStale(60_000, 100_000), true);
  assert.equal(isLocationStale(90_000, 100_000), false);
  assert.equal(isLocationStale(Number.NaN, 100_000), true);
  assert.equal(isLocationStale(110_000, 100_000), true);
});

test('location updates reject poor accuracy, stale fixes, and out-of-order timestamps', () => {
  const base = { latitude: -26, longitude: 28, accuracy: 10, timestamp: 100_000 };
  assert.equal(shouldAcceptLocationUpdate(base, null, { now: 101_000 }), true);
  assert.equal(shouldAcceptLocationUpdate({ ...base, timestamp: 60_000 }, null, { now: 101_000 }), false);
  assert.equal(shouldAcceptLocationUpdate({ ...base, accuracy: 150 }, null, { now: 101_000 }), false);
  assert.equal(shouldAcceptLocationUpdate({ ...base, timestamp: 100_500 }, base, { now: 101_000 }), true);
  assert.equal(shouldAcceptLocationUpdate(base, base, { now: 101_000 }), false);
});

test('notification provider retries transient failures and records accepted attempt', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new ProviderError('temporary provider failure', 503);
    return { status: 'accepted', providerId: 'provider-1' };
  }, 3, async () => {});
  assert.equal(calls, 3);
  assert.deepEqual(result, { status: 'accepted', providerId: 'provider-1', attempts: 3 });
});

test('notification provider skips permanent retries and stops after retry limit', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls += 1;
    throw new ProviderError('bad request', 400);
  }, 3, async () => {}), /bad request/);
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(withRetry(async () => {
    calls += 1;
    throw new ProviderError('temporarily unavailable', 503);
  }, 3, async () => {}), /temporarily unavailable/);
  assert.equal(calls, 3);
});
