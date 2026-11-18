import { useEffect } from 'react';
import type { TriggerPhrase } from '../services/triggerPhrases';

/** The browser preview cannot provide the native passive phrase monitor. */
export default function SpeechMonitor({
  active,
  phrases,
  onStatus,
}: {
  active: boolean;
  phrases: TriggerPhrase[];
  retryToken?: number;
  onStatus: (status: string) => void;
  onPhrase: (phrase: TriggerPhrase, confidence: number | null) => void;
}) {
  useEffect(() => {
    onStatus(active && phrases.some((phrase) => phrase.enabled)
      ? 'Voice trigger monitoring requires the native Companion app.'
      : 'Voice monitoring is paused');
  }, [active, onStatus, phrases]);

  return null;
}
