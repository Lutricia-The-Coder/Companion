import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const config = window.COMPANION_SUPABASE_CONFIG;
const message = document.querySelector('#message');
const journeyCard = document.querySelector('#journey-card');
const lookupCard = document.querySelector('#lookup-card');
const authCard = document.querySelector('#auth-card');
let supabase;
let journeyChannel;
let map;
let marker;
let trail;
let points = [];
let journeyFreshnessTimer;
let lastLocationTimestamp = null;
let currentJourneyId = null;

function showMessage(text, isError = false) {
  message.textContent = text;
  message.className = isError ? 'message error' : 'message';
}

if (!config?.url || !config?.publishableKey) {
  showMessage('Copy config.example.js to config.js and enter your Supabase project URL and publishable key.', true);
  document.querySelector('#sign-in').disabled = true;
  document.querySelector('#sign-up').disabled = true;
} else {
  supabase = createClient(config.url, config.publishableKey, { auth: { persistSession: true, autoRefreshToken: true } });
  map = L.map('map', { zoomControl: true }).setView([-29.0, 24.0], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  supabase.auth.onAuthStateChange((_event, session) => {
    const user = session?.user;
    document.querySelector('#account').textContent = user ? user.email : 'Not signed in';
    document.querySelector('#sign-out').hidden = !user;
    authCard.hidden = Boolean(user);
    lookupCard.hidden = !user;
    if (!user) clearJourneyView();
    const queryJourney = new URLSearchParams(window.location.search).get('journeyId');
    if (user && queryJourney) queueMicrotask(() => void openJourney(queryJourney));
  });
}

document.querySelector('#sign-out').addEventListener('click', async () => {
  if (!supabase) return;
  const button = document.querySelector('#sign-out');
  button.disabled = true;
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    clearJourneyView();
    document.querySelector('#journey-id').value = '';
    showMessage('Signed out.');
  } catch (error) {
    showMessage(`Could not sign out: ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#sign-in').addEventListener('click', async () => {
  try {
    const { error } = await supabase.auth.signInWithPassword({ email: document.querySelector('#email').value.trim(), password: document.querySelector('#password').value });
    if (error) throw error;
    showMessage('Signed in.');
  } catch (error) { showMessage(error.message, true); }
});
document.querySelector('#sign-up').addEventListener('click', async () => {
  try {
    const { error } = await supabase.auth.signUp({
      email: document.querySelector('#email').value.trim(),
      password: document.querySelector('#password').value,
      options: { emailRedirectTo: `${window.location.origin}/` },
    });
    if (error) throw error;
    showMessage('Account created. Confirm your email if prompted, then ask the journey owner to grant access.');
  } catch (error) { showMessage(error.message, true); }
});
document.querySelector('#open-journey').addEventListener('click', () => void openJourney(document.querySelector('#journey-id').value.trim()));

function stopListening() {
  if (journeyChannel) void supabase.removeChannel(journeyChannel);
  journeyChannel = null;
  currentJourneyId = null;
  if (journeyFreshnessTimer) clearInterval(journeyFreshnessTimer);
}

function clearJourneyView() {
  stopListening();
  journeyCard.hidden = true;
  points = [];
  lastLocationTimestamp = null;
  document.querySelector('#journey-title').textContent = '';
  document.querySelector('#coordinates').textContent = '';
  document.querySelector('#updated').textContent = '';
  document.querySelector('#event-list').replaceChildren();
  if (marker) map?.removeLayer(marker);
  if (trail) map?.removeLayer(trail);
  marker = null;
  trail = null;
}

async function openJourney(journeyId) {
  if (!journeyId || !supabase) {
    showMessage('Sign in and enter the journey ID shared by the owner.', true);
    return;
  }
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { showMessage('Sign in to view shared journeys.', true); return; }
  stopListening();
  currentJourneyId = journeyId;
  points = [];
  marker = null;
  trail = null;
  journeyCard.hidden = false;
  document.querySelector('#journey-id').value = journeyId;
  document.querySelector('#journey-title').textContent = 'Connecting to live journey…';
  showMessage('Opening journey…');
  journeyFreshnessTimer = setInterval(renderLocationFreshness, 10_000);
  await refreshJourney(journeyId);
  journeyChannel = supabase.channel(`journey-${journeyId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'journeys', filter: `id=eq.${journeyId}` }, () => void refreshJourney(journeyId))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'safety_events', filter: `journey_id=eq.${journeyId}` }, () => void refreshJourney(journeyId))
    .subscribe((status) => { if (status === 'CHANNEL_ERROR') showMessage('Live listener disconnected. Retrying…', true); });
}

async function refreshJourney(journeyId) {
  const { data: journey, error } = await supabase.from('journeys').select(
    'id,destination,status,emergency,location,safety_events(id,event_type,status,reason,activated_at,notifications,evidence(id,media_type,expires_at,duration_seconds),notification_attempts(id,channel,target_masked,status,attempt_count,provider,provider_reference,attempted_at))',
  ).eq('id', journeyId).maybeSingle();
  if (error) { showMessage(`Could not open this journey: ${error.message}`, true); return; }
  if (!journey) {
    showMessage('Journey not found or your access has been removed.', true);
    journeyCard.hidden = true;
    return;
  }
  document.querySelector('#journey-title').textContent = journey.destination ? `Journey to ${journey.destination}` : 'Shared safety journey';
  const emergency = journey.emergency === true;
  const status = document.querySelector('#status');
  status.textContent = emergency ? 'Emergency' : (journey.status || 'Unknown');
  status.classList.toggle('alert', emergency);
  const emergencyBanner = document.querySelector('#emergency');
  emergencyBanner.hidden = !emergency;
  emergencyBanner.textContent = emergency ? 'Emergency status triggered · contact notification status is listed below.' : '';
  renderEmergencyEvents(journey.safety_events || [], journeyId);
  const location = journey.location;
  if (location && Number.isFinite(location.latitude) && Number.isFinite(location.longitude)) {
    const latLng = [location.latitude, location.longitude];
    points.push(latLng);
    if (points.length > 500) points.shift();
    if (!marker) marker = L.marker(latLng).addTo(map).bindPopup('Latest shared location');
    marker.setLatLng(latLng);
    if (!trail) trail = L.polyline(points, { color: '#159F8B', weight: 5, opacity: 0.9 }).addTo(map);
    else trail.setLatLngs(points);
    map.setView(latLng, Math.max(map.getZoom(), 15));
    document.querySelector('#coordinates').textContent = `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`;
    lastLocationTimestamp = Number(location.timestamp) || null;
    renderLocationFreshness();
  } else {
    lastLocationTimestamp = null;
    document.querySelector('#coordinates').textContent = 'Waiting for the first location';
    document.querySelector('#updated').textContent = 'No location received yet';
  }
  showMessage('Live updates are connected.');
}

function renderLocationFreshness() {
  const updated = document.querySelector('#updated');
  if (!lastLocationTimestamp) {
    updated.textContent = 'No location received yet';
    updated.classList.remove('stale');
    return;
  }
  const stale = Date.now() - lastLocationTimestamp > 30_000;
  updated.textContent = `${new Date(lastLocationTimestamp).toLocaleString()}${stale ? ' · STALE' : ' · Live'}`;
  updated.classList.toggle('stale', stale);
}

function renderEmergencyEvents(events, journeyId) {
  const list = document.querySelector('#event-list');
  list.replaceChildren();
  const recent = [...events].sort((a, b) => Number(b.activated_at || 0) - Number(a.activated_at || 0)).slice(0, 10);
  if (!recent.length) {
    const empty = document.createElement('li');
    empty.className = 'event-empty';
    empty.textContent = 'No emergency events recorded.';
    list.append(empty);
    return;
  }
  for (const event of recent) {
    const row = document.createElement('li');
    row.className = 'event-row';
    const title = document.createElement('strong');
    title.textContent = event.event_type === 'route_deviation' ? 'Route deviation alert' : 'Emergency activated';
    const detail = document.createElement('span');
    detail.textContent = `${event.activated_at ? new Date(Number(event.activated_at)).toLocaleString() : 'Time unavailable'} · ${event.reason || 'Safety alert'}`;
    row.append(title, detail);
    if (event.notifications) {
      const delivery = document.createElement('span');
      delivery.className = `event-delivery ${event.notifications.status === 'accepted' ? 'accepted' : ''}`;
      delivery.textContent = `Notifications: ${event.notifications.status || 'unknown'} · accepted ${event.notifications.accepted || 0} · failed ${event.notifications.failures || 0}`;
      row.append(delivery);
    }
    if (event.notifications?.evidence) {
      const evidenceDelivery = document.createElement('span');
      evidenceDelivery.className = `event-delivery ${event.notifications.evidence.status === 'accepted' ? 'accepted' : ''}`;
      evidenceDelivery.textContent = `Evidence link: ${event.notifications.evidence.status || 'unknown'} · accepted ${event.notifications.evidence.accepted || 0} · failed ${event.notifications.evidence.failures || 0}`;
      row.append(evidenceDelivery);
    }
    for (const attempt of event.notification_attempts || []) {
      const attemptRow = document.createElement('span');
      attemptRow.className = `event-delivery ${attempt.status === 'accepted' || attempt.status === 'accepted_by_expo' ? 'accepted' : ''}`;
      const when = attempt.attempted_at ? new Date(attempt.attempted_at).toLocaleString() : 'time unavailable';
      attemptRow.textContent = `${attempt.channel.toUpperCase()} · ${attempt.status} · attempts ${attempt.attempt_count} · ${attempt.provider} · ${when}`;
      row.append(attemptRow);
    }
    for (const evidence of event.evidence || []) {
      const button = document.createElement('button');
      button.className = 'button secondary evidence-button';
      button.type = 'button';
      button.textContent = `Get ${evidence.media_type === 'video' ? 'video' : 'audio'} evidence link`;
      button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = 'Authorizing…';
        try {
          const { data, error } = await supabase.functions.invoke('get-evidence-download-url', { body: { journeyId, eventId: event.id, evidenceId: evidence.id } });
          if (error) throw error;
          const media = document.createElement(evidence.media_type === 'video' ? 'video' : 'audio');
          media.controls = true;
          media.src = data.url;
          if (evidence.media_type === 'video') media.playsInline = true;
          media.className = 'evidence-player';
          row.append(media);
          button.textContent = 'Evidence link expires in 2 minutes';
        } catch (error) {
          button.disabled = false;
          button.textContent = 'Retry evidence access';
          showMessage(`Could not authorize evidence: ${error.message}`, true);
        }
      });
      row.append(button);
    }
    list.append(row);
  }
}

window.addEventListener('offline', () => showMessage('Offline · live journey updates may be delayed.', true));
window.addEventListener('online', () => showMessage('Connection restored · waiting for the next live update.'));
