import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { uploadEmergencyEvidence } from '../services/evidence';
import { ACTIVE_JOURNEY_KEY } from '../services/journeys';

const EVIDENCE_KEY = 'companion-emergency-audio-evidence-v1';

type EvidenceRecord = { eventId: string; uri: string; recordedAt: number; durationSeconds: number; evidenceId?: string; expiresAt?: number };

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
    if (!eventId || !consent || recordingEventRef.current === eventId) return;
    let cancelled = false;
    recordingEventRef.current = eventId;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(EVIDENCE_KEY);
        const saved: EvidenceRecord[] = raw ? JSON.parse(raw) : [];
        if (saved.some((item) => item.eventId === eventId)) return;
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
              const currentRaw = await AsyncStorage.getItem(EVIDENCE_KEY);
              const current: EvidenceRecord[] = currentRaw ? JSON.parse(currentRaw) : [];
              await AsyncStorage.setItem(EVIDENCE_KEY, JSON.stringify([
                ...current.filter((item) => item.eventId !== eventId),
                { eventId, uri, recordedAt: Date.now(), durationSeconds: 20 },
              ].slice(-50)));
              const journeyId = await AsyncStorage.getItem(ACTIVE_JOURNEY_KEY);
              if (!journeyId) {
                statusRef.current('Audio saved locally; sign in and connect a journey to upload it securely');
                return;
              }
              const uploaded = await uploadEmergencyEvidence({ uri, journeyId, eventId, type: 'audio', durationSeconds: 20 });
              const latestRaw = await AsyncStorage.getItem(EVIDENCE_KEY);
              const latest: EvidenceRecord[] = latestRaw ? JSON.parse(latestRaw) : [];
              await AsyncStorage.setItem(EVIDENCE_KEY, JSON.stringify(latest.map((item) => item.eventId === eventId
                ? { ...item, evidenceId: uploaded.evidenceId, expiresAt: uploaded.expiresAt }
                : item)));
              const delivery = uploaded.notifications?.status;
              statusRef.current(delivery === 'accepted' || delivery === 'partial'
                ? 'SOS audio uploaded privately; email provider accepted the temporary link request'
                : 'SOS audio uploaded privately; the email link was not accepted by the configured provider');
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
