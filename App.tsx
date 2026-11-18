import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { DeviceMotion } from 'expo-sensors';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import { ACTIVE_ROUTE_KEY, LAST_LOCATION_KEY, LOCATION_TASK, ROUTE_DEVIATION_COUNT_KEY, ROUTE_DEVIATION_THRESHOLD_KEY, ROUTE_ORIGIN_KEY, SESSION_KEY } from './src/services/backgroundLocation';
import { ACTIVE_JOURNEY_KEY, createJourney, finishJourney } from './src/services/journeys';
import { clearPendingLocationUpload, publishLatestLocation } from './src/services/locationPublishing';
import { supabase, supabaseConfig, supabaseReady } from './src/lib/supabase';
import { rememberJourneyId, saveTrustedContacts } from './src/services/profile';
import { activateEmergency, grantTrustedContactAccess, resolveEmergency as resolveEmergencyEvent } from './src/services/sharing';
import LiveLocationMap from './src/components/LiveLocationMap';
import TriggerPhraseManager from './src/components/TriggerPhraseManager';
import EmergencyHistory from './src/components/EmergencyHistory';
import SpeechMonitor from './src/components/SpeechMonitor';
import EmergencyAudioCapture from './src/components/EmergencyAudioCapture';
import EmergencyVideoCapture from './src/components/EmergencyVideoCapture';
import NotificationPreferences from './src/components/NotificationPreferences';
import { deleteAccount } from './src/services/profile';
import CompanionMonitor from './modules/companion-monitor';
import { loadTriggerPhrases, type TriggerPhrase } from './src/services/triggerPhrases';
import { isLocationStale, isRouteDeviation, parseRouteCoordinates, shouldAcceptLocationUpdate, type Coordinate, type TimestampedLocation } from './src/services/routeSafety';
import { planRoadRoute } from './src/services/roadRoutes';
import { SafetyAgent, reportSafetySignal, setActiveSafetyAgent } from './src/services/safetyAgent';
import { FallDetector } from './src/services/fallDetector';
import {
  Alert,
  AppState,
  KeyboardAvoidingView,
  Linking as NativeLinking,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar as NativeStatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

type Point = { latitude: number; longitude: number; accuracy: number | null; timestamp: number };
type Contact = { name: string; phone: string; email?: string };
const BACKGROUND_LOCATION_EMERGENCY_CADENCE_KEY = 'companion-background-location-emergency-cadence';

async function sendEmergencyStatus(reason = 'Manual SOS') {
  const journeyId = await AsyncStorage.getItem(ACTIVE_JOURNEY_KEY);
  if (!journeyId || !supabaseReady || !supabase) {
    Alert.alert('SOS is not connected', 'Start a signed-in safety journey with Supabase configured. This build cannot contact emergency services directly.');
    return null;
  }
  try {
    const result = await activateEmergency(journeyId, reason);
    let eventId = result.eventId;
    if (!eventId && result.duplicate && supabase) {
      const { data } = await supabase.from('safety_events').select('id')
        .eq('journey_id', journeyId).eq('event_type', 'emergency')
        .order('activated_at', { ascending: false }).limit(1).maybeSingle();
      eventId = data?.id ?? null;
    }
    Alert.alert(
      result.duplicate ? 'Emergency already active' : 'Emergency activated',
      result.duplicate
        ? 'Your existing emergency alert is still active. Trusted contacts are not being sent duplicate alerts.'
        : 'The server recorded your emergency and is attempting to contact your trusted people. Provider acceptance is shown separately from delivery.',
    );
    return { ...result, eventId };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The emergency could not reach the secure backend.';
    Alert.alert('SOS could not sync', `${message}\n\nTry again if you can. This build cannot contact emergency services directly.`);
    return null;
  }
}

async function restoreBackgroundLocationTask(emergency: boolean) {
  if (Platform.OS === 'web') return false;
  try {
    const [foreground, background] = await Promise.all([
      Location.getForegroundPermissionsAsync(),
      Location.getBackgroundPermissionsAsync(),
    ]);
    const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
    if (!foreground.granted || !background.granted) {
      if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
      await AsyncStorage.removeItem(BACKGROUND_LOCATION_EMERGENCY_CADENCE_KEY);
      return false;
    }
    const configuredEmergencyCadence = await AsyncStorage.getItem(BACKGROUND_LOCATION_EMERGENCY_CADENCE_KEY);
    if (started && configuredEmergencyCadence === String(emergency)) return true;
    if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: emergency ? 2_000 : 5_000,
      distanceInterval: emergency ? 1 : 5,
      pausesUpdatesAutomatically: false,
      foregroundService: {
        notificationTitle: emergency ? 'Companion emergency tracking active' : 'Companion safety journey active',
        notificationBody: emergency
          ? 'Your emergency location is being shared with authorized contacts.'
          : 'Your live location is being shared for this journey.',
        killServiceOnDestroy: false,
      },
    });
    await AsyncStorage.setItem(BACKGROUND_LOCATION_EMERGENCY_CADENCE_KEY, String(emergency));
    return true;
  } catch {
    return false;
  }
}

const colors = {
  navy: '#F7F7F6',
  panel: '#F0F0EF',
  panel2: '#E8E8E7',
  ink: '#151515',
  muted: '#707070',
  teal: '#D52B37',
  red: '#D52B37',
  line: '#E3E3E2',
  yellow: '#D52B37',
};

export default function App({ screen = 'journey' }: { screen?: 'journey' | 'people' | 'settings' | 'history' }) {
  const router = useRouter();
  const tab = screen;
  const [active, setActive] = useState(false);
  const [appForeground, setAppForeground] = useState(AppState.currentState === 'active');
  const [emergencyMode, setEmergencyMode] = useState(false);
  const [emergencyEventId, setEmergencyEventId] = useState<string | null>(null);
  const [resolvingEmergency, setResolvingEmergency] = useState(false);
  const [journeyId, setJourneyId] = useState<string | null>(null);
  const [evidenceConsent, setEvidenceConsent] = useState(false);
  const [backgroundAudioAllowed, setBackgroundAudioAllowed] = useState(true);
  const [motionMonitoringAllowed, setMotionMonitoringAllowed] = useState(true);
  const [phraseMonitoringAllowed, setPhraseMonitoringAllowed] = useState(true);
  const [shareEachJourney, setShareEachJourney] = useState(false);
  const [evidenceStatus, setEvidenceStatus] = useState('Audio evidence is off');
  const [trigger, setTrigger] = useState('');
  const [triggerPhrases, setTriggerPhrases] = useState<TriggerPhrase[]>([]);
  const [voiceStatus, setVoiceStatus] = useState('Voice monitoring is paused');
  const [pendingCheckIn, setPendingCheckIn] = useState<{ reason: string; deadline: number } | null>(null);
  const [checkInSeconds, setCheckInSeconds] = useState(0);
  const [nativeMonitorStatus, setNativeMonitorStatus] = useState('');
  const [notificationPermissionStatus, setNotificationPermissionStatus] = useState('');
  const [speechRetryToken, setSpeechRetryToken] = useState(0);
  const [destination, setDestination] = useState('');
  const [routeWaypoints, setRouteWaypoints] = useState<Coordinate[]>([]);
  const [routeWaypointText, setRouteWaypointText] = useState('');
  const [routeStatus, setRouteStatus] = useState('No route check configured');
  const [routeDeviationThreshold, setRouteDeviationThreshold] = useState(100);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [point, setPoint] = useState<Point | null>(null);
  const lastAcceptedLocationRef = useRef<TimestampedLocation | null>(null);
  const [trail, setTrail] = useState<Point[]>([]);
  const [locationLabel, setLocationLabel] = useState('Location not shared');
  const [clock, setClock] = useState(0);
  const safetyAgentRef = useRef<SafetyAgent | null>(null);
  const fallDetectorRef = useRef(new FallDetector());
  const routeDeviationCountRef = useRef(0);
  const lastRouteSignalAtRef = useRef(0);
  const activeRouteRef = useRef<Coordinate[]>([]);
  const routeOriginRef = useRef<Coordinate | null>(null);
  const setPrimaryPhrase = useCallback((phrase: string) => setTrigger(phrase), []);
  useEffect(() => {
    const refresh = () => setClock(Date.now());
    const initial = setTimeout(refresh, 0);
    const timer = setInterval(refresh, 10_000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!pendingCheckIn) {
      setCheckInSeconds(0);
      return;
    }
    const refresh = () => {
      const remaining = Math.max(0, Math.ceil((pendingCheckIn.deadline - Date.now()) / 1000));
      setCheckInSeconds(remaining);
    };
    refresh();
    const timer = setInterval(refresh, 1_000);
    return () => clearInterval(timer);
  }, [pendingCheckIn]);

  useEffect(() => {
    if (!journeyId || !supabaseReady || !supabase) return;
    const client = supabase;
    let cancelled = false;
    const restoreEmergencyState = async () => {
      try {
        const { data: journey } = await client.from('journeys').select('emergency').eq('id', journeyId).maybeSingle();
        if (cancelled || !journey?.emergency) return;
        const { data: event } = await client.from('safety_events').select('id').eq('journey_id', journeyId)
          .eq('event_type', 'emergency').neq('status', 'resolved')
          .order('activated_at', { ascending: false }).limit(1).maybeSingle();
        if (cancelled) return;
        setEmergencyMode(true);
        if (event?.id) {
          setEmergencyEventId(event.id);
          await AsyncStorage.setItem('companion-emergency-event-id', event.id);
        }
      } catch { /* Keep local emergency mode and location state when the backend is unreachable. */ }
    };
    void restoreEmergencyState();
    return () => { cancelled = true; };
  }, [journeyId]);

  useEffect(() => {
    if (!emergencyMode || emergencyEventId || !journeyId || !supabase) return;
    const client = supabase;
    let cancelled = false;
    const findEmergency = async () => {
      try {
        const { data } = await client.from('safety_events').select('id').eq('journey_id', journeyId)
          .eq('event_type', 'emergency').neq('status', 'resolved')
          .order('activated_at', { ascending: false }).limit(1).maybeSingle();
        if (!cancelled && data?.id) {
          setEmergencyEventId(data.id);
          await AsyncStorage.setItem('companion-emergency-event-id', data.id);
        }
      } catch { /* The next retry will check again after connectivity returns. */ }
    };
    void findEmergency();
    const timer = setInterval(() => { void findEmergency(); }, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [emergencyMode, emergencyEventId, journeyId]);
  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.multiGet([
        SESSION_KEY,
        ACTIVE_JOURNEY_KEY,
        LAST_LOCATION_KEY,
        'companion-contacts',
        'companion-destination',
        'companion-route-waypoints',
        'companion-evidence-consent',
        'companion-background-audio-enabled',
        'companion-motion-enabled',
        'companion-phrase-monitor-enabled',
        'companion-share-journey-default',
        ROUTE_DEVIATION_THRESHOLD_KEY,
        'companion-emergency-event-id',
      ]);
      const values = Object.fromEntries(saved);
      if (values[ACTIVE_JOURNEY_KEY]) setJourneyId(values[ACTIVE_JOURNEY_KEY]!);
      if (values['companion-destination']) setDestination(values['companion-destination']!);
      if (values['companion-evidence-consent'] === 'true') setEvidenceConsent(true);
      if (values['companion-background-audio-enabled'] === 'false') setBackgroundAudioAllowed(false);
      if (values['companion-motion-enabled'] === 'false') setMotionMonitoringAllowed(false);
      if (values['companion-phrase-monitor-enabled'] === 'false') setPhraseMonitoringAllowed(false);
      if (values['companion-share-journey-default'] === 'true') setShareEachJourney(true);
      const savedThreshold = Number(values[ROUTE_DEVIATION_THRESHOLD_KEY]);
      if (Number.isFinite(savedThreshold) && savedThreshold >= 50 && savedThreshold <= 500) setRouteDeviationThreshold(savedThreshold);
      if (values['companion-emergency-event-id']) {
        setEmergencyEventId(values['companion-emergency-event-id']!);
        setEmergencyMode(true);
      }
      if (values['companion-route-waypoints']) {
        try {
          const parsed = parseRouteCoordinates(JSON.parse(values['companion-route-waypoints']!));
          setRouteWaypoints(parsed);
          setRouteWaypointText(parsed.map(({ latitude, longitude }) => `${latitude}, ${longitude}`).join('; '));
        } catch { setRouteWaypoints([]); }
      }
      if (values['companion-contacts']) setContacts(JSON.parse(values['companion-contacts']!));
      if (values[LAST_LOCATION_KEY]) {
        const savedPoint = JSON.parse(values[LAST_LOCATION_KEY]!) as Point;
        setPoint(savedPoint);
        if (typeof savedPoint.accuracy === 'number') lastAcceptedLocationRef.current = { ...savedPoint, accuracy: savedPoint.accuracy };
      }
      const configuredPhrases = await loadTriggerPhrases();
      setTrigger(configuredPhrases.phrases[0]?.phrase ?? '');
      setTriggerPhrases(configuredPhrases.phrases);
      // Keep an active journey alive when Expo Router remounts this screen during tab navigation.
      if (values[SESSION_KEY] === 'true') {
        const emergency = !!values['companion-emergency-event-id'];
        setActive(true);
        const restored = await restoreBackgroundLocationTask(emergency);
        setLocationLabel(restored
          ? emergency
            ? 'Emergency journey restored; background location updates are active.'
            : 'Journey restored; background location updates are active.'
          : 'Journey restored while Companion is open; background location needs permission or could not restart.');
      }
    })();
  }, []);

  useEffect(() => {
    if (!active || !motionMonitoringAllowed) return;
    let subscription: ReturnType<typeof DeviceMotion.addListener> | undefined;
    let cancelled = false;
    (async () => {
      try {
        if (!await DeviceMotion.isAvailableAsync()) {
          if (!cancelled) setVoiceStatus('Motion sensor is unavailable on this device');
          return;
        }
        DeviceMotion.setUpdateInterval(100);
        subscription = DeviceMotion.addListener((measurement) => {
          const fall = fallDetectorRef.current.observe({ ...measurement.accelerationIncludingGravity, timestamp: Date.now() });
          if (fall) reportSafetySignal({ kind: 'fall', ...fall });
        });
      } catch {
        if (!cancelled) setVoiceStatus('Motion monitoring could not start');
      }
    })();
    return () => { cancelled = true; subscription?.remove(); };
  }, [active, motionMonitoringAllowed]);

  useEffect(() => {
    if (!active) return;
    let subscription: Location.LocationSubscription | undefined;
    let cancelled = false;
    (async () => {
      try {
      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: emergencyMode ? 2000 : 5000, distanceInterval: emergencyMode ? 1 : 5 },
        (location) => {
          const next = {
            latitude: location.coords.latitude,
            longitude: location.coords.longitude,
            accuracy: location.coords.accuracy,
            timestamp: location.timestamp,
          };
          if (next.accuracy === null || !shouldAcceptLocationUpdate(
            { ...next, accuracy: next.accuracy },
            lastAcceptedLocationRef.current,
            { maxAccuracyMeters: 100, maxAgeMs: 30_000, now: Date.now() },
          )) {
            setLocationLabel(next.accuracy === null || next.accuracy > 100
              ? 'GPS accuracy is poor; keeping the last accepted location.'
              : 'GPS fix is stale; keeping the last accepted location.');
            return;
          }
          lastAcceptedLocationRef.current = { ...next, accuracy: next.accuracy };
          setPoint(next);
          setTrail((current) => {
            const previous = current[current.length - 1];
            if (previous && Math.abs(previous.latitude - next.latitude) < 0.00001 && Math.abs(previous.longitude - next.longitude) < 0.00001) return current;
            return [...current, next].slice(-250);
          });
          setLocationLabel('Location is updating on this device');
          AsyncStorage.setItem(LAST_LOCATION_KEY, JSON.stringify(next));
          AsyncStorage.getItem(ACTIVE_JOURNEY_KEY).then((journeyId) => {
            if (journeyId) {
              void publishLatestLocation(journeyId, next).then((synced) => {
                if (!cancelled) setLocationLabel(synced
                  ? 'Live location synced to your shared journey'
                  : 'Location is saved on this device; waiting for a connection to sync the newest fix.');
              });
            }
          });
          if (activeRouteRef.current.length > 0) {
            routeOriginRef.current ??= { latitude: next.latitude, longitude: next.longitude };
            const route = [routeOriginRef.current, ...activeRouteRef.current];
            const deviation = isRouteDeviation(next, route, { accuracyMeters: location.coords.accuracy ?? 0, thresholdMeters: routeDeviationThreshold });
            if (deviation.deviated) routeDeviationCountRef.current += 1;
            else routeDeviationCountRef.current = 0;
            setRouteStatus(deviation.deviated ? `Off route · ${Math.round(deviation.distanceMeters)} m away` : `On route · ${Math.round(deviation.distanceMeters)} m from path`);
            if (routeDeviationCountRef.current >= 3 && Date.now() - lastRouteSignalAtRef.current > 60_000) {
              lastRouteSignalAtRef.current = Date.now();
              routeDeviationCountRef.current = 0;
              reportSafetySignal({ kind: 'route_deviation', confidence: 0.9, timestamp: Date.now(), signalId: `route-${Date.now()}` });
            }
          }
        },
      );
      } catch (error) {
        if (!cancelled) setLocationLabel(`Could not read GPS: ${error instanceof Error ? error.message : 'check location settings'}`);
      }
    })();
    return () => { cancelled = true; subscription?.remove(); };
  }, [active, emergencyMode, routeDeviationThreshold]);

  const saveSetup = async () => {
    let parsedWaypoints: Coordinate[];
    try { parsedWaypoints = parseRouteCoordinates(routeWaypointText); }
    catch (error) {
      Alert.alert('Route points not saved', error instanceof Error ? error.message : 'Check the latitude and longitude values.');
      return;
    }
    setRouteWaypoints(parsedWaypoints);
    await AsyncStorage.multiSet([
      ['companion-contacts', JSON.stringify(contacts)],
      ['companion-destination', destination.trim()],
      ['companion-route-waypoints', JSON.stringify(parsedWaypoints)],
    ]);
    const { data: { session } } = supabase ? await supabase.auth.getSession() : { data: { session: null } };
    const user = session?.user ?? null;
    if (user) {
      try { await saveTrustedContacts(user.id, contacts); }
      catch { Alert.alert('Saved on this device', 'Contact changes are local for now. Account sync could not connect.'); return; }
    }
    Alert.alert('Saved', 'Your safety setup is saved.');
  };

  const startJourney = async () => {
    let plannedRoute: Coordinate[];
    try { plannedRoute = parseRouteCoordinates(routeWaypointText); }
    catch (error) { Alert.alert('Route points are invalid', error instanceof Error ? error.message : 'Check the coordinates.'); return; }
    if (destination.trim() && plannedRoute.length === 0 && Platform.OS !== 'web') {
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status !== 'granted') {
          Alert.alert('Location permission needed', 'Allow location access to plan road directions from your current position.');
          return;
        }
        const origin = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        plannedRoute = await planRoadRoute(
          { latitude: origin.coords.latitude, longitude: origin.coords.longitude },
          destination,
        );
        setRouteWaypoints(plannedRoute);
        Alert.alert('Road route ready', `${plannedRoute.length} road points will be used to monitor this journey.`);
      } catch (error) {
        Alert.alert('Road route unavailable', error instanceof Error ? error.message : 'Check your destination and connection.');
        return;
      }
    }
    setRouteWaypoints(plannedRoute);
    await AsyncStorage.setItem('companion-route-waypoints', JSON.stringify(plannedRoute));
    await AsyncStorage.multiSet([
      [ACTIVE_ROUTE_KEY, JSON.stringify(plannedRoute)],
      [ROUTE_DEVIATION_COUNT_KEY, '0'],
    ]);
    await AsyncStorage.removeItem(ROUTE_ORIGIN_KEY);
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
      try {
        const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS, {
          title: 'Companion safety notifications',
          message: 'Allow the ongoing journey monitor and safety check-in notifications to stay visible.',
          buttonPositive: 'Allow',
          buttonNegative: 'Not now',
        });
        setNotificationPermissionStatus(permission === PermissionsAndroid.RESULTS.GRANTED
          ? 'Safety notifications are allowed.'
          : 'Safety notifications are disabled. The operating system may hide monitor and check-in notifications.');
      } catch {
        setNotificationPermissionStatus('Notification permission could not be checked; review Companion permissions in Android Settings.');
      }
    }
    if (Platform.OS === 'web') {
      setVoiceStatus('Voice monitoring requires the installed iOS or Android app; this Safari preview only shows the interface');
    } else if (phraseMonitoringAllowed) {
      try {
        // Load the native-only module only on device so Expo Web can render the shared screens.
        const { ExpoSpeechRecognitionModule } = await import('expo-speech-recognition');
        const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!permission.granted) setVoiceStatus('Microphone or speech permission denied; voice monitoring will not run');
      } catch {
        setVoiceStatus('Native speech recognition is unavailable on this device');
      }
    } else if (backgroundAudioAllowed) {
      try {
        const permission = await requestRecordingPermissionsAsync();
        if (!permission.granted) setVoiceStatus('Microphone permission denied; background distress-sound monitoring will not run');
      } catch {
        setVoiceStatus('Microphone permission could not be checked; background sound monitoring may not run');
      }
    }
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (foreground.status !== 'granted') {
      Alert.alert('Location permission needed', 'Allow location access to start a live safety journey.');
      return;
    }
    let backgroundGranted = false;
    if (Platform.OS !== 'web') {
      try { backgroundGranted = (await Location.requestBackgroundPermissionsAsync()).status === 'granted'; }
      catch { backgroundGranted = false; }
    }
    try {
      let journeyId: string | null = null;
      const { data: { session } } = supabase ? await supabase.auth.getSession() : { data: { session: null } };
      const signedInUser = session?.user ?? null;
      if (signedInUser) {
        try {
          journeyId = await createJourney(signedInUser.id, destination, plannedRoute);
          if (journeyId) {
            await AsyncStorage.setItem(ACTIVE_JOURNEY_KEY, journeyId);
            setJourneyId(journeyId);
            try { await rememberJourneyId(signedInUser.id, journeyId); }
            catch { Alert.alert('Journey history is limited', 'This journey is active and sharing location, but could not be added to your account history.'); }
            if (shareEachJourney) {
              const emails = [...new Set(contacts.map((contact) => contact.email?.trim().toLowerCase()).filter((value): value is string => !!value))];
              const shares = await Promise.allSettled(emails.map((contactEmail) => grantTrustedContactAccess(journeyId!, contactEmail)));
              const granted = shares.filter((result) => result.status === 'fulfilled').length;
              if (granted < emails.length || emails.length === 0) {
                Alert.alert('Journey sharing needs attention', emails.length === 0
                  ? 'No trusted contacts with email addresses are saved. Your journey is active, but it is not shared with a dashboard contact.'
                  : `${granted} of ${emails.length} contacts received dashboard access. The others must have a Companion account and be saved as trusted contacts.`);
              }
            }
          }
        } catch {
          Alert.alert('Sharing is unavailable', 'The safety session can start on this phone, but account location sharing could not connect.');
        }
      }
      let backgroundRunning = false;
      if (backgroundGranted && Platform.OS !== 'web') {
        backgroundRunning = await restoreBackgroundLocationTask(false);
      }
      await AsyncStorage.setItem(SESSION_KEY, 'true');
      setEmergencyMode(false);
      setEmergencyEventId(null);
      await AsyncStorage.removeItem('companion-emergency-event-id');
      routeOriginRef.current = null;
      activeRouteRef.current = [...plannedRoute];
      routeDeviationCountRef.current = 0;
      setRouteStatus(plannedRoute.length > 0 ? 'Checking route after GPS fix' : 'No route points saved');
      createJourneySafetyAgent();
      setLocationLabel(journeyId
        ? 'Live location updates are reaching your account'
        : backgroundRunning
          ? 'Live GPS is on; this device is not connected to contact sharing'
          : 'Live GPS is on while Companion is open; background access was not granted');
      setActive(true);
      setTrail([]);
    } catch (error) {
      Alert.alert('Could not start journey', String(error));
    }
  };

  const stopJourney = async () => {
    if (emergencyMode) {
      Alert.alert('Resolve the emergency first', 'Companion keeps the active journey running until you confirm the emergency is resolved.');
      return false;
    }
    setActiveSafetyAgent(null);
    safetyAgentRef.current = null;
    if (Platform.OS === 'android') await CompanionMonitor?.stopMonitoring().catch(() => undefined);
    if (Platform.OS !== 'web' && await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    }
    await AsyncStorage.removeItem(BACKGROUND_LOCATION_EMERGENCY_CADENCE_KEY);
    await AsyncStorage.setItem(SESSION_KEY, 'false');
    setEmergencyMode(false);
    setEmergencyEventId(null);
    await AsyncStorage.removeItem('companion-emergency-event-id');
    const journeyId = await AsyncStorage.getItem(ACTIVE_JOURNEY_KEY);
    if (journeyId) {
      try { await finishJourney(journeyId); } catch { /* Keep local stop available while offline. */ }
      await AsyncStorage.removeItem(ACTIVE_JOURNEY_KEY);
      await clearPendingLocationUpload(journeyId);
    }
    setJourneyId(null);
    setActive(false);
    activeRouteRef.current = [];
    await AsyncStorage.multiRemove([ACTIVE_ROUTE_KEY, ROUTE_ORIGIN_KEY, ROUTE_DEVIATION_COUNT_KEY]);
    routeOriginRef.current = null;
    setLocationLabel(point ? 'Last location saved on this device' : 'Location not shared');
    return true;
  };

  const resolveCurrentEmergency = async () => {
    if (!journeyId || !emergencyEventId || resolvingEmergency) return;
    setResolvingEmergency(true);
    try {
      await resolveEmergencyEvent(journeyId, emergencyEventId);
      if (Platform.OS === 'android') await CompanionMonitor?.resolveEmergency().catch(() => undefined);
      await AsyncStorage.removeItem('companion-emergency-event-id');
      setEmergencyEventId(null);
      setEmergencyMode(false);
      void restoreBackgroundLocationTask(false);
      Alert.alert('Emergency resolved', 'The event is marked resolved, your live journey is still active, and monitoring has resumed.');
    } catch (error) {
      Alert.alert('Could not resolve emergency', error instanceof Error ? error.message : 'Reconnect and try again.');
    } finally { setResolvingEmergency(false); }
  };

  const escalateBackgroundLocation = useCallback(async () => {
    if (!await restoreBackgroundLocationTask(true)) {
      setLocationLabel('Emergency is active; Android may limit background GPS update frequency');
    }
  }, []);

  const requestEmergency = useCallback(async (reason: string) => {
    setEmergencyMode(true);
    void escalateBackgroundLocation();
    if (Platform.OS === 'android' && CompanionMonitor && journeyId) {
      void CompanionMonitor.triggerEmergency(reason).catch(() => undefined);
    }
    const result = await sendEmergencyStatus(reason);
    if (result?.eventId) {
      setEmergencyEventId(result.eventId);
      await AsyncStorage.setItem('companion-emergency-event-id', result.eventId);
    }
  }, [escalateBackgroundLocation, journeyId]);

  const createJourneySafetyAgent = useCallback(() => {
    const agent = new SafetyAgent((action, reason, deadline) => {
      if (action === 'prompt_user') {
        setPendingCheckIn({ reason: reason || 'A possible distress signal was detected.', deadline: deadline ?? Date.now() + 12_000 });
      } else if (action === 'send_emergency') {
        setPendingCheckIn(null);
        void requestEmergency(reason || 'Automatic distress detection');
      }
    });
    safetyAgentRef.current = agent;
    setActiveSafetyAgent(agent);
  }, [requestEmergency]);

  useEffect(() => {
    if (active && !safetyAgentRef.current) createJourneySafetyAgent();
  }, [active, createJourneySafetyAgent]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const foreground = state === 'active';
      setAppForeground(foreground);
      if (Platform.OS === 'android' && active && CompanionMonitor) {
        void CompanionMonitor.setBackgroundAudioEnabled(!foreground && backgroundAudioAllowed && !emergencyMode).catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, [active, backgroundAudioAllowed, emergencyMode]);

  useEffect(() => {
    if (!active || !journeyId || Platform.OS !== 'android' || !CompanionMonitor) return;
    let cancelled = false;
    const signalSubscription = CompanionMonitor.addListener('onDistressSignal', (signal) => {
      reportSafetySignal(signal);
    });
    const safeSubscription = CompanionMonitor.addListener('onCheckInResolved', () => {
      safetyAgentRef.current?.cancelPendingAlert();
      setPendingCheckIn(null);
    });
    (async () => {
      let startupError: unknown = null;
      try {
        const { data: { session } } = supabase ? await supabase.auth.getSession() : { data: { session: null } };
        if (cancelled) return;
        await CompanionMonitor.startMonitoring({
          journeyId,
          supabaseUrl: supabaseConfig.url,
          publishableKey: supabaseConfig.publishableKey,
          accessToken: session?.access_token ?? '',
          refreshToken: session?.refresh_token ?? '',
          motionEnabled: motionMonitoringAllowed,
          audioEnabled: AppState.currentState !== 'active' && backgroundAudioAllowed,
        });
      } catch (error) {
        startupError = error;
      }
      if (cancelled) return;
      try {
        if (AppState.currentState === 'active' || !backgroundAudioAllowed) await CompanionMonitor.setBackgroundAudioEnabled(false);
      } catch (error) {
        startupError ??= error;
      }
      try {
        const status = await CompanionMonitor.getStatus();
        if (cancelled) return;
        if (status.running) {
          const audioEnabled = status.audioMonitoring ?? (AppState.currentState !== 'active' && backgroundAudioAllowed);
          const motionEnabled = status.motionMonitoring ?? motionMonitoringAllowed;
          setNativeMonitorStatus(audioEnabled && motionEnabled
            ? 'Android background sound and motion monitoring are running.'
            : audioEnabled
              ? 'Android background sound monitoring is running; motion checks are disabled.'
              : motionEnabled
                ? 'Android motion checks are running. Background sound monitoring pauses while Companion is open.'
                : 'Android monitoring service is running; sound and motion checks are disabled.');
        } else {
          setNativeMonitorStatus(startupError
            ? `Android monitor is not running: ${startupError instanceof Error ? startupError.message : 'start failed'}`
            : status.status || 'Android monitor is not running.');
        }
      } catch (error) {
        if (!cancelled) setNativeMonitorStatus(startupError || error
          ? `Android monitor status could not be verified: ${startupError instanceof Error ? startupError.message : error instanceof Error ? error.message : 'unknown error'}`
          : 'Android monitor status could not be verified.');
      }
    })();
    return () => {
      cancelled = true;
      signalSubscription.remove();
      safeSubscription.remove();
    };
  }, [active, journeyId, backgroundAudioAllowed, motionMonitoringAllowed]);

  const onTriggerPhrase = useCallback((phrase: TriggerPhrase, confidence: number | null) => {
    setVoiceStatus(confidence !== null && confidence < 0.65
      ? `Possible SOS phrase heard at ${Math.round(confidence * 100)}% confidence; the current threshold is 65%. No action was taken.`
      : confidence === null
        ? phrase.independentActivation
          ? 'Exact saved SOS phrase transcribed. Android provided no confidence score; the configured phrase is activating the emergency protocol.'
          : 'Exact saved SOS phrase transcribed without a confidence score. Answer the safety check now to avoid escalation.'
        : phrase.independentActivation
          ? 'SOS phrase recognized. Activating the emergency protocol.'
          : 'SOS phrase recognized. Answer the safety check now to avoid escalation.');
    reportSafetySignal({
      kind: 'private_phrase',
      confidence: confidence ?? 0,
      confidenceAvailable: confidence !== null,
      timestamp: Date.now(),
      signalId: `phrase-${phrase.id}-${Date.now()}`,
      exactPhraseMatch: true,
      independentActivation: phrase.independentActivation,
    });
  }, []);

  const confirmSafeFromCheckIn = () => {
    safetyAgentRef.current?.cancelPendingAlert();
    setPendingCheckIn(null);
    if (Platform.OS === 'android' && CompanionMonitor) void CompanionMonitor.confirmSafe().catch(() => undefined);
  };

  const requestHelpFromCheckIn = () => {
    const reason = pendingCheckIn?.reason || 'Safety check requested help';
    safetyAgentRef.current?.cancelPendingAlert();
    setPendingCheckIn(null);
    void requestEmergency(reason);
  };

  const triggerEmergency = () => {
    void requestEmergency('Manual SOS');
  };

  const downloadOfflineSpeechModel = async () => {
    if (Platform.OS !== 'android') return;
    try {
      const { ExpoSpeechRecognitionModule } = await import('expo-speech-recognition');
      const result = await ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({ locale: 'en-US' });
      if (result.status === 'download_success') {
        setVoiceStatus('English offline speech model downloaded. Restarting phrase recognition…');
        setSpeechRetryToken((token) => token + 1);
      } else if (result.status === 'download_scheduled') {
        setVoiceStatus('English offline speech model download is queued. Keep the phone online, then tap retry after it completes.');
      } else {
        setVoiceStatus('Android opened offline speech model setup. Download English (US), then return here and tap retry.');
      }
    } catch (error) {
      setVoiceStatus(`Could not open Android speech model setup: ${error instanceof Error ? error.message : 'recognizer unavailable'}`);
    }
  };

  const addContact = () => {
    if (!contactName.trim() || !contactEmail.trim()) {
      Alert.alert('Contact email required', 'Automatic alerts currently use email only. Phone numbers can be saved, but SMS is not configured, so add an email address for this trusted contact.');
      return;
    }
    setContacts((current) => [...current, { name: contactName.trim(), phone: contactPhone.trim(), email: contactEmail.trim().toLowerCase() }]);
    setContactName('');
    setContactPhone('');
    setContactEmail('');
  };

  const shareJourneyWith = async (email?: string) => {
    if (!email) return;
    const journeyId = await AsyncStorage.getItem(ACTIVE_JOURNEY_KEY);
    const { data: { session } } = supabase ? await supabase.auth.getSession() : { data: { session: null } };
    const user = session?.user ?? null;
    if (!journeyId || !user) {
      Alert.alert('Start a signed-in journey first', 'Trusted contacts can only receive access to your active account journey.');
      return;
    }
    try {
      await grantTrustedContactAccess(journeyId, email);
      const configuredDashboard = process.env.EXPO_PUBLIC_COMPANION_DASHBOARD_URL?.trim();
      let dashboardLink = '';
      if (configuredDashboard) {
        try {
          const parsed = new URL(configuredDashboard);
          const localHost = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
          if (parsed.protocol === 'https:' && !localHost) {
            parsed.searchParams.set('journeyId', journeyId);
            dashboardLink = parsed.toString();
          }
        } catch { /* Do not show a malformed dashboard URL to a contact. */ }
      }
      Alert.alert('Access granted', dashboardLink
        ? `${email} can sign in and open journey ${journeyId}.\n\nDashboard: ${dashboardLink}`
        : `${email} is authorized to view journey ${journeyId} after signing in. The dashboard is not publicly hosted yet, so there is no link they can open from another device.`);
    } catch (error) {
      Alert.alert('Could not grant access', error instanceof Error ? error.message : 'Check that your contact has registered a Companion account and try again.');
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <SpeechMonitor active={active && phraseMonitoringAllowed && !emergencyMode && (Platform.OS !== 'android' || appForeground)} phrases={triggerPhrases} retryToken={speechRetryToken} onStatus={setVoiceStatus} onPhrase={onTriggerPhrase} />
      <EmergencyAudioCapture eventId={emergencyEventId} consent={evidenceConsent} onStatus={setEvidenceStatus} />
      <EmergencyVideoCapture eventId={emergencyEventId} journeyId={journeyId} consent={evidenceConsent} onStatus={setEvidenceStatus} />
      <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>COMPANION <Text style={styles.brandDot}>●</Text></Text>
            <Text style={styles.headerSub}>Your journey, watched over.</Text>
          </View>
          <View style={styles.avatar}><Text style={styles.avatarText}>S</Text></View>
        </View>
        <View style={styles.safetyNotice}><View style={styles.safetyNoticeDot} /><Text style={styles.safetyNoticeText}>LIVE SAFETY FEATURES DEPEND ON PERMISSIONS AND NETWORK</Text></View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {!!pendingCheckIn && !emergencyMode && <View style={styles.checkInCard} accessibilityLiveRegion="assertive">
            <Text style={styles.checkInHeading}>SAFETY CHECK · {checkInSeconds}s</Text>
            <Text style={styles.checkInBody}>{pendingCheckIn.reason} If you do not respond, Companion will activate an emergency alert.</Text>
            <View style={styles.checkInActions}>
              <TouchableOpacity style={styles.checkInSafeButton} onPress={confirmSafeFromCheckIn} accessibilityRole="button">
                <Text style={styles.checkInSafeText}>I’m safe</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.checkInSosButton} onPress={requestHelpFromCheckIn} accessibilityRole="button">
                <Text style={styles.checkInSosText}>Send SOS now</Text>
              </TouchableOpacity>
            </View>
          </View>}
          {tab === 'journey' && <>
            <View style={styles.eyebrowRow}><Text style={styles.eyebrow}>YOUR SAFETY TODAY</Text><View style={styles.pilot}><Text style={styles.pilotText}>COMPANION</Text></View></View>
            <Text style={styles.title}>A safer day{ '\n' }starts here.</Text>
            <Text style={styles.subtitle}>Start a journey to share your live location and activate your safety session.</Text>

            {emergencyMode && <View style={styles.emergencyCard}>
              <Text style={styles.emergencyHeading}>EMERGENCY MODE IS ACTIVE</Text>
              <Text style={styles.emergencyBody}>{emergencyEventId ? 'Live location remains active. Confirm that you are safe to resolve this event and resume normal monitoring.' : 'Live location remains active while Companion reconnects to the emergency record.'}</Text>
              <TouchableOpacity style={[styles.resolveButton, (!emergencyEventId || resolvingEmergency) && styles.resolveButtonDisabled]} disabled={!emergencyEventId || resolvingEmergency} onPress={() => void resolveCurrentEmergency()} accessibilityRole="button">
                <Text style={styles.resolveButtonText}>{resolvingEmergency ? 'Resolving…' : emergencyEventId ? "I’m safe — resolve emergency" : 'Waiting for emergency record…'}</Text>
              </TouchableOpacity>
            </View>}

            <View style={styles.monitorCard}><View style={styles.monitorTop}><View style={[styles.pillDot, active && styles.pillDotOn]} /><Text style={styles.monitorHeading}>{active ? 'Journey monitoring active' : 'Monitoring ready'}</Text></View><Text style={styles.monitorBody}>{active ? 'Live location is updating for your active journey.' : 'Start a journey to enable live location and available safety checks.'}</Text><View style={styles.monitorTags}><Text style={styles.monitorTag}>VOICE CUES</Text><Text style={styles.monitorTag}>{triggerPhrases.length} PHRASES</Text><Text style={styles.monitorTag}>LOCATION</Text></View></View>
            {!!voiceStatus && <Text style={styles.mapLocationStatus}>{voiceStatus}</Text>}

            <LiveLocationMap point={point} trail={trail} active={active} route={routeWaypoints} />
            <Text style={[styles.mapLocationStatus, point && isLocationStale(point.timestamp, clock) && { color: colors.red }]}>{point ? `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)} · ${isLocationStale(point.timestamp, clock) ? 'STALE · ' : ''}${new Date(point.timestamp).toLocaleTimeString()}${locationLabel.startsWith('GPS ') ? ` · ${locationLabel}` : ''}` : locationLabel}</Text>
            {!!nativeMonitorStatus && <Text style={styles.mapLocationStatus}>{nativeMonitorStatus}</Text>}
            {!!notificationPermissionStatus && <Text style={[styles.mapLocationStatus, notificationPermissionStatus.includes('disabled') && { color: colors.red }]}>{notificationPermissionStatus}</Text>}
            {Platform.OS === 'android' && active && !emergencyMode && /not yet downloaded|download is queued|opened speech model setup/i.test(voiceStatus) && <TouchableOpacity onPress={() => void downloadOfflineSpeechModel()} style={styles.speechSetupButton} accessibilityRole="button" accessibilityLabel="Download offline English speech model">
              <Text style={styles.speechSetupButtonText}>{/not yet downloaded/i.test(voiceStatus) ? 'Download offline English model' : 'Retry speech setup'}</Text>
            </TouchableOpacity>}
            {emergencyEventId && <Text style={styles.mapLocationStatus}>{evidenceStatus}</Text>}
            {routeWaypoints.length > 0 && <Text style={[styles.mapLocationStatus, routeStatus.startsWith('Off route') && { color: colors.red }]}>{routeStatus}</Text>}

            <View style={styles.statusRow}>
              <StatusPill label={active ? 'Journey active' : 'Location paused'} active={active} />
              <StatusPill label={active ? 'GPS updates live' : 'GPS paused'} active={active} />
            </View>

            <View style={styles.inputCard}>
              <Text style={styles.cardLabel}>WHERE ARE YOU HEADED?</Text>
              <TextInput value={destination} onChangeText={setDestination} onBlur={() => AsyncStorage.setItem('companion-destination', destination.trim())} placeholder="Add a destination" placeholderTextColor={colors.muted} style={styles.input} />
              <View style={styles.divider} />
              <Text style={styles.cardLabel}>YOUR SOS PHRASE</Text>
              <Text style={styles.triggerDisplay}>{trigger ? `“${trigger}”` : 'Add a private phrase in Settings'}</Text>
              <View style={styles.divider} />
              <Text style={styles.cardLabel}>ROUTE CHECKPOINTS (OPTIONAL)</Text>
              <TextInput value={routeWaypointText} onChangeText={setRouteWaypointText} placeholder="-26.2041, 28.0473; -26.2100, 28.0500" placeholderTextColor={colors.muted} style={styles.input} />
              <Text style={styles.helper}>Enter latitude, longitude checkpoints separated by semicolons, or enter a destination and start a journey to plan a road route from your current location. Three consecutive fixes beyond the selected threshold and GPS-accuracy allowance prompt a safety check. Destination and approximate origin are sent to public geocoding and directions services.</Text>
            </View>

            <TouchableOpacity style={[styles.primaryButton, active && styles.stopButton]} onPress={active ? stopJourney : startJourney}>
              <Text style={styles.primaryButtonText}>{active ? (emergencyMode ? 'Emergency must be resolved first' : 'End safety journey') : 'Start a safety journey'}</Text><Text style={styles.buttonArrow}>{active ? '×' : '→'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sosButton} onPress={triggerEmergency}><Text style={styles.sosIcon}>!</Text><View style={styles.sosCopy}><Text style={styles.sosTitle}>Send an SOS now</Text><Text style={styles.sosSub}>Email alerts go to contacts with a saved email address</Text></View><Text style={styles.sosArrow}>→</Text></TouchableOpacity>
            <Text style={styles.privacyNote}>Voice phrase recognition and motion checks run during an active journey when device permissions and recognition services allow. Continuous background monitoring still depends on native OS behavior and is not yet validated.</Text>
          </>}

          {tab === 'people' && <>
            <Text style={styles.eyebrow}>YOUR SAFETY CIRCLE</Text><Text style={styles.title}>People in{ '\n' }your corner.</Text><Text style={styles.subtitle}>Add the people you trust to receive journey alerts.</Text>
            <View style={styles.inputCard}><Text style={styles.cardLabel}>TRUSTED CONTACTS</Text>
              {contacts.length === 0 ? <Text style={styles.emptyText}>No contacts added yet. Add at least one person for your safety circle.</Text> : contacts.map((contact, index) => <View key={`${contact.phone}-${contact.email}-${index}`} style={styles.contactRow}><View style={styles.contactAvatar}><Text style={styles.contactInitial}>{contact.name[0]?.toUpperCase()}</Text></View><View style={{ flex: 1 }}><Text style={styles.contactName}>{contact.name}</Text><Text style={styles.contactPhone}>{[contact.phone, contact.email].filter(Boolean).join(' · ')}</Text>{contact.email && <TouchableOpacity onPress={() => shareJourneyWith(contact.email)}><Text style={styles.shareLink}>Grant active journey access</Text></TouchableOpacity>}</View><TouchableOpacity onPress={() => setContacts((items) => items.filter((_, i) => i !== index))}><Text style={styles.remove}>×</Text></TouchableOpacity></View>)}
            </View>
            <View style={styles.inputCard}><Text style={styles.cardLabel}>ADD A PERSON</Text><TextInput value={contactName} onChangeText={setContactName} placeholder="Name" placeholderTextColor={colors.muted} style={styles.input} /><View style={styles.divider} /><TextInput value={contactPhone} onChangeText={setContactPhone} placeholder="Phone number (saved; SMS unavailable)" keyboardType="phone-pad" placeholderTextColor={colors.muted} style={styles.input} /><View style={styles.divider} /><TextInput value={contactEmail} onChangeText={setContactEmail} placeholder="Email (required for automatic alerts)" keyboardType="email-address" autoCapitalize="none" placeholderTextColor={colors.muted} style={styles.input} /></View>
            <TouchableOpacity style={styles.primaryButton} onPress={addContact}><Text style={styles.primaryButtonText}>Add trusted contact</Text><Text style={styles.buttonArrow}>+</Text></TouchableOpacity>
            <TouchableOpacity style={styles.secondaryButton} onPress={saveSetup}><Text style={styles.secondaryText}>Save safety circle</Text></TouchableOpacity>
            <Text style={styles.privacyNote}>Emergency and evidence alerts use email only. Provider credentials stay in Supabase Edge Function secrets.</Text>
          </>}

          {tab === 'settings' && <>
            <Text style={styles.eyebrow}>YOUR PERSONAL SETUP</Text><Text style={styles.title}>Make it{ '\n' }yours.</Text><Text style={styles.subtitle}>Manage the SOS phrases the native app listens for during an active safety journey.</Text>
            <TriggerPhraseManager onPrimaryPhraseChange={setPrimaryPhrase} />
            <NotificationPreferences />
            <View style={styles.inputCard}>
              <Text style={styles.cardLabel}>MONITORING</Text>
              <Text style={styles.helper}>Saved phrases are checked by the device speech-recognition service while a journey is active and the app is open. Android also has a background YAMNet shout/scream classifier and fall heuristic when a signed-in Supabase journey and required permissions are active. Their thresholds are unvalidated. An independent SOS phrase can trigger an emergency alert automatically; lower-confidence sound and motion signals may ask you to check in. This prototype cannot contact emergency services.</Text>
              <View style={styles.statusRow}>
                <Text style={[styles.helper, { flex: 1, marginTop: 0 }]}>Recognize saved phrases while Companion is open during an active journey.</Text>
                <Switch value={phraseMonitoringAllowed} onValueChange={(value) => {
                  setPhraseMonitoringAllowed(value);
                  void AsyncStorage.setItem('companion-phrase-monitor-enabled', String(value));
                  setVoiceStatus(value ? 'Personal phrase recognition enabled' : 'Personal phrase recognition disabled');
                }} accessibilityLabel="Allow personal SOS phrase monitoring" />
              </View>
              <View style={styles.statusRow}>
                <Text style={[styles.helper, { flex: 1, marginTop: 0 }]}>Allow Android to use the microphone for on-device distress-sound checks while this app is backgrounded during an active journey.</Text>
                <Switch value={backgroundAudioAllowed} onValueChange={(value) => {
                  setBackgroundAudioAllowed(value);
                  void AsyncStorage.setItem('companion-background-audio-enabled', String(value));
                  if (Platform.OS === 'android' && active && CompanionMonitor) void CompanionMonitor.setBackgroundAudioEnabled(!appForeground && value).catch(() => undefined);
                  setVoiceStatus(value ? 'Background microphone monitoring allowed for active journeys' : 'Background microphone monitoring disabled by you');
                }} accessibilityLabel="Allow background microphone distress monitoring" />
              </View>
              <View style={styles.statusRow}>
                <Text style={[styles.helper, { flex: 1, marginTop: 0 }]}>Detect possible falls from motion during this journey.</Text>
                <Switch value={motionMonitoringAllowed} onValueChange={(value) => {
                  setMotionMonitoringAllowed(value);
                  void AsyncStorage.setItem('companion-motion-enabled', String(value));
                  if (Platform.OS === 'android' && active && CompanionMonitor) void CompanionMonitor.setMotionMonitoringEnabled(value).catch(() => setNativeMonitorStatus('Android motion monitoring preference could not be applied'));
                }} accessibilityLabel="Allow fall and motion monitoring" />
              </View>
              <View style={styles.statusRow}>
                <Text style={[styles.helper, { flex: 1, marginTop: 0 }]}>Grant live dashboard access to the trusted contacts saved with an email and Companion account when each journey starts.</Text>
                <Switch value={shareEachJourney} onValueChange={(value) => {
                  setShareEachJourney(value);
                  void AsyncStorage.setItem('companion-share-journey-default', String(value));
                }} accessibilityLabel="Share each journey with trusted contacts by default" />
              </View>
              <Text style={[styles.helper, { marginTop: 14 }]}>Route deviation threshold: {routeDeviationThreshold} m (GPS accuracy is added; alerts require three consecutive fixes).</Text>
              <View style={styles.thresholdOptions}>{[50, 75, 100, 150, 200].map((meters) => <TouchableOpacity key={meters} style={[styles.thresholdOption, routeDeviationThreshold === meters && styles.thresholdOptionSelected]} onPress={() => {
                setRouteDeviationThreshold(meters);
                void AsyncStorage.setItem(ROUTE_DEVIATION_THRESHOLD_KEY, String(meters));
              }} accessibilityRole="radio" accessibilityState={{ selected: routeDeviationThreshold === meters }}><Text style={[styles.thresholdOptionText, routeDeviationThreshold === meters && styles.thresholdOptionTextSelected]}>{meters} m</Text></TouchableOpacity>)}</View>
              <Text style={styles.helper}>Personal phrases are recognized only while Companion is foregrounded. Background service detects sounds and motion separately. Turning off a monitor keeps location tracking enabled.</Text>
            </View>
            <View style={styles.inputCard}>
              <Text style={styles.cardLabel}>EMERGENCY AUDIO EVIDENCE</Text>
              <View style={styles.statusRow}>
              <Text style={[styles.helper, { flex: 1, marginTop: 0 }]}>After an SOS, capture up to 20 seconds of audio and muted video. With Supabase Storage configured, evidence is shared only with authorized journey viewers and expires after 30 days. Delete it from history at any time.</Text>
                <Switch value={evidenceConsent} onValueChange={(value) => { setEvidenceConsent(value); setEvidenceStatus(value ? 'Audio evidence enabled for the next emergency' : 'Audio evidence is off'); void AsyncStorage.setItem('companion-evidence-consent', String(value)); }} />
              </View>
              <Text style={styles.helper}>{evidenceStatus}</Text>
            </View>
            <View style={styles.noticeCard}><Text style={styles.noticeIcon}>◉</Text><View style={{ flex: 1 }}><Text style={styles.noticeTitle}>You are in control</Text><Text style={styles.noticeBody}>Monitoring and recording must be clearly shown, opt-in, and limited to an active safety session.</Text></View></View>
            <View style={styles.inputCard}>
              <Text style={styles.cardLabel}>PRIVACY AND PERMISSIONS</Text>
              {!!notificationPermissionStatus && <Text style={styles.helper}>{notificationPermissionStatus}</Text>}
              <TouchableOpacity style={styles.secondaryButton} onPress={() => void NativeLinking.openSettings().catch(() => Alert.alert('Settings unavailable', 'Open Android Settings → Apps → Companion → Permissions to review location, microphone, camera, and notification access.'))}><Text style={styles.secondaryText}>Review app permissions</Text></TouchableOpacity>
              <TouchableOpacity style={styles.secondaryButton} onPress={() => Alert.alert('Sign out of Companion?', active ? 'Signing out will end this journey and stop Companion monitoring on this device.' : 'You can sign back in later with the same account.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Sign out', style: 'destructive', onPress: () => void (async () => {
                  try {
                    if (active && !(await stopJourney())) return;
                    const { error } = await supabase?.auth.signOut({ scope: 'local' }) ?? { error: null };
                    if (error) throw error;
                    router.replace('/login');
                  } catch (error) {
                    Alert.alert('Could not sign out', error instanceof Error ? error.message : 'Try again.');
                  }
                })() },
              ])}><Text style={styles.secondaryText}>Sign out</Text></TouchableOpacity>
              <TouchableOpacity style={styles.secondaryButton} onPress={() => Alert.alert('Delete your Companion account?', 'This removes your account, saved profile, journeys, sharing access, and evidence metadata. This cannot be undone.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete account', style: 'destructive', onPress: () => void deleteAccount().then(async () => { await supabase?.auth.signOut({ scope: 'local' }); Alert.alert('Account deleted', 'Your Companion account and associated data were deleted.'); }).catch((error) => Alert.alert('Could not delete account', error instanceof Error ? error.message : 'Try again while connected.')) },
              ])}><Text style={[styles.secondaryText, { color: colors.red }]}>Delete my account and data</Text></TouchableOpacity>
            </View>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => router.push('/register')}><Text style={styles.secondaryText}>{supabaseReady ? 'Create or connect an account' : 'Connect a Supabase account'}</Text></TouchableOpacity>
            {!supabaseReady && <Text style={styles.privacyNote}>Live sharing needs Supabase project URL and publishable key in .env.</Text>}
            <TouchableOpacity style={styles.primaryButton} onPress={saveSetup}><Text style={styles.primaryButtonText}>Save my setup</Text><Text style={styles.buttonArrow}>→</Text></TouchableOpacity>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => Alert.alert('Prototype limits', 'YAMNet and fall thresholds are not validated for real-world safety. Live contact sharing and route alerts require a working network and deployed Supabase functions. Resend test mode only allows delivery to its account owner; reaching trusted contacts requires a verified sender domain. This prototype cannot contact emergency services. Keep a manual way to call for help.') }><Text style={styles.secondaryText}>Prototype limits</Text></TouchableOpacity>
          </>}
          {tab === 'history' && <EmergencyHistory />}
          <Text style={styles.footer}>COMPANION SAFETY · PROTOTYPE</Text>
        </ScrollView>
        <View style={[styles.tabBar, { paddingBottom: Math.max(12, NativeStatusBar.currentHeight ? 12 : 18) }]}>
          <TabButton label="Journey" icon="⌖" selected={tab === 'journey'} onPress={() => router.replace('/')} />
          <TabButton label="My people" icon="♡" selected={tab === 'people'} onPress={() => router.replace('/people')} />
          <TabButton label="History" icon="◷" selected={tab === 'history'} onPress={() => router.replace('/history' as never)} />
          <TabButton label="Settings" icon="⚙" selected={tab === 'settings'} onPress={() => router.replace('/settings')} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function StatusPill({ label, active }: { label: string; active: boolean }) {
  return <View style={styles.pill}><View style={[styles.pillDot, active && styles.pillDotOn]} /><Text style={styles.pillText}>{label}</Text></View>;
}

function TabButton({ label, icon, selected, onPress }: { label: string; icon: string; selected: boolean; onPress: () => void }) {
  return <TouchableOpacity style={styles.tabButton} onPress={onPress} accessibilityRole="tab" accessibilityState={{ selected }}><Text style={[styles.tabIcon, selected && styles.tabSelected]}>{icon}</Text><Text style={[styles.tabLabel, selected && styles.tabSelected]}>{label}</Text></TouchableOpacity>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  header: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 13, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: colors.line },
  safetyNotice: { backgroundColor: '#FBEDEF', minHeight: 27, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 10 }, safetyNoticeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.red }, safetyNoticeText: { color: '#A82731', fontSize: 8, fontWeight: '800', letterSpacing: 0.7 },
  brand: { color: colors.ink, fontSize: 15, letterSpacing: 2.4, fontWeight: '800' }, brandDot: { color: colors.teal, fontSize: 10 },
  headerSub: { color: colors.muted, fontSize: 11, marginTop: 4 }, avatar: { height: 36, width: 36, borderRadius: 18, backgroundColor: colors.panel2, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line }, avatarText: { color: colors.teal, fontWeight: '700' },
  content: { padding: 21, paddingBottom: 36 }, eyebrowRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 7 }, eyebrow: { color: colors.red, letterSpacing: 1.5, fontSize: 9, fontWeight: '800', marginTop: 10 }, pilot: { borderColor: colors.line, backgroundColor: colors.panel, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 20 }, pilotText: { color: colors.muted, fontSize: 8, letterSpacing: 1.2, fontWeight: '700' },
  title: { color: colors.ink, fontSize: 34, lineHeight: 37, letterSpacing: -1.1, fontWeight: '800', marginTop: 15 }, subtitle: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 9, marginBottom: 18 },
  monitorCard: { backgroundColor: '#151515', padding: 16, borderRadius: 15, marginBottom: 14 }, monitorTop: { flexDirection: 'row', alignItems: 'center', gap: 8 }, monitorHeading: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' }, monitorBody: { color: '#D1D1D1', fontSize: 11, lineHeight: 16, marginTop: 8 }, monitorTags: { flexDirection: 'row', gap: 7, marginTop: 13, flexWrap: 'wrap' }, monitorTag: { color: '#FFFFFF', backgroundColor: '#303030', borderRadius: 12, overflow: 'hidden', fontSize: 8, letterSpacing: 0.6, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 5 },
  mapCard: { height: 234, borderRadius: 18, backgroundColor: '#E9E9E7', overflow: 'hidden', borderWidth: 1, borderColor: colors.line, padding: 15, justifyContent: 'space-between' }, mapGrid: { ...StyleSheet.absoluteFill, opacity: 0.4, backgroundColor: '#E9E9E7' }, mapRoadA: { position: 'absolute', height: 17, width: 340, backgroundColor: '#D9D9D6', top: 118, left: -55, transform: [{ rotate: '-22deg' }] }, mapRoadB: { position: 'absolute', height: 12, width: 330, backgroundColor: '#D9D9D6', top: 130, right: -150, transform: [{ rotate: '54deg' }] }, mapRoute: { position: 'absolute', height: 3, width: 175, backgroundColor: colors.teal, top: 123, left: 88, transform: [{ rotate: '-36deg' }], borderRadius: 4 }, mapTop: { flexDirection: 'row', alignItems: 'center', zIndex: 1 }, pulse: { height: 7, width: 7, borderRadius: 4, backgroundColor: colors.muted, marginRight: 7 }, pulseActive: { backgroundColor: colors.teal }, mapLive: { color: colors.ink, fontSize: 9, letterSpacing: 1.3, fontWeight: '800', flex: 1 }, mapTime: { color: colors.muted, fontSize: 9, letterSpacing: 1.2 }, mapPin: { position: 'absolute', top: 91, left: '55%', width: 34, height: 34, borderRadius: 18, borderWidth: 7, borderColor: '#D52B3740', backgroundColor: colors.teal, alignItems: 'center', justifyContent: 'center', zIndex: 2 }, pinText: { color: '#FFFFFF', fontSize: 10 }, mapCallout: { position: 'absolute', top: 52, left: 15, backgroundColor: '#FFFFFF', padding: 10, borderRadius: 10, zIndex: 2, borderWidth: 1, borderColor: colors.line }, calloutTitle: { color: colors.ink, fontSize: 10, fontWeight: '700' }, calloutText: { color: colors.muted, fontSize: 9, marginTop: 4 }, mapFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', zIndex: 1 }, coord: { color: colors.muted, fontSize: 9, letterSpacing: 1.2 }, mapArrow: { color: colors.teal, fontSize: 18 },
  mapLocationStatus: { color: colors.muted, fontSize: 10, textAlign: 'center', marginTop: 8, marginBottom: 8 },
  checkInCard: { backgroundColor: '#FFF3DC', borderWidth: 2, borderColor: '#C96912', borderRadius: 15, padding: 16, marginBottom: 15 }, checkInHeading: { color: '#8B3D0A', fontSize: 14, letterSpacing: 0.7, fontWeight: '900' }, checkInBody: { color: colors.ink, fontSize: 13, lineHeight: 19, marginTop: 8 }, checkInActions: { flexDirection: 'row', gap: 10, marginTop: 13 }, checkInSafeButton: { flex: 1, minHeight: 48, borderRadius: 10, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#C96912', alignItems: 'center', justifyContent: 'center' }, checkInSafeText: { color: '#6D330B', fontSize: 13, fontWeight: '800' }, checkInSosButton: { flex: 1, minHeight: 48, borderRadius: 10, backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center' }, checkInSosText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  speechSetupButton: { minHeight: 42, alignSelf: 'center', paddingHorizontal: 16, borderRadius: 11, backgroundColor: colors.teal, justifyContent: 'center', marginTop: 2, marginBottom: 10 },
  speechSetupButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '800' },
  thresholdOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 9 }, thresholdOption: { borderWidth: 1, borderColor: colors.line, borderRadius: 9, paddingVertical: 8, paddingHorizontal: 11, backgroundColor: '#FFFFFF' }, thresholdOptionSelected: { backgroundColor: colors.ink, borderColor: colors.ink }, thresholdOptionText: { color: colors.ink, fontSize: 10, fontWeight: '700' }, thresholdOptionTextSelected: { color: '#FFFFFF' },
  statusRow: { flexDirection: 'row', gap: 8, marginTop: 13, marginBottom: 15 }, pill: { backgroundColor: colors.panel, borderRadius: 30, paddingHorizontal: 11, paddingVertical: 8, flexDirection: 'row', alignItems: 'center' }, pillDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.muted, marginRight: 7 }, pillDotOn: { backgroundColor: colors.teal }, pillText: { color: colors.ink, fontSize: 10 },
  inputCard: { padding: 16, backgroundColor: colors.panel, borderRadius: 15, borderWidth: 1, borderColor: colors.line, marginTop: 10 }, cardLabel: { color: colors.muted, fontSize: 9, letterSpacing: 1.35, fontWeight: '800', marginBottom: 10 }, input: { color: colors.ink, fontSize: 14, paddingVertical: 6 }, triggerDisplay: { color: colors.ink, fontSize: 14, fontWeight: '600' }, divider: { height: 1, backgroundColor: colors.line, marginVertical: 13 },
  primaryButton: { marginTop: 16, backgroundColor: colors.teal, borderRadius: 13, height: 54, paddingHorizontal: 17, alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, stopButton: { backgroundColor: colors.panel2, borderWidth: 1, borderColor: colors.red }, primaryButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 }, buttonArrow: { color: '#FFFFFF', fontSize: 23, fontWeight: '400' },
  sosButton: { marginTop: 11, borderRadius: 13, borderWidth: 1, borderColor: '#EDB7BC', backgroundColor: '#FCEEEF', paddingHorizontal: 14, height: 64, flexDirection: 'row', alignItems: 'center' }, sosIcon: { color: colors.red, borderColor: '#E8A2A8', borderWidth: 1, borderRadius: 20, height: 30, width: 30, textAlign: 'center', textAlignVertical: 'center', overflow: 'hidden', fontSize: 16, fontWeight: '700', marginRight: 12 }, sosCopy: { flex: 1 }, sosTitle: { color: colors.ink, fontSize: 12, fontWeight: '700' }, sosSub: { color: '#A54D55', fontSize: 9, marginTop: 4 }, sosArrow: { color: colors.red, fontSize: 20 }, privacyNote: { color: colors.muted, textAlign: 'center', fontSize: 10, lineHeight: 15, marginTop: 15, paddingHorizontal: 6 },
  emergencyCard: { backgroundColor: '#FCEEEF', borderRadius: 14, borderWidth: 1, borderColor: '#EDB7BC', padding: 15, marginBottom: 15 }, emergencyHeading: { color: colors.red, fontSize: 12, letterSpacing: 0.7, fontWeight: '900' }, emergencyBody: { color: colors.ink, fontSize: 12, lineHeight: 18, marginTop: 7 }, resolveButton: { backgroundColor: colors.red, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 12, alignItems: 'center', marginTop: 12 }, resolveButtonDisabled: { opacity: 0.55 }, resolveButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  emptyText: { color: colors.muted, fontSize: 13, lineHeight: 20 }, contactRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomColor: colors.line, borderBottomWidth: 1 }, contactAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#FBEDEF', alignItems: 'center', justifyContent: 'center', marginRight: 10 }, contactInitial: { color: colors.teal, fontWeight: '800' }, contactName: { color: colors.ink, fontWeight: '700', fontSize: 13 }, contactPhone: { color: colors.muted, fontSize: 11, marginTop: 3 }, shareLink: { color: colors.teal, fontSize: 10, fontWeight: '700', marginTop: 7 }, remove: { color: colors.muted, fontSize: 22, paddingHorizontal: 5 }, secondaryButton: { marginTop: 10, padding: 14, alignItems: 'center' }, secondaryText: { color: colors.teal, fontWeight: '700', fontSize: 12 }, helper: { color: colors.muted, lineHeight: 18, fontSize: 11, marginTop: 7 }, noticeCard: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 14, marginTop: 14, padding: 14, flexDirection: 'row' }, noticeIcon: { color: colors.teal, fontSize: 17, marginRight: 11 }, noticeTitle: { color: colors.ink, fontSize: 12, fontWeight: '700' }, noticeBody: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  footer: { textAlign: 'center', color: colors.muted, fontSize: 8, letterSpacing: 1.6, marginTop: 29 }, tabBar: { height: 67, backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' }, tabButton: { width: '25%', alignItems: 'center', justifyContent: 'center' }, tabIcon: { color: colors.muted, fontSize: 19 }, tabLabel: { color: colors.muted, fontSize: 9, marginTop: 2 }, tabSelected: { color: colors.red },
});

