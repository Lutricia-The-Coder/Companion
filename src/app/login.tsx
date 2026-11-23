import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase, supabaseReady } from '../lib/supabase';
import { startGoogleOAuth } from '../services/oauth';
import { theme } from '../theme';

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

  const loginWithGoogle = async () => {
    if (!supabase || !supabaseReady) {
      Alert.alert('Supabase setup needed', 'Add your Supabase URL and publishable key to .env.');
      return;
    }
    setBusy(true);
    try {
      const result = await startGoogleOAuth('login');
      if (result.type === 'cancel' || result.type === 'dismiss') return;
      if (result.type === 'success') router.replace('/');
    } catch (error) {
      Alert.alert('Google sign-in unavailable', error instanceof Error ? error.message : 'Check that Google is enabled in Supabase Auth settings.');
    } finally {
      setBusy(false);
    }
  };

  return <SafeAreaView style={styles.safe}>
    <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.brandRow}>
          <View style={styles.brandMark}><Text style={styles.brandCheck}>✓</Text></View>
          <Text style={styles.brand}>Companion</Text>
        </View>
        <Text style={styles.tagline}>YOUR EVERYDAY SAFETY COMPANION</Text>

        <View style={styles.form}>
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.description}>Sign in to your safety circle.</Text>

          <Text style={styles.label}>Email address</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="alex.morgan@university.edu"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            placeholderTextColor={theme.muted}
            style={styles.input}
            accessibilityLabel="Email address"
            returnKeyType="next"
          />

          <View style={styles.passwordLabelRow}>
            <Text style={styles.label}>Password</Text>
            <TouchableOpacity onPress={() => router.push('/forgot-password' as never)} accessibilityRole="link">
              <Text style={styles.forgotLink}>Forgot password?</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Enter your password"
            secureTextEntry
            placeholderTextColor={theme.muted}
            style={styles.input}
            accessibilityLabel="Password"
            returnKeyType="go"
            onSubmitEditing={() => void login()}
          />

          <TouchableOpacity style={[styles.primaryButton, busy && styles.disabled]} onPress={() => void login()} disabled={busy} accessibilityRole="button">
            <Text style={styles.primaryButtonText}>{busy ? 'Signing in…' : 'Log in'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => router.push('/register')} accessibilityRole="button">
            <Text style={styles.secondaryButtonText}>Create an account</Text>
          </TouchableOpacity>

          <View style={styles.separator}><View style={styles.rule} /><Text style={styles.or}>OR</Text><View style={styles.rule} /></View>
          <TouchableOpacity style={styles.googleButton} onPress={() => void loginWithGoogle()} disabled={busy} accessibilityRole="button">
            <Text style={styles.googleMark}>G</Text><Text style={styles.googleText}>{busy ? 'Connecting to Google…' : 'Continue with Google'}</Text>
          </TouchableOpacity>
          <Text style={styles.privacy}>Your location is shared only with people you choose.</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFFFFF' },
  page: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 16, paddingBottom: 28 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  brandMark: { width: 23, height: 23, borderRadius: 7, borderWidth: 1.5, borderColor: theme.navy, alignItems: 'center', justifyContent: 'center' },
  brandCheck: { color: theme.navy, fontSize: 14, fontWeight: '700' },
  brand: { color: theme.ink, fontSize: 17, fontWeight: '800', letterSpacing: -0.3 },
  tagline: { color: theme.muted, fontSize: 9, letterSpacing: 0.6, marginTop: 10 },
  form: { flex: 1, justifyContent: 'center', paddingBottom: 12 },
  title: { color: theme.ink, fontSize: 22, lineHeight: 28, fontWeight: '800', marginBottom: 48 },
  description: { color: theme.muted, fontSize: 12, marginBottom: 20 },
  label: { color: theme.ink, fontSize: 10, fontWeight: '600', marginBottom: 7 },
  passwordLabelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 13 },
  forgotLink: { color: theme.navy, fontSize: 10, fontWeight: '700', paddingVertical: 5 },
  input: { minHeight: 47, borderRadius: 9, borderWidth: 1, borderColor: '#D5D9DE', backgroundColor: '#FFFFFF', color: theme.ink, fontSize: 12, paddingHorizontal: 12 },
  primaryButton: { height: 50, borderRadius: 9, backgroundColor: theme.navyDeep, alignItems: 'center', justifyContent: 'center', marginTop: 21 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  secondaryButton: { height: 45, borderRadius: 9, borderWidth: 1, borderColor: '#D5D9DE', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center', marginTop: 9 },
  secondaryButtonText: { color: theme.ink, fontSize: 11, fontWeight: '600' },
  disabled: { opacity: 0.6 },
  separator: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 15 },
  rule: { height: 1, flex: 1, backgroundColor: theme.line },
  or: { color: theme.muted, fontSize: 9, fontWeight: '700' },
  googleButton: { minHeight: 43, borderRadius: 9, borderWidth: 1, borderColor: '#D5D9DE', backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  googleMark: { color: '#4285F4', fontWeight: '900', fontSize: 15 },
  googleText: { color: theme.ink, fontSize: 11, fontWeight: '600' },
  privacy: { color: theme.muted, fontSize: 9, textAlign: 'center', marginTop: 17 },
});