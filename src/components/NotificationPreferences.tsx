import { useEffect, useState } from 'react';
import { Alert, Switch, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { saveNotificationPreferences } from '../services/profile';

type Preferences = { email: boolean; route_deviation: boolean };
const DEFAULTS: Preferences = { email: true, route_deviation: true };
const LABELS: [keyof Preferences, string, string][] = [
  ['email', 'Email emergency alerts', 'Attempts email to saved trusted contacts when the backend provider accepts those recipients.'],
  ['route_deviation', 'Route deviation alerts', 'Also attempts email when a sustained route deviation is detected.'],
];

export default function NotificationPreferences() {
  const [preferences, setPreferences] = useState(DEFAULTS);
  const [status, setStatus] = useState('Sign in to sync notification preferences.');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pendingRaw = await AsyncStorage.getItem('companion-notification-preferences-pending');
      let pending: Partial<Preferences> | null = null;
      try { if (pendingRaw) pending = JSON.parse(pendingRaw) as Partial<Preferences>; }
      catch { await AsyncStorage.removeItem('companion-notification-preferences-pending'); }
      if (!supabase) {
        if (pending) setPreferences({ ...DEFAULTS, ...pending });
        return;
      }
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        if (pending) setPreferences({ ...DEFAULTS, ...pending });
        return;
      }
      let pendingSyncFailed = false;
      if (pending && typeof pending.email === 'boolean' && typeof pending.route_deviation === 'boolean') {
        try {
          await saveNotificationPreferences(user.id, pending as Preferences);
          await AsyncStorage.removeItem('companion-notification-preferences-pending');
        } catch { pendingSyncFailed = true; }
      }
      const { data, error } = await supabase.from('profiles').select('notification_preferences').eq('id', user.id).single();
      if (cancelled) return;
      if (error) {
        if (pending) setPreferences({ ...DEFAULTS, ...pending });
        setStatus(pending ? 'Using device-saved preferences; account sync will retry when connected.' : 'Could not load saved preferences.');
        return;
      }
      const stored = (pendingSyncFailed ? pending : data.notification_preferences ?? {}) as Partial<Preferences>;
      setPreferences({ ...DEFAULTS, ...stored });
      setStatus(pendingSyncFailed ? 'Using device-saved preferences; account sync will retry when connected.' : 'Preferences are synced to your account.');
    })();
    return () => { cancelled = true; };
  }, []);

  const update = async (key: keyof Preferences, value: boolean) => {
    if (!supabase || busy) {
      if (!supabase) Alert.alert('Supabase is not configured', 'Notification preferences cannot be saved without an account connection.');
      return;
    }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { Alert.alert('Sign in required', 'Sign in before changing notification preferences.'); return; }
    const next = { ...preferences, [key]: value };
    setPreferences(next);
    setBusy(true);
    try {
      await AsyncStorage.setItem('companion-notification-preferences-pending', JSON.stringify(next));
      await saveNotificationPreferences(user.id, next);
      await AsyncStorage.removeItem('companion-notification-preferences-pending');
      setStatus('Preferences are synced to your account.');
    } catch (error) {
      setStatus('Saved on this device; account sync will retry when connected.');
      Alert.alert('Preference saved on this device', error instanceof Error ? error.message : 'Account sync will retry when connected.');
    } finally {
      setBusy(false);
    }
  };

  return <View style={{ padding: 16, backgroundColor: '#17263B', borderRadius: 15, borderWidth: 1, borderColor: '#2D4058', marginTop: 10 }}>
    <Text style={{ color: '#9BAABD', fontSize: 9, letterSpacing: 1.3, fontWeight: '800', marginBottom: 5 }}>EMAIL NOTIFICATIONS</Text>
    {LABELS.map(([key, label, help]) => <View key={key} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#F4F7FB', fontSize: 12, fontWeight: '600' }}>{label}</Text>
        <Text style={{ color: '#9BAABD', fontSize: 10, lineHeight: 15, marginTop: 3 }}>{help}</Text>
      </View>
      <Switch value={preferences[key]} onValueChange={(value) => void update(key, value)} disabled={busy} accessibilityLabel={label} />
    </View>)}
    <Text style={{ color: '#FFC96B', fontSize: 10, lineHeight: 15, marginTop: 6 }}>Email acceptance is not delivery confirmation. Resend’s unverified test sender can only email the address on that Resend account; other contacts require a verified sender domain.</Text>
    <Text style={{ color: '#9BAABD', fontSize: 10, lineHeight: 15, marginTop: 5 }}>{status}</Text>
  </View>;
}
