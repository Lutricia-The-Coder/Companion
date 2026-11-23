import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAudioCsv, evaluateAudioRows } from '../scripts/evaluate-audio-metrics.mjs';
import { selectLatestAudioEvaluationRows } from '../src/services/audioEvaluationCsv.ts';

test('audio evaluation export keeps the header and includes the newest prediction rows', () => {
  const rows = Array.from({ length: 205 }, (_, index) => `,background,0.975,1,${index},scream,0.1,0.82`);
  const result = selectLatestAudioEvaluationRows(['actual,predicted,duration_seconds,latency_ms,timestamp_ms,class_label,confidence,threshold', ...rows].join('\n'));
  const exported = result.csv.split('\n');
  assert.equal(exported[0].startsWith('actual,predicted'), true);
  assert.equal(result.sharedRows, 200);
  assert.equal(result.omittedRows, 5);
  assert.equal(exported[1].split(',')[4], '5');
  assert.equal(exported.at(-1).split(',')[4], '204');
});

test('audio evaluation export returns an empty result when the CSV has no prediction rows', () => {
  assert.deepEqual(selectLatestAudioEvaluationRows('actual,predicted\n'), { csv: '', sharedRows: 0, omittedRows: 0 });
});

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
