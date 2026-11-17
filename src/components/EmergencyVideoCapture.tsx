import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { uploadEmergencyEvidence } from '../services/evidence';

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
  const startedEvent = useRef<string | null>(null);
  const onStatusRef = useRef(onStatus);
  useEffect(() => { onStatusRef.current = onStatus; }, [onStatus]);

  useEffect(() => {
    if (!eventId || !consent) return;
    if (!permission?.granted) {
      onStatusRef.current('Requesting camera permission for opted-in emergency video evidence');
      void requestPermission().then((result) => {
        if (!result.granted) onStatusRef.current('Video evidence unavailable: camera permission was denied');
      }).catch(() => onStatusRef.current('Video evidence unavailable: camera permission could not be requested'));
    }
  }, [eventId, consent, permission?.granted, requestPermission]);

  const beginRecording = useCallback(async () => {
    if (!eventId || !journeyId || !consent || !permission?.granted || !cameraReady || !camera.current || startedEvent.current === eventId) return;
    startedEvent.current = eventId;
    onStatusRef.current('Recording up to 20 seconds of muted video evidence');
    try {
      const result = await camera.current.recordAsync({ maxDuration: 20, maxFileSize: 12 * 1024 * 1024 });
      if (!result?.uri) throw new Error('The camera did not save a video file.');
      onStatusRef.current('Video captured; uploading to private evidence storage');
      const uploaded = await uploadEmergencyEvidence({ uri: result.uri, journeyId, eventId, type: 'video', durationSeconds: 20 });
      onStatusRef.current(uploaded.notifications?.status === 'accepted' || uploaded.notifications?.status === 'partial'
        ? 'Emergency video uploaded privately; email provider accepted the temporary link request'
        : 'Emergency video uploaded privately; the email link was not accepted by the configured provider');
    } catch (error) {
      onStatusRef.current(`Video evidence upload failed: ${error instanceof Error ? error.message : 'camera unavailable'}`);
    }
  }, [cameraReady, consent, eventId, journeyId, permission?.granted]);

  useEffect(() => { void beginRecording(); }, [beginRecording]);

  useEffect(() => () => {
    if (startedEvent.current && camera.current) camera.current.stopRecording();
  }, []);

  if (!eventId || !consent) return null;
  return <View style={styles.card}>
    <Text style={styles.heading}>Emergency video evidence</Text>
    {!permission?.granted
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
        <View style={styles.statusRow}><ActivityIndicator color="#5CE0C0" /><Text style={styles.status}>The camera preview and recording are visible. Video has no audio; the separate opt-in audio recording captures sound.</Text></View>
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
