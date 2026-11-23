import 'react-native-url-polyfill/auto';
import 'expo-sqlite/localStorage/install';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { deleteEncryptedItem, getEncryptedItem, setEncryptedItem } from '../services/privateStorage';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabasePublishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
// The native session contains bearer credentials: keep it encrypted by Android
// Keystore/iOS Keychain. Web uses same-origin browser storage. During migration,
// an existing SQLite localStorage session is moved into SecureStore on first read.
const browserStorage = typeof localStorage === 'undefined' ? undefined : localStorage;
const authStorage = Platform.OS === 'web' ? browserStorage : {
  async getItem(key: string) {
    const secureKey = `companion-supabase-${key}`;
    if (await SecureStore.isAvailableAsync()) {
      const secureValue = await getEncryptedItem(secureKey);
      if (secureValue !== null) return secureValue;
      const legacyValue = browserStorage?.getItem(key) ?? null;
      if (legacyValue !== null) {
        await setEncryptedItem(secureKey, legacyValue);
        browserStorage?.removeItem(key);
      }
      return legacyValue;
    }
    throw new Error('Secure session storage is unavailable on this device.');
  },
  async setItem(key: string, value: string) {
    if (!await SecureStore.isAvailableAsync()) throw new Error('Secure session storage is unavailable on this device.');
    await setEncryptedItem(`companion-supabase-${key}`, value);
  },
  async removeItem(key: string) {
    if (await SecureStore.isAvailableAsync()) await deleteEncryptedItem(`companion-supabase-${key}`);
    browserStorage?.removeItem(key);
  },
};

export const supabaseReady = Boolean(supabaseUrl && supabasePublishableKey);
export const supabase: SupabaseClient | null = supabaseReady
  ? createClient(supabaseUrl, supabasePublishableKey, {
    auth: {
      storage: authStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
    realtime: { params: { eventsPerSecond: 10 } },
  })
  : null;

export function requireSupabase() {
  if (!supabase) throw new Error('Supabase is not configured. Add the project URL and publishable key to .env.');
  return supabase;
}

export const supabaseConfig = { url: supabaseUrl, publishableKey: supabasePublishableKey };
