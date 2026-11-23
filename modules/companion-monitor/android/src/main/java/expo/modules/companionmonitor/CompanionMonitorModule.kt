package expo.modules.companionmonitor

import android.content.Context
import android.content.Intent
import android.os.Build
import java.io.File
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CompanionMonitorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CompanionMonitor")
    Events("onDistressSignal", "onCheckInResolved")

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
        putExtra(CompanionMonitorService.EXTRA_MOTION_ENABLED, config["motionEnabled"] as? Boolean ?: true)
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

    AsyncFunction("setMotionMonitoringEnabled") { enabled: Boolean ->
      appContext.reactContext?.applicationContext?.let { context ->
        context.startService(Intent(context, CompanionMonitorService::class.java)
          .setAction(CompanionMonitorService.ACTION_SET_MOTION)
          .putExtra(CompanionMonitorService.EXTRA_MOTION_ENABLED, enabled))
      }
    }

    AsyncFunction("setAudioEvaluationLoggingEnabled") { enabled: Boolean ->
      val context = appContext.reactContext?.applicationContext
        ?: throw IllegalStateException("Application context is unavailable.")
      context.getSharedPreferences(CompanionMonitorService.PREFS, Context.MODE_PRIVATE)
        .edit().putBoolean("audioEvaluationLogging", enabled).apply()
    }

    AsyncFunction("getAudioEvaluationCsv") {
      val context = appContext.reactContext?.applicationContext
        ?: throw IllegalStateException("Application context is unavailable.")
      val file = File(context.filesDir, CompanionMonitorService.AUDIO_EVALUATION_FILENAME)
      if (!file.exists()) "" else file.readText()
    }

    AsyncFunction("clearAudioEvaluationCsv") {
      val context = appContext.reactContext?.applicationContext
        ?: throw IllegalStateException("Application context is unavailable.")
      context.getSharedPreferences(CompanionMonitorService.PREFS, Context.MODE_PRIVATE)
        .edit().putInt("audioEvaluationRowsWritten", 0).apply()
      File(context.filesDir, CompanionMonitorService.AUDIO_EVALUATION_FILENAME).delete()
    }

    AsyncFunction("triggerEmergency") { reason: String ->
      val context = appContext.reactContext?.applicationContext
        ?: throw IllegalStateException("Application context is unavailable.")
      context.startService(Intent(context, CompanionMonitorService::class.java)
        .setAction(CompanionMonitorService.ACTION_TRIGGER_EMERGENCY)
        .putExtra(CompanionMonitorService.EXTRA_EMERGENCY_REASON, reason.take(500)))
      true
    }

    AsyncFunction("resolveEmergency") {
      appContext.reactContext?.applicationContext?.let { context ->
        context.startService(Intent(context, CompanionMonitorService::class.java)
          .setAction(CompanionMonitorService.ACTION_RESOLVE_EMERGENCY))
      }
    }

    AsyncFunction("confirmSafe") {
      appContext.reactContext?.applicationContext?.let { context ->
        context.startService(Intent(context, CompanionMonitorService::class.java)
          .setAction(CompanionMonitorService.ACTION_CONFIRM_SAFE))
      }
    }

    AsyncFunction("getStatus") {
      val context = appContext.reactContext?.applicationContext
        ?: throw IllegalStateException("Application context is unavailable.")
      val prefs = context.getSharedPreferences(CompanionMonitorService.PREFS, Context.MODE_PRIVATE)
      val evaluationFile = File(context.filesDir, CompanionMonitorService.AUDIO_EVALUATION_FILENAME)
      val lastEvaluationTimestamp = if (evaluationFile.exists()) {
        evaluationFile.useLines { lines ->
          lines.drop(1).lastOrNull { it.isNotBlank() }
            ?.split(',')?.getOrNull(4)?.toLongOrNull()?.toDouble()
        }
      } else null
      val evaluationRows = prefs.getInt("audioEvaluationRowsWritten", 0)
      mapOf(
        "running" to prefs.getBoolean("running", false),
        "lastSignal" to prefs.getString("lastSignal", null),
        "status" to prefs.getString("status", null),
        "emergencyPending" to prefs.getBoolean("emergencyPending", false),
        "audioMonitoring" to prefs.getBoolean("audioMonitoringActive", false),
        "motionMonitoring" to prefs.getBoolean("motionMonitoringEnabled", true),
        "audioEvaluationLogging" to prefs.getBoolean("audioEvaluationLogging", false),
        "audioEvaluationRowsWritten" to evaluationRows,
        "audioEvaluationLogBytes" to evaluationFile.length().toDouble(),
        "audioEvaluationLimitReached" to (evaluationRows >= CompanionMonitorService.MAX_AUDIO_EVALUATION_ROWS
          || evaluationFile.length() >= CompanionMonitorService.MAX_AUDIO_EVALUATION_BYTES),
        "audioEvaluationLastTimestampMs" to lastEvaluationTimestamp,
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

  fun emitCheckInResolved(timestamp: Long) {
    module?.sendEvent("onCheckInResolved", mapOf("timestamp" to timestamp.toDouble()))
  }
}
