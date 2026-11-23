import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import WebView from 'react-native-webview';

type Point = { latitude: number; longitude: number; accuracy?: number | null; timestamp?: number };
type RoutePoint = { latitude: number; longitude: number };
type MapPayload = { point: Point; trail: Point[]; route: RoutePoint[]; stale: boolean };
type MapWebView = { injectJavaScript: (script: string) => void };

const MAP_HTML = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="">
<style>
html,body,#map{height:100%;width:100%;margin:0;background:#e9e9e7} .leaflet-control-attribution{font:10px Arial,sans-serif}
.leaflet-control-attribution a{color:#234b78} .leaflet-control-zoom a{color:#151515}
</style><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
</head><body><div id="map"></div><script>
window.addEventListener('error',()=>window.ReactNativeWebView&&window.ReactNativeWebView.postMessage('map-error'));
const map=L.map('map',{zoomControl:true,attributionControl:true}).setView([-26.2041,28.0473],14);
const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'});
tiles.on('tileerror',()=>window.ReactNativeWebView&&window.ReactNativeWebView.postMessage('tile-error'));tiles.addTo(map);
window.ReactNativeWebView&&window.ReactNativeWebView.postMessage('map-ready');
let marker=null,accuracyCircle=null,trailLine=null,routeLine=null,endpoint=null;
window.companionUpdate=function(data){
 const p=data.point;if(!p)return;const here=[p.latitude,p.longitude];
 if(!marker)marker=L.marker(here,{title:'Latest device location'}).addTo(map);else marker.setLatLng(here);
 marker.bindPopup((data.stale?'Last known location · stale':'Live device location')+'<br>'+new Date(p.timestamp||Date.now()).toLocaleTimeString());
 if(Number.isFinite(p.accuracy)&&p.accuracy>0){if(!accuracyCircle)accuracyCircle=L.circle(here,{radius:p.accuracy,color:'#cf3945',weight:1,fillOpacity:.08}).addTo(map);else accuracyCircle.setLatLng(here).setRadius(p.accuracy)}
 const trail=(data.trail||[]).map(v=>[v.latitude,v.longitude]);if(trail.length>1){if(!trailLine)trailLine=L.polyline(trail,{color:'#cf3945',weight:4,opacity:.9}).addTo(map);else trailLine.setLatLngs(trail)}
 const route=(data.route||[]).map(v=>[v.latitude,v.longitude]);if(route.length>0){if(!routeLine)routeLine=L.polyline(route,{color:'#263746',weight:4,dashArray:'7 8',opacity:.8}).addTo(map);else routeLine.setLatLngs(route);const end=route[route.length-1];if(!endpoint)endpoint=L.circleMarker(end,{radius:6,color:'#fff',weight:2,fillColor:'#263746',fillOpacity:1}).addTo(map);else endpoint.setLatLng(end)}
 map.setView(here,Math.max(map.getZoom(),15),{animate:false});
};
window.addEventListener('message',e=>{try{window.companionUpdate(JSON.parse(e.data))}catch(_){}});
document.addEventListener('message',e=>{try{window.companionUpdate(JSON.parse(e.data))}catch(_){}});
</script></body></html>`;
const MAP_ORIGIN_WHITELIST = ['*'];

export default function LiveLocationMap({ point, trail, active, route = [], stale = false }: {
  point: Point | null;
  trail: Point[];
  active: boolean;
  route?: RoutePoint[];
  stale?: boolean;
}) {
  const webViewRef = useRef<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  const [mapError, setMapError] = useState(false);
  const mapSource = useMemo(() => ({ html: MAP_HTML }), []);

  useEffect(() => {
    if (!loaded || !point) return;
    const payload: MapPayload = { point, trail, route, stale };
    const json = JSON.stringify(payload).replace(/</g, '\\u003c');
    (webViewRef.current as MapWebView | null)?.injectJavaScript(`window.companionUpdate&&window.companionUpdate(${json});true;`);
  }, [loaded, point, trail, route, stale]);

  if (!point) return <View style={styles.empty}><Text style={styles.emptyTitle}>Waiting for GPS</Text><Text style={styles.emptyText}>Start a journey and allow location access to see your live position here.</Text></View>;

  return <View style={styles.container}>
    <WebView
      // WebView 14 declares its imperative ref as unknown; narrow only at the injection call above.
      ref={webViewRef as never}
      source={mapSource}
      originWhitelist={MAP_ORIGIN_WHITELIST}
      javaScriptEnabled
      domStorageEnabled
      cacheEnabled
      userAgent="CompanionSafety/1.0 (https://companion-family.pages.dev)"
      onLoadEnd={() => setLoaded(true)}
      onError={() => setMapError(true)}
      onHttpError={() => setMapError(true)}
      onMessage={(event) => setMapError(event.nativeEvent.data !== 'map-ready')}
      style={styles.webView}
      setSupportMultipleWindows={false}
      accessible
      accessibilityLabel="Live journey map with device location and route"
    />
    <View pointerEvents="none" style={styles.badge}>
      <View style={[styles.dot, active && !stale && styles.dotLive, stale && styles.dotStale]} />
      <Text style={styles.badgeText}>{stale ? 'LAST FIX · STALE' : active ? 'LIVE LOCATION' : 'LAST FIX'}
        {typeof point.accuracy === 'number' ? ` · ±${Math.round(point.accuracy)} m` : ''}
      </Text>
    </View>
    {mapError && <View pointerEvents="none" style={styles.mapError}><Text style={styles.mapErrorText}>Map tiles unavailable · coordinates are still updating</Text></View>}
  </View>;
}

const styles = StyleSheet.create({
  container: { height: 234, borderRadius: 18, overflow: 'hidden', backgroundColor: '#E9E9E7' },
  webView: { flex: 1, backgroundColor: '#E9E9E7' },
  empty: { height: 234, borderRadius: 18, backgroundColor: '#E9E9E7', borderWidth: 1, borderColor: '#E3E3E2', alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { color: '#151515', fontSize: 14, fontWeight: '700' },
  emptyText: { color: '#707070', fontSize: 12, lineHeight: 18, marginTop: 8, textAlign: 'center' },
  badge: { position: 'absolute', top: 12, left: 12, borderRadius: 20, backgroundColor: '#FFFFFF', paddingHorizontal: 10, paddingVertical: 7, flexDirection: 'row', alignItems: 'center' },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#9BAABD', marginRight: 7 },
  dotLive: { backgroundColor: '#16855f' },
  dotStale: { backgroundColor: '#D52B37' },
  badgeText: { color: '#151515', fontSize: 9, fontWeight: '800', letterSpacing: 0.4 },
  mapError: { position: 'absolute', bottom: 10, left: 12, right: 12, alignItems: 'center' },
  mapErrorText: { overflow: 'hidden', borderRadius: 8, backgroundColor: '#ffffffee', color: '#4c5157', paddingHorizontal: 10, paddingVertical: 6, fontSize: 10 },
});
