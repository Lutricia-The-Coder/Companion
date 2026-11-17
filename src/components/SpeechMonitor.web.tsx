import { useEffect } from 'react';
import type { TriggerPhrase } from '../services/triggerPhrases';

type Props = {
  active: boolean;
  phrases: TriggerPhrase[];
  onStatus: (status: string) => void;
  onPhrase: (phrase: TriggerPhrase, confidence: number) => void;
};

/** Web preview intentionally avoids importing the native speech-recognition module. */
export default function SpeechMonitor({ active, onStatus }: Props) {
  useEffect(() => {
    onStatus(active
      ? 'Voice monitoring is unavailable in the Safari preview; use a native development build'
      : 'Voice monitoring is paused');
  }, [active, onStatus]);

  return null;
}
