import 'react-native-url-polyfill/auto';
import 'expo-sqlite/localStorage/install';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabasePublishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
// Expo Router evaluates route modules in a Node.js context while producing the
// Android bundle. Persist sessions in browser storage where it exists, but do
// not dereference the web-only global during server-side route discovery.
const authStorage = typeof localStorage === 'undefined' ? undefined : localStorage;

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
