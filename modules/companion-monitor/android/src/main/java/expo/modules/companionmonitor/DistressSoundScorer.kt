package expo.modules.companionmonitor

/** Applies app policy to YAMNet AudioSet outputs. It does not validate classifier accuracy. */
internal class DistressSoundScorer(private val highThreshold: Float = 0.82f) {
  private var consecutiveHighWindows = 0

  data class Decision(val kind: String, val confidence: Float, val activate: Boolean)

  fun score(scores: FloatArray): Decision? {
    if (scores.size <= SCREAM_INDEX) return null
    val candidate = DISTRESS_INDICES.maxByOrNull { scores[it].coerceIn(0f, 1f) } ?: return null
    val confidence = scores[candidate].coerceIn(0f, 1f)
    val kind = if (candidate == SCREAM_INDEX) "scream" else "shouting"
    if (confidence >= highThreshold) {
      consecutiveHighWindows += 1
      if (consecutiveHighWindows >= 2) {
        consecutiveHighWindows = 0
        return Decision(kind, confidence, true)
      }
      return null
    }
    consecutiveHighWindows = 0
    return if (confidence >= CHECK_IN_THRESHOLD) Decision(kind, confidence, false) else null
  }

  fun reset() { consecutiveHighWindows = 0 }

  companion object {
    const val SCREAM_INDEX = 11
    const val CHECK_IN_THRESHOLD = 0.58f
    val DISTRESS_INDICES = intArrayOf(6, 9, 10, SCREAM_INDEX)
  }
}
