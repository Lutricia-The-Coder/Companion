import { useCallback, useEffect, useRef } from 'react';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import type { TriggerPhrase } from '../services/triggerPhrases';
import { matchTriggerPhrase } from '../services/triggerPhraseMatcher';

type Props = {
  active: boolean;
  phrases: TriggerPhrase[];
  onStatus: (status: string) => void;
  onPhrase: (phrase: TriggerPhrase, confidence: number) => void;
};

/** OS speech-recognition adapter. Volume-meter events are check-in cues, never scream classifications. */
export default function SpeechMonitor({ active, phrases, onStatus, onPhrase }: Props) {
  const activeRef = useRef(active);
  const restartingRef = useRef(false);
  const restartBlockedRef = useRef(false);
  const lastMatchRef = useRef('');
  const loudSamplesRef = useRef<number[]>([]);
  const lastLoudSignalAtRef = useRef(0);

  const enabled = phrases.filter((phrase) => phrase.enabled);
  const enabledPhrases = enabled.map((phrase) => phrase.phrase);
  const phrasesKey = enabledPhrases.join('|');
  const hasEnabledPhrases = enabled.length > 0;
  const onStatusRef = useRef(onStatus);
  const onPhraseRef = useRef(onPhrase);
  const phrasesRef = useRef(enabled);

  useEffect(() => {
    activeRef.current = active;
    onStatusRef.current = onStatus;
    onPhraseRef.current = onPhrase;
    phrasesRef.current = phrases.filter((phrase) => phrase.enabled);
  }, [active, onStatus, onPhrase, phrases]);

  const restart = useCallback(() => {
    if (!activeRef.current || restartingRef.current || restartBlockedRef.current) return;
    restartingRef.current = true;
    setTimeout(() => {
      restartingRef.current = false;
      if (activeRef.current) {
        try {
          ExpoSpeechRecognitionModule.start({
            lang: 'en-US',
            continuous: true,
            interimResults: true,
            maxAlternatives: 3,
            requiresOnDeviceRecognition: true,
            contextualStrings: phrasesRef.current.map((phrase) => phrase.phrase),
            volumeChangeEventOptions: { enabled: true, intervalMillis: 250 },
          });
        } catch (error) {
          onStatusRef.current(`Speech monitor stopped: ${error instanceof Error ? error.message : 'recognizer unavailable'}`);
        }
      }
    }, 750);
  }, []);

  useSpeechRecognitionEvent('start', () => onStatusRef.current('Listening for your SOS phrase'));
  useSpeechRecognitionEvent('end', restart);
  useSpeechRecognitionEvent('error', (event) => {
    if (event.error === 'aborted') return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'language-not-supported') {
      restartBlockedRef.current = true;
    }
    onStatusRef.current(`Speech detection unavailable: ${event.message || event.error}`);
  });
  useSpeechRecognitionEvent('volumechange', (event) => {
    const now = Date.now();
    if (event.value < 8) {
      loudSamplesRef.current = loudSamplesRef.current.filter((timestamp) => now - timestamp < 1_300);
      return;
    }
    loudSamplesRef.current = [...loudSamplesRef.current.filter((timestamp) => now - timestamp < 1_300), now];
    if (loudSamplesRef.current.length < 4 || now - lastLoudSignalAtRef.current < 15_000) return;
    lastLoudSignalAtRef.current = now;
    loudSamplesRef.current = [];
    // The OS provides a volume meter, not a scream classifier; repeated loud input asks for a check-in.
    onPhraseRef.current({ id: '__loud-sound__', phrase: '', enabled: true, independentActivation: false }, 0.86);
  });
  useSpeechRecognitionEvent('result', (event) => {
    const result = event.results.find((item) => item.transcript.trim().length > 0);
    if (!result) return;
    const match = matchTriggerPhrase(result.transcript, enabled);
    if (!match) return;
    const dedupeKey = `${match.id}:${result.transcript.trim().toLocaleLowerCase()}`;
    if (dedupeKey === lastMatchRef.current) return;
    lastMatchRef.current = dedupeKey;
    const confidence = result.confidence >= 0 ? result.confidence : 0.92;
    onPhraseRef.current(match, confidence);
  });

  useEffect(() => {
    if (!active) {
      try { ExpoSpeechRecognitionModule.abort(); } catch { /* Native module may not be available on web. */ }
      onStatusRef.current('Voice monitoring paused');
      return;
    }
    if (!hasEnabledPhrases) onStatusRef.current('Monitoring loud audio; add an SOS phrase for phrase alerts');
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      restartBlockedRef.current = true;
      onStatusRef.current('Speech recognition service is unavailable on this device');
      return;
    }
    try {
      restartBlockedRef.current = false;
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        continuous: true,
        interimResults: true,
        maxAlternatives: 3,
        requiresOnDeviceRecognition: true,
        contextualStrings: phrasesRef.current.map((phrase) => phrase.phrase),
        volumeChangeEventOptions: { enabled: true, intervalMillis: 250 },
      });
    } catch (error) {
      onStatusRef.current(`Speech monitor could not start: ${error instanceof Error ? error.message : 'recognizer unavailable'}`);
    }
    return () => {
      activeRef.current = false;
      try { ExpoSpeechRecognitionModule.abort(); } catch { /* Native module may not be available on web. */ }
    };
  }, [active, hasEnabledPhrases, phrasesKey]);

  return null;
}
