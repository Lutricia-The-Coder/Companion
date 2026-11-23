import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const PREFIX = 'companion-private-v1-';
const CHUNK_SIZE = 1500;

export async function getEncryptedItem(key: string) {
  if (!await SecureStore.isAvailableAsync()) throw new Error('Secure device storage is unavailable.');
  const value = await SecureStore.getItemAsync(key);
  if (!value?.startsWith('@companion-chunks:')) return value;
  const count = Number(value.slice('@companion-chunks:'.length));
  if (!Number.isInteger(count) || count < 1 || count > 128) throw new Error('Secure device data is corrupt.');
  const chunks = await Promise.all(Array.from({ length: count }, (_, index) => SecureStore.getItemAsync(`${key}-${index}`)));
  if (chunks.some((chunk) => chunk === null)) throw new Error('Secure device data is incomplete.');
  return chunks.join('');
}

export async function setEncryptedItem(key: string, value: string) {
  if (!await SecureStore.isAvailableAsync()) throw new Error('Secure device storage is unavailable.');
  const previous = await SecureStore.getItemAsync(key);
  const previousCount = previous?.startsWith('@companion-chunks:') ? Number(previous.slice('@companion-chunks:'.length)) : 0;
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + CHUNK_SIZE, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!) && /[\uDC00-\uDFFF]/.test(value[end]!)) end--;
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  if (chunks.length <= 1) {
    await SecureStore.setItemAsync(key, value);
  } else {
    if (chunks.length > 128) throw new Error('Secure data exceeds the device storage limit.');
    await Promise.all(chunks.map((chunk, index) => SecureStore.setItemAsync(`${key}-${index}`, chunk)));
    await SecureStore.setItemAsync(key, `@companion-chunks:${chunks.length}`);
  }
  if (previousCount > chunks.length) {
    await Promise.all(Array.from({ length: previousCount - chunks.length }, (_, index) => SecureStore.deleteItemAsync(`${key}-${chunks.length + index}`)));
  }
}

export async function deleteEncryptedItem(key: string) {
  if (!await SecureStore.isAvailableAsync()) return;
  const previous = await SecureStore.getItemAsync(key);
  const count = previous?.startsWith('@companion-chunks:') ? Number(previous.slice('@companion-chunks:'.length)) : 0;
  await SecureStore.deleteItemAsync(key);
  if (count > 0 && count <= 128) await Promise.all(Array.from({ length: count }, (_, index) => SecureStore.deleteItemAsync(`${key}-${index}`)));
}

export async function getPrivateItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') return AsyncStorage.getItem(key);
  const secureValue = await getEncryptedItem(`${PREFIX}${key}`);
  if (secureValue !== null) return secureValue;
  // One-time upgrade for existing local installs. The old plaintext copy is removed
  // only after a successful encrypted write.
  const legacy = await AsyncStorage.getItem(key);
  if (legacy !== null) {
    await setPrivateItem(key, legacy);
    await AsyncStorage.removeItem(key);
  }
  return legacy;
}

export async function setPrivateItem(key: string, value: string) {
  if (Platform.OS === 'web') return AsyncStorage.setItem(key, value);
  if (!await SecureStore.isAvailableAsync()) throw new Error('Secure device storage is unavailable.');
  await setEncryptedItem(`${PREFIX}${key}`, value);
}

export async function removePrivateItem(key: string) {
  if (Platform.OS === 'web') return AsyncStorage.removeItem(key);
  await deleteEncryptedItem(`${PREFIX}${key}`);
  await AsyncStorage.removeItem(key);
}

export async function removePrivateItems(keys: string[]) {
  await Promise.all(keys.map(removePrivateItem));
}
