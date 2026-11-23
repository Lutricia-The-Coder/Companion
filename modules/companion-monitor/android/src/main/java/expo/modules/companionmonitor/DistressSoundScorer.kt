package expo.modules.companionmonitor

/** Applies app policy to YAMNet AudioSet outputs. It does not validate classifier accuracy. */
internal class DistressSoundScorer(private val highThreshold: Float = 0.82f) {
  private var consecutiveHighWindows = 0

  data class Decision(val kind: String, val confidence: Float, val activate: Boolean)

  fun score(scores: FloatArray): Decision? {
    val prediction = prediction(scores) ?: return null
    val confidence = prediction.second
    val kind = prediction.first
    if (confidence >= highThreshold) {
      consecutiveHighWindows += 1
      if (consecutiveHighWindows >= 2) {
        consecutiveHighWindows = 0
        // Crying/whimpering can indicate distress, but is never sufficient by itself
        // to auto-activate an emergency; it requests a user check-in instead.
        return Decision(kind, confidence, kind != "distress_vocalization")
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
    val SHOUT_INDICES = intArrayOf(6, 9, 10)
    val VOCAL_DISTRESS_INDICES = intArrayOf(19, 20, 21, 22) // crying, infant cry, whimper, wail/moan
    val DISTRESS_INDICES = SHOUT_INDICES + SCREAM_INDEX + VOCAL_DISTRESS_INDICES

    fun prediction(scores: FloatArray): Pair<String, Float>? {
      if (scores.size <= VOCAL_DISTRESS_INDICES.last()) return null
      val candidate = DISTRESS_INDICES.maxByOrNull { scores[it].coerceIn(0f, 1f) } ?: return null
      val confidence = scores[candidate].coerceIn(0f, 1f)
      val kind = when (candidate) {
        SCREAM_INDEX -> "scream"
        in SHOUT_INDICES -> "shouting"
        else -> "distress_vocalization"
      }
      return kind to confidence
    }
  }
}
