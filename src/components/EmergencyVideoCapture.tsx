import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import { enqueueEmergencyEvidence, loadEvidenceOutbox, uploadPendingEmergencyEvidence } from '../services/evidence';

export default function EmergencyVideoCapture({
  eventId,
  journeyId,
  consent,
  onStatus,
}: {
  eventId: string | null;
  journeyId: string | null;
  consent: boolean;
  onStatus: (status: string) => void;
}) {
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraReady, setCameraReady] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [outboxCheckedEvent, setOutboxCheckedEvent] = useState<string | null>(null);
  const startedEvent = useRef<string | null>(null);
  const appActiveRef = useRef(appActive);
  const consentRef = useRef(consent);
  const onStatusRef = useRef(onStatus);
  useEffect(() => { appActiveRef.current = appActive; }, [appActive]);
  useEffect(() => { consentRef.current = consent; }, [consent]);
  useEffect(() => { onStatusRef.current = onStatus; }, [onStatus]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const active = state === 'active';
      appActiveRef.current = active;
      setAppActive(active);
      if (!active && startedEvent.current === eventId && camera.current) {
        camera.current.stopRecording();
        onStatusRef.current('Video recording stopped because Companion moved to the background or the device locked. Emergency alerts and location tracking continue; any saved partial clip will be retained if available.');
      }
    });
    return () => subscription.remove();
  }, [eventId]);

  useEffect(() => {
    if (!eventId || !consent || !appActive) return;
    let cancelled = false;
    void loadEvidenceOutbox().then((records) => {
      if (cancelled) return;
      if (records.some((item) => item.eventId === eventId && item.type === 'video')) startedEvent.current = eventId;
      setOutboxCheckedEvent(eventId);
      if (startedEvent.current === eventId) return;
      if (!permission?.granted) {
        onStatusRef.current('Requesting camera permission for opted-in emergency video evidence');
        void requestPermission().then((result) => {
          if (!result.granted) onStatusRef.current('Video evidence unavailable: camera permission was denied');
        }).catch(() => onStatusRef.current('Video evidence unavailable: camera permission could not be requested'));
      }
    });
    return () => { cancelled = true; };
  }, [appActive, eventId, consent, permission?.granted, requestPermission]);

  const beginRecording = useCallback(async () => {
    if (!eventId || !journeyId || !consent || !permission?.granted || !cameraReady || !camera.current || outboxCheckedEvent !== eventId || startedEvent.current === eventId) return;
    if (!appActiveRef.current) {
      onStatusRef.current('Video evidence is unavailable while Companion is backgrounded or the device is locked. Emergency alerts and location tracking continue.');
      return;
    }
    startedEvent.current = eventId;
    const recordedAt = Date.now();
    onStatusRef.current('Recording up to 20 seconds of muted video evidence');
    try {
      const result = await camera.current.recordAsync({ maxDuration: 20, maxFileSize: 12 * 1024 * 1024 });
      if (!result?.uri) throw new Error('The camera did not save a video file.');
      if (!consentRef.current) {
        const discarded = new File(result.uri);
        if (discarded.exists) discarded.delete();
        onStatusRef.current('Video recording was discarded because evidence consent was turned off. Emergency alerts and location tracking continue.');
        return;
      }
      onStatusRef.current('Video captured; uploading to private evidence storage');
      await enqueueEmergencyEvidence({ uri: result.uri, journeyId, eventId, type: 'video', durationSeconds: 20, recordedAt });
      onStatusRef.current('Video evidence saved privately; secure upload is queued.');
      await uploadPendingEmergencyEvidence({ onStatus: (message) => onStatusRef.current(message) });
    } catch (error) {
      onStatusRef.current(`Video evidence upload failed: ${error instanceof Error ? error.message : 'camera unavailable'}`);
    }
  }, [cameraReady, consent, eventId, journeyId, outboxCheckedEvent, permission?.granted]);

  useEffect(() => { void beginRecording(); }, [beginRecording]);

  useEffect(() => () => {
    if (startedEvent.current && camera.current) camera.current.stopRecording();
  }, []);

  if (!eventId || !consent) return null;
  return <View style={styles.card}>
    <Text style={styles.heading}>Emergency video evidence</Text>
    {!appActive
      ? <Text style={styles.status}>Video capture requires Companion to remain in the foreground with the device unlocked. Emergency alerts and location tracking continue if Android suspends camera access.</Text>
      : !permission?.granted
      ? <Text style={styles.status}>Camera permission is needed. The emergency alert has already been sent.</Text>
      : <>
        <CameraView
          ref={camera}
          style={styles.preview}
          mode="video"
          facing="back"
          mute
          onCameraReady={() => setCameraReady(true)}
          onMountError={(event) => onStatusRef.current(`Camera could not start: ${event.message}`)}
        />
        <View style={styles.statusRow}><ActivityIndicator color="#5CE0C0" /><Text style={styles.status}>Camera preview and recording indicator are visible. Video is muted; the separate opt-in audio recording captures sound.</Text></View>
      </>}
  </View>;
}

const styles = StyleSheet.create({
  card: { marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: '#17263B', borderWidth: 1, borderColor: '#2D4058' },
  heading: { color: '#F4F7FB', fontWeight: '700', fontSize: 12, marginBottom: 8 },
  preview: { height: 190, borderRadius: 9, overflow: 'hidden' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 9 },
  status: { flex: 1, color: '#9BAABD', fontSize: 10, lineHeight: 15, marginTop: 6 },
});
