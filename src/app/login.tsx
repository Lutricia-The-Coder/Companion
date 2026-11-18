import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { supabase, supabaseReady } from '../lib/supabase';

const C = { bg: '#F7F7F6', panel: '#F0F0EF', ink: '#151515', muted: '#707070', teal: '#D52B37', line: '#E3E3E2' };

export default function LoginScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const login = async () => {
    if (!supabase || !supabaseReady) {
      Alert.alert('Supabase setup needed', 'Add your Supabase URL and publishable key to .env.');
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
      if (error) throw error;
      router.replace('/');
    } catch (error) {
      Alert.alert('Could not sign in', error instanceof Error ? error.message : 'Check your email and password.');
    } finally {
      setBusy(false);
    }
  };
  return <SafeAreaView style={s.safe}><KeyboardAvoidingView style={s.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
    <TouchableOpacity onPress={() => router.back()}><Text style={s.back}>←  BACK</Text></TouchableOpacity>
    <Text style={s.eyebrow}>WELCOME BACK</Text><Text style={s.title}>Sign in to{ '\n' }your safety account.</Text>
    <View style={s.card}><Text style={s.label}>EMAIL ADDRESS</Text><TextInput value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" keyboardType="email-address" placeholderTextColor={C.muted} style={s.input} /><View style={s.divider} /><Text style={s.label}>PASSWORD</Text><TextInput value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry placeholderTextColor={C.muted} style={s.input} /></View>
    <View style={s.assurance}><Text style={s.assuranceTitle}>A safe place to explore.</Text><Text style={s.assuranceBody}>Your account keeps your safety settings and approved contacts together.</Text></View>
    <TouchableOpacity style={s.button} onPress={login} disabled={busy}><Text style={s.buttonText}>{busy ? 'Signing in…' : 'Sign in'}</Text><Text style={s.arrow}>→</Text></TouchableOpacity>
    <TouchableOpacity style={s.link} onPress={() => router.replace('/register')}><Text style={s.linkText}>New to Companion? Create an account</Text></TouchableOpacity>
  </ScrollView></KeyboardAvoidingView></SafeAreaView>;
}

const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: C.bg }, page: { padding: 23, paddingBottom: 40 }, back: { color: C.muted, fontSize: 10, letterSpacing: 1.1, paddingVertical: 8 }, eyebrow: { color: C.teal, letterSpacing: 1.7, fontSize: 10, fontWeight: '800', marginTop: 17 }, title: { color: C.ink, fontSize: 33, lineHeight: 38, fontWeight: '800', marginTop: 15 }, card: { backgroundColor: C.panel, borderRadius: 15, borderWidth: 1, borderColor: C.line, padding: 15, marginTop: 25 }, label: { color: C.muted, fontSize: 8, letterSpacing: 1.1, fontWeight: '800', marginTop: 7 }, input: { color: C.ink, fontSize: 13, minHeight: 43, borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 8 }, divider: { height: 1, backgroundColor: C.line, marginVertical: 10 }, assurance: { backgroundColor: '#151515', padding: 15, borderRadius: 14, marginTop: 18 }, assuranceTitle: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' }, assuranceBody: { color: '#D1D1D1', fontSize: 11, lineHeight: 16, marginTop: 5 }, button: { marginTop: 16, height: 53, borderRadius: 13, backgroundColor: C.teal, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, buttonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 }, arrow: { color: '#FFFFFF', fontSize: 22 }, link: { padding: 15, alignItems: 'center' }, linkText: { color: C.teal, fontWeight: '700', fontSize: 12 } });
