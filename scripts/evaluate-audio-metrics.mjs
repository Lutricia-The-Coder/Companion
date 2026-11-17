import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { cells.push(cell); cell = ''; }
    else cell += char;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  cells.push(cell);
  return cells;
}

export function evaluateAudioRows(rows) {
  if (!rows.length) throw new Error('CSV must contain at least one prediction row.');
  const totals = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
  let backgroundHours = 0;
  const latencies = [];
  const memories = [];
  const batteryDeltas = [];

  for (const [index, row] of rows.entries()) {
    const actual = String(row.actual ?? '').trim().toLowerCase();
    const predicted = String(row.predicted ?? '').trim().toLowerCase();
    if (!['distress', 'background'].includes(actual) || !['distress', 'background'].includes(predicted)) {
      throw new Error(`Row ${index + 2}: actual and predicted must be distress or background.`);
    }
    const duration = Number(row.duration_seconds);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Row ${index + 2}: duration_seconds must be positive.`);
    const positive = actual === 'distress';
    const detected = predicted === 'distress';
    if (positive && detected) totals.truePositive += 1;
    else if (positive) totals.falseNegative += 1;
    else if (detected) totals.falsePositive += 1;
    else totals.trueNegative += 1;
    if (!positive) backgroundHours += duration / 3600;

    for (const [column, target] of [['latency_ms', latencies], ['memory_mb', memories], ['battery_delta_percent', batteryDeltas]]) {
      if (row[column] === undefined || row[column] === '') continue;
      const value = Number(row[column]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`Row ${index + 2}: ${column} must be a nonnegative number.`);
      target.push(value);
    }
  }

  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const percentile95 = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * 0.95) - 1];
  };
  const precisionDenominator = totals.truePositive + totals.falsePositive;
  const recallDenominator = totals.truePositive + totals.falseNegative;
  return {
    samples: rows.length,
    backgroundHours: Number(backgroundHours.toFixed(3)),
    ...totals,
    precision: precisionDenominator ? totals.truePositive / precisionDenominator : null,
    recall: recallDenominator ? totals.truePositive / recallDenominator : null,
    falseNegativeRate: recallDenominator ? totals.falseNegative / recallDenominator : null,
    falsePositivesPerHour: backgroundHours ? totals.falsePositive / backgroundHours : null,
    latencyMs: { mean: mean(latencies), p95: percentile95(latencies) },
    memoryMb: { mean: mean(memories), max: memories.length ? Math.max(...memories) : null },
    batteryDeltaPercent: { meanPerWindow: mean(batteryDeltas) },
  };
}

export async function evaluateAudioCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) throw new Error('CSV must include a header and at least one data row.');
  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  for (const required of ['actual', 'predicted', 'duration_seconds']) {
    if (!headers.includes(required)) throw new Error(`CSV is missing the required '${required}' column.`);
  }
  const rows = lines.slice(1).map((line, index) => {
    const cells = parseCsvLine(line);
    if (cells.length !== headers.length) throw new Error(`Row ${index + 2}: expected ${headers.length} columns, received ${cells.length}.`);
    return Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex].trim()]));
  });
  return evaluateAudioRows(rows);
}

async function main(argv) {
  const file = argv[2];
  if (argv.includes('--help')) {
    process.stdout.write('Usage: node scripts/evaluate-audio-metrics.mjs <predictions.csv>\nRequired columns: actual,predicted,duration_seconds. Optional: latency_ms,memory_mb,battery_delta_percent. Labels: distress|background.\n');
    return 0;
  }
  if (!file) throw new Error('Pass a CSV file path, or use --help for usage.');
  const csv = await readFile(path.resolve(file), 'utf8');
  process.stdout.write(`${JSON.stringify(await evaluateAudioCsv(csv), null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv).then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
