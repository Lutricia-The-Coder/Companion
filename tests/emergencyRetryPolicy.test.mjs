import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateEmergencyPolicy } from '../supabase/functions/_shared/emergencyRetryPolicy.ts';

test('concurrent duplicate activation does not send while the first notification is pending', () => {
  assert.deepEqual(duplicateEmergencyPolicy({ status: 'pending', retryable: true }), {
    shouldNotify: false,
    status: 'already_active',
    retryable: true,
  });
  assert.deepEqual(duplicateEmergencyPolicy({ status: 'queued', retryable: true }), {
    shouldNotify: false,
    status: 'already_active',
    retryable: true,
  });
});

test('duplicate activation can retry only after a persisted retryable outcome', () => {
  assert.deepEqual(duplicateEmergencyPolicy({ status: 'failed', retryable: true }), {
    shouldNotify: true,
    status: 'failed',
    retryable: true,
  });
  assert.equal(duplicateEmergencyPolicy({ status: 'accepted', retryable: false }).shouldNotify, false);
  assert.equal(duplicateEmergencyPolicy({ status: 'failed', retryable: false }).shouldNotify, false);
});
