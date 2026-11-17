import { readFile } from 'node:fs/promises';

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/evaluate-scream-classifier.mjs <consented-corpus-results.json>');
  process.exit(2);
}

const samples = JSON.parse(await readFile(input, 'utf8'));
if (!Array.isArray(samples) || samples.length === 0) throw new Error('Corpus results must be a non-empty JSON array.');
for (const [index, sample] of samples.entries()) {
  if (typeof sample?.scream !== 'boolean' || typeof sample?.detected !== 'boolean'
    || !Number.isFinite(sample.durationSeconds) || sample.durationSeconds <= 0
    || (sample.detected && (!Number.isFinite(sample.latencyMs) || sample.latencyMs < 0))) {
    throw new Error(`Invalid sample at index ${index}: require scream/detected booleans, positive durationSeconds, and latencyMs when detected.`);
  }
}

const positives = samples.filter((sample) => sample.scream);
const negatives = samples.filter((sample) => !sample.scream);
const truePositives = positives.filter((sample) => sample.detected).length;
const falsePositives = negatives.filter((sample) => sample.detected).length;
const negativeHours = negatives.reduce((total, sample) => total + sample.durationSeconds, 0) / 3600;
const latencies = samples.filter((sample) => sample.detected).map((sample) => sample.latencyMs).sort((a, b) => a - b);
const percentile = (values, p) => values.length ? values[Math.ceil(p * values.length) - 1] : null;
const byEnvironment = Object.groupBy(samples, (sample) => sample.environment || 'unspecified');

console.log(JSON.stringify({
  sampleCount: samples.length,
  positiveSamples: positives.length,
  negativeHours: Number(negativeHours.toFixed(3)),
  recall: positives.length ? Number((truePositives / positives.length).toFixed(4)) : null,
  falsePositivesPerHour: negativeHours ? Number((falsePositives / negativeHours).toFixed(3)) : null,
  detectedLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.at(-1) ?? null },
  byEnvironment: Object.fromEntries(Object.entries(byEnvironment).map(([environment, group]) => {
    const groupPositive = group.filter((sample) => sample.scream);
    const groupNegative = group.filter((sample) => !sample.scream);
    const groupFp = groupNegative.filter((sample) => sample.detected).length;
    const groupHours = groupNegative.reduce((total, sample) => total + sample.durationSeconds, 0) / 3600;
    return [environment, {
      samples: group.length,
      positiveSamples: groupPositive.length,
      recall: groupPositive.length ? Number((groupPositive.filter((sample) => sample.detected).length / groupPositive.length).toFixed(4)) : null,
      falsePositivesPerHour: groupHours ? Number((groupFp / groupHours).toFixed(3)) : null,
    }];
  })),
}, null, 2));
