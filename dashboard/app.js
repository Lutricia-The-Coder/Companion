import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const config = window.COMPANION_SUPABASE_CONFIG;
const message = document.querySelector('#message');
const journeyCard = document.querySelector('#journey-card');
const lookupCard = document.querySelector('#lookup-card');
const authCard = document.querySelector('#auth-card');
const recoveryCard = document.querySelector('#recovery-card');
const recoveryRequested = new URLSearchParams(window.location.search).get('auth_action') === 'update-password';
let supabase;
let recoveryAuthorized = false;
let journeyChannel;
let map;
let marker;
let trail;
let plannedRouteLine;
let plannedEndpoint;
let points = [];
let journeyFreshnessTimer;
let lastLocationTimestamp = null;
let currentJourneyId = null;

function showMessage(text, isError = false) {
  message.textContent = text;
  message.className = isError ? 'message error' : 'message';
  message.setAttribute('role', isError ? 'alert' : 'status');
}

if (!config?.url || !config?.publishableKey) {
  showMessage('Copy config.example.js to config.js and enter your Supabase project URL and publishable key.', true);
  document.querySelector('#sign-in').disabled = true;
  document.querySelector('#sign-up').disabled = true;
} else {
  supabase = createClient(config.url, config.publishableKey, { auth: { persistSession: true, autoRefreshToken: true } });
  if (recoveryRequested) {
    document.querySelector('#intro').hidden = true;
    document.querySelector('.account-tools').hidden = true;
    authCard.hidden = true;
    lookupCard.hidden = true;
    journeyCard.hidden = true;
    recoveryCard.hidden = false;
    const recoveryError = new URLSearchParams(window.location.search).get('error_description');
    if (recoveryError) {
      setRecoveryHelp(`This recovery link could not be verified: ${recoveryError}. Request a fresh link.`, 'error');
    }
  }
  map = L.map('map', { zoomControl: true }).setView([-29.0, 24.0], 5);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  }).addTo(map);
  supabase.auth.onAuthStateChange((event, session) => {
    if (recoveryRequested && event === 'PASSWORD_RECOVERY') {
      recoveryAuthorized = true;
      document.querySelector('#update-password').disabled = false;
      setRecoveryHelp('Recovery verified. Choose a new password for your Companion account.');
      return;
    }
    if (recoveryRequested) return;
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

function setRecoveryHelp(text, state = '') {
  const help = document.querySelector('#recovery-help');
  if (!help) return;
  help.textContent = text;
  help.className = `recovery-help${state ? ` ${state}` : ''}`;
}

document.querySelector('#update-password').addEventListener('click', async () => {
  if (!supabase || !recoveryAuthorized) return;
  const password = document.querySelector('#new-password').value;
  const confirmation = document.querySelector('#confirm-password').value;
  if (password.length < 8) { setRecoveryHelp('Use a password with at least 8 characters.', 'error'); return; }
  if (password !== confirmation) { setRecoveryHelp('The passwords do not match. Check both fields.', 'error'); return; }
  const button = document.querySelector('#update-password');
  button.disabled = true;
  button.textContent = 'Updating…';
  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    await supabase.auth.signOut({ scope: 'local' });
    recoveryAuthorized = false;
    document.querySelector('#new-password').value = '';
    document.querySelector('#confirm-password').value = '';
    setRecoveryHelp('Password updated. You can now sign in to Companion with the new password.', 'success');
    button.textContent = 'Password updated';
    window.history.replaceState({}, document.title, window.location.pathname);
  } catch (error) {
    setRecoveryHelp(error.message || 'Could not update the password. Request a fresh recovery link and try again.', 'error');
    button.disabled = false;
    button.textContent = 'Update password';
  }
});

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
  const button = document.querySelector('#sign-in');
  button.disabled = true;
  showMessage('Signing in…');
  try {
    const { error } = await supabase.auth.signInWithPassword({ email: document.querySelector('#email').value.trim(), password: document.querySelector('#password').value });
    if (error) throw error;
    showMessage('Signed in.');
  } catch (error) { showMessage(error.message || 'Could not sign in. Check your connection and account details.', true); }
  finally { button.disabled = false; }
});
document.querySelector('#sign-up').addEventListener('click', async () => {
  const button = document.querySelector('#sign-up');
  button.disabled = true;
  showMessage('Creating contact account…');
  try {
    const { error } = await supabase.auth.signUp({
      email: document.querySelector('#email').value.trim(),
      password: document.querySelector('#password').value,
      options: { emailRedirectTo: `${window.location.origin}/` },
    });
    if (error) throw error;
    showMessage('Account created. Confirm your email if prompted, then ask the journey owner to grant access.');
  } catch (error) { showMessage(error.message || 'Could not create the account. Check your connection and account details.', true); }
  finally { button.disabled = false; }
});
document.querySelector('#sign-google').addEventListener('click', async () => {
  if (!supabase) return;
  const button = document.querySelector('#sign-google');
  button.disabled = true;
  showMessage('Redirecting to Google…');
  try {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}${window.location.pathname}` },
    });
    if (error) throw error;
  } catch (error) {
    showMessage(error.message || 'Google sign-in failed. Check that Google is enabled in Supabase Auth.', true);
    button.disabled = false;
  }
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
  if (plannedRouteLine) map?.removeLayer(plannedRouteLine);
  if (plannedEndpoint) map?.removeLayer(plannedEndpoint);
  marker = null;
  trail = null;
  plannedRouteLine = null;
  plannedEndpoint = null;
}

async function openJourney(journeyId) {
  if (!journeyId || !supabase) {
    showMessage('Sign in and enter the journey ID shared by the owner.', true);
    return;
  }
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { showMessage('Sign in to view shared journeys.', true); return; }
  stopListening();
  if (marker) map?.removeLayer(marker);
  if (trail) map?.removeLayer(trail);
  if (plannedRouteLine) map?.removeLayer(plannedRouteLine);
  if (plannedEndpoint) map?.removeLayer(plannedEndpoint);
  currentJourneyId = journeyId;
  points = [];
  marker = null;
  trail = null;
  plannedRouteLine = null;
  plannedEndpoint = null;
  journeyCard.hidden = false;
  document.querySelector('#journey-id').value = journeyId;
  document.querySelector('#journey-title').textContent = 'Connecting to live journey…';
  document.querySelector('#event-list').replaceChildren(Object.assign(document.createElement('li'), { className: 'event-empty', textContent: 'Loading journey events…' }));
  showMessage('Opening journey…');
  journeyFreshnessTimer = setInterval(renderLocationFreshness, 10_000);
  await refreshJourney(journeyId);
  if (currentJourneyId !== journeyId) return;
  journeyChannel = supabase.channel(`journey-${journeyId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'journeys', filter: `id=eq.${journeyId}` }, () => void refreshJourney(journeyId))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'safety_events', filter: `journey_id=eq.${journeyId}` }, () => void refreshJourney(journeyId))
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        showMessage(navigator.onLine ? 'Realtime connection is active.' : 'Offline · showing the last authorized journey data available.');
        if (navigator.onLine) void refreshJourney(journeyId);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        showMessage(`Live updates ${status === 'CLOSED' ? 'closed' : 'disconnected'} · reconnecting. Last known data may be stale.`, true);
      }
    });
}

async function refreshJourney(journeyId) {
  if (!navigator.onLine) {
    showMessage('Offline · cannot fetch fresh location right now. Any displayed coordinates are last known; check their timestamp.', true);
    return;
  }
  let result;
  try {
    result = await supabase.from('journeys').select(
      'id,destination,status,emergency,location,route,safety_events(id,event_type,status,reason,activated_at,notifications,evidence(id,media_type,recorded_at,expires_at,duration_seconds),notification_attempts(id,channel,target_masked,status,attempt_count,provider,provider_reference,attempted_at))',
    ).eq('id', journeyId).maybeSingle();
  } catch (error) {
    showMessage(`Could not refresh this journey: ${error.message || 'network error'}. Displayed data may be stale.`, true);
    return;
  }
  const { data: journey, error } = result;
  if (error) { showMessage(`Could not refresh this journey: ${error.message}. Check access or connection; displayed data may be stale.`, true); return; }
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
  const route = (Array.isArray(journey.route) ? journey.route : [])
    .filter((point) => Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude)
      && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180)
    .map((point) => [point.latitude, point.longitude]);
  if (route.length > 1) {
    if (!plannedRouteLine) plannedRouteLine = L.polyline(route, { color: '#263746', weight: 4, dashArray: '7 8', opacity: 0.8 }).addTo(map);
    else plannedRouteLine.setLatLngs(route);
    const end = route[route.length - 1];
    if (!plannedEndpoint) plannedEndpoint = L.circleMarker(end, { radius: 6, color: '#fff', weight: 2, fillColor: '#263746', fillOpacity: 1 }).addTo(map);
    else plannedEndpoint.setLatLng(end);
  }
  const location = journey.location;
  if (location && Number.isFinite(location.latitude) && Number.isFinite(location.longitude)) {
    const latLng = [location.latitude, location.longitude];
    points.push(latLng);
    if (points.length > 500) points.shift();
    if (!marker) marker = L.marker(latLng).addTo(map).bindPopup('Latest shared location');
    marker.setLatLng(latLng);
    if (!trail) trail = L.polyline(points, { color: '#159F8B', weight: 5, opacity: 0.9 }).addTo(map);
    else trail.setLatLngs(points);
    if (route.length > 1 && points.length === 1) map.fitBounds(L.latLngBounds([...route, latLng]), { padding: [24, 24] });
    else map.setView(latLng, Math.max(map.getZoom(), 15));
    const accuracy = Number.isFinite(Number(location.accuracy)) ? ` · ±${Math.round(Number(location.accuracy))} m accuracy` : '';
    document.querySelector('#coordinates').textContent = `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}${accuracy}`;
    lastLocationTimestamp = Number(location.timestamp) || null;
    renderLocationFreshness();
  } else {
    lastLocationTimestamp = null;
    document.querySelector('#coordinates').textContent = 'Waiting for the first location';
    document.querySelector('#updated').textContent = 'No location received yet';
    if (route.length > 1) map.fitBounds(L.latLngBounds(route), { padding: [24, 24] });
  }
  if (currentJourneyId === journeyId && navigator.onLine) showMessage('Journey data refreshed. Realtime connection status is shown here.');
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
    if (event.event_type === 'route_deviation') row.classList.add('route-deviation');
    row.append(title, detail);
    if (event.notifications) {
      const delivery = document.createElement('span');
      delivery.className = `event-delivery ${event.notifications.status === 'accepted' ? 'accepted' : ''}`;
      delivery.textContent = `Notifications: ${event.notifications.status || 'unknown'} · provider accepted ${event.notifications.accepted || 0} · failed ${event.notifications.failures || 0} · unknown ${event.notifications.unknown || 0}`;
      row.append(delivery);
    }
    if (event.notifications?.evidence) {
      const evidenceDelivery = document.createElement('span');
      evidenceDelivery.className = `event-delivery ${event.notifications.evidence.status === 'accepted' ? 'accepted' : ''}`;
      evidenceDelivery.textContent = `Evidence link: ${event.notifications.evidence.status || 'unknown'} · provider accepted ${event.notifications.evidence.accepted || 0} · failed ${event.notifications.evidence.failures || 0} · unknown ${event.notifications.evidence.unknown || 0}`;
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
      const recordedAt = Number(evidence.recorded_at) ? new Date(Number(evidence.recorded_at)).toLocaleString() : 'recording time unavailable';
      button.textContent = `Get ${evidence.media_type === 'video' ? 'video' : 'audio'} evidence link · ${recordedAt}`;
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
          const seconds = Math.max(0, Math.ceil((Number(data.expiresAt) - Date.now()) / 1000));
          button.textContent = seconds > 0 ? `Evidence link expires in ${seconds} seconds` : 'Evidence link expired; request another';
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
