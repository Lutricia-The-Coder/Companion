import { useCallback, useEffect, useState } from 'react';
import { useAudioPlayer } from 'expo-audio';
import { useVideoPlayer, VideoView } from 'expo-video';
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { supabase, supabaseReady } from '../lib/supabase';
import { deleteEmergencyEvidence, deleteLocalEmergencyEvidence, loadEvidenceOutbox, requestEvidenceDownload, uploadPendingEmergencyEvidence, type EvidenceOutboxRecord } from '../services/evidence';
import { theme } from '../theme';

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
  unknown?: number;
  evidence?: EvidenceRecord[];
};

type JourneyHistoryItem = {
  journeyId: string;
  destination?: string;
  status: string;
  startedAt?: number;
  endedAt?: number;
  events: EmergencyHistoryItem[];
};

type EvidenceRecord = { evidenceId: string; type: 'audio' | 'video'; recordedAt?: number; expiresAt?: number; durationSeconds?: number };
type StoredEvidence = { id: string; media_type: 'audio' | 'video'; recorded_at?: number; expires_at?: number; duration_seconds?: number };

const C = { bg: theme.background, panel: theme.surface, ink: theme.ink, muted: theme.muted, teal: theme.navy, line: theme.line, red: theme.red };

export default function EmergencyHistory() {
  const [journeys, setJourneys] = useState<JourneyHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [evidence, setEvidence] = useState<EvidenceOutboxRecord[]>([]);
  const [retryingUploads, setRetryingUploads] = useState(false);

  useEffect(() => {
    let mounted = true;
    void loadEvidenceOutbox().then((records) => { if (mounted) setEvidence(records); }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  const load = useCallback(async () => {
    if (!supabaseReady || !supabase) {
      setJourneys([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setJourneys([]); return; }
      const { data, error: queryError } = await supabase.from('journeys').select(
        'id,destination,status,started_at,ended_at,safety_events(id,event_type,status,reason,activated_at,notifications,evidence(id,media_type,recorded_at,expires_at,duration_seconds))',
      ).eq('owner_id', user.id).eq('status', 'ended').order('started_at', { ascending: false }).limit(100);
      if (queryError) throw queryError;
      const history = (data ?? []).map((journey) => ({
        journeyId: journey.id,
        destination: journey.destination ?? undefined,
        status: journey.status ?? 'unknown',
        startedAt: Number(journey.started_at) || undefined,
        endedAt: Number(journey.ended_at) || undefined,
        events: (journey.safety_events ?? []).map((event: any) => ({
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
          unknown: Number(event.notifications?.unknown) || 0,
          evidence: (event.evidence ?? []).map((item: StoredEvidence) => ({
            evidenceId: item.id,
            type: item.media_type,
            recordedAt: Number(item.recorded_at) || undefined,
            expiresAt: Number(item.expires_at) || undefined,
            durationSeconds: item.duration_seconds,
          })),
        })).sort((a, b) => (b.activatedAt ?? 0) - (a.activatedAt ?? 0)),
      }));
      setJourneys(history);
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
    <Text style={s.title}>Journey history</Text>
    <Text style={s.subtitle}>Your past journeys, in one place.</Text>
    <TouchableOpacity style={s.refresh} onPress={() => setReload((value) => value + 1)} accessibilityRole="button"><Text style={s.refreshText}>Refresh history</Text></TouchableOpacity>
    {evidence.length > 0 ? <View style={s.evidenceSection}>
      <Text style={s.evidenceHeading}>Evidence on this device</Text>
      <Text style={s.meta}>Local files are removed at their selected retention deadline. Uploaded files stay in private storage and are available only to authorized journey viewers until server expiry.</Text>
      {evidence.some((item) => item.uploadStatus !== 'uploaded') ? <TouchableOpacity style={s.refresh} disabled={retryingUploads} onPress={() => {
        setRetryingUploads(true);
        void uploadPendingEmergencyEvidence({ retryFailed: true, retryNow: true }).then(async (result) => {
          setEvidence(await loadEvidenceOutbox());
          const summary = result.uploaded > 0
            ? `${result.uploaded} evidence file${result.uploaded === 1 ? '' : 's'} uploaded privately.`
            : result.errors.length > 0
              ? result.errors.join('\n')
              : 'No queued files were eligible to upload. Check that you are signed in and the recording belongs to a journey.';
          Alert.alert(result.uploaded > 0 ? 'Upload retry complete' : 'Upload could not complete', summary);
        }).catch((cause) => Alert.alert('Upload retry failed', cause instanceof Error ? cause.message : 'Try again when connected.')).finally(() => setRetryingUploads(false));
      }}><Text style={s.refreshText}>{retryingUploads ? 'Retrying…' : 'Retry evidence uploads'}</Text></TouchableOpacity> : null}
      {evidence.map((item) => <LocalEvidenceCard key={item.evidenceId} item={item} onDeleted={async () => setEvidence(await loadEvidenceOutbox())} />)}
    </View> : null}
    {loading ? <View style={s.state}><ActivityIndicator color={C.teal} /><Text style={s.stateText}>Loading journey history…</Text></View>
      : error ? <View style={s.state}><Text style={s.error}>{error}</Text></View>
        : journeys.length === 0 ? <View style={s.state}><Text style={s.stateText}>No journeys have been recorded on this account.</Text></View>
          : <>
          <View style={s.summaryCard}><Text style={s.summaryLabel}>YOUR JOURNEY RECORD</Text><Text style={s.summaryCount}>{journeys.length} completed journey{journeys.length === 1 ? '' : 's'}</Text></View>
          <Text style={s.sectionHeading}>RECENT JOURNEYS</Text>
          {journeys.map((journey) => <View key={journey.journeyId} style={s.journeyCard}>
            <View style={s.journeyTop}><Text style={s.date}>{journey.startedAt ? new Date(journey.startedAt).toLocaleString() : 'Start time unavailable'}</Text><View style={s.completedBadge}><Text style={s.completedText}>COMPLETED</Text></View></View>
            <Text style={s.journeyTitle}>{journey.destination || 'Safety journey'}</Text>
            <Text style={s.meta}>{journey.startedAt && journey.endedAt && journey.endedAt >= journey.startedAt ? `${Math.max(1, Math.round((journey.endedAt - journey.startedAt) / 60_000))} min` : 'Duration unavailable'} · {journey.events.length ? `${journey.events.length} safety event${journey.events.length === 1 ? '' : 's'}` : 'No safety alerts'}</Text>
            {journey.events.map((item) => <View key={item.eventId} style={s.eventCard}>
              <View style={s.cardTop}><Text style={s.cardTitle}>{item.type === 'route_deviation' ? 'Route deviation alert' : item.status === 'activating' ? 'Emergency activating' : 'Emergency activated'}</Text><Text style={s.date}>{item.activatedAt ? new Date(item.activatedAt).toLocaleString() : 'Time unavailable'}</Text></View>
              <Text style={s.reason}>{item.reason}</Text>
              <View style={s.divider} />
              <Text style={s.meta}>Message status: {item.notificationStatus ?? 'pending or not available'}</Text>
              {item.notificationStatus ? <Text style={s.meta}>Provider accepted: {item.accepted ?? 0} · failed: {item.failures ?? 0} · unknown: {item.unknown ?? 0}</Text> : null}
              {item.evidence?.map((record) => <RemoteEvidence key={record.evidenceId} journeyId={item.journeyId} eventId={item.eventId} evidence={record} onDeleted={() => setReload((value) => value + 1)} />)}
            </View>)}
          </View>)}
          <Text style={s.meta}>Only completed journeys appear in your history.</Text>
          </>}
  </View>;
}

function LocalEvidenceCard({ item, onDeleted }: { item: EvidenceOutboxRecord; onDeleted: () => void }) {
  const player = useAudioPlayer(item.type === 'audio' ? item.uri : null);
  const [videoOpen, setVideoOpen] = useState(false);
  const status = item.uploadStatus === 'uploaded' ? 'Uploaded privately' : item.uploadStatus === 'failed' ? 'Upload failed · manual retry available' : item.journeyId ? `Upload queued · ${item.uploadAttempts} attempts` : 'Saved locally · no signed-in journey';
  return <View style={s.card}>
    <Text style={s.reason}>{item.type === 'video' ? 'Video' : 'Audio'} · {new Date(item.recordedAt).toLocaleString()} · {item.durationSeconds}s</Text>
    <Text style={s.meta}>{status}</Text>
    {item.type === 'audio' ? <TouchableOpacity style={s.refresh} onPress={() => player.play()} accessibilityRole="button"><Text style={s.refreshText}>Play local recording</Text></TouchableOpacity> : null}
    {item.type === 'video' ? <>
      <TouchableOpacity style={s.refresh} onPress={() => setVideoOpen((open) => !open)} accessibilityRole="button" accessibilityState={{ expanded: videoOpen }}>
        <Text style={s.refreshText}>{videoOpen ? 'Hide local video' : 'Play local video'}</Text>
      </TouchableOpacity>
      {videoOpen ? <LocalVideoPlayer uri={item.uri} /> : null}
    </> : null}
    <TouchableOpacity style={s.refresh} onPress={() => Alert.alert('Delete local evidence?', 'This permanently removes the device copy. Any uploaded private copy must be deleted separately from the event record.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete local copy', style: 'destructive', onPress: () => { void deleteLocalEmergencyEvidence(item.evidenceId).then(onDeleted).catch((error) => Alert.alert('Delete failed', error instanceof Error ? error.message : 'Could not delete the local file.')); } },
    ])}><Text style={s.deleteText}>Delete local copy</Text></TouchableOpacity>
  </View>;
}

function LocalVideoPlayer({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (videoPlayer) => { videoPlayer.play(); });
  return <VideoView player={player} nativeControls contentFit="contain" style={s.localVideo} />;
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
    <Text style={s.meta}>{evidence.type === 'video' ? 'Video' : 'Audio'} evidence · {evidence.recordedAt ? `recorded ${new Date(evidence.recordedAt).toLocaleString()} · ` : ''}{evidence.durationSeconds ?? 20}s{evidence.expiresAt ? ` · expires ${new Date(evidence.expiresAt).toLocaleDateString()}` : ''}</Text>
    <View style={s.evidenceActions}>
      <TouchableOpacity style={s.refresh} disabled={busy} onPress={() => void download()}><Text style={s.refreshText}>{busy ? 'Working…' : 'Open evidence'}</Text></TouchableOpacity>
      <TouchableOpacity style={s.refresh} disabled={busy} onPress={remove}><Text style={s.deleteText}>Delete</Text></TouchableOpacity>
    </View>
  </View>;
}

const s = StyleSheet.create({
  wrap: { paddingTop: 8 }, eyebrow: { color: C.teal, fontSize: 10, fontWeight: '800', letterSpacing: 1.7 },
  title: { color: C.ink, fontSize: 27, lineHeight: 34, fontWeight: '700', marginTop: 12 }, subtitle: { color: C.muted, fontSize: 13, lineHeight: 19, marginTop: 8 },
  refresh: { alignSelf: 'flex-start', paddingHorizontal: 13, paddingVertical: 10, borderColor: C.line, borderWidth: 1, borderRadius: 10, marginTop: 15 }, refreshText: { color: C.teal, fontWeight: '700', fontSize: 11 },
  state: { minHeight: 180, justifyContent: 'center', alignItems: 'center', padding: 20 }, stateText: { color: C.muted, fontSize: 12, textAlign: 'center', lineHeight: 18, marginTop: 10 }, error: { color: C.red, textAlign: 'center', fontSize: 12, lineHeight: 18 },
  evidenceSection: { marginTop: 20 }, evidenceHeading: { color: C.ink, fontSize: 15, fontWeight: '700', marginBottom: 8 },
  localVideo: { width: '100%', height: 230, marginTop: 12, borderRadius: 10, backgroundColor: '#000000' },
  evidenceRow: { marginTop: 8 }, evidenceActions: { flexDirection: 'row', gap: 8 }, deleteText: { color: C.red, fontWeight: '700', fontSize: 11 },
  summaryCard: { backgroundColor: '#F5F7FA', borderColor: '#CBD3DD', borderWidth: 1, borderRadius: 8, padding: 15, marginTop: 16 }, summaryLabel: { color: C.muted, fontSize: 10, lineHeight: 15, fontWeight: '700' }, summaryCount: { color: '#142B49', fontSize: 20, lineHeight: 28, fontWeight: '700', marginTop: 4 }, sectionHeading: { color: C.muted, fontSize: 11, lineHeight: 16, fontWeight: '700', marginTop: 19 },
  journeyCard: { backgroundColor: '#FFFFFF', borderRadius: 8, borderWidth: 1, borderColor: '#CBD3DD', padding: 15, marginTop: 11 }, journeyTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }, journeyTitle: { color: '#142B49', fontSize: 14, lineHeight: 20, fontWeight: '700', marginTop: 8 }, completedBadge: { backgroundColor: '#EDF7F1', borderColor: '#B7D8C5', borderWidth: 1, borderRadius: 5, paddingVertical: 4, paddingHorizontal: 7, minWidth: 87, alignItems: 'center' }, completedText: { color: '#16734B', fontSize: 9, lineHeight: 13, fontWeight: '700' }, eventCard: { backgroundColor: '#F5F7FA', borderRadius: 8, borderWidth: 1, borderColor: C.line, padding: 12, marginTop: 12 }, card: { backgroundColor: C.panel, borderRadius: 14, borderWidth: 1, borderColor: C.line, padding: 15, marginTop: 12 }, cardTop: { gap: 5 }, cardTitle: { color: C.red, fontSize: 13, fontWeight: '800' }, date: { color: C.muted, fontSize: 10, lineHeight: 16 }, reason: { color: C.ink, fontSize: 12, lineHeight: 17, marginTop: 10 }, meta: { color: C.muted, fontSize: 10, lineHeight: 16, marginTop: 6 }, divider: { height: 1, backgroundColor: C.line, marginTop: 12 },
});
