import type { TriggerPhrase } from './triggerPhrases';

function normalizeSpokenText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Matches complete phrase boundaries in recognized speech; this does not perform speech recognition. */
export function matchTriggerPhrase(transcript: string, phrases: TriggerPhrase[]): TriggerPhrase | null {
  const spoken = ` ${normalizeSpokenText(transcript)} `;
  if (spoken.trim().length === 0) return null;
  for (const item of phrases) {
    if (!item.enabled) continue;
    const target = normalizeSpokenText(item.phrase);
    if (target && spoken.includes(` ${target} `)) return item;
  }
  return null;
}
