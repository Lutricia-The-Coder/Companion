import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
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
        <TouchableOpacity onPress={() => router.replace('/login')} accessibilityRole="link"><Text style={styles.back}>‹  Back to sign in</Text></TouchableOpacity>
        <View style={styles.form}>
          <Text style={styles.eyebrow}>ACCOUNT RECOVERY</Text>
          <Text style={styles.title}>Forgot your password?</Text>
          <Text style={styles.description}>Enter the email address on your Companion account and we’ll send you a secure link to reset your password.</Text>
          <Text style={styles.label}>Email address</Text>
          <TextInput value={email} onChangeText={setEmail} placeholder="alex.morgan@university.edu" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" placeholderTextColor={theme.muted} style={styles.input} accessibilityLabel="Account email address" returnKeyType="send" onSubmitEditing={() => void sendResetLink()} />
          <TouchableOpacity style={[styles.button, busy && styles.disabled]} disabled={busy} onPress={() => void sendResetLink()} accessibilityRole="button"><Text style={styles.buttonText}>{busy ? 'Sending…' : 'Send reset link'}</Text></TouchableOpacity>
          <Text style={styles.privacy}>For account privacy, the confirmation message won’t reveal whether this email is registered.</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFFFFF' },
  page: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 16, paddingBottom: 28 },
  back: { color: theme.navy, fontSize: 11, fontWeight: '600', paddingVertical: 8 },
  form: { flex: 1, justifyContent: 'center', paddingBottom: 48 },
  eyebrow: { color: theme.muted, letterSpacing: 1, fontSize: 9, fontWeight: '700' },
  title: { color: theme.ink, fontSize: 25, lineHeight: 32, fontWeight: '800', marginTop: 13 },
  description: { color: theme.muted, fontSize: 12, lineHeight: 19, marginTop: 10, marginBottom: 26 },
  label: { color: theme.ink, fontSize: 10, fontWeight: '600', marginBottom: 7 },
  input: { backgroundColor: '#FFFFFF', color: theme.ink, fontSize: 12, minHeight: 47, borderRadius: 9, borderWidth: 1, borderColor: '#D5D9DE', paddingHorizontal: 12 },
  button: { marginTop: 20, height: 50, borderRadius: 9, backgroundColor: theme.navyDeep, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 12 },
  privacy: { color: theme.muted, fontSize: 9, lineHeight: 14, textAlign: 'center', marginTop: 16 },
});