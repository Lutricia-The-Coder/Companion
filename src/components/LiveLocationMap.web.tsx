import { StyleSheet, Text, View } from 'react-native';

type Point = { latitude: number; longitude: number; accuracy?: number | null; timestamp?: number };

export default function LiveLocationMap({ point, active }: { point: Point | null; trail: Point[]; active: boolean; route?: Point[] }) {
  if (!point) return <View style={styles.empty}><Text style={styles.title}>Waiting for GPS</Text><Text style={styles.copy}>Start a journey and allow location access to see your live position here.</Text></View>;
  const pad = 0.003;
  const bbox = `${point.longitude - pad}%2C${point.latitude - pad}%2C${point.longitude + pad}%2C${point.latitude + pad}`;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${point.latitude}%2C${point.longitude}`;
  return <View style={styles.container}>
    <iframe title="Live journey location map" src={src} style={{ width: '100%', height: 234, border: 0 }} />
    <View style={styles.badge}><Text style={styles.badgeText}>{active ? 'LIVE GPS' : 'LAST FIX'} · {point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}</Text></View>
  </View>;
}

const styles = StyleSheet.create({
  container: { height: 234, borderRadius: 18, overflow: 'hidden', backgroundColor: '#172A3D', position: 'relative' },
  empty: { height: 234, borderRadius: 18, backgroundColor: '#172A3D', borderWidth: 1, borderColor: '#29435A', alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: '#F4F7FB', fontSize: 14, fontWeight: '700' },
  copy: { color: '#9BAABD', fontSize: 12, lineHeight: 18, marginTop: 8, textAlign: 'center' },
  badge: { position: 'absolute', top: 10, left: 10, borderRadius: 20, backgroundColor: '#101C2E', paddingHorizontal: 10, paddingVertical: 7 },
  badgeText: { color: '#F4F7FB', fontSize: 9, fontWeight: '800' },
});
