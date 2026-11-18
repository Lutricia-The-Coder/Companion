import {
  SafetyDecisionEngine,
  type SafetyEngineAction,
  type SafetyEnginePolicy,
  type SafetySignal,
} from './safetyDecisionEngine';

export type DistressSignalKind = SafetySignal['kind'];
export type DistressSignal = SafetySignal;
export type AgentAction = 'none' | 'prompt_user' | 'send_emergency';
export type SafetyAgentPolicy = Partial<SafetyEnginePolicy>;

/** UI/timer adapter around the deterministic, directly testable safety core. */
export class SafetyAgent {
  private readonly engine: SafetyDecisionEngine;
  private confirmationTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onAction: (action: AgentAction, reason?: string, deadline?: number) => void;

  constructor(onAction: (action: AgentAction, reason?: string, deadline?: number) => void, policy: SafetyAgentPolicy = {}) {
    this.engine = new SafetyDecisionEngine(policy);
    this.onAction = onAction;
  }

  startJourney() {
    this.consume(this.engine.startJourney());
  }

  observe(signal: DistressSignal) {
    this.consume(this.engine.observe(signal));
  }

  cancelPendingAlert() {
    this.clearConfirmationTimer();
    const actions = this.engine.confirmSafe();
    if (actions.length > 0) this.onAction('none');
  }

  markAlertsSent() {
    this.consume(this.engine.markAlertsSent());
  }

  startEmergencyTracking() {
    this.consume(this.engine.startEmergencyTracking());
  }

  resolve() {
    this.clearConfirmationTimer();
    this.consume(this.engine.resolve());
  }

  dispose() {
    this.clearConfirmationTimer();
  }

  private consume(actions: SafetyEngineAction[]) {
    for (const action of actions) {
      if (action.type === 'request_check_in') {
        this.onAction('prompt_user', action.reason, action.deadline);
        this.clearConfirmationTimer();
        this.confirmationTimer = setTimeout(() => {
          this.confirmationTimer = null;
          this.consume(this.engine.tick(Date.now()));
        }, Math.max(0, action.deadline - Date.now()));
      } else if (action.type === 'activate_emergency') {
        this.clearConfirmationTimer();
        this.onAction('send_emergency', action.reason);
      }
    }
  }

  private clearConfirmationTimer() {
    if (this.confirmationTimer) clearTimeout(this.confirmationTimer);
    this.confirmationTimer = null;
  }
}

let activeAgent: SafetyAgent | null = null;

export function setActiveSafetyAgent(agent: SafetyAgent | null) {
  activeAgent?.dispose();
  activeAgent = agent;
  activeAgent?.startJourney();
}

export function reportSafetySignal(signal: DistressSignal) {
  activeAgent?.observe(signal);
}
