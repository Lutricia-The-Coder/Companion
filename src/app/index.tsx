import { useEffect, useState } from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet, Text } from 'react-native';
import CompanionApp from '../../App';
import { useRouter } from 'expo-router';
import { supabase, supabaseReady } from '../lib/supabase';

export default function JourneyScreen() {
  const router = useRouter();
  const [ready, setReady] = useState(!supabaseReady);
  useEffect(() => {
    if (!supabase) return;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user;
      if (user) setReady(true);
      else router.replace('/register');
    });
    return () => subscription.unsubscribe();
  }, [router]);
  if (!ready) return <SafeAreaView style={s.loading}><ActivityIndicator color="#5CE0C0" /><Text style={s.text}>Checking your account…</Text></SafeAreaView>;
  return <CompanionApp screen="journey" />;
}

const s = StyleSheet.create({ loading: { flex: 1, backgroundColor: '#F7F7F6', justifyContent: 'center', alignItems: 'center' }, text: { color: '#707070', marginTop: 12, fontSize: 12 } });
