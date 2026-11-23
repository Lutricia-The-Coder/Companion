const assert = require('node:assert/strict');
const test = require('node:test');
const pushAdapter = import('../supabase/functions/_shared/expoPush.mjs');

const token = 'ExpoPushToken[abcdefghijklmnopqrstuvwx]';

test('Expo acceptance is recorded as accepted, never as handset delivery', async () => {
  const { sendExpoPush } = await pushAdapter;
  let sent;
  const result = await sendExpoPush(token, 'Emergency', 'Help requested', { journeyId: 'journey-1' }, async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ data: { status: 'ok', id: 'ticket-1' } }), { status: 200 });
  });
  assert.equal(sent.url, 'https://exp.host/--/api/v2/push/send');
  assert.equal(sent.body.to, token);
  assert.equal(sent.body.channelId, 'safety-alerts');
  assert.equal(result.status, 'accepted');
  assert.equal(result.providerReference, 'ticket-1');
  assert.equal(result.providerResponse.meaning, 'accepted_by_expo_not_device_delivery');
  assert.equal(result.delivered, undefined);
});

test('Expo DeviceNotRegistered response is permanent and is not retried', async () => {
  const { sendExpoPushWithLimit } = await pushAdapter;
  let calls = 0;
  const result = await sendExpoPushWithLimit(token, 'Emergency', 'Help', {}, {
    fetcher: async () => { calls += 1; return new Response(JSON.stringify({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }), { status: 400 }); },
    pause: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.providerResponse.errorCode, 'DeviceNotRegistered');
  assert.equal(result.retryable, false);
});

test('transient server failures retry only to the configured attempt limit', async () => {
  const { sendExpoPushWithLimit } = await pushAdapter;
  let calls = 0;
  const result = await sendExpoPushWithLimit(token, 'Emergency', 'Help', {}, {
    maxAttempts: 3,
    fetcher: async () => { calls += 1; return new Response('{}', { status: 503 }); },
    pause: async () => {},
  });
  assert.equal(calls, 3);
  assert.equal(result.status, 'failed');
  assert.equal(result.attempts, 3);
  assert.equal(result.retryable, true);
});

test('ambiguous network result is unknown and is not retried to avoid duplicates', async () => {
  const { sendExpoPushWithLimit } = await pushAdapter;
  let calls = 0;
  const result = await sendExpoPushWithLimit(token, 'Emergency', 'Help', {}, {
    fetcher: async () => { calls += 1; throw new Error('network unavailable'); },
    pause: async () => {},
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'unknown');
  assert.equal(result.retryable, false);
});
