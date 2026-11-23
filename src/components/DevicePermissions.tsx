import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Location from 'expo-location';
import { AudioModule, requestRecordingPermissionsAsync } from 'expo-audio';
import { Camera } from 'expo-camera';
import * as Notifications from 'expo-notifications';

type PermissionState = 'granted' | 'not granted' | 'not available' | 'checking';
type PermissionSnapshot = {
  location: PermissionState;
  backgroundLocation: PermissionState;
  microphone: PermissionState;
  speech: PermissionState;
  camera: PermissionState;
  notifications: PermissionState;
};

const EMPTY: PermissionSnapshot = {
  location: 'checking', backgroundLocation: 'checking', microphone: 'checking',
  speech: 'checking', camera: 'checking', notifications: 'checking',
};
const WEB_UNAVAILABLE: PermissionSnapshot = {
  location: 'not available', backgroundLocation: 'not available', microphone: 'not available',
  speech: 'not available', camera: 'not available', notifications: 'not available',
};

export default function DevicePermissions() {
  const [permissions, setPermissions] = useState(Platform.OS === 'web' ? WEB_UNAVAILABLE : EMPTY);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (Platform.OS === 'web') return;
    const results = await Promise.allSettled([
      Location.getForegroundPermissionsAsync(),
      Location.getBackgroundPermissionsAsync(),
      AudioModule.getRecordingPermissionsAsync(),
      import('expo-speech-recognition').then(({ ExpoSpeechRecognitionModule }) => ExpoSpeechRecognitionModule.getPermissionsAsync()),
      Camera.getCameraPermissionsAsync(),
      Notifications.getPermissionsAsync(),
    ]);
    const granted = (index: number): PermissionState => results[index]?.status === 'fulfilled'
      ? (results[index] as PromiseFulfilledResult<{ granted: boolean }>).value.granted ? 'granted' : 'not granted'
      : 'not available';
    setPermissions({
      location: granted(0), backgroundLocation: granted(1), microphone: granted(2),
      speech: granted(3), camera: granted(4), notifications: granted(5),
    });
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const task = setTimeout(() => { void refresh(); }, 0);
    return () => clearTimeout(task);
  }, [refresh]);

  const requestEnabled = async () => {
    if (Platform.OS === 'web') return;
    setBusy(true);
    const failures: string[] = [];
    try {
      try {
        const foreground = await Location.requestForegroundPermissionsAsync();
        if (foreground.granted) await Location.requestBackgroundPermissionsAsync();
        else failures.push('Location was not granted.');
      } catch { failures.push('Location permission could not be requested.'); }
      try {
        await requestRecordingPermissionsAsync();
        const { ExpoSpeechRecognitionModule } = await import('expo-speech-recognition');
        await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      } catch { failures.push('Microphone or speech permission could not be requested.'); }
      try { await Camera.requestCameraPermissionsAsync(); }
      catch { failures.push('Camera permission could not be requested.'); }
      try { await Notifications.requestPermissionsAsync(); }
      catch { failures.push('Notification permission could not be requested.'); }
      await refresh();
      if (failures.length) Alert.alert('Some permissions need attention', failures.join('\n'));
    } finally {
      setBusy(false);
    }
  };

  return <View style={styles.card}>
    <Text style={styles.heading}>PERMISSIONS</Text>
    <Text style={styles.description}>Review the access Companion needs for safety features. You can change these any time in your phone settings.</Text>
    <PermissionRow label="Location while using the app" state={permissions.location} />
    <PermissionRow label="Background location" state={permissions.backgroundLocation} />
    <PermissionRow label="Microphone" state={permissions.microphone} />
    <PermissionRow label="Speech recognition" state={permissions.speech} />
    <PermissionRow label="Camera for opted-in evidence" state={permissions.camera} />
    <PermissionRow label="Notifications" state={permissions.notifications} />
    <TouchableOpacity style={styles.action} disabled={busy} onPress={() => void requestEnabled()} accessibilityRole="button">
      {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.actionText}>Review and request permissions</Text>}
    </TouchableOpacity>
    <TouchableOpacity style={styles.linkButton} onPress={() => void Linking.openSettings().catch(() => Alert.alert('Settings unavailable', 'Open your phone Settings → Apps → Companion → Permissions.'))} accessibilityRole="button">
      <Text style={styles.linkText}>Open Companion settings</Text>
    </TouchableOpacity>
  </View>;
}

function PermissionRow({ label, state }: { label: string; state: PermissionState }) {
  return <View style={styles.row}>
    <Text style={styles.label}>{label}</Text>
    <Text style={[styles.state, state === 'granted' ? styles.ok : state === 'checking' ? styles.pending : styles.missing]}>{state}</Text>
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 1, borderColor: '#DCE5EC', padding: 16, marginTop: 14 },
  heading: { color: '#30465B', fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  description: { color: '#718091', fontSize: 11, lineHeight: 16, marginTop: 7, marginBottom: 8 },
  row: { minHeight: 34, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#E5EBEF', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  label: { flex: 1, color: '#273747', fontSize: 11 },
  state: { fontSize: 10, textTransform: 'capitalize', fontWeight: '700' },
  ok: { color: '#168365' }, missing: { color: '#A06030' }, pending: { color: '#718091' },
  action: { minHeight: 42, borderRadius: 10, marginTop: 12, backgroundColor: '#173852', alignItems: 'center', justifyContent: 'center' },
  actionText: { color: '#FFFFFF', fontWeight: '700', fontSize: 11 },
  linkButton: { alignItems: 'center', paddingTop: 13, paddingBottom: 2 },
  linkText: { color: '#1F6878', fontWeight: '700', fontSize: 11 },
});
