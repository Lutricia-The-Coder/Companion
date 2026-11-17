export type MotionSample = { x: number; y: number; z: number; timestamp: number };

const GRAVITY = 9.80665;

/** Detects a possible fall pattern (brief free fall followed by a high impact). */
export class FallDetector {
  private freeFallAt: number | null = null;
  private lastSignalAt = 0;

  observe(sample: MotionSample): { confidence: number; timestamp: number; signalId: string } | null {
    if (![sample.x, sample.y, sample.z, sample.timestamp].every(Number.isFinite)) return null;
    if (sample.timestamp <= 0 || (this.lastSignalAt > 0 && sample.timestamp - this.lastSignalAt < 8_000)) return null;

    const magnitude = Math.hypot(sample.x, sample.y, sample.z);
    const gravityUnits = magnitude / GRAVITY;

    if (gravityUnits < 0.35) {
      this.freeFallAt ??= sample.timestamp;
      return null;
    }

    const freeFallDuration = this.freeFallAt === null ? 0 : sample.timestamp - this.freeFallAt;
    const followedByImpact = this.freeFallAt !== null
      && freeFallDuration >= 150
      && freeFallDuration <= 1_500
      && gravityUnits >= 2.5;
    this.freeFallAt = null;

    if (!followedByImpact) return null;
    this.lastSignalAt = sample.timestamp;
    return {
      confidence: Math.min(0.98, 0.88 + Math.min(0.1, (gravityUnits - 2.5) * 0.04)),
      timestamp: sample.timestamp,
      signalId: `fall-${sample.timestamp}`,
    };
  }
}
