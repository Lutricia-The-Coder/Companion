import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, SafeAreaView, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, supabaseReady } from '../lib/supabase';
import { saveTrustedContacts } from '../services/profile';
import { createTriggerPhrase, saveTriggerPhrases } from '../services/triggerPhrases';

const C = { bg: '#F7F7F6', panel: '#F0F0EF', ink: '#151515', muted: '#707070', teal: '#D52B37', line: '#E3E3E2', red: '#D52B37' };

export default function RegisterScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [independentPhrase, setIndependentPhrase] = useState(true);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const register = async () => {
    if (!name.trim() || !email.trim() || password.length < 8 || phrase.trim().length < 2 || !contactName.trim() || (!contactPhone.trim() && !contactEmail.trim())) {
      Alert.alert('Complete your safety setup', 'Enter your name, email, an 8-character password, a private SOS phrase, and a trusted contact with a phone number or email address.');
      return;
    }
    const trustedContact = { name: contactName.trim(), phone: contactPhone.trim(), email: contactEmail.trim().toLowerCase() };
    try {
      await saveTriggerPhrases([createTriggerPhrase(phrase, independentPhrase)]);
      await AsyncStorage.setItem('companion-contacts', JSON.stringify([trustedContact]));
    } catch (error) {
      Alert.alert('Could not save safety setup', error instanceof Error ? error.message : 'Secure phrase storage is unavailable.');
      return;
    }
    if (!supabaseReady || !supabase) {
      Alert.alert('Supabase setup needed', 'Your phrase and contact are saved locally. Add your Supabase project URL and publishable key to .env to create a synced account.');
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          data: { display_name: name.trim() },
          emailRedirectTo: Platform.OS === 'web'
            ? `${window.location.origin}/auth/callback`
            : Linking.createURL('auth/callback'),
        },
      });
      if (error) throw error;
      if (data.user && data.session) await saveTrustedContacts(data.user.id, [trustedContact]);
      if (data.user && !data.session) {
        Alert.alert('Check your email', 'Confirm your Supabase account, then sign in to continue.');
        router.replace('/login');
        return;
      }
      router.replace('/');
    } catch (error) {
      Alert.alert('Could not create account', error instanceof Error ? error.message : 'Please check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return <SafeAreaView style={s.safe}><KeyboardAvoidingView style={s.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <TouchableOpacity onPress={() => router.back()}><Text style={s.back}>←  BACK</Text></TouchableOpacity>
      <Text style={s.eyebrow}>CREATE YOUR ACCOUNT</Text>
      <Text style={s.title}>Your safety,{ '\n' }set up your way.</Text>
      <Text style={s.sub}>Choose a private phrase and trusted contact. The native app checks the phrase during an active safety journey when microphone permission and a speech-recognition service are available.</Text>
      <View style={s.card}>
        <Field label="YOUR NAME" value={name} onChangeText={setName} placeholder="Name" />
        <Field label="EMAIL ADDRESS" value={email} onChangeText={setEmail} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" />
        <Field label="PASSWORD" value={password} onChangeText={setPassword} placeholder="At least 8 characters" secureTextEntry />
      </View>
      <View style={s.card}>
        <Text style={s.cardTitle}>YOUR SOS PHRASE</Text>
        <Text style={s.helper}>Pick something memorable and unlikely to come up in normal conversation.</Text>
        <TextInput value={phrase} onChangeText={setPhrase} placeholder="e.g. call the blue taxi" placeholderTextColor={C.muted} style={s.input} autoCapitalize="sentences" />
        <View style={s.switchRow}><View style={{ flex: 1 }}><Text style={s.switchTitle}>Trigger emergency immediately</Text><Text style={s.helper}>When enabled, a recognized exact phrase can alert contacts without waiting for another signal.</Text></View><Switch value={independentPhrase} onValueChange={setIndependentPhrase} accessibilityLabel="Allow this phrase to independently activate an emergency" /></View>
      </View>
      <View style={s.card}>
        <Text style={s.cardTitle}>FIRST TRUSTED CONTACT</Text>
        <Field label="CONTACT NAME" value={contactName} onChangeText={setContactName} placeholder="Name" />
        <Field label="PHONE NUMBER" value={contactPhone} onChangeText={setContactPhone} placeholder="+27 ..." keyboardType="phone-pad" />
        <Field label="EMAIL (OPTIONAL)" value={contactEmail} onChangeText={setContactEmail} placeholder="contact@example.com" keyboardType="email-address" autoCapitalize="none" />
      </View>
      <TouchableOpacity style={[s.button, busy && { opacity: 0.6 }]} disabled={busy} onPress={register}><Text style={s.buttonText}>{busy ? 'Creating account…' : 'Create account'}</Text><Text style={s.arrow}>→</Text></TouchableOpacity>
      <TouchableOpacity style={s.secondaryButton} onPress={() => router.replace('/login')}><Text style={s.secondaryText}>Already have an account? Sign in</Text></TouchableOpacity>
      {!supabaseReady && <Text style={s.setupNote}>Cloud account and emergency sharing activate after Supabase is configured. Your SOS phrase is stored on this device using encrypted storage on Android.</Text>}
      <Text style={s.privacy}>Audio monitoring and location sharing will only run during a safety journey you start.</Text>
    </ScrollView>
  </KeyboardAvoidingView></SafeAreaView>;
}

function Field({ label, value, onChangeText, placeholder, ...props }: { label: string; value: string; onChangeText: (value: string) => void; placeholder: string; keyboardType?: 'default' | 'email-address' | 'phone-pad'; secureTextEntry?: boolean; autoCapitalize?: 'none' | 'sentences' }) {
  return <View style={s.field}><Text style={s.label}>{label}</Text><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={C.muted} style={s.input} {...props} /></View>;
}

const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: C.bg }, page: { padding: 23, paddingBottom: 40 }, back: { color: C.muted, fontSize: 10, letterSpacing: 1.1, paddingVertical: 8 }, eyebrow: { color: C.teal, letterSpacing: 1.7, fontSize: 10, fontWeight: '800', marginTop: 17 }, title: { color: C.ink, fontSize: 33, lineHeight: 38, fontWeight: '800', marginTop: 15 }, sub: { color: C.muted, fontSize: 13, lineHeight: 20, marginTop: 10, marginBottom: 13 }, card: { backgroundColor: C.panel, borderRadius: 15, borderWidth: 1, borderColor: C.line, padding: 15, marginTop: 10 }, cardTitle: { color: C.teal, fontSize: 9, fontWeight: '800', letterSpacing: 1.3 }, field: { marginTop: 7 }, label: { color: C.muted, fontSize: 8, letterSpacing: 1.1, fontWeight: '800', marginTop: 7 }, input: { color: C.ink, fontSize: 13, minHeight: 39, borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 8 }, helper: { color: C.muted, lineHeight: 17, fontSize: 10, marginTop: 7 }, switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 }, switchTitle: { color: C.ink, fontSize: 11, fontWeight: '700' }, button: { marginTop: 16, height: 53, borderRadius: 13, backgroundColor: C.teal, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, buttonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 }, arrow: { color: '#FFFFFF', fontSize: 22 }, secondaryButton: { padding: 15, alignItems: 'center' }, secondaryText: { color: C.teal, fontSize: 12, fontWeight: '700' }, setupNote: { color: C.red, fontSize: 10, lineHeight: 15, textAlign: 'center', marginTop: 12 }, privacy: { color: C.muted, textAlign: 'center', fontSize: 10, lineHeight: 15, marginTop: 15 } });
