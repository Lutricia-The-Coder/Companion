package expo.modules.companionmonitor

/** Maintains one YAMNet input window and advances by its 0.48 s analysis hop. */
internal class AudioWindowBuffer(
  private val windowSize: Int = YAMNET_WINDOW_SAMPLES,
  private val hopSize: Int = YAMNET_HOP_SAMPLES,
) {
  private val samples = ShortArray(windowSize)
  private var bufferedSamples = 0

  init {
    require(windowSize > 0) { "Window size must be positive." }
    require(hopSize in 1..windowSize) { "Hop size must be between 1 and the window size." }
  }

  fun samplesNeeded(): Int = windowSize - bufferedSamples

  fun append(source: ShortArray, length: Int) {
    require(length in 0..source.size) { "Append length is outside the source buffer." }
    require(length <= samplesNeeded()) { "Append would overflow the audio window." }
    source.copyInto(samples, destinationOffset = bufferedSamples, endIndex = length)
    bufferedSamples += length
  }

  fun isReady(): Boolean = bufferedSamples == windowSize

  /** The returned window remains stable until [advance] is called. */
  fun currentWindow(): ShortArray {
    check(isReady()) { "Audio window is incomplete." }
    return samples
  }

  fun advance() {
    check(isReady()) { "Cannot advance an incomplete audio window." }
    val retainedSamples = windowSize - hopSize
    if (retainedSamples > 0) System.arraycopy(samples, hopSize, samples, 0, retainedSamples)
    bufferedSamples = retainedSamples
  }

  companion object {
    const val SAMPLE_RATE_HZ = 16_000
    const val YAMNET_WINDOW_SAMPLES = 15_600 // 0.975 seconds at 16 kHz.
    const val YAMNET_HOP_SAMPLES = 7_680 // 0.48 seconds, matching YAMNet's analysis hop.
  }
}

/** YAMNet expects mono PCM converted to finite float waveform samples in [-1, 1]. */
internal object AudioPreprocessor {
  fun normalizePcm16(samples: ShortArray): FloatArray = FloatArray(samples.size) { index ->
    (samples[index] / 32768f).coerceIn(-1f, 1f)
  }
}
