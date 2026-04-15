/**
 * AudioWorklet Processor for capturing and processing microphone audio
 *
 * This processor runs on the audio rendering thread (separate from main thread)
 * and handles real-time audio processing with low latency.
 *
 * Processing flow:
 * 1. Receive 128-sample chunks (Web Audio API quantum size)
 * 2. Accumulate into 4096-sample buffer
 * 3. Convert Float32 [-1.0, 1.0] to Int16 PCM [-32768, 32767]
 * 4. Send to main thread via MessagePort with zero-copy transfer
 */

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Buffer size matching the original ScriptProcessorNode configuration
    this.bufferSize = 4096;

    // Accumulation buffer for incoming audio samples
    this.buffer = new Float32Array(this.bufferSize);

    // Current position in the buffer
    this.bufferIndex = 0;

    // VAD (Voice Activity Detection) state
    // RMS energy threshold for speech detection (tuned for normalized [-1,1] audio)
    this.vadThreshold = 0.015;
    // Hold time in frames (128 samples/frame at 16kHz = 8ms/frame, ~38 frames ≈ 300ms)
    this.vadHoldFrames = 38;
    this.vadHoldCounter = 0;
    this.isSpeaking = false;
  }

  /**
   * Process audio samples
   * Called automatically by Web Audio API for each 128-sample quantum
   *
   * @param {Float32Array[][]} inputs - Input audio data (2D array: [input][channel])
   * @param {Float32Array[][]} outputs - Output audio data (not used, but required)
   * @param {Object} parameters - AudioParam values (not used)
   * @returns {boolean} - true to keep processor alive, false to stop
   */
  process(inputs, outputs, parameters) {
    // Get the first input (microphone)
    const input = inputs[0];

    // Handle edge case: no input available
    if (!input || !input.length || !input[0]) {
      return true; // Keep processor alive
    }

    // Get mono channel (channel 0)
    const inputChannel = input[0];

    // Compute RMS energy for this frame (128 samples) for VAD
    let sumSquares = 0;
    for (let i = 0; i < inputChannel.length; i++) {
      sumSquares += inputChannel[i] * inputChannel[i];
    }
    const rms = Math.sqrt(sumSquares / inputChannel.length);

    // Update VAD state with hold time to avoid flickering
    if (rms >= this.vadThreshold) {
      this.vadHoldCounter = this.vadHoldFrames;
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.port.postMessage({ type: 'vad', speaking: true });
      }
    } else if (this.vadHoldCounter > 0) {
      this.vadHoldCounter--;
      if (this.vadHoldCounter === 0 && this.isSpeaking) {
        this.isSpeaking = false;
        this.port.postMessage({ type: 'vad', speaking: false });
      }
    }

    // Accumulate samples into buffer
    for (let i = 0; i < inputChannel.length; i++) {
      this.buffer[this.bufferIndex++] = inputChannel[i];

      // When buffer is full, process and send to main thread
      if (this.bufferIndex >= this.bufferSize) {
        this.sendPCMData();
        this.bufferIndex = 0; // Reset for next buffer
      }
    }

    // Keep processor alive
    return true;
  }

  /**
   * Convert accumulated Float32 samples to Int16 PCM and send to main thread
   * Uses transferable ArrayBuffer for zero-copy performance
   */
  sendPCMData() {
    // Allocate Int16Array for PCM data
    const pcmData = new Int16Array(this.bufferSize);

    // Convert Float32 [-1.0, 1.0] to Int16 [-32768, 32767]
    for (let i = 0; i < this.bufferSize; i++) {
      // Clamp sample to valid range [-1.0, 1.0]
      const sample = Math.max(-1, Math.min(1, this.buffer[i]));

      // Convert to 16-bit signed integer
      // Negative samples: multiply by 32768 (0x8000)
      // Positive samples: multiply by 32767 (0x7FFF)
      pcmData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }

    // Send to main thread via MessagePort
    // Transfer ArrayBuffer ownership for zero-copy performance
    this.port.postMessage(
      { type: 'pcm', pcmData: pcmData.buffer },
      [pcmData.buffer] // Transferable objects list
    );
  }
}

// Register the processor with Web Audio API
// This name must match the name used in AudioWorkletNode constructor
registerProcessor('audio-capture-processor', AudioCaptureProcessor);
