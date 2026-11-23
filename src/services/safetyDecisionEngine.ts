export type SafetyState =
  | 'IDLE'
  | 'MONITORING'
  | 'POSSIBLE_DISTRESS'
  | 'EMERGENCY_ACTIVATED'
  | 'ALERTS_SENT'
  | 'LIVE_EMERGENCY_TRACKING'
  | 'RESOLVED';

export type SafetySignalKind =
  | 'private_phrase'
  | 'loud_audio'
  | 'scream'
  | 'shouting'
  | 'distress_vocalization'
  | 'fall'
  | 'route_deviation'
  | 'missed_check_in';

export type SafetySignal = {
  kind: SafetySignalKind;
  confidence: number;
  /** False means the recognizer did not provide a score; this is not a zero-confidence result. */
  confidenceAvailable?: boolean;
  timestamp: number;
  exactPhraseMatch?: boolean;
  independentActivation?: boolean;
  signalId?: string;
};

export type SafetyEnginePolicy = {
  independentPhraseEnabled: boolean;
  phraseConfidence: number;
  soundConfidence: number;
  fallConfidence: number;
  combinedConfidence: number;
  confirmationWindowMs: number;
  evidenceWindowMs: number;
  maxRecordedSignals: number;
};

export type SafetyDecisionRecord = {
  at: number;
  state: SafetyState;
  decision: 'monitoring_started' | 'check_in_requested' | 'emergency_activated' | 'safe_confirmed' | 'alerts_accepted' | 'live_tracking_started' | 'resolved';
  reason: string;
  signals: Pick<SafetySignal, 'kind' | 'confidence' | 'timestamp' | 'signalId'>[];
};

export type SafetyEngineAction =
  | { type: 'state_changed'; from: SafetyState; to: SafetyState }
  | { type: 'request_check_in'; reason: string; deadline: number }
  | { type: 'activate_emergency'; reason: string; eventId: string };

export const DEFAULT_SAFETY_POLICY: SafetyEnginePolicy = {
  independentPhraseEnabled: true,
  // ASR scores are provider-specific and uncalibrated; exact transcript match is still required.
  phraseConfidence: 0.65,
  soundConfidence: 0.94,
  fallConfidence: 0.95,
  combinedConfidence: 1.6,
  confirmationWindowMs: 12_000,
  evidenceWindowMs: 8_000,
  maxRecordedSignals: 100,
};

/** Deterministic core. Adapters provide signals and execute returned actions. */
export class SafetyDecisionEngine {
  private currentState: SafetyState = 'IDLE';
  private readonly policy: SafetyEnginePolicy;
  private evidence: SafetySignal[] = [];
  private readonly seenSignalIds = new Set<string>();
  private confirmationDeadline: number | null = null;
  private eventSequence = 0;
  private readonly decisions: SafetyDecisionRecord[] = [];

  constructor(policy: Partial<SafetyEnginePolicy> = {}) {
    this.policy = { ...DEFAULT_SAFETY_POLICY, ...policy };
  }

  get state() { return this.currentState; }
  get pendingDeadline() { return this.confirmationDeadline; }

  /** Bounded, transcript-free decision trace for diagnostics and deterministic tests. */
  getDecisionHistory(): SafetyDecisionRecord[] {
    return this.decisions.map((record) => ({ ...record, signals: record.signals.map((signal) => ({ ...signal })) }));
  }

  startJourney(): SafetyEngineAction[] {
    if (this.currentState !== 'IDLE' && this.currentState !== 'RESOLVED') return [];
    this.evidence = [];
    this.seenSignalIds.clear();
    this.confirmationDeadline = null;
    const actions = this.transition('MONITORING');
    this.record('monitoring_started', 'Journey monitoring started.', Date.now());
    return actions;
  }

  observe(signal: SafetySignal): SafetyEngineAction[] {
    if (this.currentState !== 'MONITORING' && this.currentState !== 'POSSIBLE_DISTRESS') return [];
    if (!Number.isFinite(signal.timestamp) || !Number.isFinite(signal.confidence)) return [];
    if (signal.signalId && this.seenSignalIds.has(signal.signalId)) return [];
    if (signal.signalId) this.seenSignalIds.add(signal.signalId);

    const confidence = Math.max(0, Math.min(1, signal.confidence));
    const now = signal.timestamp;
    // Keep only recent, non-future evidence. Ignore stale/out-of-order signals so they
    // cannot erase newer context or be combined with events from a different moment.
    const newest = Math.max(0, ...this.evidence.map((item) => item.timestamp));
    if (now < newest - this.policy.evidenceWindowMs) return [];
    this.evidence = this.evidence.filter((item) => item.timestamp <= now + 5_000 && now - item.timestamp <= this.policy.evidenceWindowMs);
    this.evidence.push({ ...signal, confidence });
    this.evidence = this.evidence.slice(-this.policy.maxRecordedSignals);

    const phraseConfidenceAccepted = signal.confidenceAvailable === false || confidence >= this.policy.phraseConfidence;
    if (signal.kind === 'private_phrase' && signal.exactPhraseMatch && phraseConfidenceAccepted) {
      if (signal.independentActivation ?? this.policy.independentPhraseEnabled) return this.activate('Configured personal SOS phrase matched.', now);
      return this.requestCheckIn(now, 'Configured SOS phrase matched; independent activation is disabled.');
    }

    const scream = this.peak('scream');
    const shouting = this.peak('shouting');
    const sound = Math.max(scream, shouting, this.peak('distress_vocalization'));
    const loudAudio = this.peak('loud_audio');
    const fall = this.peak('fall');
    const routeDeviation = this.peak('route_deviation');
    const missedCheckIn = this.peak('missed_check_in');

    if (fall >= this.policy.fallConfidence && sound >= this.policy.soundConfidence) {
      return this.activate('High-confidence fall and distress sound occurred together.', now);
    }

    // A microphone volume meter can identify loud input, but cannot classify it as a scream.
    // It may ask for a check-in; it must never independently activate an emergency.
    if (loudAudio >= 0.85) return this.requestCheckIn(now, 'Repeated high microphone volume was detected; this is not a scream classification.');

    const combined = sound + fall + routeDeviation + missedCheckIn;
    if (combined >= this.policy.combinedConfidence && (sound >= 0.7 || fall >= 0.7)) {
      return this.activate('Recent audio, motion, route, or check-in signals combined above the configured emergency threshold.', now);
    }

    if (sound >= this.policy.soundConfidence || fall >= this.policy.fallConfidence) {
      return this.requestCheckIn(now, 'A high-confidence distress signal needs a safety check.');
    }
    if (combined >= 0.85) return this.requestCheckIn(now, 'Several moderate signals may indicate a safety problem.');
    return [];
  }

  tick(now: number): SafetyEngineAction[] {
    if (this.currentState !== 'POSSIBLE_DISTRESS' || this.confirmationDeadline === null || now < this.confirmationDeadline) return [];
    return this.activate('The user did not respond before the safety check expired.', now);
  }

  confirmSafe(): SafetyEngineAction[] {
    if (this.currentState !== 'POSSIBLE_DISTRESS') return [];
    this.confirmationDeadline = null;
    this.evidence = [];
    const actions = this.transition('MONITORING');
    this.record('safe_confirmed', 'The user confirmed they are safe; monitoring continues.', Date.now());
    return actions;
  }

  markAlertsSent(): SafetyEngineAction[] {
    if (this.currentState !== 'EMERGENCY_ACTIVATED') return [];
    const actions = this.transition('ALERTS_SENT');
    this.record('alerts_accepted', 'At least one configured contact notification was accepted by its provider.', Date.now());
    return actions;
  }

  startEmergencyTracking(): SafetyEngineAction[] {
    if (this.currentState !== 'ALERTS_SENT' && this.currentState !== 'EMERGENCY_ACTIVATED') return [];
    const actions = this.transition('LIVE_EMERGENCY_TRACKING');
    this.record('live_tracking_started', 'Emergency live tracking was started.', Date.now());
    return actions;
  }

  resolve(): SafetyEngineAction[] {
    if (this.currentState === 'IDLE' || this.currentState === 'RESOLVED') return [];
    this.confirmationDeadline = null;
    const actions = this.transition('RESOLVED');
    this.record('resolved', 'The emergency or journey monitoring was resolved.', Date.now());
    return actions;
  }

  /** Manual SOS uses the same deduplicated emergency path as automatic decisions. */
  activateManually(reason = 'Manual SOS', now = Date.now()): SafetyEngineAction[] {
    if (this.currentState !== 'MONITORING' && this.currentState !== 'POSSIBLE_DISTRESS') return [];
    return this.activate(reason, now);
  }

  private peak(kind: SafetySignalKind) {
    return Math.max(0, ...this.evidence.filter((item) => item.kind === kind).map((item) => item.confidence));
  }

  private requestCheckIn(now: number, reason: string): SafetyEngineAction[] {
    if (this.currentState === 'POSSIBLE_DISTRESS') return [];
    this.confirmationDeadline = now + this.policy.confirmationWindowMs;
    const actions = [
      ...this.transition('POSSIBLE_DISTRESS'),
      { type: 'request_check_in', reason, deadline: this.confirmationDeadline },
    ] as SafetyEngineAction[];
    this.record('check_in_requested', reason, now);
    return actions;
  }

  private activate(reason: string, now = Date.now()): SafetyEngineAction[] {
    if (this.currentState === 'EMERGENCY_ACTIVATED' || this.currentState === 'ALERTS_SENT' || this.currentState === 'LIVE_EMERGENCY_TRACKING') return [];
    this.confirmationDeadline = null;
    this.eventSequence += 1;
    const actions = [
      ...this.transition('EMERGENCY_ACTIVATED'),
      { type: 'activate_emergency', reason, eventId: `local-emergency-${this.eventSequence}` },
    ] as SafetyEngineAction[];
    this.record('emergency_activated', reason, now);
    return actions;
  }

  private record(decision: SafetyDecisionRecord['decision'], reason: string, at: number) {
    this.decisions.push({
      at,
      state: this.currentState,
      decision,
      reason,
      signals: this.evidence.map(({ kind, confidence, timestamp, signalId }) => ({ kind, confidence, timestamp, signalId })),
    });
    if (this.decisions.length > this.policy.maxRecordedSignals) this.decisions.splice(0, this.decisions.length - this.policy.maxRecordedSignals);
  }

  private transition(to: SafetyState): SafetyEngineAction[] {
    if (this.currentState === to) return [];
    const from = this.currentState;
    this.currentState = to;
    return [{ type: 'state_changed', from, to }];
  }
}
