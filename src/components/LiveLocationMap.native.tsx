import MapView, { Marker, Polyline, type LatLng } from 'react-native-maps';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

type Point = LatLng & { accuracy?: number | null; timestamp?: number };
type RoutePoint = LatLng;

export default function LiveLocationMap({ point, trail, active, route = [] }: { point: Point | null; trail: Point[]; active: boolean; route?: RoutePoint[] }) {
  if (!point) return <View style={styles.empty}><Text style={styles.emptyTitle}>Waiting for GPS</Text><Text style={styles.emptyText}>Start a journey and allow location access to see your live position here.</Text></View>;
  if (Platform.OS === 'android') {
    const mapUrl = `https://maps.google.com/?q=${point.latitude},${point.longitude}`;
    return <View style={[styles.empty, styles.androidFallback]}>
      <View style={[styles.badge, { position: 'relative', top: 0, left: 0, alignSelf: 'flex-start' }]}><View style={[styles.dot, active && styles.dotLive]} /><Text style={styles.badgeText}>{active ? 'LIVE GPS' : 'LAST FIX'}</Text></View>
      <Text style={styles.emptyTitle}>Live location</Text>
      <Text style={styles.coordinates}>{point.latitude.toFixed(5)}, {point.longitude.toFixed(5)}</Text>
      <Text style={styles.emptyText}>The in-app Android map needs a Google Maps key. Your live GPS updates continue without it.</Text>
      <Pressable accessibilityRole="button" onPress={() => void Linking.openURL(mapUrl).catch(() => undefined)} style={styles.mapButton}><Text style={styles.mapButtonText}>Open location in Maps</Text></Pressable>
    </View>;
  }
  return <View style={styles.container}>
    <MapView style={StyleSheet.absoluteFill} region={{ latitude: point.latitude, longitude: point.longitude, latitudeDelta: 0.006, longitudeDelta: 0.006 }} showsUserLocation showsMyLocationButton showsCompass loadingEnabled>
      {trail.length > 1 && <Polyline coordinates={trail} strokeColor="#D52B37" strokeWidth={4} />}
      {route.length > 1 && <Polyline coordinates={point ? [{ latitude: point.latitude, longitude: point.longitude }, ...route] : route} strokeColor="#151515" strokeWidth={3} lineDashPattern={[8, 5]} />}
      {route.length > 0 && <Marker coordinate={route[route.length - 1]} title="Planned route endpoint" pinColor="#D52B37" />}
      <Marker coordinate={point} title={active ? 'Live journey location' : 'Last known location'} description={point.timestamp ? new Date(point.timestamp).toLocaleTimeString() : undefined} />
    </MapView>
    <View style={styles.badge}><View style={[styles.dot, active && styles.dotLive]} /><Text style={styles.badgeText}>{active ? 'LIVE GPS' : 'LAST FIX'}</Text></View>
  </View>;
}

const styles = StyleSheet.create({
  container: { height: 234, borderRadius: 18, overflow: 'hidden', backgroundColor: '#E9E9E7' },
  empty: { height: 234, borderRadius: 18, backgroundColor: '#E9E9E7', borderWidth: 1, borderColor: '#E3E3E2', alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { color: '#151515', fontSize: 14, fontWeight: '700' },
  emptyText: { color: '#707070', fontSize: 12, lineHeight: 18, marginTop: 8, textAlign: 'center' },
  badge: { position: 'absolute', top: 12, left: 12, borderRadius: 20, backgroundColor: '#FFFFFF', paddingHorizontal: 10, paddingVertical: 7, flexDirection: 'row', alignItems: 'center' },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#9BAABD', marginRight: 7 },
  dotLive: { backgroundColor: '#D52B37' },
  badgeText: { color: '#151515', fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  androidFallback: { justifyContent: 'center', gap: 7 },
  coordinates: { color: '#373737', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  mapButton: { backgroundColor: '#D52B37', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9, marginTop: 2 },
  mapButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
});
