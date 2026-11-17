package expo.modules.companionmonitor

import kotlin.math.sqrt

/** A conservative free-fall followed by impact heuristic; not a medically validated fall detector. */
internal class FallImpactDetector(
  private val freeFallThreshold: Float = 2.2f,
  private val impactThreshold: Float = 24f,
  private val minFallMs: Long = 120,
  private val maxFallMs: Long = 1_500,
) {
  private var freeFallAt = 0L

  fun onAcceleration(x: Float, y: Float, z: Float, timestampMs: Long): Float? {
    val magnitude = sqrt(x * x + y * y + z * z)
    if (magnitude < freeFallThreshold) {
      if (freeFallAt == 0L) freeFallAt = timestampMs
      return null
    }
    val startedAt = freeFallAt
    freeFallAt = 0L
    if (startedAt == 0L || timestampMs < startedAt) return null
    val duration = timestampMs - startedAt
    if (duration !in minFallMs..maxFallMs || magnitude < impactThreshold) return null
    return 0.7f + ((magnitude - impactThreshold) / 40f).coerceIn(0f, 0.29f)
  }

  fun reset() { freeFallAt = 0L }
}

