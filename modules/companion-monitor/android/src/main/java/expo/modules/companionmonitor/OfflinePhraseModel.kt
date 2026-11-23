package expo.modules.companionmonitor

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.text.Normalizer
import java.util.Locale
import java.util.zip.ZipInputStream

internal data class SavedSosPhrase(
  val id: String,
  val phrase: String,
  val independentActivation: Boolean,
)

/** Private, offline Vosk model storage plus grammar-constrained personalized phrase recognition. */
internal object OfflinePhraseModel {
  private const val MODEL_NAME = "vosk-model-small-en-us-0.15"
  private const val MODEL_URL = "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"
  private const val MAX_DOWNLOAD_BYTES = 60L * 1024L * 1024L
  private const val MAX_EXTRACTED_BYTES = 180L * 1024L * 1024L

  fun directory(context: Context) = File(File(context.filesDir, "offline-speech"), MODEL_NAME)

  fun isInstalled(context: Context): Boolean = File(directory(context), "am/final.mdl").isFile

  fun install(context: Context, progress: (Long, Long) -> Unit = { _, _ -> }): File {
    val target = directory(context)
    if (File(target, "am/final.mdl").isFile) return target
    val parent = target.parentFile ?: throw IllegalStateException("Private model directory is unavailable.")
    if (!parent.exists() && !parent.mkdirs()) throw IllegalStateException("Could not create private model storage.")
    val archive = File(parent, "$MODEL_NAME.zip.part")
    val extraction = File(parent, "$MODEL_NAME.extracting")
    archive.delete()
    extraction.deleteRecursively()
    try {
      val connection = (URL(MODEL_URL).openConnection() as HttpURLConnection).apply {
        connectTimeout = 15_000
        readTimeout = 45_000
        instanceFollowRedirects = true
        setRequestProperty("User-Agent", "CompanionSafety/1.0")
      }
      try {
        if (connection.responseCode !in 200..299) throw IllegalStateException("Offline speech model download failed (HTTP ${connection.responseCode}).")
        val declared = connection.contentLengthLong
        if (declared > MAX_DOWNLOAD_BYTES) throw IllegalStateException("Offline speech model archive is larger than expected.")
        connection.inputStream.use { input ->
          BufferedOutputStream(FileOutputStream(archive)).use { output ->
            val buffer = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
              val count = input.read(buffer)
              if (count < 0) break
              total += count
              if (total > MAX_DOWNLOAD_BYTES) throw IllegalStateException("Offline speech model download exceeded the size limit.")
              output.write(buffer, 0, count)
              progress(total, declared)
            }
          }
        }
      } finally {
        connection.disconnect()
      }
      if (!extraction.mkdirs()) throw IllegalStateException("Could not prepare model extraction storage.")
      var unpackedBytes = 0L
      ZipInputStream(BufferedInputStream(archive.inputStream())).use { zip ->
        while (true) {
          val entry = zip.nextEntry ?: break
          val output = File(extraction, entry.name)
          val rootPath = extraction.canonicalPath + File.separator
          if (!output.canonicalPath.startsWith(rootPath)) throw IllegalStateException("The model archive contains an unsafe path.")
          if (entry.isDirectory) {
            if (!output.mkdirs() && !output.isDirectory) throw IllegalStateException("Could not unpack the speech model.")
          } else {
            output.parentFile?.let { if (!it.mkdirs() && !it.isDirectory) throw IllegalStateException("Could not unpack the speech model.") }
            FileOutputStream(output).use { file ->
              val buffer = ByteArray(64 * 1024)
              while (true) {
                val count = zip.read(buffer)
                if (count < 0) break
                unpackedBytes += count
                if (unpackedBytes > MAX_EXTRACTED_BYTES) throw IllegalStateException("Unpacked speech model exceeded the size limit.")
                file.write(buffer, 0, count)
              }
            }
          }
          zip.closeEntry()
        }
      }
      val unpackedRoot = File(extraction, MODEL_NAME)
      if (!File(unpackedRoot, "am/final.mdl").isFile) throw IllegalStateException("Downloaded speech model is incomplete.")
      target.deleteRecursively()
      if (!unpackedRoot.renameTo(target)) throw IllegalStateException("Could not install the offline speech model.")
      return target
    } catch (error: Exception) {
      throw if (error is IllegalStateException) error else IllegalStateException("Could not install offline phrase recognition: ${error.message ?: "network or storage error"}", error)
    } finally {
      archive.delete()
      extraction.deleteRecursively()
    }
  }

  fun parsePhrases(json: String): List<SavedSosPhrase> = try {
    val values = JSONArray(json)
    (0 until values.length()).mapNotNull { index ->
      val value = values.optJSONObject(index) ?: return@mapNotNull null
      val phrase = value.optString("phrase").trim().replace(Regex("\\s+"), " ")
      val id = value.optString("id")
      if (id.isBlank() || phrase.length !in 2..80 || !value.optBoolean("enabled", false)) null
      else SavedSosPhrase(id, phrase, value.optBoolean("independentActivation", false))
    }.take(8)
  } catch (_: Exception) { emptyList() }

  fun createRecognizer(model: Model, phrases: List<SavedSosPhrase>): Recognizer? {
    if (phrases.isEmpty()) return null
    val grammar = JSONArray().apply {
      phrases.forEach { put(it.phrase) }
      put("[unk]")
    }
    return Recognizer(model, 16_000f, grammar.toString()).apply { setWords(true) }
  }

  fun matchResult(json: String, phrases: List<SavedSosPhrase>): Pair<SavedSosPhrase, Float>? {
    return try {
      val result = JSONObject(json)
      val transcript = result.optString("text")
      val normalizedTranscript = normalize(transcript)
      if (normalizedTranscript.isBlank() || normalizedTranscript == "unk" || normalizedTranscript.contains(" unk ")) return null
      val words = result.optJSONArray("result") ?: return null
      if (words.length() == 0) return null
      var confidence = 0.0
      for (index in 0 until words.length()) {
        val word = words.optJSONObject(index) ?: return null
        confidence += word.optDouble("conf", Double.NaN)
      }
      confidence = confidence / words.length()
      if (!confidence.isFinite()) null else matchTranscript(transcript, confidence.toFloat(), phrases)
    } catch (_: Exception) { null }
  }

  fun matchTranscript(transcript: String, confidence: Float, phrases: List<SavedSosPhrase>): Pair<SavedSosPhrase, Float>? {
    if (!confidence.isFinite() || confidence !in 0f..1f) return null
    val spoken = " ${normalize(transcript)} "
    if (spoken.isBlank() || spoken == " unk " || spoken.contains(" unk ")) return null
    val phrase = phrases.firstOrNull { item ->
      val normalized = normalize(item.phrase)
      normalized.isNotBlank() && spoken.contains(" $normalized ")
    } ?: return null
    return phrase to confidence
  }

  private fun normalize(value: String): String = Normalizer.normalize(value, Normalizer.Form.NFKC)
    .lowercase(Locale.ROOT)
    .replace(Regex("[\\p{Punct}\\p{S}]+"), " ")
    .replace(Regex("\\s+"), " ")
    .trim()
}
