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
  private var pendingEmergencyReason = ""
  private var checkInRunnable: Runnable? = null
  private val emergencyRetryDelays = longArrayOf(2_000, 5_000, 15_000, 30_000, 60_000, 120_000)
  @Volatile private var monitoring = false
  @Volatile private var audioMonitoring = false
  @Volatile private var emergencySent = false
  private var journeyId = ""

  override fun onCreate() {
    super.onCreate()
    ensureChannel()
    startForeground(NOTIFICATION_ID, monitoringNotification())
    sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
    val accelerometer = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    accelerometer?.let { sensorManager?.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        clearPendingCheckIn()
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
        if (enabled && monitoring && !audioMonitoring) startAudioMonitor()
        else {
          if (!enabled) stopAudioCapture()
          if (monitoring) startForeground(NOTIFICATION_ID, monitoringNotification())
        }
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
        editor.putBoolean("running", true).putBoolean("backgroundAudioEnabled", audioEnabled).apply()
        screamThreshold = intent.getFloatExtra(EXTRA_SCREAM_THRESHOLD, 0.82f).coerceIn(0.5f, 0.99f)
        if (prefs.getBoolean("emergencyActive", false)) {
          val reason = prefs.getString("pendingEmergencyReason", null)
          val pendingJourneyId = prefs.getString("pendingEmergencyJourneyId", journeyId)
          emergencySent = true
          monitoring = false
          startForeground(NOTIFICATION_ID, monitoringNotification())
          if (prefs.getBoolean("emergencyPending", false) && !reason.isNullOrBlank() && !pendingJourneyId.isNullOrBlank()) {
            emergencyRetryAttempts = prefs.getInt("emergencyRetryAttempts", 0)
            pendingEmergencyReason = reason
            attemptEmergencyDelivery(reason, pendingJourneyId)
          }
          return START_STICKY
        }
        monitoring = true
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
    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("running", true).apply()
    startForeground(NOTIFICATION_ID, monitoringNotification())
    audioThread.execute {
      try {
        val model = loadModel()
        interpreter = Interpreter(model, Interpreter.Options().setNumThreads(2))
        val sampleRate = 16_000
        val windowSize = 15_600 // YAMNet input is 0.975 s of mono 16 kHz PCM.
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
        val shorts = ShortArray(windowSize)
        while (monitoring && audioMonitoring && !Thread.currentThread().isInterrupted) {
          var offset = 0
          while (offset < windowSize && monitoring && audioMonitoring) {
            val count = recorder.read(shorts, offset, windowSize - offset, AudioRecord.READ_BLOCKING)
            if (count <= 0) throw IllegalStateException("Microphone stream ended.")
            offset += count
          }
          if (offset == windowSize && monitoring && audioMonitoring) inferWindow(shorts)
        }
      } catch (_: SecurityException) {
        publishStatus("Microphone access was denied. Background voice monitoring is off.")
      } catch (error: Exception) {
        publishStatus("Voice model unavailable: ${error.message ?: "initialization failed"}")
      } finally {
        audioMonitoring = false
        try { audioRecord?.stop() } catch (_: Exception) { }
        audioRecord?.release()
        audioRecord = null
        interpreter?.close()
        interpreter = null
        if (!monitoring) getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("running", false).apply()
      }
    }
  }

  private fun inferWindow(samples: ShortArray) {
    val inputTensor = interpreter?.getInputTensor(0) ?: return
    val inputElements = inputTensor.shape().fold(1) { acc, value -> acc * value }
    if (inputElements != samples.size) {
      publishStatus("YAMNet input shape ${inputTensor.shape().contentToString()} does not match the 16 kHz audio window.")
      monitoring = false
      return
    }
    val outputTensor = interpreter?.getOutputTensor(0) ?: return
    val outputSize = outputTensor.shape().fold(1) { acc, value -> acc * value }
    if (outputSize < 12) { monitoring = false; publishStatus("The distress model output does not contain AudioSet labels."); return }
    val input = Array(1) { FloatArray(samples.size) }
    for (i in samples.indices) input[0][i] = samples[i] / 32768f
    val output = Array(1) { FloatArray(outputSize) }
    try {
      interpreter?.run(input as Any, output as Any)
      val scores = output[0]
      // YAMNet AudioSet class-map indices: Shout 6, Yell 9, Children shouting 10, Screaming 11.
      val decision = soundScorer.score(scores) ?: return
      val now = System.currentTimeMillis()
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
      publishStatus("Distress sound inference failed: ${error.message ?: "model error"}")
      monitoring = false
    }
  }

  override fun onSensorChanged(event: SensorEvent) {
    if (!monitoring || event.sensor.type != Sensor.TYPE_ACCELEROMETER) return
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
    monitoring = journeyId.isNotBlank()
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
      publishStatus("Emergency alert accepted by the server; delivery to contacts is still being confirmed.")
      connection.disconnect()
      return true
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
    try { audioRecord?.stop() } catch (_: Exception) { }
  }

  private fun hasMicrophonePermission() =
    checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

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
    .setContentText(if (audioMonitoring) "On-device audio and motion checks are running for this journey." else "Native motion checks are on; background audio monitoring is off.")
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
    const val ACTION_START = "expo.modules.companionmonitor.START"
    const val ACTION_STOP = "expo.modules.companionmonitor.STOP"
    const val ACTION_TRIGGER_EMERGENCY = "expo.modules.companionmonitor.TRIGGER_EMERGENCY"
    const val ACTION_RESOLVE_EMERGENCY = "expo.modules.companionmonitor.RESOLVE_EMERGENCY"
    const val ACTION_CONFIRM_SAFE = "expo.modules.companionmonitor.CONFIRM_SAFE"
    const val ACTION_SET_AUDIO = "expo.modules.companionmonitor.SET_AUDIO"
    const val EXTRA_JOURNEY_ID = "journeyId"
    const val EXTRA_SUPABASE_URL = "supabaseUrl"
    const val EXTRA_PUBLISHABLE_KEY = "publishableKey"
    const val EXTRA_ACCESS_TOKEN = "accessToken"
    const val EXTRA_REFRESH_TOKEN = "refreshToken"
    const val EXTRA_SCREAM_THRESHOLD = "screamThreshold"
    const val EXTRA_AUDIO_ENABLED = "audioEnabled"
    const val EXTRA_EMERGENCY_REASON = "emergencyReason"
    private const val CHANNEL_ID = "companion-safety-monitor"
    private const val NOTIFICATION_ID = 48101
    private const val ALERT_NOTIFICATION_ID = 48102
    private const val SAFE_PENDING_ID = 48103
    private const val CHECK_IN_MS = 15_000L
  }
}
