import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export type TriggerPhrase = {
  id: string;
  phrase: string;
  enabled: boolean;
  independentActivation: boolean;
};

const STORAGE_KEY = 'companion-trigger-phrases-v1';
const LEGACY_KEY = 'companion-trigger';
const WEB_KEY = 'companion-trigger-phrases-web-v1';
const MAX_PHRASES = 8;

export type TriggerPhraseStorage = 'encrypted-device' | 'web-local-only';

function parsePhrases(raw: string | null): TriggerPhrase[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is TriggerPhrase =>
      !!value && typeof value === 'object'
      && typeof value.id === 'string'
      && typeof value.phrase === 'string'
      && typeof value.enabled === 'boolean'
      && typeof value.independentActivation === 'boolean'
      && value.phrase.trim().length >= 2,
    ).slice(0, MAX_PHRASES);
  } catch {
    return [];
  }
}

async function readStored(): Promise<{ value: string | null; storage: TriggerPhraseStorage }> {
  if (Platform.OS === 'web') {
    return { value: await AsyncStorage.getItem(WEB_KEY), storage: 'web-local-only' };
  }
  if (!await SecureStore.isAvailableAsync()) throw new Error('Encrypted phrase storage is unavailable on this device.');
  return { value: await SecureStore.getItemAsync(STORAGE_KEY), storage: 'encrypted-device' };
}

async function writeStored(value: string): Promise<TriggerPhraseStorage> {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(WEB_KEY, value);
    return 'web-local-only';
  }
  if (!await SecureStore.isAvailableAsync()) throw new Error('Encrypted phrase storage is unavailable on this device.');
  await SecureStore.setItemAsync(STORAGE_KEY, value);
  return 'encrypted-device';
}

export async function loadTriggerPhrases(): Promise<{ phrases: TriggerPhrase[]; storage: TriggerPhraseStorage }> {
  const stored = await readStored();
  if (stored.value) return { phrases: parsePhrases(stored.value), storage: stored.storage };

  // One-time migration of the prototype's single unencrypted phrase into device-encrypted storage.
  if (Platform.OS !== 'web') {
    const legacy = (await AsyncStorage.getItem(LEGACY_KEY))?.trim();
    if (legacy) {
      const phrase: TriggerPhrase = { id: `legacy-${Date.now()}`, phrase: legacy, enabled: true, independentActivation: true };
      await writeStored(JSON.stringify([phrase]));
      await AsyncStorage.removeItem(LEGACY_KEY);
      return { phrases: [phrase], storage: 'encrypted-device' };
    }
  }
  return { phrases: [], storage: stored.storage };
}

export async function saveTriggerPhrases(phrases: TriggerPhrase[]): Promise<TriggerPhraseStorage> {
  if (phrases.length > MAX_PHRASES) throw new Error(`You can save up to ${MAX_PHRASES} trigger phrases.`);
  const normalized = phrases.map((item) => ({ ...item, phrase: item.phrase.trim().replace(/\s+/g, ' ') }));
  if (normalized.some((item) => item.phrase.length < 2 || item.phrase.length > 80)) {
    throw new Error('Each phrase must be between 2 and 80 characters.');
  }
  const unique = new Set(normalized.map((item) => item.phrase.toLocaleLowerCase()));
  if (unique.size !== normalized.length) throw new Error('Trigger phrases must be unique.');
  return writeStored(JSON.stringify(normalized));
}

export function createTriggerPhrase(phrase: string, independentActivation = true): TriggerPhrase {
  return {
    id: `phrase-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    phrase: phrase.trim().replace(/\s+/g, ' '),
    enabled: true,
    independentActivation,
  };
}
