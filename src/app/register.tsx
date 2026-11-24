import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, PermissionsAndroid, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import { Camera } from 'expo-camera';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase, supabaseReady } from '../lib/supabase';
import { saveNotificationPreferences, saveTrustedContacts } from '../services/profile';
import { createTriggerPhrase, saveTriggerPhrases, type TriggerPhrase } from '../services/triggerPhrases';
import { startGoogleOAuth } from '../services/oauth';
import { setPrivateItem } from '../services/privateStorage';
import { theme } from '../theme';

const C = { bg: theme.background, panel: theme.surface, ink: theme.ink, muted: theme.muted, teal: theme.navy, navy: theme.navy, navyDeep: theme.navyDeep, line: theme.line, red: theme.red };

export default function RegisterScreen() {
  const router = useRouter();
  const { oauth } = useLocalSearchParams<{ oauth?: string }>();
  const oauthRegistration = oauth === '1';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [step, setStep] = useState(1);
  const [phrases, setPhrases] = useState<TriggerPhrase[]>([createTriggerPhrase('')]);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [phraseMonitoring, setPhraseMonitoring] = useState(true);
  const [backgroundSoundMonitoring, setBackgroundSoundMonitoring] = useState(true);
  const [motionMonitoring, setMotionMonitoring] = useState(true);
  const [evidenceConsent, setEvidenceConsent] = useState(false);
  const [shareEachJourney, setShareEachJourney] = useState(false);
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [routeAlerts, setRouteAlerts] = useState(true);
  const [permissionSetupStatus, setPermissionSetupStatus] = useState('Permissions are requested only when you enable them or use a feature. You can review them in app settings.');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!oauthRegistration || !supabase) return;
    let mounted = true;
    void supabase.auth.getUser().then(({ data: { user } }) => {
      if (!mounted || !user) return;
      setName(String(user.user_metadata?.display_name ?? user.user_metadata?.full_name ?? user.user_metadata?.name ?? ''));
      setEmail(user.email ?? '');
      setStep(2);
    });
    return () => { mounted = false; };
  }, [oauthRegistration]);

  const updatePhrase = (id: string, patch: Partial<TriggerPhrase>) => {
    setPhrases((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  };

  const addPhrase = () => {
    if (phrases.length < 8) setPhrases((current) => [...current, createTriggerPhrase('', false)]);
  };

  const removePhrase = (id: string) => {
    if (phrases.length > 1) setPhrases((current) => current.filter((item) => item.id !== id));
  };

  const register = async () => {
    const enabledPhrases = phrases.filter((item) => item.enabled && item.phrase.trim().length >= 2);
    if (!name.trim() || !email.trim() || (!oauthRegistration && (password.length < 8 || !/\d/.test(password) || password !== confirmPassword)) || !acceptedTerms || enabledPhrases.length === 0 || !contactName.trim() || (!contactPhone.trim() && !contactEmail.trim()) || (emailAlerts && !contactEmail.trim())) {
      Alert.alert('Complete your safety setup', `Enter your name, ${oauthRegistration ? 'at least one enabled SOS phrase' : 'email, a password with at least 8 characters and a number, and matching passwords'}, agree to the Terms and Privacy Policy, and add a trusted contact. Email is required for automatic alerts because SMS is not enabled.`);
      return;
    }
    const trustedContact = { name: contactName.trim(), phone: contactPhone.trim(), email: contactEmail.trim().toLowerCase() };
    const saveLocalSafetySetup = async () => {
      await saveTriggerPhrases(phrases.map((item) => ({ ...item, phrase: item.phrase.trim() })).filter((item) => item.phrase.length >= 2));
      await setPrivateItem('companion-contacts', JSON.stringify([trustedContact]));
      await AsyncStorage.multiSet([
        ['companion-phrase-monitor-enabled', String(phraseMonitoring)],
        ['companion-background-audio-enabled', String(backgroundSoundMonitoring)],
        ['companion-motion-enabled', String(motionMonitoring)],
        ['companion-evidence-consent', String(evidenceConsent)],
        ['companion-share-journey-default', String(shareEachJourney)],
        ['companion-notification-preferences-pending', JSON.stringify({ email: emailAlerts, route_deviation: routeAlerts })],
      ]);
    };
    if (!supabaseReady || !supabase) {
      Alert.alert('Supabase setup needed', 'Add your Supabase project URL and publishable key to .env before creating an account.');
      return;
    }
    setBusy(true);
    try {
      if (oauthRegistration) {
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) throw userError ?? new Error('Sign in with Google again to finish account setup.');
        const { error: metadataError } = await supabase.auth.updateUser({ data: { display_name: name.trim() } });
        if (metadataError) throw metadataError;
        const { error: profileError } = await supabase.from('profiles').upsert({ id: user.id, email: user.email ?? email.trim().toLowerCase(), display_name: name.trim() }, { onConflict: 'id' });
        if (profileError) throw profileError;
        await saveTrustedContacts(user.id, [trustedContact]);
        await saveNotificationPreferences(user.id, { email: emailAlerts, route_deviation: routeAlerts, push: false });
        await AsyncStorage.removeItem('companion-notification-preferences-pending');
        await saveLocalSafetySetup();
        router.replace('/');
        return;
      }
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
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        Alert.alert(
          'Try signing in',
          'This email may already have a Companion account. If you have signed up before, sign in or reset your password. If this is a new address, check your inbox for a confirmation email.',
          [
            { text: 'Reset password', onPress: () => router.replace('/forgot-password') },
            { text: 'Go to sign in', onPress: () => router.replace('/login') },
          ],
        );
        return;
      }
      await saveLocalSafetySetup();
      if (data.user && data.session) {
        await saveTrustedContacts(data.user.id, [trustedContact]);
        await saveNotificationPreferences(data.user.id, { email: emailAlerts, route_deviation: routeAlerts, push: false });
        await AsyncStorage.removeItem('companion-notification-preferences-pending');
      }
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

  const registerWithGoogle = async () => {
    if (!supabaseReady || !supabase) {
      Alert.alert('Supabase setup needed', 'Add your Supabase URL and publishable key to .env.');
      return;
    }
    setBusy(true);
    try {
      const result = await startGoogleOAuth('register');
      if (result.type === 'cancel' || result.type === 'dismiss') setBusy(false);
      else if (result.type === 'success') router.replace('/register?oauth=1' as never);
    } catch (error) {
      Alert.alert('Google sign-up unavailable', error instanceof Error ? error.message : 'Check that Google is enabled in Supabase Auth settings.');
      setBusy(false);
    }
  };

  const continueToSafetySetup = () => {
    if (!name.trim() || !email.trim() || (!oauthRegistration && (password.length < 8 || !/\d/.test(password)))) {
      Alert.alert('Complete your account details', 'Enter your name, email address, and a password with at least 8 characters, including a number.');
      return;
    }
    if (!oauthRegistration && password !== confirmPassword) {
      Alert.alert('Passwords do not match', 'Check that both password fields are the same.');
      return;
    }
    if (!acceptedTerms) {
      Alert.alert('Agree to continue', 'Please agree to the Terms and Privacy Policy before continuing.');
      return;
    }
    setStep(2);
  };

  const requestSetupPermissions = async () => {
    if (Platform.OS === 'web') {
      setPermissionSetupStatus('Browser preview does not request the native safety permissions. Use a native app build.');
      return;
    }
    const results: string[] = [];
    try {
      const location = await Location.requestForegroundPermissionsAsync();
      results.push(location.granted ? 'foreground location granted' : 'foreground location not granted');
      if (location.granted) {
        const background = await Location.requestBackgroundPermissionsAsync();
        results.push(background.granted ? 'background location granted' : 'background location not granted');
      }
    } catch { results.push('location permission could not be requested'); }
    if (phraseMonitoring) {
      try {
        const { ExpoSpeechRecognitionModule } = await import('expo-speech-recognition');
        const speech = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        results.push(speech.granted ? 'microphone and speech access granted' : 'microphone or speech access not granted');
      } catch { results.push('speech recognition is unavailable in this build'); }
    }
    if (backgroundSoundMonitoring || evidenceConsent) {
      try {
        const audioPermission = await requestRecordingPermissionsAsync();
        results.push(audioPermission.granted ? 'audio recording granted' : 'audio recording not granted');
      } catch { results.push('audio recording permission could not be requested'); }
    }
    if (evidenceConsent) {
      try {
        const camera = await Camera.requestCameraPermissionsAsync();
        results.push(camera.granted ? 'camera granted' : 'camera not granted');
      } catch { results.push('camera permission could not be requested'); }
    } else results.push('camera permission deferred because evidence recording is off');
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
      try {
        const notifications = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS, {
          title: 'Companion safety notifications',
          message: 'Allow Companion to show the ongoing journey monitor and safety check-in notifications.',
          buttonPositive: 'Allow',
          buttonNegative: 'Not now',
        });
        results.push(notifications === PermissionsAndroid.RESULTS.GRANTED ? 'notifications granted' : 'notifications not granted');
      } catch { results.push('notification permission could not be requested'); }
    }
    setPermissionSetupStatus(results.join(' · '));
  };

  return <SafeAreaView style={s.safe}><KeyboardAvoidingView style={s.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
      <TouchableOpacity onPress={() => step === 1 ? router.replace('/login') : setStep(1)}><Text style={s.back}>‹  {step === 1 ? 'BACK TO SIGN IN' : 'BACK'}</Text></TouchableOpacity>
      <View style={s.stepHeader}><Text style={s.stepLabel}>SET UP YOUR SAFETY</Text><Text style={s.stepCount}>{step} OF 2</Text></View>
      <View style={s.progressTrack}><View style={[s.progressSegment, s.progressComplete]} /><View style={[s.progressSegment, step === 2 && s.progressComplete]} /></View>
      <Text style={s.eyebrow}>{step === 1 ? 'YOUR ACCOUNT' : 'YOUR SAFETY SETUP'}</Text>
      <Text style={s.title}>{step === 1 ? 'Create your account' : 'Your discreet safety signal'}</Text>
      <Text style={s.sub}>{step === 1
        ? 'Your details keep your safety circle connected.'
        : 'Choose a private phrase and trusted contact. Monitoring only runs during a safety journey you start.'}</Text>
      {step === 1 && !oauthRegistration && <>
        <TouchableOpacity style={s.googleButton} onPress={registerWithGoogle} disabled={busy} accessibilityRole="button"><Text style={s.googleMark}>G</Text><Text style={s.googleText}>{busy ? 'Connecting to Google…' : 'Continue with Google'}</Text></TouchableOpacity>
        <View style={s.separator}><View style={s.rule} /><Text style={s.or}>OR SIGN UP WITH EMAIL</Text><View style={s.rule} /></View>
      </>}
      {step === 1 && <View style={s.accountCard}>
        <Field label="FULL NAME" value={name} onChangeText={setName} placeholder="Alex Morgan" />
        {oauthRegistration ? <Text style={s.helper}>Google account: {email || 'loading…'}</Text> : <>
          <Field label="EMAIL ADDRESS" value={email} onChangeText={setEmail} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" />
          <Field label="CREATE PASSWORD" value={password} onChangeText={setPassword} placeholder="At least 8 characters" secureTextEntry />
          <Text style={s.passwordHint}>Use at least 8 characters, including a number.</Text>
          <Field label="CONFIRM PASSWORD" value={confirmPassword} onChangeText={setConfirmPassword} placeholder="Enter your password again" secureTextEntry />
        </>}
      </View>}
      {step === 1 && <>
        <TouchableOpacity style={s.termsRow} onPress={() => setAcceptedTerms((accepted) => !accepted)} accessibilityRole="checkbox" accessibilityState={{ checked: acceptedTerms }}>
          <View style={[s.checkbox, acceptedTerms && s.checkboxChecked]}>{acceptedTerms && <Text style={s.checkboxMark}>✓</Text>}</View>
          <Text style={s.termsText}>I agree to the Terms and Privacy Policy.</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.button} onPress={continueToSafetySetup} accessibilityRole="button"><Text style={s.buttonText}>Continue</Text><Text style={s.arrow}>→</Text></TouchableOpacity>
        <TouchableOpacity style={s.secondaryButton} onPress={() => router.replace('/login')}><Text style={s.secondaryText}>Already have an account? Sign in</Text></TouchableOpacity>
      </>}
      {step === 2 && <>
      {oauthRegistration && <TouchableOpacity style={s.termsRow} onPress={() => setAcceptedTerms((accepted) => !accepted)} accessibilityRole="checkbox" accessibilityState={{ checked: acceptedTerms }}>
        <View style={[s.checkbox, acceptedTerms && s.checkboxChecked]}>{acceptedTerms && <Text style={s.checkboxMark}>✓</Text>}</View>
        <Text style={s.termsText}>I agree to the Terms and Privacy Policy.</Text>
      </TouchableOpacity>}
      <View style={s.card}>
        <Text style={s.cardTitle}>MONITORING AND SHARING</Text>
        <Text style={s.helper}>All monitoring is limited to journeys you start. Android background audio and motion require the foreground monitor service and the relevant permissions.</Text>
        <SetupSwitch title="Personal phrase monitoring" detail="Recognize your saved phrase while Companion is open during a journey." value={phraseMonitoring} onChange={setPhraseMonitoring} />
        <SetupSwitch title="Background distress-sound checks" detail="Use the on-device classifier for screams, shouts, cries, whimpers, and wails while the app is backgrounded. Its accuracy has not been validated." value={backgroundSoundMonitoring} onChange={setBackgroundSoundMonitoring} />
        <SetupSwitch title="Fall and motion checks" detail="Use movement sensors during an active safety journey." value={motionMonitoring} onChange={setMotionMonitoring} />
        <SetupSwitch title="Audio and video evidence after SOS" detail="Allow recording attempts after emergency activation. Android may require the app to be open and camera available." value={evidenceConsent} onChange={setEvidenceConsent} />
        <SetupSwitch title="Share each journey with my contact" detail="When enabled, an emailed contact with a Companion account will be granted live dashboard access at journey start." value={shareEachJourney} onChange={setShareEachJourney} />
      </View>
      <View style={s.card}>
        <Text style={s.cardTitle}>EMERGENCY EMAIL PREFERENCES</Text>
        <SetupSwitch title="Emergency email alerts" detail="Automatic delivery requires an email address and a provider-approved sender." value={emailAlerts} onChange={setEmailAlerts} />
        <SetupSwitch title="Route deviation emails" detail="Email the contact after a sustained route deviation." value={routeAlerts} onChange={setRouteAlerts} />
        <Text style={s.helper}>Phone numbers are saved, but SMS delivery is not configured. Location, microphone, notification, and camera permissions are requested when the related feature is first used; review them later in Settings.</Text>
      </View>
      <View style={s.card}>
        <Text style={s.cardTitle}>DEVICE PERMISSIONS</Text>
        <Text style={s.helper}>You can grant location, microphone/speech, camera, and Android notification access now. Denying a permission does not block account creation; only features that need it will be unavailable.</Text>
        <TouchableOpacity style={s.permissionButton} onPress={() => void requestSetupPermissions()}><Text style={s.permissionButtonText}>Set up device permissions</Text></TouchableOpacity>
        <Text style={s.helper}>{permissionSetupStatus}</Text>
      </View>
      <View style={s.card}>
        <Text style={s.cardTitle}>YOUR SOS PHRASE</Text>
        <Text style={s.helper}>Pick short phrases that are memorable and unlikely to come up in ordinary conversation. You can add up to eight.</Text>
        {phrases.map((item, index) => <View key={item.id} style={s.phraseSetup}>
          <View style={s.phraseSetupHeader}><Text style={s.switchTitle}>PHRASE {index + 1}</Text>{phrases.length > 1 && <TouchableOpacity onPress={() => removePhrase(item.id)} accessibilityRole="button"><Text style={s.removePhrase}>Remove</Text></TouchableOpacity>}</View>
          <TextInput value={item.phrase} onChangeText={(value) => updatePhrase(item.id, { phrase: value })} placeholder="e.g. call the blue taxi" placeholderTextColor={C.muted} style={s.input} maxLength={80} autoCapitalize="sentences" />
          <View style={s.switchRow}><View style={{ flex: 1 }}><Text style={s.switchTitle}>Trigger emergency immediately</Text><Text style={s.helper}>When enabled, a recognized exact phrase can alert contacts without waiting for another signal.</Text></View><Switch value={item.independentActivation} onValueChange={(value) => updatePhrase(item.id, { independentActivation: value })} accessibilityLabel={`Allow phrase ${index + 1} to independently activate an emergency`} /></View>
          <View style={s.switchRow}><Text style={[s.switchTitle, { flex: 1 }]}>Enable this phrase</Text><Switch value={item.enabled} onValueChange={(value) => updatePhrase(item.id, { enabled: value })} accessibilityLabel={`Enable phrase ${index + 1}`} /></View>
        </View>)}
        <TouchableOpacity style={s.addPhraseButton} onPress={addPhrase} disabled={phrases.length >= 8}><Text style={s.addPhraseButtonText}>{phrases.length >= 8 ? 'Phrase limit reached' : 'Add another phrase'}</Text></TouchableOpacity>
      </View>
      <View style={s.card}>
        <Text style={s.cardTitle}>FIRST TRUSTED CONTACT</Text>
        <Field label="CONTACT NAME" value={contactName} onChangeText={setContactName} placeholder="Name" />
        <Field label="PHONE NUMBER" value={contactPhone} onChangeText={setContactPhone} placeholder="+27 ..." keyboardType="phone-pad" />
        <Field label={emailAlerts ? 'EMAIL FOR AUTOMATIC ALERTS' : 'EMAIL (OPTIONAL)'} value={contactEmail} onChangeText={setContactEmail} placeholder="contact@example.com" keyboardType="email-address" autoCapitalize="none" />
      </View>
      <TouchableOpacity style={[s.button, busy && { opacity: 0.6 }]} disabled={busy} onPress={register}><Text style={s.buttonText}>{busy ? 'Saving safety setup…' : oauthRegistration ? 'Finish safety setup' : 'Create account'}</Text><Text style={s.arrow}>→</Text></TouchableOpacity>
      </>}
      {!supabaseReady && <Text style={s.setupNote}>Cloud account and emergency sharing activate after Supabase is configured. Your SOS phrase is stored on this device using encrypted storage on Android.</Text>}
      <Text style={s.privacy}>Audio monitoring and location sharing will only run during a safety journey you start.</Text>
    </ScrollView>
  </KeyboardAvoidingView></SafeAreaView>;
}

function Field({ label, value, onChangeText, placeholder, ...props }: { label: string; value: string; onChangeText: (value: string) => void; placeholder: string; keyboardType?: 'default' | 'email-address' | 'phone-pad'; secureTextEntry?: boolean; autoCapitalize?: 'none' | 'sentences' }) {
  return <View style={s.field}><Text style={s.label}>{label}</Text><TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={C.muted} style={s.input} {...props} /></View>;
}

function SetupSwitch({ title, detail, value, onChange }: { title: string; detail: string; value: boolean; onChange: (value: boolean) => void }) {
  return <View style={s.switchRow}><View style={{ flex: 1 }}><Text style={s.switchTitle}>{title}</Text><Text style={s.helper}>{detail}</Text></View><Switch value={value} onValueChange={onChange} accessibilityRole="switch" accessibilityLabel={title} /></View>;
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFFFFF' },
  page: { paddingHorizontal: 23, paddingTop: 14, paddingBottom: 36 },
  back: { color: C.navy, fontSize: 10, letterSpacing: 0.6, fontWeight: '600', paddingVertical: 8 },
  stepHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  stepLabel: { color: C.muted, fontSize: 8, letterSpacing: 0.7, fontWeight: '700' },
  stepCount: { color: C.muted, fontSize: 8, fontWeight: '700' },
  progressTrack: { flexDirection: 'row', gap: 5, marginTop: 11 },
  progressSegment: { height: 2, flex: 1, backgroundColor: C.line },
  progressComplete: { backgroundColor: C.navy },
  eyebrow: { color: C.muted, letterSpacing: 0.8, fontSize: 9, fontWeight: '700', marginTop: 15 },
  title: { color: C.ink, fontSize: 22, lineHeight: 28, fontWeight: '800', marginTop: 10 },
  sub: { color: C.muted, fontSize: 11, lineHeight: 17, marginTop: 8, marginBottom: 10 },
  googleButton: { minHeight: 44, borderRadius: 9, borderWidth: 1, borderColor: '#D5D9DE', backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 8 },
  googleMark: { color: '#4285F4', fontWeight: '900', fontSize: 15 },
  googleText: { color: C.ink, fontSize: 11, fontWeight: '600' },
  separator: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 12 },
  rule: { height: 1, flex: 1, backgroundColor: C.line },
  or: { color: C.muted, fontSize: 8, fontWeight: '700' },
  card: { backgroundColor: '#FFFFFF', borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 13, marginTop: 10 },
  accountCard: { backgroundColor: '#FFFFFF', marginTop: 10 },
  cardTitle: { color: C.ink, fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  field: { marginTop: 9 },
  label: { color: C.ink, fontSize: 9, fontWeight: '600', marginBottom: 6 },
  input: { color: C.ink, fontSize: 12, minHeight: 43, borderWidth: 1, borderColor: '#D5D9DE', borderRadius: 8, backgroundColor: '#FFFFFF', paddingHorizontal: 11, paddingVertical: 8 },
  passwordHint: { color: C.muted, fontSize: 8, marginTop: 5 },
  termsRow: { flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 36, marginTop: 9 },
  checkbox: { width: 16, height: 16, borderRadius: 3, borderWidth: 1, borderColor: C.muted, alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: C.navy, borderColor: C.navy },
  checkboxMark: { color: '#FFFFFF', fontSize: 11, fontWeight: '800', lineHeight: 14 },
  termsText: { color: C.muted, fontSize: 9 },
  helper: { color: C.muted, lineHeight: 16, fontSize: 9, marginTop: 7 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  switchTitle: { color: C.ink, fontSize: 10, fontWeight: '700' },
  phraseSetup: { borderTopWidth: 1, borderTopColor: C.line, marginTop: 11, paddingTop: 9 },
  phraseSetupHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  removePhrase: { color: C.red, fontSize: 10, fontWeight: '700', padding: 6 },
  addPhraseButton: { minHeight: 40, marginTop: 11, alignItems: 'center', justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: C.navy },
  addPhraseButtonText: { color: C.navy, fontSize: 10, fontWeight: '700' },
  permissionButton: { minHeight: 40, marginTop: 11, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: C.navy },
  permissionButtonText: { color: '#FFFFFF', fontSize: 10, fontWeight: '700' },
  button: { marginTop: 14, height: 50, borderRadius: 9, backgroundColor: C.navyDeep, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 12 },
  arrow: { color: '#FFFFFF', fontSize: 20 },
  secondaryButton: { padding: 13, alignItems: 'center' },
  secondaryText: { color: C.navy, fontSize: 10, fontWeight: '600' },
  setupNote: { color: C.red, fontSize: 9, lineHeight: 14, textAlign: 'center', marginTop: 12 },
  privacy: { color: C.muted, textAlign: 'center', fontSize: 9, lineHeight: 14, marginTop: 15 },
});
