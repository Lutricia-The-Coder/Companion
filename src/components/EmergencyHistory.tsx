import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAudioPlayer } from 'expo-audio';
import { ActivityIndicator, Alert, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { supabase, supabaseReady } from '../lib/supabase';
import { deleteEmergencyEvidence, requestEvidenceDownload } from '../services/evidence';

type EmergencyHistoryItem = {
  eventId: string;
  journeyId: string;
  type?: string;
  destination?: string;
  activatedAt?: number;
  reason?: string;
  status?: string;
  notificationStatus?: string;
  accepted?: number;
  failures?: number;
  evidence?: EvidenceRecord[];
};

type EvidenceRecord = { evidenceId: string; type: 'audio' | 'video'; expiresAt?: number; durationSeconds?: number };
type StoredEvidence = { id: string; media_type: 'audio' | 'video'; expires_at?: number; duration_seconds?: number };

type LocalEvidence = { eventId: string; uri: string; recordedAt: number; durationSeconds: number };

const C = { bg: '#101C2E', panel: '#17263B', ink: '#F4F7FB', muted: '#9BAABD', teal: '#5CE0C0', line: '#2D4058', red: '#FF6B6B' };

export default function EmergencyHistory() {
  const [items, setItems] = useState<EmergencyHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [evidence, setEvidence] = useState<LocalEvidence[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void AsyncStorage.getItem('companion-emergency-audio-evidence-v1').then((raw) => {
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) setEvidence(parsed as LocalEvidence[]);
      }).catch(() => undefined);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const load = useCallback(async () => {
    if (!supabaseReady || !supabase) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setItems([]); return; }
      const { data, error: queryError } = await supabase.from('journeys').select(
        'id,destination,safety_events(id,event_type,status,reason,activated_at,notifications,evidence(id,media_type,expires_at,duration_seconds))',
      ).eq('owner_id', user.id).order('started_at', { ascending: false }).limit(100);
      if (queryError) throw queryError;
      const history = (data ?? []).flatMap((journey) => (journey.safety_events ?? []).map((event: any) => ({
        eventId: event.id,
        journeyId: journey.id,
        type: event.event_type,
        destination: journey.destination,
        activatedAt: Number(event.activated_at) || undefined,
        reason: event.reason || 'Safety alert',
        status: event.status || 'unknown',
        notificationStatus: event.notifications?.status,
        accepted: Number(event.notifications?.accepted) || 0,
        failures: Number(event.notifications?.failures) || 0,
        evidence: (event.evidence ?? []).map((item: StoredEvidence) => ({
          evidenceId: item.id,
          type: item.media_type,
          expiresAt: Number(item.expires_at) || undefined,
          durationSeconds: item.duration_seconds,
        })),
      }))).sort((a, b) => (b.activatedAt ?? 0) - (a.activatedAt ?? 0));
      setItems(history);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load emergency history.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [load, reload]);

  return <View style={s.wrap}>
    <Text style={s.eyebrow}>YOUR ACCOUNT</Text>
    <Text style={s.title}>Emergency history</Text>
    <Text style={s.subtitle}>Provider acceptance is shown separately from delivery confirmation.</Text>
    <TouchableOpacity style={s.refresh} onPress={() => setReload((value) => value + 1)} accessibilityRole="button"><Text style={s.refreshText}>Refresh history</Text></TouchableOpacity>
    {loading ? <View style={s.state}><ActivityIndicator color={C.teal} /><Text style={s.stateText}>Loading events…</Text></View>
      : error ? <View style={s.state}><Text style={s.error}>{error}</Text></View>
        : items.length === 0 ? <View style={s.state}><Text style={s.stateText}>No emergency events are recorded on this account.</Text></View>
          : <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>{items.map((item) => <View key={`${item.journeyId}-${item.eventId}`} style={s.card}>
            <View style={s.cardTop}><Text style={s.cardTitle}>{item.type === 'route_deviation' ? 'Route deviation alert' : item.status === 'activating' ? 'Emergency activating' : 'Emergency activated'}</Text><Text style={s.date}>{item.activatedAt ? new Date(item.activatedAt).toLocaleString() : 'Time unavailable'}</Text></View>
            <Text style={s.reason}>{item.reason}</Text>
            {item.destination ? <Text style={s.meta}>Journey to {item.destination}</Text> : null}
            <View style={s.divider} />
            <Text style={s.meta}>Message status: {item.notificationStatus ?? 'pending or not available'}</Text>
            {item.notificationStatus ? <Text style={s.meta}>Provider accepted: {item.accepted ?? 0} · failed: {item.failures ?? 0}</Text> : null}
            {item.evidence?.map((record) => <RemoteEvidence key={record.evidenceId} journeyId={item.journeyId} eventId={item.eventId} evidence={record} onDeleted={() => setReload((value) => value + 1)} />)}
          </View>)}</ScrollView>}
    {evidence.length > 0 ? <View style={s.evidenceSection}>
      <Text style={s.evidenceHeading}>Audio evidence stored on this device</Text>
      {evidence.map((item) => <LocalAudioEvidence key={item.eventId} item={item} />)}
      <Text style={s.meta}>Audio clips are local to this app and are not uploaded or shared.</Text>
    </View> : null}
  </View>;
}

function LocalAudioEvidence({ item }: { item: LocalEvidence }) {
  const player = useAudioPlayer(item.uri);
  return <View style={s.card}>
    <Text style={s.reason}>{new Date(item.recordedAt).toLocaleString()} · {item.durationSeconds}s</Text>
    <TouchableOpacity style={s.refresh} onPress={() => player.play()} accessibilityRole="button"><Text style={s.refreshText}>Play local recording</Text></TouchableOpacity>
  </View>;
}

function RemoteEvidence({ journeyId, eventId, evidence, onDeleted }: {
  journeyId: string;
  eventId: string;
  evidence: EvidenceRecord;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const result = await requestEvidenceDownload(journeyId, eventId, evidence.evidenceId);
      await Linking.openURL(result.url);
    } catch (error) {
      Alert.alert('Evidence unavailable', error instanceof Error ? error.message : 'Could not open this evidence.');
    } finally { setBusy(false); }
  };
  const remove = () => Alert.alert('Delete evidence?', 'This permanently deletes the stored audio or video for this event.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => {
      setBusy(true);
      void deleteEmergencyEvidence(journeyId, eventId, evidence.evidenceId)
        .then(onDeleted)
        .catch((error) => Alert.alert('Delete failed', error instanceof Error ? error.message : 'Could not delete evidence.'))
        .finally(() => setBusy(false));
    } },
  ]);
  return <View style={s.evidenceRow}>
    <Text style={s.meta}>{evidence.type === 'video' ? 'Video' : 'Audio'} evidence · {evidence.durationSeconds ?? 20}s{evidence.expiresAt ? ` · expires ${new Date(evidence.expiresAt).toLocaleDateString()}` : ''}</Text>
    <View style={s.evidenceActions}>
      <TouchableOpacity style={s.refresh} disabled={busy} onPress={() => void download()}><Text style={s.refreshText}>{busy ? 'Working…' : 'Open evidence'}</Text></TouchableOpacity>
      <TouchableOpacity style={s.refresh} disabled={busy} onPress={remove}><Text style={s.deleteText}>Delete</Text></TouchableOpacity>
    </View>
  </View>;
}

const s = StyleSheet.create({
  wrap: { flex: 1, paddingTop: 8 }, eyebrow: { color: C.teal, fontSize: 10, fontWeight: '800', letterSpacing: 1.7 },
  title: { color: C.ink, fontSize: 30, lineHeight: 36, fontWeight: '700', marginTop: 12 }, subtitle: { color: C.muted, fontSize: 12, lineHeight: 18, marginTop: 8 },
  refresh: { alignSelf: 'flex-start', paddingHorizontal: 13, paddingVertical: 10, borderColor: C.line, borderWidth: 1, borderRadius: 10, marginTop: 15 }, refreshText: { color: C.teal, fontWeight: '700', fontSize: 11 },
  state: { minHeight: 180, justifyContent: 'center', alignItems: 'center', padding: 20 }, stateText: { color: C.muted, fontSize: 12, textAlign: 'center', lineHeight: 18, marginTop: 10 }, error: { color: C.red, textAlign: 'center', fontSize: 12, lineHeight: 18 },
  evidenceSection: { marginTop: 20 }, evidenceHeading: { color: C.ink, fontSize: 15, fontWeight: '700', marginBottom: 8 },
  evidenceRow: { marginTop: 8 }, evidenceActions: { flexDirection: 'row', gap: 8 }, deleteText: { color: C.red, fontWeight: '700', fontSize: 11 },
  card: { backgroundColor: C.panel, borderRadius: 14, borderWidth: 1, borderColor: C.line, padding: 15, marginTop: 12 }, cardTop: { gap: 5 }, cardTitle: { color: C.red, fontSize: 13, fontWeight: '800' }, date: { color: C.muted, fontSize: 10 }, reason: { color: C.ink, fontSize: 12, lineHeight: 17, marginTop: 10 }, meta: { color: C.muted, fontSize: 10, lineHeight: 16, marginTop: 6 }, divider: { height: 1, backgroundColor: C.line, marginTop: 12 },
});
