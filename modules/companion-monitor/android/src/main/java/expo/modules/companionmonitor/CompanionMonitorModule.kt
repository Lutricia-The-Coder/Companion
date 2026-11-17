package expo.modules.companionmonitor

import android.content.Context
import android.content.Intent
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CompanionMonitorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CompanionMonitor")
    Events("onDistressSignal")

    OnCreate { CompanionMonitorBridge.module = this@CompanionMonitorModule }
    OnDestroy { CompanionMonitorBridge.module = null }

    AsyncFunction("startMonitoring") { config: Map<String, Any?> ->
      val context = appContext.reactContext?.applicationContext
        ?: throw IllegalStateException("Application context is unavailable.")
      val journeyId = config["journeyId"] as? String
        ?: throw IllegalArgumentException("An active journey ID is required.")
      val intent = Intent(context, CompanionMonitorService::class.java).apply {
        action = CompanionMonitorService.ACTION_START
        putExtra(CompanionMonitorService.EXTRA_JOURNEY_ID, journeyId)
        putExtra(CompanionMonitorService.EXTRA_SUPABASE_URL, config["supabaseUrl"] as? String ?: "")
        putExtra(CompanionMonitorService.EXTRA_PUBLISHABLE_KEY, config["publishableKey"] as? String ?: "")
        putExtra(CompanionMonitorService.EXTRA_ACCESS_TOKEN, config["accessToken"] as? String ?: "")
        putExtra(CompanionMonitorService.EXTRA_REFRESH_TOKEN, config["refreshToken"] as? String ?: "")
        putExtra(CompanionMonitorService.EXTRA_SCREAM_THRESHOLD, (config["screamThreshold"] as? Number)?.toFloat() ?: 0.82f)
        putExtra(CompanionMonitorService.EXTRA_AUDIO_ENABLED, config["audioEnabled"] as? Boolean ?: false)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
      true
    }

    AsyncFunction("stopMonitoring") {
      appContext.reactContext?.applicationContext?.let { context ->
        context.startService(Intent(context, CompanionMonitorService::class.java).setAction(CompanionMonitorService.ACTION_STOP))
      }
    }

    AsyncFunction("setBackgroundAudioEnabled") { enabled: Boolean ->
      appContext.reactContext?.applicationContext?.let { context ->
        context.startService(Intent(context, CompanionMonitorService::class.java)
          .setAction(CompanionMonitorService.ACTION_SET_AUDIO)
          .putExtra(CompanionMonitorService.EXTRA_AUDIO_ENABLED, enabled))
      }
    }

    AsyncFunction("getStatus") {
      val context = appContext.reactContext?.applicationContext
        ?: throw IllegalStateException("Application context is unavailable.")
      val prefs = context.getSharedPreferences(CompanionMonitorService.PREFS, Context.MODE_PRIVATE)
      mapOf(
        "running" to prefs.getBoolean("running", false),
        "lastSignal" to prefs.getString("lastSignal", null),
      )
    }
  }
}

internal object CompanionMonitorBridge {
  @Volatile var module: CompanionMonitorModule? = null

  fun emit(kind: String, confidence: Float, timestamp: Long, signalId: String) {
    module?.sendEvent(
      "onDistressSignal",
      mapOf("kind" to kind, "confidence" to confidence.toDouble(), "timestamp" to timestamp.toDouble(), "signalId" to signalId),
    )
  }
}
