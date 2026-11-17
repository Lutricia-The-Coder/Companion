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
  | 'fall'
  | 'route_deviation'
  | 'missed_check_in';

export type SafetySignal = {
  kind: SafetySignalKind;
  confidence: number;
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
};

export type SafetyEngineAction =
  | { type: 'state_changed'; from: SafetyState; to: SafetyState }
  | { type: 'request_check_in'; reason: string; deadline: number }
  | { type: 'activate_emergency'; reason: string; eventId: string };

export const DEFAULT_SAFETY_POLICY: SafetyEnginePolicy = {
  independentPhraseEnabled: true,
  phraseConfidence: 0.9,
  soundConfidence: 0.94,
  fallConfidence: 0.95,
  combinedConfidence: 1.6,
  confirmationWindowMs: 12_000,
  evidenceWindowMs: 8_000,
};

/** Deterministic core. Adapters provide signals and execute returned actions. */
export class SafetyDecisionEngine {
  private currentState: SafetyState = 'IDLE';
  private readonly policy: SafetyEnginePolicy;
  private evidence: SafetySignal[] = [];
  private readonly seenSignalIds = new Set<string>();
  private confirmationDeadline: number | null = null;
  private eventSequence = 0;

  constructor(policy: Partial<SafetyEnginePolicy> = {}) {
    this.policy = { ...DEFAULT_SAFETY_POLICY, ...policy };
  }

  get state() { return this.currentState; }
  get pendingDeadline() { return this.confirmationDeadline; }

  startJourney(): SafetyEngineAction[] {
    if (this.currentState !== 'IDLE' && this.currentState !== 'RESOLVED') return [];
    this.evidence = [];
    this.seenSignalIds.clear();
    this.confirmationDeadline = null;
    return this.transition('MONITORING');
  }

  observe(signal: SafetySignal): SafetyEngineAction[] {
    if (this.currentState !== 'MONITORING' && this.currentState !== 'POSSIBLE_DISTRESS') return [];
    if (!Number.isFinite(signal.timestamp) || !Number.isFinite(signal.confidence)) return [];
    if (signal.signalId && this.seenSignalIds.has(signal.signalId)) return [];
    if (signal.signalId) this.seenSignalIds.add(signal.signalId);

    const confidence = Math.max(0, Math.min(1, signal.confidence));
    const now = signal.timestamp;
    this.evidence = this.evidence.filter((item) => now >= item.timestamp && now - item.timestamp <= this.policy.evidenceWindowMs);
    this.evidence.push({ ...signal, confidence });

    if (signal.kind === 'private_phrase' && signal.exactPhraseMatch && confidence >= this.policy.phraseConfidence) {
      if (signal.independentActivation ?? this.policy.independentPhraseEnabled) return this.activate('Configured personal SOS phrase matched.');
      return this.requestCheckIn(now, 'Configured SOS phrase matched; independent activation is disabled.');
    }

    const scream = this.peak('scream');
    const shouting = this.peak('shouting');
    const sound = Math.max(scream, shouting);
    const loudAudio = this.peak('loud_audio');
    const fall = this.peak('fall');
    const routeDeviation = this.peak('route_deviation');
    const missedCheckIn = this.peak('missed_check_in');

    if (fall >= this.policy.fallConfidence && sound >= this.policy.soundConfidence) {
      return this.activate('High-confidence fall and distress sound occurred together.');
    }

    // A microphone volume meter can identify loud input, but cannot classify it as a scream.
    // It may ask for a check-in; it must never independently activate an emergency.
    if (loudAudio >= 0.85) return this.requestCheckIn(now, 'Repeated high microphone volume was detected; this is not a scream classification.');

    const combined = sound + fall + routeDeviation + missedCheckIn;
    if (combined >= this.policy.combinedConfidence && (sound >= 0.7 || fall >= 0.7)) {
      return this.activate('Multiple independent safety signals indicate immediate danger.');
    }

    if (sound >= this.policy.soundConfidence || fall >= this.policy.fallConfidence) {
      return this.requestCheckIn(now, 'A high-confidence distress signal needs a safety check.');
    }
    if (combined >= 0.85) return this.requestCheckIn(now, 'Several moderate signals may indicate a safety problem.');
    return [];
  }

  tick(now: number): SafetyEngineAction[] {
    if (this.currentState !== 'POSSIBLE_DISTRESS' || this.confirmationDeadline === null || now < this.confirmationDeadline) return [];
    return this.activate('The user did not respond before the safety check expired.');
  }

  confirmSafe(): SafetyEngineAction[] {
    if (this.currentState !== 'POSSIBLE_DISTRESS') return [];
    this.confirmationDeadline = null;
    this.evidence = [];
    return this.transition('MONITORING');
  }

  markAlertsSent(): SafetyEngineAction[] {
    return this.currentState === 'EMERGENCY_ACTIVATED' ? this.transition('ALERTS_SENT') : [];
  }

  startEmergencyTracking(): SafetyEngineAction[] {
    return this.currentState === 'ALERTS_SENT' ? this.transition('LIVE_EMERGENCY_TRACKING') : [];
  }

  resolve(): SafetyEngineAction[] {
    if (this.currentState === 'IDLE' || this.currentState === 'RESOLVED') return [];
    this.confirmationDeadline = null;
    return this.transition('RESOLVED');
  }

  private peak(kind: SafetySignalKind) {
    return Math.max(0, ...this.evidence.filter((item) => item.kind === kind).map((item) => item.confidence));
  }

  private requestCheckIn(now: number, reason: string): SafetyEngineAction[] {
    if (this.currentState === 'POSSIBLE_DISTRESS') return [];
    this.confirmationDeadline = now + this.policy.confirmationWindowMs;
    return [
      ...this.transition('POSSIBLE_DISTRESS'),
      { type: 'request_check_in', reason, deadline: this.confirmationDeadline },
    ];
  }

  private activate(reason: string): SafetyEngineAction[] {
    if (this.currentState === 'EMERGENCY_ACTIVATED' || this.currentState === 'ALERTS_SENT' || this.currentState === 'LIVE_EMERGENCY_TRACKING') return [];
    this.confirmationDeadline = null;
    this.eventSequence += 1;
    return [
      ...this.transition('EMERGENCY_ACTIVATED'),
      { type: 'activate_emergency', reason, eventId: `local-emergency-${this.eventSequence}` },
    ];
  }

  private transition(to: SafetyState): SafetyEngineAction[] {
    if (this.currentState === to) return [];
    const from = this.currentState;
    this.currentState = to;
    return [{ type: 'state_changed', from, to }];
  }
}
