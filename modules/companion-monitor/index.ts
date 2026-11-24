import { NativeModule, requireOptionalNativeModule } from 'expo';

export type MonitorSignal = {
  kind: 'private_phrase' | 'scream' | 'shouting' | 'distress_vocalization' | 'fall';
  confidence: number;
  confidenceAvailable?: boolean;
  exactPhraseMatch?: boolean;
  nativeDecisionHandled?: boolean;
  independentActivation?: boolean;
  phraseId?: string;
  timestamp: number;
  signalId: string;
};

export type MonitorStatus = {
  running: boolean;
  lastSignal?: MonitorSignal | null;
  status?: string | null;
  emergencyPending?: boolean;
  audioMonitoring?: boolean;
  audioCaptureEnabled?: boolean;
  motionMonitoring?: boolean;
  audioEvaluationLogging?: boolean;
  audioEvaluationLogError?: string | null;
  audioEvaluationRowsWritten?: number;
  audioEvaluationLogBytes?: number;
  audioEvaluationLimitReached?: boolean;
  audioEvaluationLastTimestampMs?: number | null;
  soundClassificationEnabled?: boolean;
  soundClassificationActive?: boolean;
  phraseRecognitionEnabled?: boolean;
  phraseRecognitionActive?: boolean;
  emergencyActive?: boolean;
  checkInPending?: boolean;
  checkInDeadlineAt?: number;
  checkInReason?: string | null;
  phraseModelReady?: boolean;
};

declare class CompanionMonitorNative extends NativeModule<{
  onDistressSignal: (signal: MonitorSignal) => void;
  onCheckInResolved: (event: { timestamp: number }) => void;
}> {
  startMonitoring(config: {
    journeyId: string;
    supabaseUrl: string;
    publishableKey: string;
    accessToken: string;
    refreshToken: string;
    screamThreshold?: number;
    motionEnabled: boolean;
    audioEnabled: boolean;
    soundEnabled: boolean;
    phraseRecognitionEnabled: boolean;
    triggerPhrasesJson: string;
  }): Promise<boolean>;
  stopMonitoring(): Promise<void>;
  triggerEmergency(reason: string): Promise<boolean>;
  resolveEmergency(): Promise<void>;
  confirmSafe(): Promise<void>;
  setAudioMonitoringEnabled(enabled: boolean, soundEnabled: boolean): Promise<void>;
  setTriggerPhrases(phrasesJson: string, enabled: boolean): Promise<void>;
  prepareOfflinePhraseModel(): Promise<boolean>;
  setMotionMonitoringEnabled(enabled: boolean): Promise<void>;
  setAudioEvaluationLoggingEnabled(enabled: boolean): Promise<void>;
  getAudioEvaluationCsv(): Promise<string>;
  clearAudioEvaluationCsv(): Promise<void>;
  getStatus(): Promise<MonitorStatus>;
}

export default requireOptionalNativeModule<CompanionMonitorNative>('CompanionMonitor');
