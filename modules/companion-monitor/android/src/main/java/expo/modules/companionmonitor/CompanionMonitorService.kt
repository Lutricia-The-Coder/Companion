package expo.modules.companionmonitor

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import org.tensorflow.lite.Interpreter
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.io.File
import java.util.Locale
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import java.util.concurrent.Executors
import kotlin.math.max

/** Android foreground monitor. Audio is processed on device and never stored by this service. */
class CompanionMonitorService : Service(), SensorEventListener {
  private val handler = Handler(Looper.getMainLooper())
  private val io = Executors.newSingleThreadExecutor()
  private val audioThread = Executors.newSingleThreadExecutor()
  private var audioRecord: AudioRecord? = null
  private var interpreter: Interpreter? = null
  private var sensorManager: SensorManager? = null
  private val fallDetector = FallImpactDetector()
  private val soundScorer: DistressSoundScorer by lazy { DistressSoundScorer(screamThreshold) }
  private var pendingSignalAt: Long = 0
  private var pendingSignalConfidence = 0f
  private var lastSignalAt = 0L
  private var screamThreshold = 0.82f
  private var emergencyRetryAttempts = 0
  @Volatile private var audioRetryAttempts = 0
  private var pendingEmergencyReason = ""
  private var checkInRunnable: Runnable? = null
  private val emergencyRetryDelays = longArrayOf(2_000, 5_000, 15_000, 30_000, 60_000, 120_000)
  @Volatile private var monitoring = false
  @Volatile private var audioMonitoring = false
  @Volatile private var motionMonitoring = true
  @Volatile private var emergencySent = false
  private var journeyId = ""

  override fun onCreate() {
    super.onCreate()
    ensureChannel()
    startForeground(NOTIFICATION_ID, monitoringNotification())
    sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        clearPendingCheckIn()
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("audioEvaluationLogging", false).apply()
        stopMonitoring()
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_TRIGGER_EMERGENCY -> {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        if (journeyId.isBlank()) journeyId = prefs.getString("journeyId", "").orEmpty()
        val reason = intent.getStringExtra(EXTRA_EMERGENCY_REASON)?.take(500) ?: "Automatic distress detection"
        if (journeyId.isBlank()) publishStatus("Emergency request is pending, but no active journey is connected.")
        else activateEmergency(reason)
        return START_STICKY
      }
      ACTION_RESOLVE_EMERGENCY -> {
        resolveEmergencyMonitoring()
        return START_STICKY
      }
      ACTION_CONFIRM_SAFE -> { confirmSafe(); return START_STICKY }
      ACTION_SET_AUDIO -> {
        val enabled = intent.getBooleanExtra(EXTRA_AUDIO_ENABLED, false)
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("backgroundAudioEnabled", enabled).apply()
        if (enabled && monitoring && !audioMonitoring) { audioRetryAttempts = 0; startAudioMonitor() }
        else {
          if (!enabled) stopAudioCapture()
          if (monitoring) startForeground(NOTIFICATION_ID, monitoringNotification())
        }
        return START_STICKY
      }
      ACTION_SET_MOTION -> {
        val enabled = intent.getBooleanExtra(EXTRA_MOTION_ENABLED, true)
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("motionMonitoringEnabled", enabled).apply()
        configureMotionMonitoring(enabled)
        if (monitoring) startForeground(NOTIFICATION_ID, monitoringNotification())
        return START_STICKY
      }
      ACTION_START -> {
        val nextJourneyId = intent.getStringExtra(EXTRA_JOURNEY_ID).orEmpty()
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        if (prefs.getString("journeyId", null) != nextJourneyId) clearPendingCheckIn()
        journeyId = nextJourneyId
        val editor = prefs.edit().putString("journeyId", journeyId)
          .putString("supabaseUrl", intent.getStringExtra(EXTRA_SUPABASE_URL).orEmpty())
          .putString("publishableKey", intent.getStringExtra(EXTRA_PUBLISHABLE_KEY).orEmpty())
        intent.getStringExtra(EXTRA_ACCESS_TOKEN)?.takeIf { it.isNotBlank() }?.let { editor.putString("accessToken", SecretBox.encrypt(this, it)) }
        intent.getStringExtra(EXTRA_REFRESH_TOKEN)?.takeIf { it.isNotBlank() }?.let { editor.putString("refreshToken", SecretBox.encrypt(this, it)) }
        val audioEnabled = intent.getBooleanExtra(EXTRA_AUDIO_ENABLED, false)
        motionMonitoring = intent.getBooleanExtra(EXTRA_MOTION_ENABLED, prefs.getBoolean("motionMonitoringEnabled", true))
        editor.putBoolean("running", true).putBoolean("backgroundAudioEnabled", audioEnabled)
          .putBoolean("motionMonitoringEnabled", motionMonitoring).apply()
        screamThreshold = intent.getFloatExtra(EXTRA_SCREAM_THRESHOLD, 0.82f).coerceIn(0.5f, 0.99f)
        if (prefs.getBoolean("emergencyActive", false)) {
          val reason = prefs.getString("pendingEmergencyReason", null)
          val pendingJourneyId = prefs.getString("pendingEmergencyJourneyId", journeyId)
          emergencySent = true
          monitoring = false
          configureMotionMonitoring(false)
          startForeground(NOTIFICATION_ID, monitoringNotification())
          if (prefs.getBoolean("emergencyPending", false) && !reason.isNullOrBlank() && !pendingJourneyId.isNullOrBlank()) {
            emergencyRetryAttempts = prefs.getInt("emergencyRetryAttempts", 0)
            pendingEmergencyReason = reason
            attemptEmergencyDelivery(reason, pendingJourneyId)
          }
          return START_STICKY
        }
        monitoring = true
        configureMotionMonitoring(motionMonitoring)
        if (audioEnabled && !audioMonitoring) startAudioMonitor()
        else {
          if (!audioEnabled) stopAudioCapture()
          startForeground(NOTIFICATION_ID, monitoringNotification())
        }
        if (prefs.getBoolean("checkInPending", false)) restorePendingCheckIn(prefs)
      }
      null -> {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        if (prefs.getBoolean("emergencyActive", false)) {
          val reason = prefs.getString("pendingEmergencyReason", null)
          val pendingJourneyId = prefs.getString("pendingEmergencyJourneyId", null)
          journeyId = pendingJourneyId ?: prefs.getString("journeyId", "").orEmpty()
          monitoring = false
          emergencySent = true
          startForeground(NOTIFICATION_ID, monitoringNotification())
          if (prefs.getBoolean("emergencyPending", false) && !reason.isNullOrBlank() && journeyId.isNotBlank()) {
            emergencyRetryAttempts = prefs.getInt("emergencyRetryAttempts", 0)
            pendingEmergencyReason = reason
            attemptEmergencyDelivery(reason, journeyId)
          }
          return START_STICKY
        }
        journeyId = prefs.getString("journeyId", "").orEmpty()
        if (prefs.getBoolean("running", false) && journeyId.isNotBlank()) {
          monitoring = true
          motionMonitoring = prefs.getBoolean("motionMonitoringEnabled", true)
          configureMotionMonitoring(motionMonitoring)
          if (!audioMonitoring && MonitorRecoveryPolicy.shouldStartBackgroundAudio(
              prefs.getBoolean("backgroundAudioEnabled", false), hasMicrophonePermission(),
            )) startAudioMonitor()
          else startForeground(NOTIFICATION_ID, monitoringNotification())
          if (prefs.getBoolean("backgroundAudioEnabled", false) && !hasMicrophonePermission()) {
            publishStatus("Background audio is paused because microphone permission is unavailable. Motion monitoring continues.")
          }
          if (prefs.getBoolean("checkInPending", false)) restorePendingCheckIn(prefs)
        }
      }
    }
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    stopMonitoring()
    sensorManager?.unregisterListener(this)
    audioThread.shutdownNow()
    io.shutdownNow()
    super.onDestroy()
  }

  private fun startAudioMonitor() {
    if (audioMonitoring) return
    if (!MonitorRecoveryPolicy.shouldStartBackgroundAudio(
        getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("backgroundAudioEnabled", false),
        hasMicrophonePermission(),
      )) {
      publishStatus("Background audio is off. Enable it and grant microphone permission to use sound monitoring.")
      return
    }
    audioMonitoring = true
    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("running", true).putBoolean("audioMonitoringActive", true).apply()
    startForeground(NOTIFICATION_ID, monitoringNotification())
    audioThread.execute {
      try {
        val model = loadModel()
        interpreter = Interpreter(model, Interpreter.Options().setNumThreads(2))
        val sampleRate = AudioWindowBuffer.SAMPLE_RATE_HZ
        val windowSize = AudioWindowBuffer.YAMNET_WINDOW_SAMPLES
        val windowBuffer = AudioWindowBuffer()
        val minBuffer = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuffer <= 0) throw IllegalStateException("This device cannot open the microphone input format.")
        val bufferSize = max(minBuffer, windowSize * 2)
        val recorder = AudioRecord.Builder()
          .setAudioSource(MediaRecorder.AudioSource.MIC)
          .setAudioFormat(AudioFormat.Builder().setSampleRate(sampleRate).setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
          .setBufferSizeInBytes(bufferSize)
          .build()
        if (recorder.state != AudioRecord.STATE_INITIALIZED) throw IllegalStateException("Microphone initialization failed.")
        audioRecord = recorder
        recorder.startRecording()
        val readBuffer = ShortArray(windowSize)
        while (monitoring && audioMonitoring && !Thread.currentThread().isInterrupted) {
          var readOffset = 0
          val required = windowBuffer.samplesNeeded()
          while (readOffset < required && monitoring && audioMonitoring) {
            val count = recorder.read(readBuffer, 0, minOf(readBuffer.size, required - readOffset), AudioRecord.READ_BLOCKING)
            if (count <= 0) throw IllegalStateException("Microphone stream ended.")
            windowBuffer.append(readBuffer, count)
            readOffset += count
          }
          if (windowBuffer.isReady() && monitoring && audioMonitoring) {
            // Timestamp the end of captured audio before inference latency is added.
            inferWindow(windowBuffer.currentWindow(), System.currentTimeMillis())
            windowBuffer.advance()
          }
        }
      } catch (_: SecurityException) {
        publishStatus("Microphone access was denied. Background voice monitoring is off.")
      } catch (error: Exception) {
        publishStatus("Voice model unavailable: ${error.message ?: "initialization failed"}")
        scheduleAudioRetry()
      } finally {
        audioMonitoring = false
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("audioMonitoringActive", false).apply()
        try { audioRecord?.stop() } catch (_: Exception) { }
        audioRecord?.release()
        audioRecord = null
        interpreter?.close()
        interpreter = null
        if (!monitoring) getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("running", false).apply()
      }
    }
  }

  private fun inferWindow(samples: ShortArray, windowTimestamp: Long) {
    val inputTensor = interpreter?.getInputTensor(0) ?: return
    val inputElements = inputTensor.shape().fold(1) { acc, value -> acc * value }
    if (inputElements != samples.size) {
      publishStatus("YAMNet input shape ${inputTensor.shape().contentToString()} does not match the 16 kHz audio window.")
      soundScorer.reset()
      scheduleAudioRetry()
      audioMonitoring = false
      return
    }
    val outputTensor = interpreter?.getOutputTensor(0) ?: return
    val outputSize = outputTensor.shape().fold(1) { acc, value -> acc * value }
    if (outputSize <= DistressSoundScorer.VOCAL_DISTRESS_INDICES.last()) {
      audioMonitoring = false
      publishStatus("The distress model output does not contain the required AudioSet labels.")
      scheduleAudioRetry()
      return
    }
    val input = arrayOf(AudioPreprocessor.normalizePcm16(samples))
    val output = Array(1) { FloatArray(outputSize) }
    try {
      val inferenceStartedAt = android.os.SystemClock.elapsedRealtimeNanos()
      interpreter?.run(input as Any, output as Any)
      val scores = output[0]
      val inferenceLatencyMs = (android.os.SystemClock.elapsedRealtimeNanos() - inferenceStartedAt) / 1_000_000.0
      recordAudioEvaluationWindow(scores, windowTimestamp, inferenceLatencyMs)
      // AudioSet classes include shout/yell/screaming and crying/whimper/wail vocalizations.
      val decision = soundScorer.score(scores) ?: return
      val now = windowTimestamp
      if (decision.activate) {
        emitSignal(decision.kind, decision.confidence, now)
        onDistress(decision.kind, decision.confidence, now)
      } else {
        if (decision.confidence >= DistressSoundScorer.CHECK_IN_THRESHOLD && now - lastSignalAt > 5_000) {
          emitSignal(decision.kind, decision.confidence, now)
          requestCheckIn("Possible ${decision.kind} detected by YAMNet", decision.confidence, now)
        }
      }
    } catch (error: Exception) {
      soundScorer.reset()
      publishStatus("Distress sound inference failed: ${error.message ?: "model error"}")
      scheduleAudioRetry()
      audioMonitoring = false
    }
  }

  /** Opt-in prediction metadata only. Raw microphone samples are never written to this log. */
  private fun recordAudioEvaluationWindow(scores: FloatArray, timestamp: Long, latencyMs: Double) {
    val preferences = getSharedPreferences(PREFS, MODE_PRIVATE)
    if (!preferences.getBoolean("audioEvaluationLogging", false)) return
    val prediction = DistressSoundScorer.prediction(scores) ?: return
    val file = File(filesDir, AUDIO_EVALUATION_FILENAME)
    var rowCount = preferences.getInt("audioEvaluationRowsWritten", 0)
    if (rowCount >= MAX_AUDIO_EVALUATION_ROWS || file.length() >= MAX_AUDIO_EVALUATION_BYTES) return
    try {
      if (!file.exists() || file.length() == 0L) {
        file.writeText("actual,predicted,duration_seconds,latency_ms,timestamp_ms,class_label,confidence,threshold\n")
        rowCount = 0
      }
      val predicted = if (prediction.second >= screamThreshold) "distress" else "background"
      val confidence = String.format(Locale.US, "%.6f", prediction.second)
      val latency = String.format(Locale.US, "%.3f", latencyMs)
      val threshold = String.format(Locale.US, "%.4f", screamThreshold)
      file.appendText(",${predicted},0.975,${latency},${timestamp},${prediction.first},${confidence},${threshold}\n")
      preferences.edit().putInt("audioEvaluationRowsWritten", rowCount + 1).apply()
    } catch (error: Exception) {
      publishStatus("Audio evaluation log could not be written: ${error.message ?: "storage unavailable"}")
      preferences.edit().putBoolean("audioEvaluationLogging", false).apply()
    }
  }

  override fun onSensorChanged(event: SensorEvent) {
    if (!monitoring || !motionMonitoring || event.sensor.type != Sensor.TYPE_ACCELEROMETER) return
    val now = System.currentTimeMillis()
    val confidence = fallDetector.onAcceleration(event.values[0], event.values[1], event.values[2], now)
    if (confidence != null) {
      emitSignal("fall", confidence, now)
      onDistress("fall", confidence, now)
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

  private fun emitSignal(kind: String, confidence: Float, timestamp: Long) {
    if (timestamp - lastSignalAt < 2_500) return
    lastSignalAt = timestamp
    val signalId = "native-${kind}-${UUID.randomUUID()}"
    val value = JSONObject().put("kind", kind).put("confidence", confidence).put("timestamp", timestamp).put("signalId", signalId).toString()
    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("lastSignal", value).apply()
    CompanionMonitorBridge.emit(kind, confidence, timestamp, signalId)
  }

  private fun onDistress(kind: String, confidence: Float, timestamp: Long) {
    if (emergencySent) return
    if (kind == "distress_vocalization") {
      // A cry/whimper/wail alone prompts a check-in; only another distinct signal can escalate.
      pendingSignalAt = timestamp
      pendingSignalConfidence = confidence
      requestCheckIn("Possible distress vocalization detected", confidence, timestamp)
      return
    }
    if (pendingSignalAt != 0L && timestamp - pendingSignalAt < 12_000) {
      if (kind == "fall" || pendingSignalConfidence >= 0.78f) {
        activateEmergency("Native monitor detected repeated distress signals.")
        return
      }
    }
    pendingSignalAt = timestamp
    pendingSignalConfidence = confidence
    requestCheckIn("Possible $kind detected", confidence, timestamp)
  }

  private fun requestCheckIn(reason: String, confidence: Float, timestamp: Long) {
    val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
    if (prefs.getBoolean("checkInPending", false) || emergencySent) return
    val deadline = System.currentTimeMillis() + CHECK_IN_MS
    prefs.edit().putBoolean("checkInPending", true).putLong("checkInDeadlineAt", deadline).apply()
    showAlertNotification("Check in now", "$reason. Companion will alert your trusted contacts if you do not confirm you're safe.", safeAction = true)
    schedulePendingCheckIn(deadline)
  }

  private fun schedulePendingCheckIn(deadline: Long) {
    checkInRunnable?.let(handler::removeCallbacks)
    val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
    val task = Runnable {
      checkInRunnable = null
      if (prefs.getBoolean("checkInPending", false) && !emergencySent) {
        activateEmergency("No response to the background safety check-in.")
      }
    }
    checkInRunnable = task
    handler.postDelayed(task, MonitorRecoveryPolicy.remainingCheckInDelay(System.currentTimeMillis(), deadline))
  }

  private fun restorePendingCheckIn(prefs: android.content.SharedPreferences) {
    val deadline = MonitorRecoveryPolicy.restoreCheckInDeadline(
      System.currentTimeMillis(), prefs.takeIf { it.contains("checkInDeadlineAt") }?.getLong("checkInDeadlineAt", 0L), CHECK_IN_MS,
    )
    prefs.edit().putLong("checkInDeadlineAt", deadline).apply()
    schedulePendingCheckIn(deadline)
  }

  private fun clearPendingCheckIn() {
    checkInRunnable?.let(handler::removeCallbacks)
    checkInRunnable = null
    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
      .putBoolean("checkInPending", false)
      .remove("checkInDeadlineAt")
      .apply()
  }

  private fun confirmSafe() {
    clearPendingCheckIn()
    pendingSignalAt = 0
    pendingSignalConfidence = 0f
    soundScorer.reset()
    fallDetector.reset()
    emergencySent = false
    handler.removeCallbacksAndMessages(null)
    CompanionMonitorBridge.emitCheckInResolved(System.currentTimeMillis())
    showAlertNotification("Safety check confirmed", "Background monitoring continues during this journey.", safeAction = false)
  }

  private fun resolveEmergencyMonitoring() {
    val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
    if (journeyId.isBlank()) journeyId = prefs.getString("journeyId", "").orEmpty()
    emergencySent = false
    emergencyRetryAttempts = 0
    pendingEmergencyReason = ""
    clearPendingCheckIn()
    handler.removeCallbacksAndMessages(null)
    prefs.edit()
      .putBoolean("emergencyActive", false)
      .putBoolean("emergencyPending", false)
      .putBoolean("running", true)
      .putInt("emergencyRetryAttempts", 0)
      .remove("pendingEmergencyReason")
      .remove("pendingEmergencyJourneyId")
      .remove("emergencyRetryAttempts")
      .apply()
    monitoring = journeyId.isNotBlank() && prefs.getBoolean("running", true)
    motionMonitoring = prefs.getBoolean("motionMonitoringEnabled", true)
    configureMotionMonitoring(motionMonitoring)
    if (monitoring && prefs.getBoolean("backgroundAudioEnabled", false) && hasMicrophonePermission()) startAudioMonitor()
    else startForeground(NOTIFICATION_ID, monitoringNotification())
    showAlertNotification("Emergency resolved", "The emergency is marked resolved. Monitoring continues while this journey remains active.", safeAction = false)
  }

  private fun activateEmergency(reason: String) {
    if (emergencySent) return
    emergencySent = true
    monitoring = false
    stopAudioCapture()
    pendingEmergencyReason = reason
    emergencyRetryAttempts = 0
    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
      .putBoolean("emergencyActive", true)
      .putBoolean("checkInPending", false)
      .remove("checkInDeadlineAt")
      .putBoolean("emergencyPending", true)
      .putString("pendingEmergencyReason", reason)
      .putString("pendingEmergencyJourneyId", journeyId)
      .putInt("emergencyRetryAttempts", 0)
      .putLong("lastEmergencyAt", System.currentTimeMillis())
      .apply()
    handler.removeCallbacksAndMessages(null)
    showAlertNotification("Emergency detected", "Companion is sending an emergency alert and live journey location to your trusted contacts.", safeAction = false)
    attemptEmergencyDelivery(reason, journeyId)
  }

  private fun attemptEmergencyDelivery(reason: String, destinationJourneyId: String) {
    io.execute {
      val accepted = notifyBackend(reason, destinationJourneyId)
      handler.post {
        if (accepted) {
          emergencyRetryAttempts = 0
          pendingEmergencyReason = ""
          getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putBoolean("emergencyPending", false)
            .remove("pendingEmergencyReason")
            .remove("pendingEmergencyJourneyId")
            .remove("emergencyRetryAttempts")
            .apply()
        } else {
          scheduleEmergencyRetry(reason, destinationJourneyId)
        }
      }
    }
  }

  private fun scheduleEmergencyRetry(reason: String, destinationJourneyId: String) {
    if (emergencyRetryAttempts >= emergencyRetryDelays.size) {
      publishStatus("Emergency alert is still pending. Companion will retry when the monitor service restarts.")
      return
    }
    val delay = emergencyRetryDelays[emergencyRetryAttempts]
    emergencyRetryAttempts += 1
    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putInt("emergencyRetryAttempts", emergencyRetryAttempts).apply()
    handler.postDelayed({ attemptEmergencyDelivery(reason, destinationJourneyId) }, delay)
  }

  private fun notifyBackend(reason: String, destinationJourneyId: String): Boolean {
    try {
      val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
      val supabaseUrl = prefs.getString("supabaseUrl", "").orEmpty().trimEnd('/')
      val publishableKey = prefs.getString("publishableKey", "").orEmpty()
      val refresh = SecretBox.decrypt(this, prefs.getString("refreshToken", null)).orEmpty()
      if (supabaseUrl.isBlank() || publishableKey.isBlank() || refresh.isBlank() || destinationJourneyId.isBlank()) {
        publishStatus("Emergency detected, but no signed-in journey connection is available for contact alerts.")
        return false
      }
      val token = refreshAccessToken(supabaseUrl, publishableKey, refresh)
      val url = URL("$supabaseUrl/functions/v1/activate-emergency")
      val connection = (url.openConnection() as HttpURLConnection).apply {
        requestMethod = "POST"
        connectTimeout = 12_000
        readTimeout = 12_000
        doOutput = true
        setRequestProperty("Authorization", "Bearer $token")
        setRequestProperty("apikey", publishableKey)
        setRequestProperty("Content-Type", "application/json")
      }
      val body = JSONObject().put("journeyId", destinationJourneyId).put("reason", reason).toString()
      connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      val code = connection.responseCode
      if (code !in 200..299) throw IllegalStateException("Emergency service rejected the alert (HTTP $code).")
      val payload = connection.inputStream.bufferedReader().use { it.readText() }
      val result = JSONObject(payload)
      val notification = result.optJSONObject("notifications")
      val status = notification?.optString("status").orEmpty().ifBlank { result.optString("status", "unknown") }
      val retryable = notification?.optBoolean("retryable", result.optBoolean("retryable", false))
        ?: result.optBoolean("retryable", false)
      when (status) {
        "accepted" -> publishStatus(if (retryable) "Email provider accepted the alert; audit confirmation is pending and will be retried safely." else "Email provider accepted the emergency alert. Inbox delivery is not confirmed.")
        "partial" -> publishStatus("Some emergency emails were accepted; remaining recipients ${if (retryable) "will be retried" else "could not be confirmed"}.")
        "no_recipients" -> publishStatus("Emergency is recorded, but no eligible email contacts are configured.")
        "failed" -> publishStatus("Emergency is recorded, but email delivery failed${if (retryable) "; retrying" else " after the retry limit"}.")
        "unknown" -> publishStatus("Emergency is recorded, but the email provider outcome is unknown${if (retryable) "; retrying safely" else " and retries are exhausted"}.")
        "already_active" -> publishStatus("Emergency is active, but this server version did not return contact delivery outcomes; retrying the request.")
        else -> publishStatus("Emergency is recorded, but contact delivery has no confirmed provider outcome.")
      }
      connection.disconnect()
      return (status == "accepted" && !retryable) || status == "no_recipients" || ((status == "failed" || status == "unknown" || status == "partial") && !retryable)
    } catch (error: Exception) {
      publishStatus("Emergency detected, but the server could not confirm contact alerts: ${error.message ?: "network unavailable"}")
      return false
    }
  }

  private fun refreshAccessToken(supabaseUrl: String, publishableKey: String, refreshToken: String): String {
    val url = URL("$supabaseUrl/auth/v1/token?grant_type=refresh_token")
    val connection = (url.openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = 12_000
      readTimeout = 12_000
      doOutput = true
      setRequestProperty("apikey", publishableKey)
      setRequestProperty("Content-Type", "application/json")
    }
    val body = JSONObject().put("refresh_token", refreshToken).toString().toByteArray()
    connection.outputStream.use { it.write(body) }
    val response = connection.inputStream.bufferedReader().use { it.readText() }
    val token = JSONObject(response).optString("access_token")
    val rotatedRefreshToken = JSONObject(response).optString("refresh_token")
    if (token.isBlank()) throw IllegalStateException("Supabase could not refresh the monitor token.")
    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
      .putString("accessToken", SecretBox.encrypt(this, token))
      .putString("refreshToken", SecretBox.encrypt(this, rotatedRefreshToken.ifBlank { refreshToken })).apply()
    connection.disconnect()
    return token
  }

  private fun stopMonitoring() {
    monitoring = false
    stopAudioCapture()
    handler.removeCallbacksAndMessages(null)
    try { audioRecord?.stop() } catch (_: Exception) { }
    sensorManager?.unregisterListener(this)
    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("running", false).apply()
    stopForeground(STOP_FOREGROUND_REMOVE)
  }

  private fun stopAudioCapture() {
    audioMonitoring = false
    audioRetryAttempts = 0
    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("audioMonitoringActive", false).apply()
    try { audioRecord?.stop() } catch (_: Exception) { }
  }

  private fun hasMicrophonePermission() =
    checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

  private fun scheduleAudioRetry() {
    val delays = longArrayOf(2_000, 5_000, 15_000)
    if (!monitoring || audioRetryAttempts >= delays.size) return
    val delay = delays[audioRetryAttempts++]
    handler.postDelayed({
      val preferences = getSharedPreferences(PREFS, MODE_PRIVATE)
      if (monitoring && preferences.getBoolean("backgroundAudioEnabled", false) && hasMicrophonePermission() && !audioMonitoring) {
        startAudioMonitor()
      }
    }, delay)
  }

  private fun configureMotionMonitoring(enabled: Boolean) {
    motionMonitoring = enabled
    val accelerometer = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    if (enabled && monitoring && accelerometer != null) {
      sensorManager?.registerListener(this, accelerometer, SensorManager.SENSOR_DELAY_GAME)
    } else {
      sensorManager?.unregisterListener(this)
    }
  }

  private fun publishStatus(message: String) {
    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("status", message).apply()
    showAlertNotification("Companion monitor", message, safeAction = false)
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Safety monitoring", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Visible status and safety check-ins during an active journey."
      })
    }
  }

  private fun monitoringNotification(): Notification = NotificationCompat.Builder(this, CHANNEL_ID)
    .setSmallIcon(android.R.drawable.ic_lock_lock)
    .setContentTitle("Companion safety monitoring active")
    .setContentText(when {
      audioMonitoring && motionMonitoring -> "On-device sound and motion checks are running for this journey."
      audioMonitoring -> "On-device sound checks are running; motion checks are off."
      motionMonitoring -> "Native motion checks are on; background audio monitoring is off."
      else -> "Safety location tracking is active; sound and motion checks are off."
    })
    .setOngoing(true)
    .setCategory(NotificationCompat.CATEGORY_SERVICE)
    .build()

  private fun showAlertNotification(title: String, message: String, safeAction: Boolean) {
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.ic_dialog_alert)
      .setContentTitle(title)
      .setContentText(message)
      .setStyle(NotificationCompat.BigTextStyle().bigText(message))
      .setAutoCancel(!safeAction)
      .setPriority(NotificationCompat.PRIORITY_MAX)
    if (safeAction) {
      val intent = Intent(this, MonitorSafeReceiver::class.java).setAction(ACTION_CONFIRM_SAFE)
      val pending = PendingIntent.getBroadcast(this, SAFE_PENDING_ID, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      builder.addAction(android.R.drawable.ic_menu_info_details, "I'm safe", pending)
    }
    getSystemService(NotificationManager::class.java).notify(ALERT_NOTIFICATION_ID, builder.build())
  }

  private fun loadModel(): ByteBuffer {
    val bytes = assets.open("yamnet.tflite").use { it.readBytes() }
    return ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).apply { put(bytes); rewind() }
  }

  companion object {
    const val PREFS = "companion_native_monitor"
    const val AUDIO_EVALUATION_FILENAME = "companion-audio-evaluation.csv"
    const val MAX_AUDIO_EVALUATION_ROWS = 20_000
    const val MAX_AUDIO_EVALUATION_BYTES = 4L * 1024L * 1024L
    const val ACTION_START = "expo.modules.companionmonitor.START"
    const val ACTION_STOP = "expo.modules.companionmonitor.STOP"
    const val ACTION_TRIGGER_EMERGENCY = "expo.modules.companionmonitor.TRIGGER_EMERGENCY"
    const val ACTION_RESOLVE_EMERGENCY = "expo.modules.companionmonitor.RESOLVE_EMERGENCY"
    const val ACTION_CONFIRM_SAFE = "expo.modules.companionmonitor.CONFIRM_SAFE"
    const val ACTION_SET_AUDIO = "expo.modules.companionmonitor.SET_AUDIO"
    const val ACTION_SET_MOTION = "expo.modules.companionmonitor.SET_MOTION"
    const val EXTRA_JOURNEY_ID = "journeyId"
    const val EXTRA_SUPABASE_URL = "supabaseUrl"
    const val EXTRA_PUBLISHABLE_KEY = "publishableKey"
    const val EXTRA_ACCESS_TOKEN = "accessToken"
    const val EXTRA_REFRESH_TOKEN = "refreshToken"
    const val EXTRA_SCREAM_THRESHOLD = "screamThreshold"
    const val EXTRA_AUDIO_ENABLED = "audioEnabled"
    const val EXTRA_MOTION_ENABLED = "motionEnabled"
    const val EXTRA_EMERGENCY_REASON = "emergencyReason"
    private const val CHANNEL_ID = "companion-safety-monitor"
    private const val NOTIFICATION_ID = 48101
    private const val ALERT_NOTIFICATION_ID = 48102
    private const val SAFE_PENDING_ID = 48103
    private const val CHECK_IN_MS = 15_000L
  }
}
