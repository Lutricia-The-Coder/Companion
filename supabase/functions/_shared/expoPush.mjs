/**
 * Expo Push Service adapter. A successful ticket means Expo accepted the message;
 * only a later Expo receipt can establish whether FCM/APNs accepted delivery.
 */
export async function sendExpoPush(token, title, body, data, fetcher = fetch) {
  let httpStatus = 0;
  let payload = {};
  try {
    const response = await fetcher('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip, deflate' },
      body: JSON.stringify({ to: token, sound: 'default', channelId: 'safety-alerts', title, body, data }),
      signal: AbortSignal.timeout(12_000),
    });
    httpStatus = response.status;
    payload = await response.json().catch(() => ({}));
  } catch {
    return { status: 'unknown', retryable: false, attempts: 1, provider: 'expo', providerResponse: { outcome: 'network_unknown' } };
  }

  const ticket = Array.isArray(payload.data) ? payload.data[0]
    : payload.data && typeof payload.data === 'object' ? payload.data : undefined;
  if (httpStatus >= 200 && httpStatus < 300 && ticket?.status === 'ok' && typeof ticket.id === 'string') {
    return {
      status: 'accepted', accepted: true, retryable: false, attempts: 1, provider: 'expo', providerReference: ticket.id,
      providerResponse: { ticketStatus: 'ok', meaning: 'accepted_by_expo_not_device_delivery' },
    };
  }

  const details = ticket?.details && typeof ticket.details === 'object' ? ticket.details : {};
  const errorCode = typeof details.error === 'string' ? details.error.slice(0, 80) : 'ExpoPushRequestFailed';
  const retryable = httpStatus === 429 || httpStatus >= 500;
  return {
    status: 'failed', accepted: false, retryable, attempts: 1, provider: 'expo',
    error: `Expo push rejected (${errorCode}).`,
    providerResponse: { httpStatus, ticketStatus: ticket?.status ?? 'error', errorCode },
  };
}

export async function sendExpoPushWithLimit(token, title, body, data, options = {}) {
  const maxAttempts = Math.max(1, Math.min(3, options.maxAttempts ?? 3));
  const fetcher = options.fetcher ?? fetch;
  const pause = options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let result = await sendExpoPush(token, title, body, data, fetcher);
  let attempts = 1;
  while (result.retryable && attempts < maxAttempts) {
    await pause(250 * attempts);
    result = await sendExpoPush(token, title, body, data, fetcher);
    attempts += 1;
  }
  return { ...result, attempts, totalAttempts: attempts };
}
