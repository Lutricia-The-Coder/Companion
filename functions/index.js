const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');
const { getStorage } = require('firebase-admin/storage');
const { defineSecret } = require('firebase-functions/params');
const { onValueWritten } = require('firebase-functions/v2/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { ProviderError, summarizeNotificationOutcomes, withRetry } = require('./notificationRetry');
const { activateEmergency: activateEmergencyHandler } = require('./emergencyActivation');

initializeApp();

exports.grantTrustedContactAccess = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to share a journey.');
  const { journeyId, contactEmail } = request.data || {};
  if (typeof journeyId !== 'string' || typeof contactEmail !== 'string') {
    throw new HttpsError('invalid-argument', 'A journey ID and trusted contact email are required.');
  }

  const db = getDatabase();
  const journeyRef = db.ref(`journeys/${journeyId}`);
  const journeySnapshot = await journeyRef.get();
  const journey = journeySnapshot.val();
  if (!journey || journey.ownerUid !== request.auth.uid) {
    throw new HttpsError('permission-denied', 'Only the journey owner can share it.');
  }

  const email = contactEmail.trim().toLowerCase();
  const profileSnapshot = await db.ref(`users/${request.auth.uid}/profile`).get();
  const contacts = profileSnapshot.val()?.trustedContacts || [];
  if (!contacts.some((contact) => String(contact.email || '').toLowerCase() === email)) {
    throw new HttpsError('permission-denied', 'That email is not saved as a trusted contact.');
  }

  let contact;
  try {
    contact = await getAuth().getUserByEmail(email);
  } catch {
    throw new HttpsError('failed-precondition', 'Your trusted contact must create a Companion account before they can monitor this journey.');
  }
  await journeyRef.child(`access/${contact.uid}`).set(true);
  return { contactUid: contact.uid, monitorPath: `/monitor/${journeyId}` };
});

exports.activateEmergency = onCall(async (request) => activateEmergencyHandler(request, {
  db: getDatabase(),
  HttpsError,
}));

const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_FROM_NUMBER = defineSecret('TWILIO_FROM_NUMBER');
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const RESEND_FROM_EMAIL = defineSecret('RESEND_FROM_EMAIL');

exports.reportRouteDeviation = onCall(
  { secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, RESEND_API_KEY, RESEND_FROM_EMAIL] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to report a route alert.');
    const { journeyId, location, distanceMeters } = request.data || {};
    if (typeof journeyId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(journeyId)
      || !location || !Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90
      || !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180
      || !Number.isFinite(location.timestamp) || !Number.isFinite(distanceMeters)
      || distanceMeters < 100 || distanceMeters > 100_000) {
      throw new HttpsError('invalid-argument', 'A valid recent location and route distance are required.');
    }

    const now = Date.now();
    if (location.timestamp > now + 10_000 || now - location.timestamp > 2 * 60_000) {
      throw new HttpsError('invalid-argument', 'The route alert location is not recent.');
    }
    const db = getDatabase();
    const journeyRef = db.ref(`journeys/${journeyId}`);
    const journeySnapshot = await journeyRef.get();
    const journey = journeySnapshot.val();
    if (!journey || journey.ownerUid !== request.auth.uid) {
      throw new HttpsError('permission-denied', 'Only the journey owner can report a route alert.');
    }
    if (journey.status !== 'active' || journey.emergency === true) {
      return { eventId: null, duplicate: true };
    }

    const throttleRef = journeyRef.child('routeAlertState/lastSentAt');
    const throttle = await throttleRef.transaction((lastSentAt) => {
      if (Number.isFinite(lastSentAt) && now - lastSentAt < 5 * 60_000) return;
      return now;
    });
    if (!throttle.committed) return { eventId: null, duplicate: true };

    const eventRef = journeyRef.child('events').push();
    const eventId = eventRef.key;
    if (!eventId) throw new HttpsError('internal', 'Could not create a route event ID.');
    const event = {
      eventId,
      type: 'route_deviation',
      status: 'alerting',
      reason: `The active journey appears about ${Math.round(distanceMeters)} m from its planned route.`,
      activatedAt: now,
      location: { latitude: location.latitude, longitude: location.longitude, timestamp: location.timestamp },
    };
    await eventRef.set(event);

    const profileSnapshot = await db.ref(`users/${journey.ownerUid}/profile`).get();
    const profile = profileSnapshot.val() || {};
    const contacts = Array.isArray(profile.trustedContacts) ? profile.trustedContacts : [];
    const mapLink = `https://maps.google.com/?q=${location.latitude},${location.longitude}`;
    const projectId = getAuth().app.options.projectId;
    const liveLink = projectId
      ? `https://${projectId}.web.app/?journeyId=${encodeURIComponent(journeyId)}`
      : 'Sign in to the Companion dashboard to view the live journey.';
    const name = profile.displayName || 'A Companion user';
    const message = `Route alert: ${name}'s active safety journey appears about ${Math.round(distanceMeters)} m off the planned route. Current location: ${mapLink} Live journey: ${liveLink}`;
    const sends = [];
    for (const contact of contacts) {
      if (contact.phone) sends.push({ channel: 'sms', send: withRetry(() => sendSms(contact.phone, message)) });
      if (contact.email) sends.push({ channel: 'email', send: withRetry(() => sendEmail(contact.email, name, journey, mapLink, liveLink, 'Route deviation alert')) });
    }
    const outcomes = await Promise.allSettled(sends.map((item) => item.send));
    const notifications = summarizeNotificationOutcomes(sends, outcomes);
    await eventRef.update({ status: 'recorded', notifications });
    return { eventId, duplicate: false };
  },
);

exports.registerEvidence = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to upload emergency evidence.');
  const { journeyId, eventId, evidenceId, objectPath, contentType, durationSeconds } = request.data || {};
  if (![journeyId, eventId, evidenceId].every((value) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value))
    || typeof objectPath !== 'string' || !['audio/mp4', 'audio/m4a', 'video/mp4'].includes(contentType)
    || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 30) {
    throw new HttpsError('invalid-argument', 'Evidence metadata is invalid.');
  }
  const expectedPath = `evidence/${request.auth.uid}/${journeyId}/${eventId}/${evidenceId}`;
  if (objectPath !== expectedPath) throw new HttpsError('permission-denied', 'Evidence must be stored in your own journey folder.');
  const journeyRef = getDatabase().ref(`journeys/${journeyId}`);
  const journey = (await journeyRef.get()).val();
  if (!journey || journey.ownerUid !== request.auth.uid) {
    throw new HttpsError('permission-denied', 'Only the journey owner can register evidence.');
  }
  if (!journey.events?.[eventId]) throw new HttpsError('failed-precondition', 'The emergency event was not found.');
  const file = getStorage().bucket().file(objectPath);
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError('failed-precondition', 'Evidence upload has not completed.');
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size || 0);
  if (size <= 0 || size > 25 * 1024 * 1024 || metadata.contentType !== contentType) {
    await file.delete({ ignoreNotFound: true });
    throw new HttpsError('invalid-argument', 'Evidence file type or size is not allowed.');
  }
  const record = {
    evidenceId,
    type: contentType.startsWith('video/') ? 'video' : 'audio',
    contentType,
    durationSeconds: Math.round(durationSeconds),
    sizeBytes: size,
    objectPath,
    uploadedAt: Date.now(),
    expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
  };
  await journeyRef.child(`events/${eventId}/evidence/${evidenceId}`).set(record);
  await file.setMetadata({ metadata: { ownerUid: request.auth.uid, journeyId, eventId, evidenceId, expiresAt: String(record.expiresAt) } });
  return { evidenceId, expiresAt: record.expiresAt };
});

exports.getEvidenceDownloadUrl = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to view evidence.');
  const { journeyId, eventId, evidenceId } = request.data || {};
  if (![journeyId, eventId, evidenceId].every((value) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value))) {
    throw new HttpsError('invalid-argument', 'Evidence reference is invalid.');
  }
  const journeyRef = getDatabase().ref(`journeys/${journeyId}`);
  const journey = (await journeyRef.get()).val();
  if (!journey || (journey.ownerUid !== request.auth.uid && journey.access?.[request.auth.uid] !== true)) {
    throw new HttpsError('permission-denied', 'You do not have access to this journey.');
  }
  const evidence = journey.events?.[eventId]?.evidence?.[evidenceId];
  if (!evidence || typeof evidence.objectPath !== 'string' || evidence.expiresAt <= Date.now()) {
    throw new HttpsError('not-found', 'Evidence is missing or has expired.');
  }
  const [url] = await getStorage().bucket().file(evidence.objectPath).getSignedUrl({
    action: 'read',
    expires: Date.now() + 2 * 60_000,
  });
  return { url, type: evidence.type, contentType: evidence.contentType, expiresAt: Date.now() + 2 * 60_000 };
});

exports.deleteEvidence = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to delete evidence.');
  const { journeyId, eventId, evidenceId } = request.data || {};
  if (![journeyId, eventId, evidenceId].every((value) => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value))) {
    throw new HttpsError('invalid-argument', 'Evidence reference is invalid.');
  }
  const journeyRef = getDatabase().ref(`journeys/${journeyId}`);
  const journey = (await journeyRef.get()).val();
  if (!journey || journey.ownerUid !== request.auth.uid) {
    throw new HttpsError('permission-denied', 'Only the journey owner can delete evidence.');
  }
  const evidenceRef = journeyRef.child(`events/${eventId}/evidence/${evidenceId}`);
  const evidence = (await evidenceRef.get()).val();
  if (!evidence?.objectPath) throw new HttpsError('not-found', 'Evidence was not found.');
  await getStorage().bucket().file(evidence.objectPath).delete({ ignoreNotFound: true });
  await evidenceRef.remove();
  return { deleted: true };
});

exports.cleanupExpiredEvidence = onSchedule('every day 03:20', async () => {
  const bucket = getStorage().bucket();
  let pageToken;
  let removed = 0;
  for (let page = 0; page < 10; page += 1) {
    const [files, , response] = await bucket.getFiles({ prefix: 'evidence/', autoPaginate: false, maxResults: 500, pageToken });
    for (const file of files) {
      const [metadata] = await file.getMetadata().catch(() => [null]);
      const expiresAt = Number(metadata?.metadata?.expiresAt || 0);
      if (!expiresAt || expiresAt > Date.now()) continue;
      const [, , journeyId, eventId, evidenceId] = file.name.split('/');
      if (journeyId && eventId && evidenceId) {
        await getDatabase().ref(`journeys/${journeyId}/events/${eventId}/evidence/${evidenceId}`).remove();
      }
      await file.delete({ ignoreNotFound: true });
      removed += 1;
    }
    pageToken = response?.nextPageToken;
    if (!pageToken) break;
  }
  if (removed) logger.info('Expired evidence deleted', { removed });
});

exports.notifyTrustedContacts = onValueWritten(
  {
    ref: '/journeys/{journeyId}/emergency',
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, RESEND_API_KEY, RESEND_FROM_EMAIL],
  },
  async (event) => {
    if (event.data.after.val() !== true || event.data.before.val() === true) return;

    const db = getDatabase();
    const journeyId = event.params.journeyId;
    const journeyRef = db.ref(`journeys/${journeyId}`);
    const journeySnapshot = await journeyRef.get();
    const journey = journeySnapshot.val();
    if (!journey || !journey.ownerUid) {
      logger.error('Emergency journey has no owner', { journeyId });
      return;
    }

    const profileSnapshot = await db.ref(`users/${journey.ownerUid}/profile`).get();
    const profile = profileSnapshot.val() || {};
    const contacts = Array.isArray(profile.trustedContacts) ? profile.trustedContacts : [];
    const location = journey.location;
    const mapsLink = location
      ? `https://maps.google.com/?q=${location.latitude},${location.longitude}`
      : 'Location is not available yet. Check the last location in the shared journey.';
    const projectId = getAuth().app.options.projectId;
    const liveJourneyLink = projectId ? `https://${projectId}.web.app/?journeyId=${encodeURIComponent(journeyId)}` : 'Sign in to the Companion dashboard to view the shared live journey.';
    const name = profile.displayName || 'A Companion user';
    const message = `${name} may need help and triggered a safety alert.${journey.destination ? ` Destination: ${journey.destination}.` : ''} Current location: ${mapsLink} Live journey: ${liveJourneyLink}`;

    await journeyRef.update({ alertDelivery: { status: 'sending', startedAt: Date.now() } });
    const sends = [];
    for (const contact of contacts) {
      if (contact.phone) sends.push({ channel: 'sms', send: withRetry(() => sendSms(contact.phone, message)) });
      if (contact.email) sends.push({ channel: 'email', send: withRetry(() => sendEmail(contact.email, name, journey, mapsLink, liveJourneyLink)) });
    }

    const outcomes = await Promise.allSettled(sends.map((item) => item.send));
    const delivery = summarizeNotificationOutcomes(sends, outcomes);
    await journeyRef.update({
      alertDelivery: {
        ...delivery,
        lastKnownLocationAt: location?.timestamp || null,
      },
    });
    const eventId = journey.emergencyEventId;
    if (eventId) {
      await journeyRef.child(`events/${eventId}/notifications`).set(delivery);
    }
    if (!outcomes.length) logger.warn('Emergency has no phone/email recipients', { journeyId });
    if (delivery.failures) logger.error('Some emergency messages failed', { journeyId, accepted: delivery.accepted, failures: delivery.failures });
  },
);

async function sendSms(to, body) {
  const accountSid = TWILIO_ACCOUNT_SID.value();
  const authToken = TWILIO_AUTH_TOKEN.value();
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER.value(), Body: body }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ProviderError(`SMS request rejected with status ${response.status}.`, response.status);
  return { status: 'accepted', providerId: result.sid || null, providerStatus: result.status || 'queued' };
}

async function sendEmail(to, name, journey, mapsLink, liveJourneyLink, subjectPrefix = 'Safety alert for') {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY.value()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL.value(),
      to: [to],
      subject: `Companion ${subjectPrefix} ${name}`,
      text: `${name} may need help and triggered a safety alert.\n\nDestination: ${journey.destination || 'Not set'}\nCurrent location: ${mapsLink}\nLive journey: ${liveJourneyLink}\n\nThis automated alert does not contact emergency services.`,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ProviderError(`Email request rejected with status ${response.status}.`, response.status);
  return { status: 'accepted', providerId: result.id || null, providerStatus: 'accepted' };
}

