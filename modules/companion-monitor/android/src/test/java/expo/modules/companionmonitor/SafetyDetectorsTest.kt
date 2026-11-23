package expo.modules.companionmonitor

import org.junit.Assert.*
import org.junit.Test

class SafetyDetectorsTest {
  @Test fun disabledBackgroundAudioNeverRestartsEvenWhenPermissionIsGranted() {
    assertFalse(MonitorRecoveryPolicy.shouldStartBackgroundAudio(userEnabled = false, microphonePermissionGranted = true))
    assertFalse(MonitorRecoveryPolicy.shouldStartBackgroundAudio(userEnabled = false, microphonePermissionGranted = false))
    assertTrue(MonitorRecoveryPolicy.shouldStartBackgroundAudio(userEnabled = true, microphonePermissionGranted = true))
    assertFalse(MonitorRecoveryPolicy.shouldStartBackgroundAudio(userEnabled = true, microphonePermissionGranted = false))
  }

  @Test fun interruptedCheckInRetainsItsDeadlineAndExpiredChecksRunImmediately() {
    assertEquals(4_000L, MonitorRecoveryPolicy.remainingCheckInDelay(10_000L, 14_000L))
    assertEquals(0L, MonitorRecoveryPolicy.remainingCheckInDelay(14_000L, 10_000L))
    assertEquals(30_000L, MonitorRecoveryPolicy.restoreCheckInDeadline(10_000L, null, 20_000L))
    assertEquals(14_000L, MonitorRecoveryPolicy.restoreCheckInDeadline(10_000L, 14_000L, 20_000L))
  }

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
    val highScream = FloatArray(23).apply { this[11] = 0.9f }
    assertNull(scorer.score(highScream))
    val activation = scorer.score(highScream)
    assertEquals("scream", activation?.kind)
    assertTrue(activation?.activate == true)
    assertNull(scorer.score(FloatArray(12)))
    assertNull(scorer.score(highScream))
  }

  @Test fun soundScorerRequestsCheckInForMediumConfidence() {
    val scorer = DistressSoundScorer()
    val mediumShout = FloatArray(23).apply { this[6] = 0.7f }
    val decision = scorer.score(mediumShout)
    assertEquals("shouting", decision?.kind)
    assertFalse(decision?.activate ?: true)
  }

  @Test fun cryingAndWhimperingAreClassifiedAsVocalDistressButNeverActivateAlone() {
    val scorer = DistressSoundScorer()
    val crying = FloatArray(23).apply { this[19] = 0.9f }
    assertNull(scorer.score(crying))
    val decision = scorer.score(crying)
    assertEquals("distress_vocalization", decision?.kind)
    assertFalse(decision?.activate ?: true)
  }

  @Test fun shortModelOutputIsRejectedInsteadOfReadingPastTheScoreArray() {
    assertNull(DistressSoundScorer.prediction(FloatArray(22)))
  }

  @Test fun audioWindowsAdvanceByTheYamnetHopAndRetainOverlap() {
    val windows = AudioWindowBuffer(windowSize = 8, hopSize = 3)
    val first = ShortArray(8) { it.toShort() }
    windows.append(first, first.size)
    assertTrue(windows.isReady())
    assertArrayEquals(first, windows.currentWindow())
    windows.advance()

    val second = shortArrayOf(8, 9, 10)
    windows.append(second, second.size)
    assertTrue(windows.isReady())
    assertArrayEquals(shortArrayOf(3, 4, 5, 6, 7, 8, 9, 10), windows.currentWindow())
  }

  @Test fun pcmPreprocessingNormalizesSamplesToYamnetFloatRange() {
    val result = AudioPreprocessor.normalizePcm16(shortArrayOf(Short.MIN_VALUE, 0, Short.MAX_VALUE))
    assertArrayEquals(floatArrayOf(-1f, 0f, 32767f / 32768f), result, 0.000001f)
  }
}
