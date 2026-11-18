import { NativeModule, requireOptionalNativeModule } from 'expo';

export type MonitorSignal = {
  kind: 'scream' | 'shouting' | 'fall';
  confidence: number;
  timestamp: number;
  signalId: string;
};

declare class CompanionMonitorNative extends NativeModule<{
  onDistressSignal: (signal: MonitorSignal) => void;
}> {
  startMonitoring(config: {
    journeyId: string;
    supabaseUrl: string;
    publishableKey: string;
    accessToken: string;
    refreshToken: string;
    screamThreshold?: number;
    audioEnabled: boolean;
  }): Promise<boolean>;
  stopMonitoring(): Promise<void>;
  triggerEmergency(reason: string): Promise<boolean>;
  resolveEmergency(): Promise<void>;
  setBackgroundAudioEnabled(enabled: boolean): Promise<void>;
  getStatus(): Promise<{ running: boolean; lastSignal?: MonitorSignal | null; status?: string | null; emergencyPending?: boolean }>;
}

export default requireOptionalNativeModule<CompanionMonitorNative>('CompanionMonitor');
