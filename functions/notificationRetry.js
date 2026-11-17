class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

async function withRetry(operation, maxAttempts = 3, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return { ...await operation(), attempts: attempt };
    } catch (error) {
      const retryable = error instanceof ProviderError ? error.retryable : true;
      if (!retryable || attempt === maxAttempts) {
        const finalError = error instanceof Error ? error : new Error(String(error));
        finalError.attempts = attempt;
        throw finalError;
      }
      await sleep(500 * (2 ** (attempt - 1)));
    }
  }
  throw new Error('Notification provider failed without a result.');
}

function summarizeNotificationOutcomes(sends, outcomes, completedAt = Date.now()) {
  const attempts = outcomes.map((result, index) => result.status === 'fulfilled'
    ? { channel: sends[index].channel, ...result.value }
    : {
      channel: sends[index].channel,
      status: 'failed',
      error: String(result.reason?.message || 'Provider request failed').slice(0, 160),
      attempts: result.reason?.attempts || 1,
    });
  const accepted = attempts.filter((attempt) => attempt.status === 'accepted').length;
  const failures = attempts.length - accepted;
  const status = accepted > 0 && failures === 0 ? 'accepted'
    : accepted > 0 ? 'partial'
      : attempts.length === 0 ? 'no_recipients' : 'failed';
  return { status, accepted, failures, attempts, completedAt };
}

module.exports = { ProviderError, summarizeNotificationOutcomes, withRetry };
