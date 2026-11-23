import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { theme } from './src/theme';
import { DeviceMotion } from 'expo-sensors';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import { ACTIVE_ROUTE_KEY, LAST_LOCATION_KEY, LAST_ROUTE_ALERT_KEY, LOCATION_TASK, ROUTE_DEVIATION_COUNT_KEY, ROUTE_DEVIATION_THRESHOLD_KEY, ROUTE_ORIGIN_KEY, SESSION_KEY } from './src/services/backgroundLocation';
import { ACTIVE_JOURNEY_KEY, createJourney, finishJourney } from './src/services/journeys';
import { clearPendingLocationUpload, publishLatestLocation } from './src/services/locationPublishing';
import { supabase, supabaseConfig, supabaseReady } from './src/lib/supabase';
import { loadEvidenceRetentionDays, rememberJourneyId, saveEvidenceRetentionDays, saveTrustedContacts, type EvidenceRetentionDays } from './src/services/profile';
import { EVIDENCE_RETENTION_KEY } from './src/services/evidence';
import { getPrivateItem, setPrivateItem, removePrivateItem } from './src/services/privateStorage';
import { activateEmergency, grantTrustedContactAccess, revokeTrustedContactAccess, resolveEmergency as resolveEmergencyEvent } from './src/services/sharing';
import LiveLocationMap from './src/components/LiveLocationMap';
import TriggerPhraseManager from './src/components/TriggerPhraseManager';
import EmergencyHistory from './src/components/EmergencyHistory';
import SpeechMonitor from './src/components/SpeechMonitor';
import EmergencyAudioCapture from './src/components/EmergencyAudioCapture';
import EmergencyVideoCapture from './src/components/EmergencyVideoCapture';
import NotificationPreferences from './src/components/NotificationPreferences';
import DevicePermissions from './src/components/DevicePermissions';
import { deleteAccount } from './src/services/profile';
import CompanionMonitor, { type MonitorStatus } from './modules/companion-monitor';
import { loadTriggerPhrases, type TriggerPhrase } from './src/services/triggerPhrases';
import { isLocationStale, isRouteDeviation, parseRouteCoordinates, shouldAcceptLocationUpdate, type Coordinate, type TimestampedLocation } from './src/services/routeSafety';
import { planRoadRoute } from './src/services/roadRoutes';
import { selectLatestAudioEvaluationRows } from './src/services/audioEvaluationCsv';
import { SafetyAgent, reportSafetySignal, setActiveSafetyAgent } from './src/services/safetyAgent';
import { FallDetector } from './src/services/fallDetector';
import {
  Alert,
  AppState,
  KeyboardAvoidingView,
  Linking as NativeLinking,
  PermissionsAndroid,
  Platform,
  Share,
  ScrollView,
  StatusBar as NativeStatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type Point = { latitude: number; longitude: number; accuracy: number | null; timestamp: number };
type Contact = { name: string; phone: string; email?: string };
const BACKGROUND_LOCATION_EMERGENCY_CADENCE_KEY = 'companion-background-location-emergency-cadence';

function describeAudioEvaluationStatus(status: MonitorStatus) {
  const latest = status.audioEvaluationLastTimestampMs
    ? new Date(status.audioEvaluationLastTimestampMs).toLocaleString()
    : 'none';
  const microphone = status.audioMonitoring ? 'background microphone active' : 'background microphone paused';
  const limit = status.audioEvaluationLimitReached ? '; storage cap reached—export and clear predictions to resume' : '';
  return `Logger ${status.audioEvaluationLogging ? 'ON' : 'OFF'} · ${status.audioEvaluationRowsWritten ?? 0} rows · latest ${latest} · ${microphone}${limit}`;
}

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
    const deliveryStatus = result.notifications?.status ?? result.status ?? 'unknown';
    const deliveryMessage = deliveryStatus === 'accepted'
      ? 'The email provider accepted the alert. Inbox delivery is not confirmed.'
      : deliveryStatus === 'partial'
        ? `The provider accepted ${result.notifications?.accepted ?? 0} email(s); ${result.notifications?.failures ?? 0} failed and ${result.notifications?.unknown ?? 0} have unknown outcomes.`
        : deliveryStatus === 'no_recipients'
          ? 'The emergency is recorded, but there are no eligible email contacts configured.'
          : deliveryStatus === 'queued'
            ? 'The emergency is recorded and contact notification is queued.'
            : `The emergency is recorded. Email outcome: ${deliveryStatus}${result.notifications?.retryable ? '; a bounded retry is pending.' : '.'}`;
    Alert.alert(result.duplicate ? 'Emergency already active' : 'Emergency activated', deliveryMessage);
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
  navy: theme.background,
  panel: theme.surface,
  panel2: theme.surfaceSoft,
  ink: theme.ink,
  muted: theme.muted,
  teal: theme.navy,
  red: theme.red,
  line: theme.line,
  yellow: theme.amber,
};

export default function App({ screen = 'home' }: { screen?: 'home' | 'journey' | 'people' | 'settings' | 'history' }) {
  const router = useRouter();
  const tab = screen;
  const [active, setActive] = useState(false);
  const [appForeground, setAppForeground] = useState(AppState.currentState === 'active');
  const [emergencyMode, setEmergencyMode] = useState(false);
  const [emergencyEventId, setEmergencyEventId] = useState<string | null>(null);
  const [resolvingEmergency, setResolvingEmergency] = useState(false);
  const [journeyId, setJourneyId] = useState<string | null>(null);
  const [evidenceConsent, setEvidenceConsent] = useState(false);
  const [evidenceRetentionDays, setEvidenceRetentionDays] = useState<EvidenceRetentionDays>(30);
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
  const [audioEvaluationLogging, setAudioEvaluationLogging] = useState(false);
  const [audioEvaluationStatus, setAudioEvaluationStatus] = useState('Prediction logging is off');
  const [speechRetryToken, setSpeechRetryToken] = useState(0);
  const [destination, setDestination] = useState('');
  const [travelMode, setTravelMode] = useState<'Walking' | 'Driving' | 'Public transport'>('Walking');
  const [routeWaypoints, setRouteWaypoints] = useState<Coordinate[]>([]);
  const [routeWaypointText, setRouteWaypointText] = useState('');
  const [routeStatus, setRouteStatus] = useState('No route check configured');
  const [journeyOptionsOpen, setJourneyOptionsOpen] = useState(false);
  const [monitoringDetailsOpen, setMonitoringDetailsOpen] = useState(false);
  const [routeDeviationThreshold, setRouteDeviationThreshold] = useState(100);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [displayName, setDisplayName] = useState('there');
  const [userEmail, setUserEmail] = useState('');
  const [userPhone, setUserPhone] = useState('');
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
    let cancelled = false;
    void supabase?.auth.getUser().then(({ data: { user } }) => {
      if (cancelled || !user) return;
      const fullName = String(user.user_metadata?.display_name ?? user.user_metadata?.full_name ?? user.user_metadata?.name ?? '').trim();
      if (fullName) setDisplayName(fullName.split(/\s+/)[0]);
      if (user.email) setUserEmail(user.email);
      if (user.phone) setUserPhone(user.phone);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const refresh = () => setClock(Date.now());
    const initial = setTimeout(refresh, 0);
    const timer = setInterval(refresh, 10_000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!pendingCheckIn) return;
    const refresh = () => {
      const remaining = Math.max(0, Math.ceil((pendingCheckIn.deadline - Date.now()) / 1000));
      setCheckInSeconds(remaining);
    };
    const initial = setTimeout(refresh, 0);
    const timer = setInterval(refresh, 1_000);
    return () => { clearTimeout(initial); clearInterval(timer); };
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
        'companion-evidence-consent',
        EVIDENCE_RETENTION_KEY,
        'companion-background-audio-enabled',
        'companion-motion-enabled',
        'companion-phrase-monitor-enabled',
        'companion-share-journey-default',
        'companion-audio-evaluation-logging',
        ROUTE_DEVIATION_THRESHOLD_KEY,
        'companion-emergency-event-id',
      ]);
      const values = Object.fromEntries(saved);
      if (values[ACTIVE_JOURNEY_KEY]) setJourneyId(values[ACTIVE_JOURNEY_KEY]!);
      if (values['companion-evidence-consent'] === 'true') setEvidenceConsent(true);
      const retention = Number(values[EVIDENCE_RETENTION_KEY]);
      if (retention === 7 || retention === 30 || retention === 90) setEvidenceRetentionDays(retention);
      if (values['companion-background-audio-enabled'] === 'false') setBackgroundAudioAllowed(false);
      if (values['companion-motion-enabled'] === 'false') setMotionMonitoringAllowed(false);
      if (values['companion-phrase-monitor-enabled'] === 'false') setPhraseMonitoringAllowed(false);
      if (values['companion-share-journey-default'] === 'true') setShareEachJourney(true);
      if (values['companion-audio-evaluation-logging'] === 'true') setAudioEvaluationLogging(true);
      const savedThreshold = Number(values[ROUTE_DEVIATION_THRESHOLD_KEY]);
      if (Number.isFinite(savedThreshold) && savedThreshold >= 50 && savedThreshold <= 500) setRouteDeviationThreshold(savedThreshold);
      if (values['companion-emergency-event-id']) {
        setEmergencyEventId(values['companion-emergency-event-id']!);
        setEmergencyMode(true);
      }
      let savedDestination: string | null = null;
      let savedWaypoints: string | null = null;
      let savedContacts: string | null = null;
      let savedLocation: string | null = null;
      try {
        [savedDestination, savedWaypoints, savedContacts, savedLocation] = await Promise.all([
          getPrivateItem('companion-destination'),
          getPrivateItem('companion-route-waypoints'),
          getPrivateItem('companion-contacts'),
          getPrivateItem(LAST_LOCATION_KEY),
        ]);
      } catch {
        setLocationLabel('Secure device storage is unavailable; saved private settings could not be restored.');
      }
      if (savedDestination) setDestination(savedDestination);
      if (savedWaypoints) {
        try {
          const parsed = parseRouteCoordinates(JSON.parse(savedWaypoints));
          setRouteWaypoints(parsed);
          setRouteWaypointText(parsed.map(({ latitude, longitude }) => `${latitude}, ${longitude}`).join('; '));
        } catch { setRouteWaypoints([]); }
      }
      if (savedContacts) setContacts(JSON.parse(savedContacts));
      if (savedLocation) {
        const savedPoint = JSON.parse(savedLocation) as Point;
        if (!lastAcceptedLocationRef.current || savedPoint.timestamp > lastAcceptedLocationRef.current.timestamp) {
          setPoint(savedPoint);
          if (typeof savedPoint.accuracy === 'number') lastAcceptedLocationRef.current = { ...savedPoint, accuracy: savedPoint.accuracy };
        }
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
    let mounted = true;
    void (async () => {
      try {
        const { data: { user } } = await supabase?.auth.getUser() ?? { data: { user: null } };
        if (!user) return;
        const remoteDays = await loadEvidenceRetentionDays(user.id);
        if (!mounted) return;
        setEvidenceRetentionDays(remoteDays);
        await AsyncStorage.setItem(EVIDENCE_RETENTION_KEY, String(remoteDays));
      } catch { /* Local preference remains available until the retention migration is deployed. */ }
    })();
    return () => { mounted = false; };
  }, []);

  const chooseEvidenceRetention = useCallback(async (days: EvidenceRetentionDays) => {
    setEvidenceRetentionDays(days);
    await AsyncStorage.setItem(EVIDENCE_RETENTION_KEY, String(days));
    try {
      const { data: { user } } = await supabase?.auth.getUser() ?? { data: { user: null } };
      if (!user) {
        setEvidenceStatus(`Evidence retention saved on this device: ${days} days. Sign in to sync it to your account.`);
        return;
      }
      await saveEvidenceRetentionDays(user.id, days);
      setEvidenceStatus(`Evidence retention saved to this device and your account: ${days} days.`);
    } catch {
      setEvidenceStatus(`Evidence retention saved on this device: ${days} days. Account sync is pending until the Supabase migration is applied.`);
    }
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
          void setPrivateItem(LAST_LOCATION_KEY, JSON.stringify(next)).catch(() => {
            if (!cancelled) setLocationLabel('Live location continues, but its private device cache could not be saved.');
          });
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
    try {
      await Promise.all([
        setPrivateItem('companion-contacts', JSON.stringify(contacts)),
        setPrivateItem('companion-destination', destination.trim()),
        setPrivateItem('companion-route-waypoints', JSON.stringify(parsedWaypoints)),
      ]);
    } catch {
      Alert.alert('Secure storage unavailable', 'Your contacts and route settings were not saved on this device. Review device storage settings and try again.');
      return;
    }
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
    await setPrivateItem('companion-route-waypoints', JSON.stringify(plannedRoute));
    await Promise.all([
      setPrivateItem(ACTIVE_ROUTE_KEY, JSON.stringify(plannedRoute)),
      AsyncStorage.setItem(ROUTE_DEVIATION_COUNT_KEY, '0'),
      removePrivateItem(ROUTE_ORIGIN_KEY),
      AsyncStorage.removeItem(LAST_ROUTE_ALERT_KEY),
    ]);
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
      try {
        const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS, {
          title: 'Companion safety notifications',
          message: 'Allow the ongoing journey monitor and safety check-in notifications to stay visible.',
          buttonPositive: 'Allow',
          buttonNegative: 'Not now',
        });
      } catch { /* Profile → Permissions shows the latest OS permission status. */ }
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
      lastRouteSignalAtRef.current = 0;
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
    await Promise.all([removePrivateItem(ACTIVE_ROUTE_KEY), removePrivateItem(ROUTE_ORIGIN_KEY), AsyncStorage.removeItem(ROUTE_DEVIATION_COUNT_KEY)]);
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
      safetyAgentRef.current?.resolve();
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
      if (result.status === 'accepted' || result.status === 'partial') {
        safetyAgentRef.current?.markAlertsSent();
      }
      safetyAgentRef.current?.startEmergencyTracking();
      setEmergencyEventId(result.eventId);
      await AsyncStorage.setItem('companion-emergency-event-id', result.eventId);
    }
  }, [escalateBackgroundLocation, journeyId]);

  const createJourneySafetyAgent = useCallback(() => {
    const decisionStorageKey = `companion-safety-decisions:${journeyId ?? 'unlinked'}`;
    let decisionWriteQueue: Promise<void> = Promise.resolve();
    const agent = new SafetyAgent((action, reason, deadline) => {
      if (action === 'prompt_user') {
        setPendingCheckIn({ reason: reason || 'A possible distress signal was detected.', deadline: deadline ?? Date.now() + 12_000 });
      } else if (action === 'send_emergency') {
        setPendingCheckIn(null);
        void requestEmergency(reason || 'Automatic distress detection');
      }
    }, {}, (records) => {
      // Store a bounded, transcript-free audit trail so decisions and reasons survive app restarts.
      decisionWriteQueue = decisionWriteQueue
        .then(() => AsyncStorage.setItem(decisionStorageKey, JSON.stringify(records)))
        .catch(() => undefined);
    });
    safetyAgentRef.current = agent;
    setActiveSafetyAgent(agent);
  }, [journeyId, requestEmergency]);

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

  const refreshAudioEvaluationStatus = useCallback(async () => {
    if (!CompanionMonitor) return;
    try {
      setAudioEvaluationStatus(describeAudioEvaluationStatus(await CompanionMonitor.getStatus()));
    } catch {
      setAudioEvaluationStatus('Could not read Android prediction-logger status');
    }
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android' || !CompanionMonitor) return;
    void CompanionMonitor.setAudioEvaluationLoggingEnabled(active && audioEvaluationLogging)
      .then(refreshAudioEvaluationStatus)
      .catch(() => setAudioEvaluationStatus('Could not update the Android evaluation logging setting'));
  }, [active, audioEvaluationLogging, refreshAudioEvaluationStatus]);

  const exportAudioEvaluationCsv = useCallback(async () => {
    if (Platform.OS !== 'android' || !CompanionMonitor) {
      Alert.alert('Android only', 'The YAMNet background prediction log is available in the Android app.');
      return;
    }
    try {
      const { csv: shareCsv, sharedRows, omittedRows } = selectLatestAudioEvaluationRows(await CompanionMonitor.getAudioEvaluationCsv());
      if (sharedRows === 0) {
        Alert.alert('No predictions yet', 'Enable prediction logging, then run an active journey with background sound monitoring enabled.');
        return;
      }
      await Share.share({
        title: 'Companion audio evaluation CSV',
        message: shareCsv,
      }, { dialogTitle: 'Export audio evaluation predictions' });
      const status = describeAudioEvaluationStatus(await CompanionMonitor.getStatus());
      setAudioEvaluationStatus(`${status} · shared ${sharedRows} recent rows${omittedRows ? `; ${omittedRows} older omitted` : ''}. No raw audio included.`);
    } catch {
      setAudioEvaluationStatus('Could not export the audio evaluation predictions');
      Alert.alert('Export failed', 'Android could not open the share sheet for the prediction CSV.');
    }
  }, []);

  const clearAudioEvaluationCsv = useCallback(() => {
    const monitor = CompanionMonitor;
    if (!monitor) return;
    Alert.alert('Delete evaluation predictions?', 'This removes the locally stored prediction metadata from this device. Microphone audio is never stored in this log.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => {
        void monitor.clearAudioEvaluationCsv()
          .then(refreshAudioEvaluationStatus)
          .catch(() => setAudioEvaluationStatus('Could not delete the local prediction log'));
      } },
    ]);
  }, [refreshAudioEvaluationStatus]);

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
    if (safetyAgentRef.current) safetyAgentRef.current.activateManually('Manual SOS');
    else void requestEmergency('Manual SOS');
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
            <Text style={styles.headerSub}>{tab === 'home' ? 'Your safety companion' : 'Your journey, watched over.'}</Text>
          </View>
          <TouchableOpacity style={styles.avatar} onPress={() => router.replace('/settings')} accessibilityRole="button" accessibilityLabel="Open Profile and Settings"><Text style={styles.avatarText}>{tab === 'home' && userEmail ? userEmail[0]?.toUpperCase() : '⚙'}</Text></TouchableOpacity>
        </View>
        <ScrollView contentOffset={{ x: 0, y: 0 }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
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
          {tab === 'home' && <>
            <Text style={styles.title}>Good {clock && new Date(clock).getHours() < 12 ? 'morning' : clock && new Date(clock).getHours() < 17 ? 'afternoon' : 'evening'}, {displayName}</Text>
            <Text style={styles.subtitle}>{new Date(clock || Date.now()).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} · {destination || 'Ready for your next journey'}</Text>
            <View style={styles.homeStatusCard}>
              <View style={styles.homeStatusTop}><Text style={styles.homeShield}>♡</Text><Text style={styles.homeStatusLabel}>{emergencyMode ? 'EMERGENCY SUPPORT ACTIVE' : active ? 'JOURNEY IN PROGRESS' : 'SAFETY CIRCLE READY'}</Text></View>
              <Text style={styles.homeStatusTitle}>{emergencyMode ? 'Your contacts have been alerted' : active ? 'Your journey is being shared' : 'Your safety circle is ready'}</Text>
              <Text style={styles.homeStatusBody}>{active && point ? `Location updated ${new Date(point.timestamp).toLocaleTimeString()}` : `${contacts.length} trusted contact${contacts.length === 1 ? '' : 's'} connected`}</Text>
            </View>
            {active && <LiveLocationMap point={point} trail={trail} active={active} route={routeWaypoints} stale={!!point && isLocationStale(point.timestamp, clock)} />}
            <View style={styles.homeConfidenceCard}><Text style={styles.homeConfidenceTitle}>{active ? 'Stay connected on the way.' : 'Head out with confidence.'}</Text><Text style={styles.homeConfidenceBody}>{active ? 'Your safety circle can follow your live route.' : 'Share your route and safety circle when you travel.'}</Text><TouchableOpacity style={styles.homeConfidenceButton} onPress={() => router.replace('/journey' as never)} accessibilityRole="button"><Text style={styles.homeConfidenceButtonText}>{active ? 'View live journey' : 'Plan a journey'}</Text><Text style={styles.homeConfidenceArrow}>→</Text></TouchableOpacity></View>
            <Text style={styles.sectionTitle}>Your safety tools</Text>
            <TouchableOpacity style={styles.homeToolCard} onPress={() => router.replace('/settings')}><Text style={styles.homeToolIcon}>◉</Text><View style={{ flex: 1 }}><Text style={styles.homeToolTitle}>AI safety monitoring</Text><Text style={styles.homeToolBody}>{active ? 'Monitoring status and personal SOS phrases' : 'Set up phrases, monitoring, and privacy'}</Text></View><Text style={styles.homeToolArrow}>›</Text></TouchableOpacity>
            <TouchableOpacity style={styles.homeToolCard} onPress={() => router.replace('/people')}><Text style={styles.homeToolIcon}>♡</Text><View style={{ flex: 1 }}><Text style={styles.homeToolTitle}>Family & guardians</Text><Text style={styles.homeToolBody}>Manage trusted contacts and journey access</Text></View><Text style={styles.homeToolArrow}>›</Text></TouchableOpacity>
            <TouchableOpacity style={styles.homeSosButton} onPress={triggerEmergency} accessibilityRole="button"><Text style={styles.homeSosIcon}>!</Text><View style={{ flex: 1 }}><Text style={styles.homeSosTitle}>Emergency SOS</Text><Text style={styles.homeSosBody}>Alert your trusted contacts</Text></View><Text style={styles.homeSosArrow}>→</Text></TouchableOpacity>
          </>}

          {tab === 'journey' && (active ? <>
            <Text style={styles.eyebrow}>LIVE JOURNEY</Text>
            <Text style={styles.title}>Your journey is live</Text>
            <Text style={styles.subtitle}>{destination ? `On the way to ${destination}` : 'Your location is being shared with your safety circle.'}</Text>

            {emergencyMode && <View style={styles.emergencyCard}>
              <Text style={styles.emergencyHeading}>EMERGENCY MODE IS ACTIVE</Text>
              <Text style={styles.emergencyBody}>{emergencyEventId ? 'Live location remains active. Confirm that you are safe to resolve this event and resume normal monitoring.' : 'Live location remains active while Companion reconnects to the emergency record.'}</Text>
              <TouchableOpacity style={[styles.resolveButton, (!emergencyEventId || resolvingEmergency) && styles.resolveButtonDisabled]} disabled={!emergencyEventId || resolvingEmergency} onPress={() => void resolveCurrentEmergency()} accessibilityRole="button">
                <Text style={styles.resolveButtonText}>{resolvingEmergency ? 'Resolving…' : emergencyEventId ? "I’m safe — resolve emergency" : 'Waiting for emergency record…'}</Text>
              </TouchableOpacity>
            </View>}

            <View style={styles.liveMapCard}>
              <View style={styles.liveMapHeading}><Text style={styles.liveMapLabel}>●  LIVE SHARING</Text><Text style={styles.liveMapUpdated}>{point ? `Updated ${Math.max(0, Math.floor((clock - point.timestamp) / 1000))} sec ago` : 'Waiting for GPS'}</Text></View>
              <LiveLocationMap point={point} trail={trail} active={active} route={routeWaypoints} stale={!!point && isLocationStale(point.timestamp, clock)} />
            </View>
            <Text style={[styles.mapLocationStatus, point && isLocationStale(point.timestamp, clock) && { color: colors.red }]}>{point ? `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)} · ${isLocationStale(point.timestamp, clock) ? 'STALE · ' : ''}${new Date(point.timestamp).toLocaleTimeString()}` : locationLabel}</Text>
            {routeWaypoints.length > 0 && <Text style={[styles.mapLocationStatus, routeStatus.startsWith('Off route') && { color: colors.red }]}>{routeStatus}</Text>}
            <View style={styles.monitorCard}><View style={styles.monitorTop}><View style={[styles.pillDot, styles.pillDotOn]} /><Text style={styles.monitorHeading}>AI monitoring active</Text></View><Text style={styles.monitorBody}>Location, enabled sound checks, and motion checks are running for this journey.</Text><TouchableOpacity onPress={() => router.replace('/settings')}><Text style={styles.shareLink}>Review monitoring and SOS phrase settings</Text></TouchableOpacity></View>
            <TouchableOpacity style={styles.arrivedButton} onPress={() => void stopJourney()} disabled={emergencyMode}><Text style={styles.arrivedButtonText}>{emergencyMode ? 'Resolve emergency before ending' : 'I’ve arrived · End journey'}</Text></TouchableOpacity>
            <TouchableOpacity style={styles.sosButton} onPress={triggerEmergency}><Text style={styles.sosIcon}>!</Text><View style={styles.sosCopy}><Text style={styles.sosTitle}>Emergency SOS</Text><Text style={styles.sosSub}>Alert your trusted contacts</Text></View><Text style={styles.sosArrow}>→</Text></TouchableOpacity>
            <TouchableOpacity style={styles.detailsLink} onPress={() => setMonitoringDetailsOpen((open) => !open)} accessibilityRole="button" accessibilityState={{ expanded: monitoringDetailsOpen }}><Text style={styles.secondaryText}>{monitoringDetailsOpen ? 'Hide monitoring details' : 'Monitoring details'}</Text></TouchableOpacity>
            {monitoringDetailsOpen && <View style={styles.inputCard}><Text style={styles.cardLabel}>DEVICE & LOCATION STATUS</Text><Text style={styles.helper}>{voiceStatus || 'Voice monitoring status unavailable.'}</Text>{!!nativeMonitorStatus && <Text style={styles.helper}>{nativeMonitorStatus}</Text>}{emergencyEventId && <Text style={styles.helper}>{evidenceStatus}</Text>}<Text style={styles.helper}>Background monitoring depends on Android permissions and operating-system behavior. It may stop if permissions are revoked, the app is force-stopped, or the device powers off.</Text>{Platform.OS === 'android' && !emergencyMode && /not yet downloaded|download is queued|opened speech model setup/i.test(voiceStatus) && <TouchableOpacity onPress={() => void downloadOfflineSpeechModel()} style={styles.speechSetupButton} accessibilityRole="button"><Text style={styles.speechSetupButtonText}>{/not yet downloaded/i.test(voiceStatus) ? 'Download offline English model' : 'Retry speech setup'}</Text></TouchableOpacity>}</View>}
          </> : <>
            <Text style={styles.eyebrow}>PLAN A SAFE TRIP</Text>
            <Text style={styles.title}>Start a journey</Text>
            <Text style={styles.subtitle}>Choose where you’re heading.</Text>
            <View style={styles.journeyFieldCard}>
              <Text style={styles.fieldLabel}>STARTING POINT</Text>
              <View style={styles.locationField}><Text style={styles.locationFieldIcon}>⌖</Text><Text style={styles.locationFieldText}>{point && !isLocationStale(point.timestamp, clock) ? 'Current location · GPS ready' : 'Current location · Waiting for GPS'}</Text></View>
              <Text style={[styles.fieldLabel, { marginTop: 16 }]}>DESTINATION</Text>
              <View style={styles.locationField}><Text style={styles.locationFieldIcon}>⌖</Text><TextInput value={destination} onChangeText={setDestination} onBlur={() => void setPrivateItem('companion-destination', destination.trim())} placeholder="Where are you going?" placeholderTextColor={colors.muted} style={styles.journeyDestinationInput} accessibilityLabel="Journey destination" /></View>
            </View>
            <Text style={styles.sectionTitle}>Travel mode</Text>
            <View style={styles.travelModeRow}>{(['Walking', 'Driving', 'Public transport'] as const).map((mode) => <TouchableOpacity key={mode} style={[styles.travelModeOption, travelMode === mode && styles.travelModeSelected]} onPress={() => setTravelMode(mode)} accessibilityRole="radio" accessibilityState={{ selected: travelMode === mode }}><Text style={[styles.travelModeText, travelMode === mode && styles.travelModeTextSelected]}>{mode}</Text></TouchableOpacity>)}</View>
            <View style={styles.shareJourneyCard}><View style={{ flex: 1 }}><Text style={styles.homeToolTitle}>Share with your safety circle</Text><Text style={styles.homeToolBody}>{contacts.length ? `${contacts.length} trusted contact${contacts.length === 1 ? '' : 's'} available` : 'Add contacts before starting a shared journey'}</Text></View><Switch value={shareEachJourney} onValueChange={(value) => { setShareEachJourney(value); void AsyncStorage.setItem('companion-share-journey-default', String(value)); }} accessibilityLabel="Share this journey with my safety circle" /></View>
            <TouchableOpacity style={styles.disclosureButton} onPress={() => setJourneyOptionsOpen((open) => !open)} accessibilityRole="button" accessibilityState={{ expanded: journeyOptionsOpen }}><Text style={styles.disclosureText}>{journeyOptionsOpen ? 'Hide route options' : 'Add route checkpoints'}</Text><Text style={styles.disclosureIcon}>{journeyOptionsOpen ? '−' : '+'}</Text></TouchableOpacity>
            {journeyOptionsOpen && <View style={styles.inputCard}><Text style={styles.cardLabel}>OPTIONAL ROUTE CHECKPOINTS</Text><TextInput value={routeWaypointText} onChangeText={setRouteWaypointText} placeholder="Latitude, longitude; …" placeholderTextColor={colors.muted} style={styles.input} /><Text style={styles.helper}>A destination plans a road route automatically when route services are available. Three consecutive off-route GPS fixes prompt a safety check.</Text><TouchableOpacity onPress={() => router.replace('/settings')}><Text style={styles.shareLink}>Manage personal SOS phrases in Profile</Text></TouchableOpacity></View>}
            <View style={styles.estimateCard}><Text style={styles.estimateIcon}>{travelMode === 'Walking' ? '♧' : travelMode === 'Driving' ? '▣' : '⇄'}</Text><View style={{ flex: 1 }}><Text style={styles.homeToolTitle}>{travelMode}</Text><Text style={styles.homeToolBody}>{destination.trim() ? 'Route will be planned when you start' : 'Add a destination to plan your route'}</Text></View></View>
            <TouchableOpacity style={styles.homePrimaryButton} onPress={() => void startJourney()} accessibilityRole="button"><Text style={styles.homePrimaryText}>Start protected journey</Text><Text style={styles.homePrimaryArrow}>→</Text></TouchableOpacity>
            <TouchableOpacity style={styles.secondaryButton} onPress={() => router.replace('/settings')}><Text style={styles.secondaryText}>Monitoring settings · {trigger ? `“${trigger}”` : 'Set up SOS phrase'}</Text></TouchableOpacity>
          </>)}

          {tab === 'people' && <>
            <Text style={styles.eyebrow}>YOUR SAFETY CIRCLE</Text><Text style={styles.title}>Your people</Text><Text style={styles.subtitle}>Add trusted contacts and share an active journey with them.</Text>
            <View style={styles.inputCard}><Text style={styles.cardLabel}>TRUSTED CONTACTS</Text>
                {contacts.length === 0 ? <Text style={styles.emptyText}>No contacts added yet. Add at least one person for your safety circle.</Text> : contacts.map((contact, index) => <View key={`${contact.phone}-${contact.email}-${index}`} style={styles.contactRow}><View style={styles.contactAvatar}><Text style={styles.contactInitial}>{contact.name[0]?.toUpperCase()}</Text></View><View style={{ flex: 1 }}><Text style={styles.contactName}>{contact.name}</Text><Text style={styles.contactPhone}>{[contact.phone, contact.email].filter(Boolean).join(' · ')}</Text>{contact.email && <><TouchableOpacity onPress={() => shareJourneyWith(contact.email)}><Text style={styles.shareLink}>Grant active journey access</Text></TouchableOpacity><TouchableOpacity onPress={() => Alert.alert('Revoke journey access?', `${contact.name} will no longer be able to view the active journey.`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Revoke access', style: 'destructive', onPress: () => void (async () => {
                    const activeJourney = await AsyncStorage.getItem(ACTIVE_JOURNEY_KEY);
                    if (!activeJourney) { Alert.alert('No active journey', 'Start the journey before changing its contact access.'); return; }
                    try {
                      const revoked = await revokeTrustedContactAccess(activeJourney, contact.email!);
                      Alert.alert(revoked ? 'Access revoked' : 'No active access found', revoked ? `${contact.name} can no longer view this journey.` : `${contact.name} did not have access to this journey.`);
                    } catch (error) { Alert.alert('Could not revoke access', error instanceof Error ? error.message : 'Try again while connected.'); }
                  })() },
                ])}><Text style={styles.removeAccess}>Revoke active journey access</Text></TouchableOpacity></>}</View><TouchableOpacity onPress={() => setContacts((items) => items.filter((_, i) => i !== index))}><Text style={styles.remove}>×</Text></TouchableOpacity></View>)}
            </View>
            <View style={styles.inputCard}><Text style={styles.cardLabel}>ADD A PERSON</Text><TextInput value={contactName} onChangeText={setContactName} placeholder="Name" placeholderTextColor={colors.muted} style={styles.input} /><View style={styles.divider} /><TextInput value={contactPhone} onChangeText={setContactPhone} placeholder="Phone number (saved; SMS unavailable)" keyboardType="phone-pad" placeholderTextColor={colors.muted} style={styles.input} /><View style={styles.divider} /><TextInput value={contactEmail} onChangeText={setContactEmail} placeholder="Email (required for automatic alerts)" keyboardType="email-address" autoCapitalize="none" placeholderTextColor={colors.muted} style={styles.input} /></View>
            <TouchableOpacity style={styles.primaryButton} onPress={addContact}><Text style={styles.primaryButtonText}>Add trusted contact</Text><Text style={styles.buttonArrow}>+</Text></TouchableOpacity>
            <TouchableOpacity style={styles.secondaryButton} onPress={saveSetup}><Text style={styles.secondaryText}>Save safety circle</Text></TouchableOpacity>
            <Text style={styles.privacyNote}>Emergency and evidence alerts use email only. Provider credentials stay in Supabase Edge Function secrets.</Text>
          </>}

          {tab === 'settings' && <>
            <ProfileSectionTabs selected="settings" />
            <View style={styles.profileAccountCard}><Text style={styles.profileName}>{displayName === 'there' ? 'Companion member' : displayName}</Text><Text style={styles.profileDetail}>{userEmail || 'Email not available'}</Text>{!!userPhone && <Text style={styles.profileDetail}>{userPhone}</Text>}</View>
            <Text style={styles.eyebrow}>SAFETY PREFERENCES</Text>
            <Text style={styles.subtitle}>Manage your safety setup, monitoring, notifications, and privacy.</Text>
            <View style={styles.inputCard}>
              <Text style={styles.cardLabel}>FAMILY & GUARDIAN VIEW</Text>
              <Text style={styles.helper}>Manage trusted contacts and control who can access journeys you explicitly share.</Text>
              <TouchableOpacity style={styles.secondaryButton} onPress={() => router.replace('/people')}><Text style={styles.secondaryText}>Manage family and guardians</Text></TouchableOpacity>
            </View>
            <DevicePermissions />
            <TriggerPhraseManager onPrimaryPhraseChange={setPrimaryPhrase} />
            <NotificationPreferences />
            <View style={styles.inputCard}>
              <Text style={styles.cardLabel}>MONITORING</Text>
              <Text style={styles.helper}>Saved phrases are checked by the device speech-recognition service while a journey is active and the app is open. Android also has a background YAMNet classifier for shouting, screaming, crying, whimpering and wailing, plus a fall heuristic, when a signed-in Supabase journey and required permissions are active. Its thresholds are unvalidated. An independent SOS phrase can trigger an emergency alert automatically; lower-confidence sound and motion signals may ask you to check in. This prototype cannot contact emergency services.</Text>
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
              <Text style={styles.cardLabel}>AUDIO MODEL EVALUATION</Text>
              <Text style={styles.helper}>Optional and Android only. While a journey and background audio monitoring are active, save YAMNet prediction metadata (label, confidence, timestamp, and model latency) for a consented evaluation. Companion never saves microphone audio in this log and does not upload it. Do not record around people who have not consented.</Text>
              <View style={styles.statusRow}>
                <Text style={[styles.helper, { flex: 1, marginTop: 0 }]}>Log prediction metadata during active journeys.</Text>
                <Switch value={audioEvaluationLogging} disabled={Platform.OS !== 'android' || !CompanionMonitor} onValueChange={(value) => {
                  setAudioEvaluationLogging(value);
                  void AsyncStorage.setItem('companion-audio-evaluation-logging', String(value));
                }} accessibilityLabel="Opt in to local audio model prediction logging" />
              </View>
              <Text style={styles.helper}>{Platform.OS === 'android' ? audioEvaluationStatus : 'Available only in the Android native build.'}</Text>
              <Text style={styles.helper}>The exported CSV has an empty actual column for manual labeling. Per-window threshold predictions are for evaluation and may differ from the multi-window SOS activation policy.</Text>
              <TouchableOpacity style={styles.secondaryButton} disabled={Platform.OS !== 'android' || !CompanionMonitor} onPress={() => void exportAudioEvaluationCsv()}><Text style={styles.secondaryText}>Export prediction CSV</Text></TouchableOpacity>
              <TouchableOpacity style={styles.secondaryButton} disabled={Platform.OS !== 'android' || !CompanionMonitor} onPress={clearAudioEvaluationCsv}><Text style={styles.secondaryText}>Delete local prediction log</Text></TouchableOpacity>
            </View>
            <View style={styles.inputCard}>
              <Text style={styles.cardLabel}>EMERGENCY AUDIO + VIDEO EVIDENCE</Text>
              <View style={styles.statusRow}>
              <Text style={[styles.helper, { flex: 1, marginTop: 0 }]}>Recording is opt-in. After an SOS, audio capture can run only while Android permits its microphone foreground service. Muted video requires the app open, the device unlocked, camera permission, and an available camera; Android may stop or prevent it in the background. Alerts and location continue if recording is unavailable. Recordings stay in private app files while offline, upload to private Supabase storage when connected, and are accessible only to authorized journey viewers. Delete them from History at any time.</Text>
                <Switch value={evidenceConsent} onValueChange={(value) => { setEvidenceConsent(value); setEvidenceStatus(value ? 'Audio and video evidence enabled for the next emergency' : 'Evidence capture is off'); void AsyncStorage.setItem('companion-evidence-consent', String(value)); }} accessibilityLabel="Opt in to emergency audio and video evidence" />
              </View>
              <Text style={styles.helper}>Cloud and local retention: {evidenceRetentionDays} days. Choose how long saved recordings are kept.</Text>
              <View style={styles.thresholdOptions}>{([7, 30, 90] as const).map((days) => <TouchableOpacity key={days} style={[styles.thresholdOption, evidenceRetentionDays === days && styles.thresholdOptionSelected]} onPress={() => void chooseEvidenceRetention(days)} accessibilityRole="radio" accessibilityState={{ selected: evidenceRetentionDays === days }}><Text style={[styles.thresholdOptionText, evidenceRetentionDays === days && styles.thresholdOptionTextSelected]}>{days} days</Text></TouchableOpacity>)}</View>
              <Text style={styles.helper}>{evidenceStatus}</Text>
            </View>
            <View style={styles.noticeCard}><Text style={styles.noticeIcon}>◉</Text><View style={{ flex: 1 }}><Text style={styles.noticeTitle}>You are in control</Text><Text style={styles.noticeBody}>Monitoring and recording must be clearly shown, opt-in, and limited to an active safety session.</Text></View></View>
            <View style={styles.inputCard}>
              <Text style={styles.cardLabel}>ACCOUNT</Text>
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
          {tab === 'history' && <><ProfileSectionTabs selected="history" /><EmergencyHistory /></>}
          <Text style={styles.footer}>COMPANION SAFETY · PROTOTYPE</Text>
        </ScrollView>
        <View style={[styles.tabBar, { paddingBottom: Math.max(12, NativeStatusBar.currentHeight ? 12 : 18) }]}>
          <TabButton label="Home" icon="⌂" selected={tab === 'home'} onPress={() => router.replace('/')} />
          <TabButton label="Journey" icon="⌖" selected={tab === 'journey'} onPress={() => router.replace('/journey' as never)} />
          <TabButton label="Contacts" icon="♡" selected={tab === 'people'} onPress={() => router.replace('/people')} />
          <TabButton label="Profile" icon="●" selected={tab === 'settings' || tab === 'history'} onPress={() => router.replace('/settings')} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function TabButton({ label, icon, selected, onPress }: { label: string; icon: string; selected: boolean; onPress: () => void }) {
  return <TouchableOpacity style={styles.tabButton} onPress={onPress} accessibilityRole="tab" accessibilityState={{ selected }}><Text style={[styles.tabIcon, selected && styles.tabSelected]}>{icon}</Text><Text style={[styles.tabLabel, selected && styles.tabSelected]}>{label}</Text></TouchableOpacity>;
}

function ProfileSectionTabs({ selected }: { selected: 'settings' | 'history' }) {
  const router = useRouter();
  return <View style={styles.profileTabs} accessibilityRole="tablist">
    <TouchableOpacity style={[styles.profileTab, selected === 'settings' && styles.profileTabSelected]} onPress={() => router.replace('/settings')} accessibilityRole="tab" accessibilityState={{ selected: selected === 'settings' }}><Text style={[styles.profileTabText, selected === 'settings' && styles.profileTabTextSelected]}>Settings</Text></TouchableOpacity>
    <TouchableOpacity style={[styles.profileTab, selected === 'history' && styles.profileTabSelected]} onPress={() => router.replace('/history' as never)} accessibilityRole="tab" accessibilityState={{ selected: selected === 'history' }}><Text style={[styles.profileTabText, selected === 'history' && styles.profileTabTextSelected]}>History</Text></TouchableOpacity>
  </View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#FFFFFF' },
  header: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 9, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  disclosureButton: { minHeight: 45, marginTop: 7, paddingHorizontal: 13, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: '#FFFFFF', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, disclosureText: { color: colors.ink, fontSize: 12, fontWeight: '700' }, disclosureIcon: { color: colors.teal, fontSize: 20, fontWeight: '700' }, detailsLink: { alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 10, marginTop: 5 },
  brand: { color: colors.ink, fontSize: 11, letterSpacing: 1.2, fontWeight: '800' }, brandDot: { color: colors.teal, fontSize: 8 },
  headerSub: { color: colors.muted, fontSize: 9, marginTop: 3 }, avatar: { height: 32, width: 32, borderRadius: 16, backgroundColor: colors.panel2, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line }, avatarText: { color: colors.teal, fontWeight: '700' },
  content: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 30 }, eyebrowRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 7 }, eyebrow: { color: colors.red, letterSpacing: 1.5, fontSize: 9, fontWeight: '800', marginTop: 10 }, pilot: { borderColor: colors.line, backgroundColor: colors.panel, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 20 }, pilotText: { color: colors.muted, fontSize: 8, letterSpacing: 1.2, fontWeight: '700' },
  title: { color: colors.ink, fontSize: 23, lineHeight: 28, letterSpacing: -0.5, fontWeight: '800', marginTop: 8 }, subtitle: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: 6, marginBottom: 13 },
  monitorCard: { backgroundColor: theme.greenSoft, borderWidth: 1, borderColor: '#CDE8DA', padding: 16, borderRadius: 15, marginBottom: 14 }, monitorTop: { flexDirection: 'row', alignItems: 'center', gap: 8 }, monitorHeading: { color: theme.ink, fontSize: 14, fontWeight: '800' }, monitorBody: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 8 }, monitorTags: { flexDirection: 'row', gap: 7, marginTop: 13, flexWrap: 'wrap' }, monitorTag: { color: theme.green, backgroundColor: '#D7EEE2', borderRadius: 12, overflow: 'hidden', fontSize: 8, letterSpacing: 0.6, fontWeight: '800', paddingHorizontal: 8, paddingVertical: 5 },
  homeStatusCard: { backgroundColor: theme.greenSoft, borderWidth: 1, borderColor: '#CDE8DA', borderRadius: 11, padding: 12, marginBottom: 10 }, homeStatusTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 }, homeShield: { color: theme.green, fontSize: 15, marginRight: 7 }, homeStatusLabel: { color: theme.green, fontSize: 9, fontWeight: '800', letterSpacing: 0.3 }, homeStatusTitle: { color: colors.ink, fontSize: 13, fontWeight: '800' }, homeStatusBody: { color: colors.muted, fontSize: 10, marginTop: 4 }, homeLastUpdate: { color: theme.green, fontSize: 10, fontWeight: '700', marginTop: 10 }, homeConfidenceCard: { backgroundColor: theme.navyDeep, borderRadius: 11, padding: 13, marginBottom: 12 }, homeConfidenceTitle: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' }, homeConfidenceBody: { color: '#DCE6EE', fontSize: 10, lineHeight: 15, marginTop: 5, marginBottom: 10 }, homeConfidenceButton: { minHeight: 38, backgroundColor: '#FFFFFF', borderRadius: 8, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, homeConfidenceButtonText: { color: theme.navy, fontSize: 10, fontWeight: '800' }, homeConfidenceArrow: { color: theme.navy, fontSize: 17 }, homePrimaryButton: { minHeight: 50, backgroundColor: theme.navy, borderRadius: 9, marginTop: 16, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, homePrimaryText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' }, homePrimaryArrow: { color: '#FFFFFF', fontSize: 21 }, sectionTitle: { color: colors.ink, fontSize: 9, fontWeight: '800', letterSpacing: 0.6, marginTop: 14, marginBottom: 1 }, homeSupportingText: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 5, marginBottom: 8 }, homeToolCard: { minHeight: 52, flexDirection: 'row', alignItems: 'center', backgroundColor: theme.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 9, paddingHorizontal: 10, marginTop: 7 }, homeToolIcon: { width: 31, height: 31, textAlign: 'center', textAlignVertical: 'center', overflow: 'hidden', borderRadius: 7, backgroundColor: theme.surfaceSoft, color: theme.navy, fontSize: 16, marginRight: 9 }, homeToolTitle: { color: colors.ink, fontSize: 10, fontWeight: '800' }, homeToolBody: { color: colors.muted, fontSize: 9, marginTop: 3 }, homeToolArrow: { color: theme.navy, fontSize: 20, marginLeft: 7 }, homeSosButton: { minHeight: 43, flexDirection: 'row', alignItems: 'center', backgroundColor: theme.redSoft, borderWidth: 1, borderColor: '#F0C8CD', borderRadius: 8, paddingHorizontal: 10, marginTop: 9 }, homeSosIcon: { color: theme.red, borderColor: '#E8B4BA', borderWidth: 1, borderRadius: 15, width: 26, height: 26, textAlign: 'center', textAlignVertical: 'center', overflow: 'hidden', fontWeight: '800', marginRight: 9 }, homeSosTitle: { color: theme.red, fontSize: 10, fontWeight: '800' }, homeSosBody: { color: '#9D5961', fontSize: 8, marginTop: 3 }, homeSosArrow: { color: theme.red, fontSize: 17 },
  journeyFieldCard: { backgroundColor: theme.surface, borderRadius: 15, borderWidth: 1, borderColor: colors.line, padding: 15 }, fieldLabel: { color: colors.muted, fontSize: 9, fontWeight: '800', letterSpacing: 0.7, marginBottom: 7 }, locationField: { minHeight: 45, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: theme.surface, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 11 }, locationFieldIcon: { color: theme.navy, fontSize: 17, marginRight: 8 }, locationFieldText: { color: colors.ink, fontSize: 11, flex: 1 }, journeyDestinationInput: { color: colors.ink, fontSize: 12, flex: 1, paddingVertical: 8 }, travelModeRow: { flexDirection: 'row', gap: 7, marginTop: 9 }, travelModeOption: { flex: 1, minHeight: 42, paddingHorizontal: 4, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: theme.surface, alignItems: 'center', justifyContent: 'center' }, travelModeSelected: { borderColor: theme.navy, backgroundColor: theme.surfaceSoft }, travelModeText: { color: colors.muted, fontSize: 9, fontWeight: '700' }, travelModeTextSelected: { color: theme.navy, fontWeight: '800' }, shareJourneyCard: { flexDirection: 'row', alignItems: 'center', minHeight: 62, backgroundColor: theme.surface, borderRadius: 13, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 13, marginTop: 14 }, estimateCard: { flexDirection: 'row', alignItems: 'center', minHeight: 58, backgroundColor: theme.surfaceSoft, borderRadius: 12, paddingHorizontal: 13, marginTop: 13 }, estimateIcon: { width: 30, color: theme.navy, fontSize: 19, textAlign: 'center', marginRight: 8 }, liveMapCard: { backgroundColor: theme.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 16, padding: 10, marginBottom: 4 }, liveMapHeading: { minHeight: 25, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }, liveMapLabel: { color: theme.green, backgroundColor: theme.greenSoft, overflow: 'hidden', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, fontSize: 8, fontWeight: '800', letterSpacing: 0.4 }, liveMapUpdated: { color: colors.muted, fontSize: 9 }, arrivedButton: { minHeight: 48, backgroundColor: theme.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginTop: 9 }, arrivedButtonText: { color: colors.ink, fontSize: 11, fontWeight: '800' },
  mapCard: { height: 234, borderRadius: 18, backgroundColor: '#E9E9E7', overflow: 'hidden', borderWidth: 1, borderColor: colors.line, padding: 15, justifyContent: 'space-between' }, mapGrid: { ...StyleSheet.absoluteFill, opacity: 0.4, backgroundColor: '#E9E9E7' }, mapRoadA: { position: 'absolute', height: 17, width: 340, backgroundColor: '#D9D9D6', top: 118, left: -55, transform: [{ rotate: '-22deg' }] }, mapRoadB: { position: 'absolute', height: 12, width: 330, backgroundColor: '#D9D9D6', top: 130, right: -150, transform: [{ rotate: '54deg' }] }, mapRoute: { position: 'absolute', height: 3, width: 175, backgroundColor: colors.teal, top: 123, left: 88, transform: [{ rotate: '-36deg' }], borderRadius: 4 }, mapTop: { flexDirection: 'row', alignItems: 'center', zIndex: 1 }, pulse: { height: 7, width: 7, borderRadius: 4, backgroundColor: colors.muted, marginRight: 7 }, pulseActive: { backgroundColor: colors.teal }, mapLive: { color: colors.ink, fontSize: 9, letterSpacing: 1.3, fontWeight: '800', flex: 1 }, mapTime: { color: colors.muted, fontSize: 9, letterSpacing: 1.2 }, mapPin: { position: 'absolute', top: 91, left: '55%', width: 34, height: 34, borderRadius: 18, borderWidth: 7, borderColor: '#D52B3740', backgroundColor: colors.teal, alignItems: 'center', justifyContent: 'center', zIndex: 2 }, pinText: { color: '#FFFFFF', fontSize: 10 }, mapCallout: { position: 'absolute', top: 52, left: 15, backgroundColor: '#FFFFFF', padding: 10, borderRadius: 10, zIndex: 2, borderWidth: 1, borderColor: colors.line }, calloutTitle: { color: colors.ink, fontSize: 10, fontWeight: '700' }, calloutText: { color: colors.muted, fontSize: 9, marginTop: 4 }, mapFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', zIndex: 1 }, coord: { color: colors.muted, fontSize: 9, letterSpacing: 1.2 }, mapArrow: { color: colors.teal, fontSize: 18 },
  mapLocationStatus: { color: colors.muted, fontSize: 10, textAlign: 'center', marginTop: 8, marginBottom: 8 },
  checkInCard: { backgroundColor: '#FFF3DC', borderWidth: 2, borderColor: '#C96912', borderRadius: 15, padding: 16, marginBottom: 15 }, checkInHeading: { color: '#8B3D0A', fontSize: 14, letterSpacing: 0.7, fontWeight: '900' }, checkInBody: { color: colors.ink, fontSize: 13, lineHeight: 19, marginTop: 8 }, checkInActions: { flexDirection: 'row', gap: 10, marginTop: 13 }, checkInSafeButton: { flex: 1, minHeight: 48, borderRadius: 10, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#C96912', alignItems: 'center', justifyContent: 'center' }, checkInSafeText: { color: '#6D330B', fontSize: 13, fontWeight: '800' }, checkInSosButton: { flex: 1, minHeight: 48, borderRadius: 10, backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center' }, checkInSosText: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  speechSetupButton: { minHeight: 42, alignSelf: 'center', paddingHorizontal: 16, borderRadius: 11, backgroundColor: colors.teal, justifyContent: 'center', marginTop: 2, marginBottom: 10 },
  speechSetupButtonText: { color: '#FFFFFF', fontSize: 11, fontWeight: '800' },
  thresholdOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 9 }, thresholdOption: { borderWidth: 1, borderColor: colors.line, borderRadius: 9, paddingVertical: 8, paddingHorizontal: 11, backgroundColor: '#FFFFFF' }, thresholdOptionSelected: { backgroundColor: colors.ink, borderColor: colors.ink }, thresholdOptionText: { color: colors.ink, fontSize: 10, fontWeight: '700' }, thresholdOptionTextSelected: { color: '#FFFFFF' },
  statusRow: { flexDirection: 'row', gap: 8, marginTop: 13, marginBottom: 15 }, pill: { backgroundColor: colors.panel, borderRadius: 30, paddingHorizontal: 11, paddingVertical: 8, flexDirection: 'row', alignItems: 'center' }, pillDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.muted, marginRight: 7 }, pillDotOn: { backgroundColor: colors.teal }, pillText: { color: colors.ink, fontSize: 10 },
  inputCard: { padding: 16, backgroundColor: colors.panel, borderRadius: 15, borderWidth: 1, borderColor: colors.line, marginTop: 10 }, cardLabel: { color: colors.muted, fontSize: 9, letterSpacing: 1.35, fontWeight: '800', marginBottom: 10 }, input: { color: colors.ink, fontSize: 14, paddingVertical: 6 }, triggerDisplay: { color: colors.ink, fontSize: 14, fontWeight: '600' }, divider: { height: 1, backgroundColor: colors.line, marginVertical: 13 },
  primaryButton: { marginTop: 16, backgroundColor: colors.teal, borderRadius: 13, height: 54, paddingHorizontal: 17, alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, stopButton: { backgroundColor: theme.navyDeep, borderWidth: 1, borderColor: theme.navyDeep }, primaryButtonText: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 }, buttonArrow: { color: '#FFFFFF', fontSize: 23, fontWeight: '400' },
  sosButton: { marginTop: 11, borderRadius: 13, borderWidth: 1, borderColor: '#EDB7BC', backgroundColor: '#FCEEEF', paddingHorizontal: 14, height: 64, flexDirection: 'row', alignItems: 'center' }, sosIcon: { color: colors.red, borderColor: '#E8A2A8', borderWidth: 1, borderRadius: 20, height: 30, width: 30, textAlign: 'center', textAlignVertical: 'center', overflow: 'hidden', fontSize: 16, fontWeight: '700', marginRight: 12 }, sosCopy: { flex: 1 }, sosTitle: { color: colors.ink, fontSize: 12, fontWeight: '700' }, sosSub: { color: '#A54D55', fontSize: 9, marginTop: 4 }, sosArrow: { color: colors.red, fontSize: 20 }, privacyNote: { color: colors.muted, textAlign: 'center', fontSize: 10, lineHeight: 15, marginTop: 15, paddingHorizontal: 6 },
  emergencyCard: { backgroundColor: '#FCEEEF', borderRadius: 14, borderWidth: 1, borderColor: '#EDB7BC', padding: 15, marginBottom: 15 }, emergencyHeading: { color: colors.red, fontSize: 12, letterSpacing: 0.7, fontWeight: '900' }, emergencyBody: { color: colors.ink, fontSize: 12, lineHeight: 18, marginTop: 7 }, resolveButton: { backgroundColor: colors.red, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 12, alignItems: 'center', marginTop: 12 }, resolveButtonDisabled: { opacity: 0.55 }, resolveButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  emptyText: { color: colors.muted, fontSize: 13, lineHeight: 20 }, contactRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomColor: colors.line, borderBottomWidth: 1 }, contactAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#FBEDEF', alignItems: 'center', justifyContent: 'center', marginRight: 10 }, contactInitial: { color: colors.teal, fontWeight: '800' }, contactName: { color: colors.ink, fontWeight: '700', fontSize: 13 }, contactPhone: { color: colors.muted, fontSize: 11, marginTop: 3 }, shareLink: { color: colors.teal, fontSize: 10, fontWeight: '700', marginTop: 7 }, removeAccess: { color: colors.red, fontSize: 10, fontWeight: '700', marginTop: 7 }, remove: { color: colors.muted, fontSize: 22, paddingHorizontal: 5 }, secondaryButton: { marginTop: 10, padding: 14, alignItems: 'center' }, secondaryText: { color: colors.teal, fontWeight: '700', fontSize: 12 }, helper: { color: colors.muted, lineHeight: 18, fontSize: 11, marginTop: 7 }, noticeCard: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 14, marginTop: 14, padding: 14, flexDirection: 'row' }, noticeIcon: { color: colors.teal, fontSize: 17, marginRight: 11 }, noticeTitle: { color: colors.ink, fontSize: 12, fontWeight: '700' }, noticeBody: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  profileTabs: { height: 40, flexDirection: 'row', backgroundColor: '#F5F7FA', borderColor: '#CBD3DD', borderWidth: 1, borderRadius: 9, padding: 1, marginBottom: 16 }, profileTab: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 7 }, profileTabSelected: { backgroundColor: theme.navy }, profileTabText: { color: theme.navy, fontSize: 13, fontWeight: '700' }, profileTabTextSelected: { color: '#FFFFFF' }, profileAccountCard: { backgroundColor: '#F5F7FA', borderColor: '#CBD3DD', borderWidth: 1, borderRadius: 10, padding: 15, marginBottom: 16 }, profileName: { color: '#142B49', fontSize: 20, lineHeight: 26, fontWeight: '700' }, profileDetail: { color: '#617084', fontSize: 12, lineHeight: 17, marginTop: 3 },
  footer: { textAlign: 'center', color: colors.muted, fontSize: 8, letterSpacing: 1.6, marginTop: 29 }, tabBar: { height: 67, backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' }, tabButton: { width: '25%', alignItems: 'center', justifyContent: 'center' }, tabIcon: { color: colors.muted, fontSize: 19 }, tabLabel: { color: colors.muted, fontSize: 9, marginTop: 2 }, tabSelected: { color: theme.navy },
});