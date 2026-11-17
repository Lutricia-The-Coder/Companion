import { useEffect, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import {
  createTriggerPhrase,
  loadTriggerPhrases,
  saveTriggerPhrases,
  type TriggerPhrase,
  type TriggerPhraseStorage,
} from '../services/triggerPhrases';

const C = { panel: '#17263B', ink: '#F4F7FB', muted: '#9BAABD', teal: '#5CE0C0', line: '#2D4058', red: '#FF6B6B', amber: '#FFC96B' };

export default function TriggerPhraseManager({ onPrimaryPhraseChange }: { onPrimaryPhraseChange?: (phrase: string) => void }) {
  const [phrases, setPhrases] = useState<TriggerPhrase[]>([]);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [storage, setStorage] = useState<TriggerPhraseStorage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    loadTriggerPhrases().then(({ phrases: saved, storage: mode }) => {
      if (!mounted) return;
      setPhrases(saved);
      setStorage(mode);
      onPrimaryPhraseChange?.(saved[0]?.phrase ?? '');
    }).catch((error: unknown) => {
      if (mounted) Alert.alert('Could not load trigger phrases', error instanceof Error ? error.message : 'Encrypted phrase storage is unavailable.');
    }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [onPrimaryPhraseChange]);

  const persist = async (next: TriggerPhrase[]) => {
    try {
      const mode = await saveTriggerPhrases(next);
      setPhrases(next);
      setStorage(mode);
      onPrimaryPhraseChange?.(next[0]?.phrase ?? '');
    } catch (error) {
      Alert.alert('Could not save phrases', error instanceof Error ? error.message : 'Try again.');
    }
  };

  const addPhrase = () => {
    const value = draft.trim();
    if (!value) return;
    const next = editingId
      ? phrases.map((item) => item.id === editingId ? { ...item, phrase: value } : item)
      : [...phrases, createTriggerPhrase(value)];
    void persist(next);
    setDraft('');
    setEditingId(null);
  };

  const updatePhrase = (id: string, patch: Partial<TriggerPhrase>) => {
    void persist(phrases.map((item) => item.id === id ? { ...item, ...patch } : item));
  };

  const removePhrase = (id: string) => {
    Alert.alert('Delete this phrase?', 'It will be removed from this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { void persist(phrases.filter((item) => item.id !== id)); } },
    ]);
  };

  return <View>
    <View style={s.card}>
      <Text style={s.cardLabel}>PERSONAL SOS PHRASES</Text>
      <Text style={s.help}>Use short phrases that are unlikely to come up in ordinary conversation. Up to 8 phrases.</Text>
      {loading ? <Text style={s.help}>Loading secure settings…</Text> : phrases.length === 0 ? <Text style={s.empty}>No phrases saved yet.</Text> : phrases.map((item) => <View key={item.id} style={s.phraseRow}>
        <View style={{ flex: 1 }}>
          <TouchableOpacity onPress={() => { setEditingId(item.id); setDraft(item.phrase); }} accessibilityRole="button" accessibilityLabel={`Edit phrase ${item.phrase}`}>
            <Text style={s.phrase}>“{item.phrase}” · Edit</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => updatePhrase(item.id, { independentActivation: !item.independentActivation })} accessibilityRole="switch" accessibilityState={{ checked: item.independentActivation }}>
            <Text style={s.option}>{item.independentActivation ? 'Independent emergency activation: ON' : 'Independent emergency activation: OFF'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => updatePhrase(item.id, { enabled: !item.enabled })} accessibilityRole="switch" accessibilityState={{ checked: item.enabled }}>
            <Text style={[s.option, { color: item.enabled ? C.teal : C.muted }]}>{item.enabled ? 'Enabled for future recognition' : 'Disabled'}</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={() => removePhrase(item.id)} accessibilityRole="button" accessibilityLabel={`Delete phrase ${item.phrase}`} style={s.remove}><Text style={s.removeText}>×</Text></TouchableOpacity>
      </View>)}
      <TextInput value={draft} onChangeText={setDraft} placeholder="Add a private SOS phrase" placeholderTextColor={C.muted} style={s.input} maxLength={80} accessibilityLabel="New personal SOS phrase" />
      <TouchableOpacity onPress={addPhrase} disabled={!draft.trim() || (!editingId && phrases.length >= 8) || loading} style={[s.addButton, (!draft.trim() || (!editingId && phrases.length >= 8)) && { opacity: 0.5 }]}><Text style={s.addText}>{editingId ? 'Save phrase changes' : 'Add phrase'}</Text></TouchableOpacity>
      <Text style={[s.storage, { color: storage === 'encrypted-device' ? C.teal : C.amber }]}>{storage === 'encrypted-device' ? 'Stored with Android Keystore encryption on this device.' : 'Web preview: stored locally in browser storage, not encrypted.'}</Text>
    </View>
    <View style={s.warning}>
      <Text style={s.warningTitle}>{Platform.OS === 'web' ? 'Voice detection is unavailable in Safari' : 'Phrase monitoring needs an active journey'}</Text>
      <Text style={s.warningBody}>{Platform.OS === 'web'
        ? 'Phrases are saved in this browser, but the Safari preview cannot load the native speech recognizer. Use the Android app to test phrase detection.'
        : 'Phrase recognition starts during an active journey while the app is open. It requires an available on-device speech-recognition service and language model. Background recognition of personal phrases is not available; Android background monitoring uses its separate YAMNet sound classifier.'}</Text>
    </View>
  </View>;
}

const s = StyleSheet.create({
  card: { padding: 16, backgroundColor: C.panel, borderRadius: 15, borderWidth: 1, borderColor: C.line, marginTop: 10 },
  cardLabel: { color: C.muted, fontSize: 9, letterSpacing: 1.35, fontWeight: '800', marginBottom: 10 },
  help: { color: C.muted, fontSize: 11, lineHeight: 17, marginBottom: 8 }, empty: { color: C.muted, fontSize: 12, paddingVertical: 10 },
  phraseRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: C.line },
  phrase: { color: C.ink, fontSize: 14, fontWeight: '700', marginBottom: 5 }, option: { color: C.amber, fontSize: 10, marginTop: 5 },
  remove: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, removeText: { color: C.red, fontSize: 25 },
  input: { color: C.ink, fontSize: 13, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line, marginTop: 8 },
  addButton: { minHeight: 44, marginTop: 10, borderRadius: 10, backgroundColor: C.teal, alignItems: 'center', justifyContent: 'center' }, addText: { color: '#0D2630', fontSize: 12, fontWeight: '800' },
  storage: { fontSize: 10, lineHeight: 15, marginTop: 12 },
  warning: { backgroundColor: '#382C25', borderWidth: 1, borderColor: '#6A503A', borderRadius: 14, padding: 14, marginTop: 13 }, warningTitle: { color: C.amber, fontSize: 12, fontWeight: '800' }, warningBody: { color: '#D4C3AE', fontSize: 11, lineHeight: 17, marginTop: 5 },
});
