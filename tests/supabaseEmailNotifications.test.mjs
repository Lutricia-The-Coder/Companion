import test from 'node:test';
import assert from 'node:assert/strict';
import { emailTargets, retryEmailDelivery, sendResendEmail } from '../supabase/functions/_shared/emailNotifications.ts';

test('email notifications select only valid, unique email contacts', () => {
  const targets = emailTargets([
    { email: ' Trusted@Example.com ' },
    { phone: '+27123456789' },
    { email: 'trusted@example.com' },
    { email: 'not-an-email' },
    null,
  ]);
  assert.deepEqual(targets, ['trusted@example.com']);
});

test('email preferences can disable delivery without selecting SMS or push', () => {
  assert.deepEqual(emailTargets([{ email: 'trusted@example.com', phone: '+27123456789' }], false), []);
});

test('email delivery retries transient failures and returns provider acceptance', async () => {
  let calls = 0;
  const delays = [];
  const result = await retryEmailDelivery(async () => {
    calls++;
    if (calls < 3) throw new Error('temporary provider error');
    return { id: 'email-123' };
  }, async (ms) => delays.push(ms));
  assert.equal(result.accepted, true);
  assert.equal(result.status, 'accepted');
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.providerResponse, { id: 'email-123' });
  assert.deepEqual(delays, [400, 800]);
});

test('email delivery stops after three failures and reports the final provider error', async () => {
  let calls = 0;
  const result = await retryEmailDelivery(async () => {
    calls++;
    throw new Error('provider unavailable');
  }, async () => undefined);
  assert.equal(calls, 3);
  assert.equal(result.accepted, false);
  assert.equal(result.status, 'unknown');
  assert.equal(result.attempts, 3);
  assert.equal(result.retryable, true);
  assert.equal(result.error, 'Email provider request failed.');
});

test('Resend request uses a stable idempotency key and records the provider reference', async () => {
  let request;
  const result = await sendResendEmail({
    apiKey: 'test-key',
    from: 'Companion <alerts@example.test>',
    to: 'contact@example.test',
    subject: 'Emergency alert',
    text: 'Test only',
    idempotencyKey: 'event-123/email/contact-1',
    fetcher: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ id: 'resend-email-123' }), { status: 200 });
    },
  });
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.options.headers['Idempotency-Key'], 'event-123/email/contact-1');
  assert.deepEqual(JSON.parse(request.options.body), {
    from: 'Companion <alerts@example.test>',
    to: ['contact@example.test'],
    subject: 'Emergency alert',
    text: 'Test only',
  });
  assert.deepEqual(result, { status: 'accepted', providerReference: 'resend-email-123' });
});

test('Resend rejection is not reported as accepted delivery', async () => {
  await assert.rejects(sendResendEmail({
    apiKey: 'test-key', from: 'alerts@example.test', to: 'contact@example.test',
    subject: 'Emergency alert', text: 'Test only', idempotencyKey: 'event-123/email/contact-1',
    fetcher: async () => new Response('unauthorized', { status: 401 }),
  }), /HTTP 401/);
});

test('permanent Resend recipient rejection is recorded after one attempt without retrying', async () => {
  let calls = 0;
  const result = await retryEmailDelivery(() => sendResendEmail({
    apiKey: 'test-key', from: 'onboarding@resend.dev', to: 'another-contact@example.test',
    subject: 'Emergency alert', text: 'Test only', idempotencyKey: 'event-123/email/contact-1',
    fetcher: async () => { calls += 1; return new Response('recipient is not allowed in test mode', { status: 403 }); },
  }), async () => { throw new Error('A permanent error must not retry.'); });
  assert.equal(calls, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.attempts, 1);
  assert.match(result.error, /HTTP 403/);
});
