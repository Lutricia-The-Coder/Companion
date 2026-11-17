export type EmailOutcome = {
  channel: 'email';
  target: string;
  accepted: boolean;
  status: 'accepted' | 'failed';
  attempts: number;
  providerResponse?: unknown;
  error?: string;
};

export class EmailDeliveryError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'EmailDeliveryError';
    this.retryable = retryable;
  }
}

export async function sendResendEmail(input: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
  fetcher?: typeof fetch;
}) {
  if (!input.apiKey || !input.from) throw new Error('Email provider is not configured');
  const result = await (input.fetcher ?? fetch)('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': input.idempotencyKey,
    },
    body: JSON.stringify({ from: input.from, to: [input.to], subject: input.subject, text: input.text }),
  });
  if (!result.ok) {
    const retryable = result.status === 408 || result.status === 429 || result.status >= 500;
    throw new EmailDeliveryError(`Resend rejected email (HTTP ${result.status})`, retryable);
  }
  const provider = await result.json().catch(() => ({}));
  return { status: 'accepted', providerReference: provider.id ?? null };
}

/** Return unique, syntactically valid trusted-contact email addresses only. */
export function emailTargets(value: unknown, enabled = true): string[] {
  if (!enabled || !Array.isArray(value)) return [];
  const targets = new Set<string>();
  for (const item of value.slice(0, 10)) {
    if (!item || typeof item !== 'object') continue;
    const email = typeof item.email === 'string' ? item.email.trim().toLowerCase() : '';
    if (email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) targets.add(email);
  }
  return [...targets];
}

export async function retryEmailDelivery(
  send: () => Promise<unknown>,
  pause: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<Omit<EmailOutcome, 'channel' | 'target'>> {
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return { accepted: true, status: 'accepted', attempts: attempt + 1, providerResponse: await send() };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Email provider failure';
      if (error && typeof error === 'object' && 'retryable' in error && error.retryable === false) {
        return { accepted: false, status: 'failed', attempts: attempt + 1, error: lastError };
      }
      if (attempt < 2) await pause(400 * (attempt + 1));
    }
  }
  return { accepted: false, status: 'failed', attempts: 3, error: lastError };
}
