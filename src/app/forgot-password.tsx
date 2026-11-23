import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase, supabaseReady } from '../lib/supabase';
import { theme } from '../theme';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const sendResetLink = async () => {
    if (!supabase || !supabaseReady) {
      Alert.alert('Supabase setup needed', 'Add your Supabase URL and publishable key to .env.');
      return;
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      Alert.alert('Enter your account email', 'Use the email address you registered with.');
      return;
    }
    setBusy(true);
    try {
      // Recovery must be independent of the device that requested it. Send the
      // email link to the hosted dashboard, which exchanges the recovery code
      // and lets the user choose a password in any browser.
      const dashboardUrl = (process.env.EXPO_PUBLIC_COMPANION_DASHBOARD_URL || 'https://companion-family.pages.dev').replace(/\/+$/, '');
      const redirect = new URL('/', dashboardUrl);
      redirect.searchParams.set('auth_action', 'update-password');
      const redirectTo = redirect.toString();
      const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, { redirectTo });
      if (error) throw error;
      Alert.alert('Check your email', 'If a Companion account exists for this address, Supabase sent a secure password-reset link. Open it in any browser, on any device, to choose a new password.');
    } catch (error) {
      Alert.alert('Could not request a reset', error instanceof Error ? error.message : 'Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return <SafeAreaView style={styles.safe}>
    <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <TouchableOpacity onPress={() => router.replace('/login')}><Text style={styles.back}>←  BACK TO SIGN IN</Text></TouchableOpacity>
        <Text style={styles.eyebrow}>ACCOUNT RECOVERY</Text>
        <Text style={styles.title}>Reset your password.</Text>
        <Text style={styles.description}>We’ll email a secure link to the address on your Companion account. Open it on any phone or computer with a browser to set a new password.</Text>
        <Text style={styles.label}>EMAIL ADDRESS</Text>
        <TextInput value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" placeholderTextColor={theme.muted} style={styles.input} accessibilityLabel="Account email address" />
        <TouchableOpacity style={[styles.button, busy && styles.disabled]} disabled={busy} onPress={() => void sendResetLink()} accessibilityRole="button"><Text style={styles.buttonText}>{busy ? 'Sending…' : 'Send reset link'}</Text></TouchableOpacity>
        <Text style={styles.privacy}>For account privacy, the confirmation message does not reveal whether the email is registered.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.background },
  page: { padding: 23, paddingBottom: 40 },
  back: { color: theme.muted, fontSize: 10, letterSpacing: 1.1, paddingVertical: 8 },
  eyebrow: { color: theme.navy, letterSpacing: 1.7, fontSize: 10, fontWeight: '800', marginTop: 28 },
  title: { color: theme.ink, fontSize: 32, lineHeight: 38, fontWeight: '800', marginTop: 15 },
  description: { color: theme.muted, fontSize: 13, lineHeight: 20, marginTop: 10, marginBottom: 25 },
  label: { color: theme.muted, fontSize: 9, letterSpacing: 1.1, fontWeight: '800', marginTop: 7 },
  input: { backgroundColor: theme.surface, color: theme.ink, fontSize: 14, minHeight: 52, borderRadius: 12, borderWidth: 1, borderColor: theme.line, paddingHorizontal: 14, marginTop: 8 },
  button: { marginTop: 18, height: 53, borderRadius: 13, backgroundColor: theme.navy, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 },
  privacy: { color: theme.muted, fontSize: 10, lineHeight: 15, textAlign: 'center', marginTop: 16 },
});
