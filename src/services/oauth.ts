import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { requireSupabase } from '../lib/supabase';

export type OAuthDestination = 'login' | 'register';
const exchanges = new Map<string, Promise<void>>();
const completedCodes = new Set<string>();
const OAUTH_DESTINATION_KEY = 'companion-oauth-next-screen';

/** Completes the Supabase PKCE callback. Shared by the browser result and Expo Router deep link. */
export async function completeOAuthCallback(url: string) {
  const client = requireSupabase();
  const callback = new URL(url, 'https://companion.invalid');
  const params: Record<string, string> = Object.fromEntries(new URLSearchParams(callback.search));
  new URLSearchParams(callback.hash.replace(/^#/, '')).forEach((value, key) => { params[key] = value; });
  const providerError = params.errorCode || params.error_description || params.error;
  if (providerError) throw new Error(decodeURIComponent(providerError.replaceAll('+', ' ')));

  const code = params.code;
  if (code) {
    if (completedCodes.has(code)) return;
    let exchange = exchanges.get(code);
    if (!exchange) {
      exchange = (async () => {
        const { error } = await client.auth.exchangeCodeForSession(code);
        if (error) throw error;
        completedCodes.add(code);
      })();
      exchanges.set(code, exchange);
    }
    try { await exchange; } finally { exchanges.delete(code); }
    return;
  }

  if (params.access_token && params.refresh_token) {
    const { error } = await client.auth.setSession({ access_token: params.access_token, refresh_token: params.refresh_token });
    if (error) throw error;
    return;
  }
  const { data } = await client.auth.getSession();
  if (!data.session) throw new Error('Google sign-in did not return a usable session. Please try again.');
}

export async function startGoogleOAuth(destination: OAuthDestination) {
  const client = requireSupabase();
  await AsyncStorage.setItem(OAUTH_DESTINATION_KEY, destination);
  const redirectTo = Platform.OS === 'web'
    ? `${window.location.origin}/auth/callback`
    : Linking.createURL('auth/callback');
  try {
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo, skipBrowserRedirect: Platform.OS !== 'web' },
    });
    if (error) throw error;
    if (Platform.OS === 'web') return { type: 'redirect' as const };
    if (!data.url) throw new Error('Supabase did not provide a Google sign-in URL. Check the Google provider settings.');

    const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
    if (result.type === 'success') {
      await completeOAuthCallback(result.url);
      return { type: 'success' as const };
    }
    await AsyncStorage.removeItem(OAUTH_DESTINATION_KEY);
    return { type: result.type as 'cancel' | 'dismiss' };
  } catch (error) {
    await AsyncStorage.removeItem(OAUTH_DESTINATION_KEY);
    throw error;
  }
}

export async function consumeOAuthDestination() {
  const destination = await AsyncStorage.getItem(OAUTH_DESTINATION_KEY);
  await AsyncStorage.removeItem(OAUTH_DESTINATION_KEY);
  return destination === 'register' || destination === 'login' ? destination : null;
}
