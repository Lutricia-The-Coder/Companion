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

const C = { bg: theme.background, panel: theme.surface, ink: theme.ink, muted: theme.muted, teal: theme.navy, line: theme.line, red: theme.red };

export default function RegisterScreen() {
  const router = useRouter();
  const { oauth } = useLocalSearchParams<{ oauth?: string }>();
  const oauthRegistration = oauth === '1';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    if (!name.trim() || !email.trim() || (!oauthRegistration && password.length < 8) || enabledPhrases.length === 0 || !contactName.trim() || (!contactPhone.trim() && !contactEmail.trim()) || (emailAlerts && !contactEmail.trim())) {
      Alert.alert('Complete your safety setup', `Enter your name, ${oauthRegistration ? 'at least one enabled SOS phrase' : 'email and an 8-character password'}, and a trusted contact. Email is required for automatic alerts because SMS is not enabled.`);
      return;
    }
    const trustedContact = { name: contactName.trim(), phone: contactPhone.trim(), email: contactEmail.trim().toLowerCase() };
    try {
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
      <TouchableOpacity onPress={() => router.back()}><Text style={s.back}>←  BACK</Text></TouchableOpacity>
      <Text style={s.eyebrow}>CREATE YOUR ACCOUNT</Text>
      <Text style={s.title}>Your safety,{ '\n' }set up your way.</Text>
      <Text style={s.sub}>Choose a private phrase and trusted contact. The native app checks the phrase during an active safety journey when microphone permission and a speech-recognition service are available.</Text>
      {!oauthRegistration && <><TouchableOpacity style={s.googleButton} onPress={registerWithGoogle} disabled={busy} accessibilityRole="button"><Text style={s.googleMark}>G</Text><Text style={s.googleText}>{busy ? 'Connecting to Google…' : 'Continue with Google'}</Text></TouchableOpacity><View style={s.separator}><View style={s.rule} /><Text style={s.or}>OR SIGN UP WITH EMAIL</Text><View style={s.rule} /></View></>}
      <View style={s.card}>
        <Field label="YOUR NAME" value={name} onChangeText={setName} placeholder="Name" />
        {oauthRegistration ? <Text style={s.helper}>Google account: {email || 'loading…'}</Text> : <><Field label="EMAIL ADDRESS" value={email} onChangeText={setEmail} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" /><Field label="PASSWORD" value={password} onChangeText={setPassword} placeholder="At least 8 characters" secureTextEntry /></>}
      </View>
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
      <TouchableOpacity style={s.secondaryButton} onPress={() => router.replace('/login')}><Text style={s.secondaryText}>Already have an account? Sign in</Text></TouchableOpacity>
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

const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: C.bg }, page: { padding: 23, paddingBottom: 40 }, back: { color: C.muted, fontSize: 10, letterSpacing: 1.1, paddingVertical: 8 }, eyebrow: { color: C.teal, letterSpacing: 1.7, fontSize: 10, fontWeight: '800', marginTop: 17 }, title: { color: C.ink, fontSize: 33, lineHeight: 38, fontWeight: '800', marginTop: 15 }, sub: { color: C.muted, fontSize: 13, lineHeight: 20, marginTop: 10, marginBottom: 13 }, googleButton: { minHeight: 50, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11, marginTop: 10 }, googleMark: { color: '#4285F4', fontWeight: '900', fontSize: 17 }, googleText: { color: C.ink, fontSize: 12, fontWeight: '700' }, separator: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 16 }, rule: { height: 1, flex: 1, backgroundColor: C.line }, or: { color: C.muted, fontSize: 9, fontWeight: '700' }, card: { backgroundColor: C.panel, borderRadius: 15, borderWidth: 1, borderColor: C.line, padding: 15, marginTop: 10 }, cardTitle: { color: C.teal, fontSize: 9, fontWeight: '800', letterSpacing: 1.3 }, field: { marginTop: 7 }, label: { color: C.muted, fontSize: 8, letterSpacing: 1.1, fontWeight: '800', marginTop: 7 }, input: { color: C.ink, fontSize: 13, minHeight: 39, borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 8 }, helper: { color: C.muted, lineHeight: 17, fontSize: 10, marginTop: 7 }, switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 }, switchTitle: { color: C.ink, fontSize: 11, fontWeight: '700' }, phraseSetup: { borderTopWidth: 1, borderTopColor: C.line, marginTop: 11, paddingTop: 9 }, phraseSetupHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, removePhrase: { color: C.red, fontSize: 10, fontWeight: '700', padding: 6 }, addPhraseButton: { minHeight: 42, marginTop: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: C.teal }, addPhraseButtonText: { color: C.teal, fontSize: 11, fontWeight: '800' }, permissionButton: { minHeight: 42, marginTop: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: C.teal }, permissionButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '800' }, button: { marginTop: 16, height: 53, borderRadius: 13, backgroundColor: C.teal, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, buttonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 }, arrow: { color: '#FFFFFF', fontSize: 22 }, secondaryButton: { padding: 15, alignItems: 'center' }, secondaryText: { color: C.teal, fontSize: 12, fontWeight: '700' }, setupNote: { color: C.red, fontSize: 10, lineHeight: 15, textAlign: 'center', marginTop: 12 }, privacy: { color: C.muted, textAlign: 'center', fontSize: 10, lineHeight: 15, marginTop: 15 } });
