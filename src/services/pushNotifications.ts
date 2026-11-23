import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { requireSupabase } from '../lib/supabase';
import { getPrivateItem, removePrivateItem, setPrivateItem } from './privateStorage';

const PUSH_TOKEN_KEY = 'companion-expo-push-token';

function getProjectId() {
  return Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null;
}

export async function registerCurrentPushDevice(options: { requestPermission?: boolean } = {}) {
  if (Platform.OS === 'web') throw new Error('Remote push is available in the Android and iOS apps, not the web preview.');
  const client = requireSupabase();
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) throw new Error('Sign in before enabling push alerts.');
  const projectId = getProjectId();
  if (!projectId) throw new Error('Expo project ID is missing from app configuration.');

  const Notifications = await import('expo-notifications');
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('safety-alerts', {
      name: 'Safety alerts',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#D52B37',
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted' && options.requestPermission !== false) ({ status } = await Notifications.requestPermissionsAsync());
  if (status !== 'granted') throw new Error('Notification permission was not granted.');

  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  if (!/^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/.test(token)) throw new Error('Expo returned an invalid push token.');
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  await setPrivateItem(PUSH_TOKEN_KEY, token);
  const { error } = await client.rpc('register_push_device', {
    p_expo_push_token: token,
    p_platform: platform,
  });
  if (error) {
    await removePrivateItem(PUSH_TOKEN_KEY);
    throw error;
  }
  return token;
}

export async function unregisterCurrentPushDevice() {
  const token = await getPrivateItem(PUSH_TOKEN_KEY);
  if (!token) return false;
  const { data, error } = await requireSupabase().rpc('unregister_push_device', { p_expo_push_token: token });
  if (error) throw error;
  await removePrivateItem(PUSH_TOKEN_KEY);
  return data === true;
}
