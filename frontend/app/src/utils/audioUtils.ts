// Persistent audio context for smooth playback
let playbackContext: AudioContext | null = null;
let nextPlayTime = 0;
// MediaStream destination for capturing playback audio (used by screen recording)
let playbackStreamDest: MediaStreamAudioDestinationNode | null = null;

// --- Playback timing tracker for enriched transcript ---
// Tracks cumulative playback timing per customer speech block.
// Each block starts when the first audio chunk plays (after a gap)
// and accumulates duration across consecutive chunks.
let playbackSessionStartMs: number | null = null;  // session start time (Date.now)
let currentBlockStartMs: number | null = null;      // when current speech block started
let currentBlockDuration: number = 0;               // accumulated seconds for current block

/**
 * Set the session start time for relative timing calculations.
 * Call once when the training session starts.
 */
export function setPlaybackSessionStart(sessionStartMs: number): void {
  playbackSessionStartMs = sessionStartMs;
  currentBlockStartMs = null;
  currentBlockDuration = 0;
}

/**
 * Get the accumulated playback timing for the current customer speech block
 * and reset for the next block.
 *
 * Returns null if no playback has occurred since the last call.
 */
export function getAndResetPlaybackTiming(): { startTime: number; duration: number } | null {
  if (currentBlockStartMs === null || playbackSessionStartMs === null) {
    return null;
  }

  const result = {
    startTime: (currentBlockStartMs - playbackSessionStartMs) / 1000,  // seconds from session start
    duration: currentBlockDuration,
  };

  currentBlockStartMs = null;
  currentBlockDuration = 0;

  return result;
}

// Initialize audio context once (exported so callers can eagerly create the playback stream)
export function initPlaybackContext(): AudioContext {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    nextPlayTime = playbackContext.currentTime;
    playbackStreamDest = playbackContext.createMediaStreamDestination();
  }
  return playbackContext;
}

// Convert ArrayBuffer to base64
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Convert base64 to ArrayBuffer
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// Play audio from base64 string
export function playAudioFromBase64(base64Data: string): void {
  try {
    const context = initPlaybackContext();
    const audioData = base64ToArrayBuffer(base64Data);

    // Convert Int16 PCM to Float32
    const int16Array = new Int16Array(audioData);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }

    // Create audio buffer
    const audioBuffer = context.createBuffer(1, float32Array.length, 24000);
    audioBuffer.getChannelData(0).set(float32Array);

    // Schedule playback
    const source = context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(context.destination);
    // Also route to stream destination for screen recording capture
    if (playbackStreamDest) {
      source.connect(playbackStreamDest);
    }

    // Schedule at next available time slot
    const currentTime = context.currentTime;
    const scheduleTime = Math.max(currentTime, nextPlayTime);

    source.start(scheduleTime);

    // Update next play time (duration of this buffer)
    const duration = audioBuffer.duration;
    nextPlayTime = scheduleTime + duration;

    // Track playback timing for enriched transcript
    if (currentBlockStartMs === null) {
      currentBlockStartMs = Date.now();
    }
    currentBlockDuration += duration;
  } catch (error) {
    console.error('Error playing audio:', error);
  }
}

// Get the playback audio as a MediaStream (for screen recording)
export function getPlaybackStream(): MediaStream | null {
  return playbackStreamDest?.stream ?? null;
}

// Clean up audio context
export function closeAudioContext(): void {
  if (playbackContext) {
    playbackContext.close();
    playbackContext = null;
    playbackStreamDest = null;
    nextPlayTime = 0;
  }
  // Reset playback timing tracker
  playbackSessionStartMs = null;
  currentBlockStartMs = null;
  currentBlockDuration = 0;
}
