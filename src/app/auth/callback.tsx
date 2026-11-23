import { useEffect, useState } from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../../lib/supabase';
import { saveNotificationPreferences, saveTrustedContacts, type NotificationPreferences, type TrustedContact } from '../../services/profile';
import { completeOAuthCallback, consumeOAuthDestination } from '../../services/oauth';
import { getPrivateItem } from '../../services/privateStorage';

export default function AuthCallbackScreen() {
  const router = useRouter();
  const { code, error: authError, error_description: errorDescription, next } = useLocalSearchParams<{
    code?: string;
    error?: string;
    error_description?: string;
    next?: string;
  }>();
  const [message, setMessage] = useState('Finishing secure sign-in…');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const finish = async () => {
      if (authError) {
        await consumeOAuthDestination();
        setFailed(true);
        setMessage(errorDescription || authError);
        return;
      }
      if (!supabase || !code) {
        setFailed(true);
        setMessage('This sign-in link is incomplete. Open it again or request a new one.');
        return;
      }
      await completeOAuthCallback(`${Linking.createURL('auth/callback')}?code=${encodeURIComponent(code)}`);
      if (!active) return;
      const { data: { user } } = await supabase.auth.getUser();
      const pendingDestination = await consumeOAuthDestination();
      const redirectIntentValue = await AsyncStorage.getItem('companion-auth-next-screen');
      await AsyncStorage.removeItem('companion-auth-next-screen');
      let redirectIntent: string | null = null;
      if (redirectIntentValue) {
        try {
          const candidate = JSON.parse(redirectIntentValue) as { destination?: string; createdAt?: number };
          if (candidate.destination === 'update-password' && typeof candidate.createdAt === 'number' && Date.now() - candidate.createdAt < 15 * 60_000) redirectIntent = candidate.destination;
        } catch { /* Ignore malformed or stale local navigation intent. */ }
      }
      const destination = redirectIntent === 'update-password' ? 'update-password' : next === 'register' || next === 'login' ? next : pendingDestination;
      // Only email-confirmation signups may sync pending setup from this device. OAuth
      // accounts must never inherit another account's locally cached contacts/preferences.
      if (!destination) {
        const storedContacts = await getPrivateItem('companion-contacts');
        if (user && storedContacts) {
          try {
            const contacts = JSON.parse(storedContacts) as TrustedContact[];
            if (Array.isArray(contacts)) await saveTrustedContacts(user.id, contacts);
          } catch {
            // Authentication is already confirmed; Settings can retry profile synchronization.
          }
        }
        const storedPreferences = await AsyncStorage.getItem('companion-notification-preferences-pending');
        if (user && storedPreferences) {
          try {
            const preferences = JSON.parse(storedPreferences) as NotificationPreferences;
            if (typeof preferences.email === 'boolean' && typeof preferences.route_deviation === 'boolean') {
              await saveNotificationPreferences(user.id, preferences);
              await AsyncStorage.removeItem('companion-notification-preferences-pending');
            }
          } catch {
            // Keep the local copy so Settings can retry syncing it after confirmation.
          }
        }
      }
      if (destination === 'register') {
        router.replace('/register?oauth=1' as never);
        return;
      }
      if (destination === 'update-password') {
        router.replace('/update-password' as never);
        return;
      }
      if (user && destination === 'login') {
        const { data: profile } = await supabase.from('profiles').select('display_name,trusted_contacts').eq('id', user.id).maybeSingle();
        const hasContact = Array.isArray(profile?.trusted_contacts) && profile.trusted_contacts.length > 0;
        if (!profile?.display_name?.trim() || !hasContact) {
          router.replace('/register?oauth=1' as never);
          return;
        }
      }
      router.replace('/');
      return;
    };
    void finish().catch((error) => {
      if (!active) return;
      setFailed(true);
      setMessage(error instanceof Error ? error.message : 'Sign-in could not be completed. Please try again.');
    });
    return () => { active = false; };
  }, [authError, code, errorDescription, next, router]);

  return <SafeAreaView style={s.page}>
    {!failed && <ActivityIndicator color="#5CE0C0" />}
    <Text style={[s.message, failed && s.error]}>{message}</Text>
    {failed && <TouchableOpacity onPress={() => router.replace('/login')}><Text style={s.link}>Back to sign in</Text></TouchableOpacity>}
  </SafeAreaView>;
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#101C2E', justifyContent: 'center', alignItems: 'center', padding: 28 },
  message: { color: '#F4F7FB', fontSize: 14, lineHeight: 22, textAlign: 'center', marginTop: 14 },
  error: { color: '#FF8B8B' },
  link: { color: '#5CE0C0', fontWeight: '700', fontSize: 13, marginTop: 20 },
});
