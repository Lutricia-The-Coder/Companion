import { randomUUID } from 'expo-crypto';
import { requireSupabase } from '../lib/supabase';

const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['audio/mp4', 'audio/m4a', 'video/mp4']);

export async function uploadEmergencyEvidence(input: {
  uri: string;
  journeyId: string;
  eventId: string;
  type: 'audio' | 'video';
  durationSeconds: number;
}) {
  const client = requireSupabase();
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > 30) {
    throw new Error('Evidence duration is outside the allowed range.');
  }
  const { data: { user } } = await client.auth.getUser();
  if (!user) throw new Error('Sign in before uploading evidence.');
  const response = await fetch(input.uri);
  if (!response.ok) throw new Error('Could not read the local evidence file.');
  const blob = await response.blob();
  const contentType = input.type === 'video' ? 'video/mp4' : 'audio/mp4';
  if (!ALLOWED_TYPES.has(contentType) || blob.size <= 0 || blob.size > MAX_EVIDENCE_BYTES) {
    throw new Error('Evidence file type or size is not allowed.');
  }
  const evidenceId = randomUUID();
  const objectPath = `${user.id}/${input.journeyId}/${input.eventId}/${evidenceId}`;
  const { error: uploadError } = await client.storage.from('evidence').upload(objectPath, await blob.arrayBuffer(), {
    contentType,
    upsert: false,
  });
  if (uploadError) throw uploadError;

  const { data, error } = await client.functions.invoke('register-evidence', {
    body: {
      journeyId: input.journeyId,
      eventId: input.eventId,
      evidenceId,
      objectPath,
      contentType,
      durationSeconds: input.durationSeconds,
      sizeBytes: blob.size,
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
