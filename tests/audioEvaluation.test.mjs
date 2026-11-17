import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAudioCsv, evaluateAudioRows } from '../scripts/evaluate-audio-metrics.mjs';

test('audio evaluation reports confusion matrix, rates, and runtime summary', () => {
  const result = evaluateAudioRows([
    { actual: 'distress', predicted: 'distress', duration_seconds: 1, latency_ms: 80, memory_mb: 42, battery_delta_percent: 0.01 },
    { actual: 'distress', predicted: 'background', duration_seconds: 1, latency_ms: 100, memory_mb: 43, battery_delta_percent: 0.02 },
    { actual: 'background', predicted: 'distress', duration_seconds: 1800, latency_ms: 90, memory_mb: 41, battery_delta_percent: 0.01 },
    { actual: 'background', predicted: 'background', duration_seconds: 1800, latency_ms: 110, memory_mb: 40, battery_delta_percent: 0.02 },
  ]);
  assert.deepEqual([result.truePositive, result.falsePositive, result.trueNegative, result.falseNegative], [1, 1, 1, 1]);
  assert.equal(result.precision, 0.5);
  assert.equal(result.recall, 0.5);
  assert.equal(result.falseNegativeRate, 0.5);
  assert.equal(result.falsePositivesPerHour, 1);
  assert.deepEqual(result.latencyMs, { mean: 95, p95: 110 });
  assert.equal(result.memoryMb.max, 43);
});

test('audio CSV parser supports quoted fields and rejects invalid labels and missing columns', async () => {
  const result = await evaluateAudioCsv('actual,predicted,duration_seconds,scenario\nbackground,background,3600,"street, crowd"');
  assert.equal(result.trueNegative, 1);
  await assert.rejects(evaluateAudioCsv('actual,duration_seconds\nbackground,2'), /missing the required 'predicted'/);
  assert.throws(() => evaluateAudioRows([{ actual: 'maybe', predicted: 'background', duration_seconds: 1 }]), /must be distress or background/);
});
