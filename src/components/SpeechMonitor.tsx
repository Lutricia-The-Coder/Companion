import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import type { TriggerPhrase } from '../services/triggerPhrases';
import { matchTriggerPhrase } from '../services/triggerPhraseMatcher';

type Props = {
  active: boolean;
  phrases: TriggerPhrase[];
  retryToken?: number;
  onStatus: (status: string) => void;
  onPhrase: (phrase: TriggerPhrase, confidence: number | null) => void;
};

type RecognitionConfig = { locale: string; servicePackage?: string };
const ANDROID_ON_DEVICE_SERVICE = 'com.google.android.as';
const MATCH_COOLDOWN_MS = 15_000;

/** Foreground, on-device speech adapter. Custom phrases are transcript matches, not a keyword spotter. */
export default function SpeechMonitor({ active, phrases, retryToken = 0, onStatus, onPhrase }: Props) {
  const activeRef = useRef(active);
  const restartingRef = useRef(false);
  const restartBlockedRef = useRef(false);
  const recognitionConfigRef = useRef<RecognitionConfig | null>(null);
  const lastMatchRef = useRef<{ key: string; at: number } | null>(null);
  const lastUnmatchedStatusAtRef = useRef(0);
  const enabled = phrases.filter((phrase) => phrase.enabled);
  const phrasesKey = enabled.map((phrase) => phrase.phrase).join('|');
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

  const startRecognition = useCallback(() => {
    const config = recognitionConfigRef.current;
    if (!activeRef.current || !config || restartBlockedRef.current) return;
    try {
      ExpoSpeechRecognitionModule.start({
        lang: config.locale,
        continuous: true,
        interimResults: true,
        maxAlternatives: 5,
        requiresOnDeviceRecognition: true,
        contextualStrings: phrasesRef.current.map((phrase) => phrase.phrase),
        ...(Platform.OS === 'android' && config.servicePackage
          ? { androidRecognitionServicePackage: config.servicePackage }
          : {}),
      });
    } catch (error) {
      onStatusRef.current(`Speech monitor stopped: ${error instanceof Error ? error.message : 'recognizer unavailable'}`);
    }
  }, []);

  const restart = useCallback(() => {
    if (!activeRef.current || restartingRef.current || restartBlockedRef.current) return;
    restartingRef.current = true;
    setTimeout(() => {
      restartingRef.current = false;
      startRecognition();
    }, 750);
  }, [startRecognition]);

  useSpeechRecognitionEvent('start', () => onStatusRef.current('Listening for your SOS phrase (on-device speech recognition)'));
  useSpeechRecognitionEvent('end', restart);
  useSpeechRecognitionEvent('error', (event) => {
    if (event.error === 'aborted') return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'language-not-supported') {
      restartBlockedRef.current = true;
    }
    onStatusRef.current(`Speech detection unavailable: ${event.message || event.error}`);
  });
  useSpeechRecognitionEvent('result', (event) => {
    // Ignore interim hypotheses so an early low score cannot consume the phrase cooldown.
    if (!event.isFinal) return;
    const candidates = event.results
      .filter((item) => item.transcript.trim().length > 0)
      .map((result) => ({ result, match: matchTriggerPhrase(result.transcript, phrasesRef.current) }));
    const candidate = candidates.find((item) => item.match);
    if (!candidate?.match) {
      const now = Date.now();
      if (candidates.length > 0 && now - lastUnmatchedStatusAtRef.current > 4_000) {
        lastUnmatchedStatusAtRef.current = now;
        onStatusRef.current('Speech heard, but it did not match a saved SOS phrase.');
      }
      return;
    }

    const { result, match } = candidate;
    const key = `${match.id}:${result.transcript.trim().toLocaleLowerCase()}`;
    const now = Date.now();
    if (lastMatchRef.current?.key === key && now - lastMatchRef.current.at < MATCH_COOLDOWN_MS) return;
    lastMatchRef.current = { key, at: now };

    // The Android adapter maps an omitted confidence array to 0. Preserve that as unknown.
    if (!Number.isFinite(result.confidence) || result.confidence <= 0) {
      onPhraseRef.current(match, null);
      return;
    }
    onPhraseRef.current(match, result.confidence);
  });

  useEffect(() => {
    let cancelled = false;
    if (!active) {
      recognitionConfigRef.current = null;
      try { ExpoSpeechRecognitionModule.abort(); } catch { /* Native module may not be available on web. */ }
      onStatusRef.current('Voice monitoring paused');
      return;
    }
    activeRef.current = true;
    if (retryToken > 0) restartBlockedRef.current = false;
    if (!hasEnabledPhrases) {
      onStatusRef.current('Add and enable an SOS phrase to use phrase recognition.');
      return;
    }
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      restartBlockedRef.current = true;
      onStatusRef.current('Speech recognition service is unavailable on this device.');
      return;
    }

    const configureAndStart = async () => {
      try {
        let locale = 'en-US';
        let servicePackage: string | undefined;
        if (Platform.OS === 'android') {
          const services = ExpoSpeechRecognitionModule.getSpeechRecognitionServices();
          servicePackage = services.includes(ANDROID_ON_DEVICE_SERVICE)
            ? ANDROID_ON_DEVICE_SERVICE
            : ExpoSpeechRecognitionModule.getDefaultRecognitionService().packageName || undefined;
          const supported = await ExpoSpeechRecognitionModule.getSupportedLocales(
            servicePackage ? { androidRecognitionServicePackage: servicePackage } : {},
          );
          if (cancelled) return;
          const installedEnglish = supported.installedLocales.find((item) => item.toLowerCase() === 'en-us')
            ?? supported.installedLocales.find((item) => item.toLowerCase().startsWith('en-'));
          if (!installedEnglish) {
            const supportedEnglish = supported.locales.find((item) => item.toLowerCase() === 'en-us')
              ?? supported.locales.find((item) => item.toLowerCase().startsWith('en-'));
            if (!supportedEnglish || servicePackage === ANDROID_ON_DEVICE_SERVICE) {
              recognitionConfigRef.current = null;
              onStatusRef.current('English offline speech model is not yet downloaded. Download an English model, then retry phrase recognition.');
              return;
            }
            locale = supportedEnglish;
            onStatusRef.current('Checking the default recognizer’s on-device English model…');
          } else {
            locale = installedEnglish;
          }
        }
        if (cancelled) return;
        recognitionConfigRef.current = { locale, servicePackage };
        restartBlockedRef.current = false;
        startRecognition();
      } catch (error) {
        if (cancelled) return;
        restartBlockedRef.current = true;
        onStatusRef.current(`Could not check offline speech models: ${error instanceof Error ? error.message : 'recognizer unavailable'}`);
      }
    };
    void configureAndStart();
    return () => {
      cancelled = true;
      activeRef.current = false;
      recognitionConfigRef.current = null;
      try { ExpoSpeechRecognitionModule.abort(); } catch { /* Native module may not be available on web. */ }
    };
  }, [active, hasEnabledPhrases, phrasesKey, retryToken, startRecognition]);

  return null;
}
