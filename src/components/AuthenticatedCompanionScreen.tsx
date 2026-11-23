import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import CompanionApp from '../../App';
import { supabase, supabaseReady } from '../lib/supabase';

export default function AuthenticatedCompanionScreen({ screen }: { screen: 'home' | 'journey' | 'people' | 'settings' | 'history' }) {
  const router = useRouter();
  const [ready, setReady] = useState(!supabaseReady);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    void supabase.auth.getSession().then(({ data: { session } }) => {
      if (!alive) return;
      if (session?.user) setReady(true);
      else router.replace('/login');
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      if (session?.user) setReady(true);
      else router.replace('/login');
    });
    return () => { alive = false; subscription.unsubscribe(); };
  }, [router]);

  if (!ready) return <SafeAreaView style={styles.loading}><ActivityIndicator color="#173852" /><Text style={styles.label}>Checking your account…</Text></SafeAreaView>;
  return <CompanionApp screen={screen} />;
}

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: '#F5F8FA', alignItems: 'center', justifyContent: 'center' },
  label: { color: '#718091', marginTop: 12, fontSize: 12 },
});