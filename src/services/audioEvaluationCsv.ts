export type AudioEvaluationCsvSlice = {
  csv: string;
  sharedRows: number;
  omittedRows: number;
};

/** Keep the CSV header and export the newest rows so recent test sessions are visible. */
export function selectLatestAudioEvaluationRows(csv: string, limit = 200): AudioEvaluationCsvSlice {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0]?.trim();
  const rows = lines.slice(1).filter((line) => line.trim().length > 0);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 200;
  const selected = rows.slice(-safeLimit);
  return {
    csv: header && selected.length > 0 ? [header, ...selected].join('\n') : '',
    sharedRows: selected.length,
    omittedRows: Math.max(0, rows.length - selected.length),
  };
}
