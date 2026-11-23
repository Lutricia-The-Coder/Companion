export type ExistingEmergencyNotificationSummary = {
  status?: unknown;
  retryable?: unknown;
};

export type DuplicateEmergencyPolicy = {
  shouldNotify: boolean;
  status: string;
  retryable: boolean;
};

/**
 * A duplicate activation may be a concurrent Android/JS request. Never send while
 * the first request is pending; only retry after its persisted outcome says so.
 */
export function duplicateEmergencyPolicy(
  summary: ExistingEmergencyNotificationSummary | null | undefined,
): DuplicateEmergencyPolicy {
  const status = typeof summary?.status === 'string' ? summary.status : 'pending';
  if (status === 'pending' || status === 'queued') {
    return { shouldNotify: false, status: 'already_active', retryable: true };
  }
  if (summary?.retryable === true) {
    return { shouldNotify: true, status, retryable: true };
  }
  return { shouldNotify: false, status: status === 'pending' ? 'already_active' : status, retryable: false };
}
