import { useEffect, useState } from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../../lib/supabase';
import { saveTrustedContacts, type TrustedContact } from '../../services/profile';

export default function AuthCallbackScreen() {
  const router = useRouter();
  const { code, error: authError, error_description: errorDescription } = useLocalSearchParams<{
    code?: string;
    error?: string;
    error_description?: string;
  }>();
  const [message, setMessage] = useState('Confirming your email…');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const finish = async () => {
      if (authError) {
        setFailed(true);
        setMessage(errorDescription || authError);
        return;
      }
      if (!supabase || !code) {
        setFailed(true);
        setMessage('This confirmation link is incomplete. Open it again or request a new email.');
        return;
      }
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!active) return;
      if (error) {
        setFailed(true);
        setMessage(`Email confirmation failed: ${error.message}`);
        return;
      }
      const { data: { user } } = await supabase.auth.getUser();
      const storedContacts = await AsyncStorage.getItem('companion-contacts');
      if (user && storedContacts) {
        try {
          const contacts = JSON.parse(storedContacts) as TrustedContact[];
          if (Array.isArray(contacts)) await saveTrustedContacts(user.id, contacts);
        } catch {
          // Authentication is already confirmed; the app can sync contacts again from its settings screen.
        }
      }
      router.replace('/');
    };
    void finish();
    return () => { active = false; };
  }, [authError, code, errorDescription, router]);

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
