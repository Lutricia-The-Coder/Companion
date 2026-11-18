package expo.modules.companionmonitor

/** Pure policy helpers for recovering an interrupted native monitoring session. */
internal object MonitorRecoveryPolicy {
  fun shouldStartBackgroundAudio(userEnabled: Boolean, microphonePermissionGranted: Boolean): Boolean =
    userEnabled && microphonePermissionGranted

  fun remainingCheckInDelay(nowMillis: Long, deadlineMillis: Long): Long =
    (deadlineMillis - nowMillis).coerceAtLeast(0L)

  fun restoreCheckInDeadline(nowMillis: Long, savedDeadlineMillis: Long?, timeoutMillis: Long): Long =
    savedDeadlineMillis?.takeIf { it > 0L } ?: (nowMillis + timeoutMillis)
}
