package expo.modules.companionmonitor

import org.junit.Assert.*
import org.junit.Test

class SafetyDetectorsTest {
  @Test fun fallRequiresFreeFallAndSufficientImpactWithinWindow() {
    val detector = FallImpactDetector()
    assertNull(detector.onAcceleration(0f, 0f, 0f, 1_000))
    assertNull(detector.onAcceleration(0f, 0f, 10f, 1_200))
    assertNull(detector.onAcceleration(0f, 0f, 0f, 2_000))
    assertNull(detector.onAcceleration(0f, 0f, 30f, 2_050))
    assertNull(detector.onAcceleration(0f, 0f, 0f, 3_000))
    assertTrue(detector.onAcceleration(0f, 0f, 30f, 3_200)!! >= 0.7f)
  }

  @Test fun soundScorerRequiresTwoHighWindowsAndResetsOnQuiet() {
    val scorer = DistressSoundScorer()
    val highScream = FloatArray(12).apply { this[11] = 0.9f }
    assertNull(scorer.score(highScream))
    val activation = scorer.score(highScream)
    assertEquals("scream", activation?.kind)
    assertTrue(activation?.activate == true)
    assertNull(scorer.score(FloatArray(12)))
    assertNull(scorer.score(highScream))
  }

  @Test fun soundScorerRequestsCheckInForMediumConfidence() {
    val scorer = DistressSoundScorer()
    val mediumShout = FloatArray(12).apply { this[6] = 0.7f }
    val decision = scorer.score(mediumShout)
    assertEquals("shouting", decision?.kind)
    assertFalse(decision?.activate ?: true)
  }
}
