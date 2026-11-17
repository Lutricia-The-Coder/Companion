const assert = require('node:assert/strict');
const test = require('node:test');
const { ProviderError, summarizeNotificationOutcomes, withRetry } = require('./notificationRetry');

test('provider retry returns accepted response and attempt count', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new ProviderError('temporary provider failure', 503);
    return { status: 'accepted', providerId: 'provider-1' };
  }, 3, async () => {});

  assert.equal(calls, 3);
  assert.deepEqual(result, { status: 'accepted', providerId: 'provider-1', attempts: 3 });
});

test('provider retry stops after a permanent rejection', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls += 1;
    throw new ProviderError('invalid recipient', 400);
  }, 3, async () => {}), (error) => error.attempts === 1 && error.retryable === false);
  assert.equal(calls, 1);
});

test('provider retry reports the final transient failure after its retry limit', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls += 1;
    throw new ProviderError('provider unavailable', 503);
  }, 3, async () => {}), (error) => error.attempts === 3 && error.retryable === true);
  assert.equal(calls, 3);
});

test('notification outcomes distinguish accepted, partial, failed, and no-recipient delivery', () => {
  const sends = [{ channel: 'sms' }, { channel: 'email' }];
  const accepted = { status: 'fulfilled', value: { status: 'accepted', providerId: 'm1', attempts: 1 } };
  const failed = { status: 'rejected', reason: Object.assign(new Error('provider unavailable'), { attempts: 3 }) };

  assert.equal(summarizeNotificationOutcomes([sends[0]], [accepted], 99).status, 'accepted');
  assert.deepEqual(summarizeNotificationOutcomes(sends, [accepted, failed], 100), {
    status: 'partial', accepted: 1, failures: 1, completedAt: 100,
    attempts: [
      { channel: 'sms', status: 'accepted', providerId: 'm1', attempts: 1 },
      { channel: 'email', status: 'failed', error: 'provider unavailable', attempts: 3 },
    ],
  });
  assert.equal(summarizeNotificationOutcomes([sends[1]], [failed]).status, 'failed');
  const noRecipients = summarizeNotificationOutcomes([], []);
  assert.equal(noRecipients.status, 'no_recipients');
  assert.equal(noRecipients.accepted, 0);
  assert.equal(noRecipients.failures, 0);
  assert.deepEqual(noRecipients.attempts, []);
});
