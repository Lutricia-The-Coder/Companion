package expo.modules.companionmonitor

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.rule.GrantPermissionRule
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class CompanionMonitorServiceLifecycleTest {
  private val context: Context = ApplicationProvider.getApplicationContext()

  @get:Rule
  val microphonePermission: GrantPermissionRule =
    GrantPermissionRule.grant(Manifest.permission.RECORD_AUDIO)

  @Test
  fun activeJourneyStartPersistsStateAndExplicitStopClearsIt() {
    val preferences = clearPreferences()
    val startIntent = Intent(context, CompanionMonitorService::class.java)
      .setAction(CompanionMonitorService.ACTION_START)
      .putExtra(CompanionMonitorService.EXTRA_JOURNEY_ID, "instrumented-journey")
      .putExtra(CompanionMonitorService.EXTRA_AUDIO_ENABLED, false)

    startUnboundService(startIntent)
    waitForState { preferences.getBoolean("running", false) }

    assertTrue(preferences.getBoolean("running", false))
    assertEquals("instrumented-journey", preferences.getString("journeyId", null))
    assertFalse(preferences.getBoolean("backgroundAudioEnabled", true))

    context.startService(serviceIntent(CompanionMonitorService.ACTION_STOP))
    waitForState { !preferences.getBoolean("running", true) }
    assertFalse(preferences.getBoolean("running", true))
  }

  @Test
  fun stickyRestartWithoutAnActionRestoresAnActiveJourney() {
    val preferences = clearPreferences()
    preferences.edit()
      .putBoolean("running", true)
      .putBoolean("backgroundAudioEnabled", false)
      .putString("journeyId", "restored-journey")
      .commit()

    startUnboundService(Intent(context, CompanionMonitorService::class.java))
    waitForState { preferences.getBoolean("running", false) }

    assertTrue(preferences.getBoolean("running", false))
    assertEquals("restored-journey", preferences.getString("journeyId", null))

    context.startService(serviceIntent(CompanionMonitorService.ACTION_STOP))
    waitForState { !preferences.getBoolean("running", true) }
  }

  @Test
  fun safetyConfirmationClearsPendingCheckInAndKeepsMonitoring() {
    val preferences = clearPreferences()
    preferences.edit()
      .putBoolean("running", true)
      .putBoolean("backgroundAudioEnabled", false)
      .putString("journeyId", "safe-confirmation-journey")
      .putBoolean("checkInPending", true)
      .commit()

    startUnboundService(
      Intent(context, CompanionMonitorService::class.java)
        .setAction(CompanionMonitorService.ACTION_START)
        .putExtra(CompanionMonitorService.EXTRA_JOURNEY_ID, "safe-confirmation-journey")
        .putExtra(CompanionMonitorService.EXTRA_AUDIO_ENABLED, false),
    )
    context.startService(serviceIntent(CompanionMonitorService.ACTION_CONFIRM_SAFE))

    waitForState { !preferences.getBoolean("checkInPending", true) }
    assertTrue(preferences.getBoolean("running", false))

    context.startService(serviceIntent(CompanionMonitorService.ACTION_STOP))
    waitForState { !preferences.getBoolean("running", true) }
  }

  private fun clearPreferences() = context
    .getSharedPreferences(CompanionMonitorService.PREFS, Context.MODE_PRIVATE)
    .also { it.edit().clear().commit() }

  private fun serviceIntent(action: String) =
    Intent(context, CompanionMonitorService::class.java).setAction(action)

  private fun startUnboundService(intent: Intent) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
    else context.startService(intent)
  }

  @After
  fun stopServiceAfterTest() {
    val preferences = context.getSharedPreferences(CompanionMonitorService.PREFS, Context.MODE_PRIVATE)
    if (preferences.getBoolean("running", false)) {
      context.startService(serviceIntent(CompanionMonitorService.ACTION_STOP))
      waitForState { !preferences.getBoolean("running", true) }
    }
  }

  private fun waitForState(predicate: () -> Boolean) {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
    while (!predicate() && System.nanoTime() < deadline) Thread.sleep(25)
    assertTrue("Timed out waiting for the monitor service state.", predicate())
  }
}
