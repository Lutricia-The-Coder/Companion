export type NotificationStatus = 'accepted' | 'failed' | 'unknown';

export type EmailOutcome = {
  channel: 'email';
  target: string;
  accepted: boolean;
  status: NotificationStatus;
  attempts: number;
  totalAttempts?: number;
  retryable?: boolean;
  providerResponse?: unknown;
  providerReference?: string | null;
  error?: string;
};

export class EmailDeliveryError extends Error {
  readonly retryable: boolean;
  readonly status: NotificationStatus;

  constructor(message: string, retryable: boolean, status: NotificationStatus = 'failed') {
    super(message);
    this.name = 'EmailDeliveryError';
    this.retryable = retryable;
    this.status = status;
  }
}

type ResendOptions = {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
  fetcher?: typeof fetch;
};

type BrevoOptions = Omit<ResendOptions, 'apiKey'> & { apiKey: string };

/** The Resend adapter reports provider acceptance only; it does not assert inbox delivery. */
export async function sendResendEmail(options: ResendOptions) {
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': options.idempotencyKey,
      },
      body: JSON.stringify({ from: options.from, to: [options.to], subject: options.subject, text: options.text }),
    });
  } catch (error) {
    throw new EmailDeliveryError('Email provider network outcome is unknown.', true, 'unknown');
  }

  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try { payload = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { /* preserve only bounded plain response below */ }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new EmailDeliveryError(`Email provider rejected the request (HTTP ${response.status}).`, retryable, 'failed');
  }
  const id = typeof payload.id === 'string' && payload.id ? payload.id : null;
  if (!id) {
    // A success status without a provider reference is ambiguous. Retrying is safe because the
    // same idempotency key is reused for every attempt.
    throw new EmailDeliveryError('Resend returned success without an email reference; outcome unknown.', true, 'unknown');
  }
  return { status: 'accepted' as const, providerReference: id };
}

/** Brevo's transactional API reports that it accepted a message, not that it reached an inbox. */
export async function sendBrevoEmail(options: BrevoOptions) {
  const fetcher = options.fetcher ?? fetch;
  const sender = parseSender(options.from);
  let response: Response;
  try {
    response = await fetcher('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': options.apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender,
        to: [{ email: options.to }],
        subject: options.subject,
        textContent: options.text,
      }),
    });
  } catch {
    // Brevo's send endpoint does not document idempotency support. Do not automatically retry
    // a network failure because Brevo may have accepted the first request before the connection
    // failed; retrying could send duplicate emergency messages.
    throw new EmailDeliveryError('Brevo email outcome is unknown; automatic retry was withheld to avoid duplicates.', false, 'unknown');
  }

  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try { payload = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { /* discard provider body */ }
  if (!response.ok) {
    // Only an explicit rate-limit rejection is safe to retry. Other transient-looking
    // responses can be ambiguous at the provider boundary and must not duplicate an SOS.
    const retryable = response.status === 429;
    const status = response.status >= 500 || response.status === 408 ? 'unknown' : 'failed';
    throw new EmailDeliveryError(`Brevo rejected the email request (HTTP ${response.status}).`, retryable, status);
  }
  const messageId = typeof payload.messageId === 'string' && payload.messageId ? payload.messageId : null;
  if (!messageId) {
    throw new EmailDeliveryError('Brevo accepted the request without returning a message reference; outcome unknown.', false, 'unknown');
  }
  return { status: 'accepted' as const, providerReference: messageId };
}

function parseSender(from: string) {
  const match = from.trim().match(/^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/);
  if (match) return { name: match[1].trim() || 'Companion', email: match[2] };
  if (/^[^\s<>]+@[^\s<>]+$/.test(from.trim())) return { name: 'Companion', email: from.trim() };
  throw new EmailDeliveryError('Email sender must be an email address or a name followed by an email address.', false, 'failed');
}

/** Provider selection lives behind this adapter so a future provider does not change callers. */
export async function sendEmailWithProvider(provider: string, options: ResendOptions) {
  if (provider === 'resend') return sendResendEmail(options);
  if (provider === 'brevo') return sendBrevoEmail(options);
  throw new EmailDeliveryError(`Unsupported email provider: ${provider}`, false, 'failed');
}

export function emailTargets(value: unknown, enabled = true) {
  if (!enabled || !Array.isArray(value)) return [] as string[];
  const emails = value.flatMap((item) => {
    const email = item && typeof item === 'object' ? (item as Record<string, unknown>).email : null;
    if (typeof email !== 'string') return [];
    const normalized = email.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? [normalized] : [];
  });
  return [...new Set(emails)].slice(0, 10);
}

/** Three attempts per invocation, six total by default; callers persist totalAttempts between calls. */
export async function retryEmailDelivery(
  send: () => Promise<unknown>,
  pause: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  options: { previousAttempts?: number; maxAttempts?: number; maxAttemptsPerRun?: number } = {},
): Promise<Omit<EmailOutcome, 'channel' | 'target'>> {
  const previousAttempts = Math.max(0, options.previousAttempts ?? 0);
  const maxAttempts = options.maxAttempts ?? 6;
  const maxAttemptsPerRun = options.maxAttemptsPerRun ?? 3;
  let attempts = 0;
  let lastError: unknown;
  let lastStatus: NotificationStatus = 'failed';
  for (let index = 0; index < Math.min(maxAttemptsPerRun, Math.max(0, maxAttempts - previousAttempts)); index += 1) {
    attempts += 1;
    try {
      const result = await send();
      const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      const providerResponse = record.providerResponse ?? result;
      const providerReference = typeof record.providerReference === 'string' ? record.providerReference : null;
      return {
        accepted: true, status: 'accepted', attempts, totalAttempts: previousAttempts + attempts,
        retryable: false, providerResponse, providerReference,
      };
    } catch (error) {
      lastError = error;
      lastStatus = error instanceof EmailDeliveryError ? error.status : 'unknown';
      const retryable = error instanceof EmailDeliveryError ? error.retryable : true;
      if (!retryable || previousAttempts + attempts >= maxAttempts || index + 1 >= maxAttemptsPerRun) {
        return {
          accepted: false, status: lastStatus, attempts, totalAttempts: previousAttempts + attempts,
          retryable: retryable && previousAttempts + attempts < maxAttempts,
          error: error instanceof EmailDeliveryError ? error.message : 'Email provider request failed.',
        };
      }
      await pause(400 * 2 ** index);
    }
  }
  return {
    accepted: false, status: lastStatus, attempts, totalAttempts: previousAttempts + attempts,
    retryable: false, error: lastError instanceof Error ? lastError.message : 'Email retry limit reached.',
  };
}
