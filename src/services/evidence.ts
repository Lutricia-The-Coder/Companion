import { randomUUID } from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { requireSupabase } from '../lib/supabase';

const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['audio/mp4', 'audio/m4a', 'video/mp4']);
export const EVIDENCE_OUTBOX_KEY = 'companion-emergency-evidence-outbox-v1';
export const EVIDENCE_RETENTION_KEY = 'companion-evidence-retention-days';
const LEGACY_AUDIO_KEY = 'companion-emergency-audio-evidence-v1';
const MAX_UPLOAD_ATTEMPTS = 8;
const MAX_OUTBOX_RECORDS = 50;
const LOCAL_RETENTION_MS = 30 * 24 * 60 * 60_000;
const RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export type EvidenceOutboxRecord = {
  evidenceId: string;
  eventId: string;
  journeyId: string | null;
  uri: string;
  type: 'audio' | 'video';
  recordedAt: number;
  durationSeconds: number;
  uploadAttempts: number;
  nextUploadAt?: number;
  uploadStatus: 'pending' | 'uploaded' | 'failed';
  expiresAt?: number;
  notificationStatus?: string;
};

let outboxWorkerActive = false;
let legacyMigration: Promise<void> | null = null;

async function readOutbox(): Promise<EvidenceOutboxRecord[]> {
  const raw = await AsyncStorage.getItem(EVIDENCE_OUTBOX_KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed as EvidenceOutboxRecord[] : [];
}

async function writeOutbox(records: EvidenceOutboxRecord[]) {
  await AsyncStorage.setItem(EVIDENCE_OUTBOX_KEY, JSON.stringify(records));
}

async function migrateLegacyAudioRecords() {
  if (legacyMigration) return legacyMigration;
  legacyMigration = (async () => {
    const legacyRaw = await AsyncStorage.getItem(LEGACY_AUDIO_KEY);
    if (!legacyRaw) return;
    const legacy = JSON.parse(legacyRaw) as { eventId?: string; uri?: string; recordedAt?: number; durationSeconds?: number; evidenceId?: string; expiresAt?: number }[];
    let records = await readOutbox();
    for (const item of legacy) {
      if (!item.eventId || !item.uri || records.some((record) => record.eventId === item.eventId && record.type === 'audio')) continue;
      const evidenceId = item.evidenceId ?? randomUUID();
      const directory = new Directory(Paths.document, 'companion-emergency-evidence');
      directory.create({ idempotent: true, intermediates: true });
      const destination = new File(directory, `${evidenceId}.m4a`);
      let uri = item.uri;
      try {
        await new File(item.uri).copy(destination, { overwrite: true });
        uri = destination.uri;
      } catch { /* Keep the original private app file when migration cannot copy it. */ }
      records = [...records, {
        evidenceId,
        eventId: item.eventId,
        journeyId: null,
        uri,
        type: 'audio',
        recordedAt: item.recordedAt ?? Date.now(),
        durationSeconds: item.durationSeconds ?? 20,
        uploadAttempts: 0,
        uploadStatus: item.evidenceId ? 'uploaded' : 'pending',
        expiresAt: item.expiresAt,
      }];
    }
    await writeOutbox(records);
    await AsyncStorage.removeItem(LEGACY_AUDIO_KEY);
  })().finally(() => { legacyMigration = null; });
  return legacyMigration;
}

export async function loadEvidenceOutbox() {
  await migrateLegacyAudioRecords();
  return readOutbox();
}

export async function enqueueEmergencyEvidence(input: {
  uri: string;
  journeyId: string | null;
  eventId: string;
  type: 'audio' | 'video';
  durationSeconds: number;
  recordedAt?: number;
}) {
  const records = await readOutbox();
  const existing = records.find((record) => record.eventId === input.eventId && record.type === input.type);
  if (existing) return existing;
  if (records.length >= MAX_OUTBOX_RECORDS) throw new Error('Evidence storage is full. Delete older local evidence before recording another clip.');
  const evidenceId = randomUUID();
  const directory = new Directory(Paths.document, 'companion-emergency-evidence');
  directory.create({ idempotent: true, intermediates: true });
  const extension = input.type === 'audio' ? 'm4a' : 'mp4';
  const source = new File(input.uri);
  const destination = new File(directory, `${evidenceId}.${extension}`);
  await source.copy(destination);
  const recordedAt = input.recordedAt ?? Date.now();
  const configuredRetention = Number(await AsyncStorage.getItem(EVIDENCE_RETENTION_KEY));
  const retentionDays = configuredRetention === 7 || configuredRetention === 90 ? configuredRetention : 30;
  const record: EvidenceOutboxRecord = {
    ...input,
    uri: destination.uri,
    evidenceId,
    recordedAt,
    uploadAttempts: 0,
    uploadStatus: 'pending',
    expiresAt: recordedAt + retentionDays * 24 * 60 * 60_000,
  };
  try {
    await writeOutbox([...records, record]);
  } catch (error) {
    if (destination.exists) destination.delete();
    throw error;
  }
  return record;
}

export async function deleteLocalEmergencyEvidence(evidenceId: string) {
  const records = await readOutbox();
  const record = records.find((item) => item.evidenceId === evidenceId);
  if (record) {
    const file = new File(record.uri);
    if (file.exists) file.delete();
  }
  await writeOutbox(records.filter((item) => item.evidenceId !== evidenceId));
}

export async function clearLocalEmergencyEvidence() {
  const records = await readOutbox();
  await Promise.all(records.map(async (record) => {
    const file = new File(record.uri);
    if (file.exists) file.delete();
  }));
  await AsyncStorage.multiRemove([EVIDENCE_OUTBOX_KEY, LEGACY_AUDIO_KEY]);
}

async function removeExpiredLocalEvidence() {
  const records = await readOutbox();
  const now = Date.now();
  const retained: EvidenceOutboxRecord[] = [];
  for (const record of records) {
    const expiresAt = record.expiresAt ?? (record.recordedAt + LOCAL_RETENTION_MS);
    if (expiresAt <= now) {
      const file = new File(record.uri);
      if (file.exists) file.delete();
    } else retained.push(record);
  }
  if (retained.length !== records.length) await writeOutbox(retained);
}

/** Retry queued evidence after an interrupted or offline upload. The same object ID is reused. */
export async function uploadPendingEmergencyEvidence(options: {
  retryFailed?: boolean;
  retryNow?: boolean;
  onStatus?: (message: string) => void;
} = {}) {
  if (outboxWorkerActive) return { uploaded: 0, pending: 0, failed: 0, errors: ['An evidence upload is already running.'] };
  outboxWorkerActive = true;
  let uploaded = 0;
  const errors: string[] = [];
  try {
    await migrateLegacyAudioRecords();
    await removeExpiredLocalEvidence();
    const now = Date.now();
    let records = await readOutbox();
    if (options.retryFailed) {
      records = records.map((record) => record.uploadStatus === 'failed'
        ? { ...record, uploadAttempts: 0, nextUploadAt: undefined, uploadStatus: 'pending' }
        : record);
      await writeOutbox(records);
    }
    if (options.retryNow) {
      records = records.map((record) => record.uploadStatus === 'uploaded'
        ? record
        : { ...record, nextUploadAt: undefined });
      await writeOutbox(records);
    }
    for (const record of records) {
      if (record.uploadStatus === 'uploaded' || !record.journeyId
        || record.uploadAttempts >= MAX_UPLOAD_ATTEMPTS
        || (record.nextUploadAt !== undefined && record.nextUploadAt > now)) continue;
      const nextAttempt = record.uploadAttempts + 1;
      const retryAt = Date.now() + RETRY_DELAYS_MS[Math.min(record.uploadAttempts, RETRY_DELAYS_MS.length - 1)];
      records = records.map((item) => item.evidenceId === record.evidenceId
        ? { ...item, uploadAttempts: nextAttempt, nextUploadAt: retryAt }
        : item);
      await writeOutbox(records);
      try {
        const result = await uploadEmergencyEvidence({
          uri: record.uri,
          journeyId: record.journeyId,
          eventId: record.eventId,
          evidenceId: record.evidenceId,
          type: record.type,
          durationSeconds: record.durationSeconds,
          recordedAt: record.recordedAt,
        });
        records = records.map((item) => item.evidenceId === record.evidenceId
          ? { ...item, uploadStatus: 'uploaded', expiresAt: result.expiresAt, notificationStatus: result.notifications?.status, nextUploadAt: undefined }
          : item);
        uploaded++;
        options.onStatus?.(`${record.type === 'audio' ? 'Audio' : 'Video'} evidence uploaded to private storage.`);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : 'Unknown upload error.';
        errors.push(`${record.type === 'audio' ? 'Audio' : 'Video'}: ${detail}`);
        if (nextAttempt >= MAX_UPLOAD_ATTEMPTS) {
          records = records.map((item) => item.evidenceId === record.evidenceId
            ? { ...item, uploadStatus: 'failed', nextUploadAt: undefined }
            : item);
        }
        options.onStatus?.(nextAttempt >= MAX_UPLOAD_ATTEMPTS
          ? `${record.type === 'audio' ? 'Audio' : 'Video'} upload stopped after ${MAX_UPLOAD_ATTEMPTS} failures; the device copy remains available for manual retry. ${detail}`
          : `${record.type === 'audio' ? 'Audio' : 'Video'} evidence upload attempt ${nextAttempt} failed; it remains queued for retry. ${detail}`);
      }
      await writeOutbox(records);
    }
    const latest = await readOutbox();
    return { uploaded, pending: latest.filter((item) => item.uploadStatus === 'pending').length, failed: latest.filter((item) => item.uploadStatus === 'failed').length, errors };
  } finally {
    outboxWorkerActive = false;
  }
}

export async function uploadEmergencyEvidence(input: {
  uri: string;
  journeyId: string;
  eventId: string;
  evidenceId?: string;
  type: 'audio' | 'video';
  durationSeconds: number;
  recordedAt: number;
}) {
  const client = requireSupabase();
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > 30) {
    throw new Error('Evidence duration is outside the allowed range.');
  }
  const { data: { user } } = await client.auth.getUser();
  if (!user) throw new Error('Sign in before uploading evidence.');
  const file = new File(input.uri);
  if (!file.exists) throw new Error('Could not read the local evidence file.');
  const contentType = input.type === 'video' ? 'video/mp4' : 'audio/mp4';
  const sizeBytes = file.size;
  if (!ALLOWED_TYPES.has(contentType) || sizeBytes <= 0 || sizeBytes > MAX_EVIDENCE_BYTES) {
    throw new Error('Evidence file type or size is not allowed.');
  }
  const fileContents = await file.arrayBuffer();
  const evidenceId = input.evidenceId ?? randomUUID();
  const objectPath = `${user.id}/${input.journeyId}/${input.eventId}/${evidenceId}`;
  const { error: uploadError } = await client.storage.from('evidence').upload(objectPath, fileContents, {
    contentType,
    upsert: false,
  });
  const objectAlreadyExists = uploadError && 'statusCode' in uploadError && String(uploadError.statusCode) === '409';
  if (uploadError && !objectAlreadyExists) throw uploadError;

  const { data, error } = await client.functions.invoke('register-evidence', {
    body: {
      journeyId: input.journeyId,
      eventId: input.eventId,
      evidenceId,
      objectPath,
      contentType,
      durationSeconds: input.durationSeconds,
      recordedAt: input.recordedAt,
      sizeBytes,
    },
  });
  if (error) {
    await client.storage.from('evidence').remove([objectPath]).catch(() => undefined);
    throw error;
  }
  return data as { evidenceId: string; expiresAt: number; notifications?: { status: string; accepted: number; failures: number } };
}

export async function requestEvidenceDownload(journeyId: string, eventId: string, evidenceId: string) {
  const { data, error } = await requireSupabase().functions.invoke('get-evidence-download-url', {
    body: { journeyId, eventId, evidenceId },
  });
  if (error) throw error;
  return data as { url: string; type: 'audio' | 'video'; contentType: string; expiresAt: number };
}

export async function deleteEmergencyEvidence(journeyId: string, eventId: string, evidenceId: string) {
  const { data, error } = await requireSupabase().functions.invoke('delete-evidence', {
    body: { journeyId, eventId, evidenceId },
  });
  if (error) throw error;
  return data as { deleted: boolean };
}
