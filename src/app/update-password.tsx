import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { theme } from '../theme';

export default function UpdatePasswordScreen() {
  const router = useRouter();
  const [sessionReady, setSessionReady] = useState(false);
  const [recoverySession, setRecoverySession] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void supabase?.auth.getSession().then(({ data: { session } }) => {
      if (!active) return;
      setRecoverySession(Boolean(session));
      setSessionReady(true);
    }).catch(() => { if (active) setSessionReady(true); });
    return () => { active = false; };
  }, []);

  const updatePassword = async () => {
    if (!supabase || !recoverySession) {
      Alert.alert('Reset link required', 'Request a fresh password-reset email from the latest app version, then open its secure dashboard link in any browser on any device.');
      return;
    }
    if (password.length < 8) {
      Alert.alert('Password too short', 'Choose a password with at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('Passwords do not match', 'Enter the same new password in both fields.');
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      await supabase.auth.signOut({ scope: 'local' });
      Alert.alert('Password updated', 'Sign in with your new password.');
      router.replace('/login');
    } catch (error) {
      Alert.alert('Could not update password', error instanceof Error ? error.message : 'Open a fresh reset link and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!sessionReady) return <SafeAreaView style={[styles.safe, styles.center]}><ActivityIndicator color={theme.navy} /><Text style={styles.description}>Checking your secure reset link…</Text></SafeAreaView>;

  return <SafeAreaView style={styles.safe}>
    <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <TouchableOpacity onPress={() => router.replace('/login')}><Text style={styles.back}>←  BACK TO SIGN IN</Text></TouchableOpacity>
        <Text style={styles.eyebrow}>ACCOUNT RECOVERY</Text>
        <Text style={styles.title}>Choose a new password.</Text>
        {!recoverySession && <Text style={styles.description}>This older in-app recovery page needs a link issued to this app. Request a fresh link from the latest Companion version; new reset links open in the secure web dashboard on any device.</Text>}
        {recoverySession && <>
          <Text style={styles.label}>NEW PASSWORD</Text>
          <TextInput value={password} onChangeText={setPassword} placeholder="At least 8 characters" secureTextEntry autoCapitalize="none" placeholderTextColor={theme.muted} style={styles.input} accessibilityLabel="New password" />
          <Text style={styles.label}>CONFIRM NEW PASSWORD</Text>
          <TextInput value={confirmPassword} onChangeText={setConfirmPassword} placeholder="Enter it again" secureTextEntry autoCapitalize="none" placeholderTextColor={theme.muted} style={styles.input} accessibilityLabel="Confirm new password" />
          <TouchableOpacity style={[styles.button, busy && styles.disabled]} disabled={busy} onPress={() => void updatePassword()} accessibilityRole="button"><Text style={styles.buttonText}>{busy ? 'Updating…' : 'Update password'}</Text></TouchableOpacity>
        </>}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.background },
  center: { justifyContent: 'center', alignItems: 'center' },
  page: { padding: 23, paddingBottom: 40 },
  back: { color: theme.muted, fontSize: 10, letterSpacing: 1.1, paddingVertical: 8 },
  eyebrow: { color: theme.navy, letterSpacing: 1.7, fontSize: 10, fontWeight: '800', marginTop: 28 },
  title: { color: theme.ink, fontSize: 32, lineHeight: 38, fontWeight: '800', marginTop: 15, marginBottom: 18 },
  description: { color: theme.muted, fontSize: 13, lineHeight: 20, marginTop: 10 },
  label: { color: theme.muted, fontSize: 9, letterSpacing: 1.1, fontWeight: '800', marginTop: 18 },
  input: { backgroundColor: theme.surface, color: theme.ink, fontSize: 14, minHeight: 52, borderRadius: 12, borderWidth: 1, borderColor: theme.line, paddingHorizontal: 14, marginTop: 8 },
  button: { marginTop: 22, height: 53, borderRadius: 13, backgroundColor: theme.navy, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 },
});
