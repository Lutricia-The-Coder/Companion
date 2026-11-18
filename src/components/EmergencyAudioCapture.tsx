import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { enqueueEmergencyEvidence, loadEvidenceOutbox, uploadPendingEmergencyEvidence } from '../services/evidence';
import { ACTIVE_JOURNEY_KEY } from '../services/journeys';

/** Opt-in, post-alert audio evidence. The app uploads it privately and sends contacts a short-lived access link. */
export default function EmergencyAudioCapture({
  eventId,
  consent,
  onStatus,
}: {
  eventId: string | null;
  consent: boolean;
  onStatus: (status: string) => void;
}) {
  const recorder = useAudioRecorder(RecordingPresets.LOW_QUALITY);
  const recordingEventRef = useRef('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef(onStatus);

  useEffect(() => { statusRef.current = onStatus; }, [onStatus]);

  useEffect(() => {
    const retry = () => {
      void uploadPendingEmergencyEvidence({ onStatus: (message) => statusRef.current(message) });
    };
    retry();
    const interval = setInterval(retry, 30_000);
    const appState = AppState.addEventListener('change', (state) => { if (state === 'active') retry(); });
    return () => { clearInterval(interval); appState.remove(); };
  }, []);

  useEffect(() => {
    if (!eventId || !consent || recordingEventRef.current === eventId) return;
    let cancelled = false;
    recordingEventRef.current = eventId;
    (async () => {
      try {
        if ((await loadEvidenceOutbox()).some((item) => item.eventId === eventId && item.type === 'audio')) return;
        const permission = await AudioModule.getRecordingPermissionsAsync();
        if (!permission.granted) {
          statusRef.current('Audio evidence unavailable: microphone permission is not granted');
          return;
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: true });
        await recorder.prepareToRecordAsync();
        if (cancelled) return;
        recorder.record();
        statusRef.current('Recording up to 20 seconds of local SOS audio');
        timerRef.current = setTimeout(() => {
          void (async () => {
            try {
              await recorder.stop();
              const uri = recorder.uri;
              if (!uri) throw new Error('The recorder did not return an audio file.');
              const journeyId = await AsyncStorage.getItem(ACTIVE_JOURNEY_KEY);
              await enqueueEmergencyEvidence({ uri, journeyId, eventId, type: 'audio', durationSeconds: 20 });
              statusRef.current(journeyId
                ? 'Audio evidence saved privately; secure upload is queued.'
                : 'Audio evidence saved privately on this device; upload waits for a signed-in journey.');
              await uploadPendingEmergencyEvidence({ onStatus: (message) => statusRef.current(message) });
            } catch (error) {
              statusRef.current(`Audio evidence failed: ${error instanceof Error ? error.message : 'recording could not be saved'}`);
            }
          })();
        }, 20_000);
      } catch (error) {
        statusRef.current(`Audio evidence failed: ${error instanceof Error ? error.message : 'recorder unavailable'}`);
      }
    })();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [eventId, consent, recorder]);

  return null;
}
