import { useRef, useState, useCallback } from 'react';
import type { ScreenCapture, ScreenCaptureStatus } from '../types';

/** Result returned by stopCapture, includes pending screenshots and a promise for the video recording */
export interface StopCaptureResult {
  pendingCaptures: ScreenCapture[];
  /** Resolves once MediaRecorder has flushed its final data chunk */
  recordingBlob: Promise<Blob | null>;
}

export interface UseScreenCaptureOptions {
  /** Capture interval in seconds (default: 10) */
  intervalSeconds?: number;
  /** Max image width in pixels (default: 1280) */
  maxWidth?: number;
  /** Max image height in pixels (default: 720) */
  maxHeight?: number;
  /** JPEG quality 0-1 (default: 0.7) */
  jpegQuality?: number;
  /** Called each time a batch of captures is ready to send */
  onCapturesBatch?: (captures: ScreenCapture[]) => void;
  /** Number of captures per batch before invoking callback (default: 3) */
  batchSize?: number;
}

export const useScreenCapture = (options?: UseScreenCaptureOptions) => {
  const {
    intervalSeconds = 10,
    maxWidth = 1280,
    maxHeight = 720,
    jpegQuality = 0.7,
    onCapturesBatch,
    batchSize = 3,
  } = options ?? {};

  const [status, setStatus] = useState<ScreenCaptureStatus>('idle');
  const [captureCount, setCaptureCount] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingRef = useRef<ScreenCapture[]>([]);
  const captureIndexRef = useRef(0);
  const sessionStartRef = useRef(0);
  const onCapturesBatchRef = useRef(onCapturesBatch);
  onCapturesBatchRef.current = onCapturesBatch;

  // MediaRecorder refs for full video recording
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  // Audio mixing context for combining mic + playback audio into video recording
  const mixingContextRef = useRef<AudioContext | null>(null);

  const cleanup = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    if (mixingContextRef.current) {
      mixingContextRef.current.close();
      mixingContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current = null;
    }
  }, []);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < video.HAVE_CURRENT_DATA) return;

    // Calculate scaled dimensions preserving aspect ratio
    let width = video.videoWidth;
    let height = video.videoHeight;

    if (width > maxWidth || height > maxHeight) {
      const scale = Math.min(maxWidth / width, maxHeight / height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/jpeg', jpegQuality);
    // Strip the data:image/jpeg;base64, prefix
    const imageData = dataUrl.split(',')[1];
    if (!imageData) return;

    const now = Date.now();
    const elapsedSeconds = Math.round((now - sessionStartRef.current) / 1000);
    const capture: ScreenCapture = {
      imageData,
      timestamp: now,
      elapsedSeconds,
      captureIndex: captureIndexRef.current++,
    };

    pendingRef.current.push(capture);
    setCaptureCount((prev) => prev + 1);

    console.log(
      `[ScreenCapture] Frame captured #${capture.captureIndex} at ${elapsedSeconds}s (${width}x${height})`
    );

    // Flush batch when full
    if (pendingRef.current.length >= batchSize) {
      const batch = pendingRef.current.splice(0, batchSize);
      console.log(`[ScreenCapture] Sending batch of ${batch.length} captures`);
      onCapturesBatchRef.current?.(batch);
    }
  }, [maxWidth, maxHeight, jpegQuality, batchSize]);

  /**
   * Phase 1: Acquire the screen share stream (triggers browser permission dialog).
   * Call this when the user toggles screen capture ON so they can pick
   * their screen/window before the training session starts.
   */
  const requestStream = useCallback(async (): Promise<boolean> => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      console.warn('[ScreenCapture] getDisplayMedia not supported in this browser');
      return false;
    }

    setStatus('requesting');

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
      });

      streamRef.current = stream;

      // Handle user stopping screen share via browser UI
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          console.log('[ScreenCapture] Screen sharing stopped by user');
          if (pendingRef.current.length > 0) {
            const remaining = pendingRef.current.splice(0);
            onCapturesBatchRef.current?.(remaining);
          }
          cleanup();
          setStatus('stopped');
        };
      }

      // Create offscreen video element
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      videoRef.current = video;

      // Create offscreen canvas
      canvasRef.current = document.createElement('canvas');

      setStatus('ready_to_record');
      console.log('[ScreenCapture] Stream acquired, ready to record');
      return true;
    } catch (error: any) {
      if (error.name === 'NotAllowedError') {
        console.log('[ScreenCapture] Permission denied by user');
        setStatus('denied');
      } else {
        console.error('[ScreenCapture] Failed to acquire stream:', error);
        setStatus('idle');
      }
      return false;
    }
  }, [cleanup]);

  /**
   * Phase 2: Start the periodic capture interval and video recording.
   * Call this when the training session actually begins.
   * The stream must already be acquired via requestStream().
   *
   * @param audioStreams Optional array of MediaStreams containing audio tracks
   *   (e.g. microphone, playback) to mix into the video recording.
   */
  const startInterval = useCallback((audioStreams?: MediaStream[]) => {
    if (!streamRef.current || !videoRef.current) {
      console.warn('[ScreenCapture] No stream acquired — call requestStream() first');
      return;
    }

    // Reset counters
    captureIndexRef.current = 0;
    pendingRef.current = [];
    sessionStartRef.current = Date.now();
    setCaptureCount(0);

    // Build the stream for MediaRecorder: screen video + optional mixed audio
    let recordingStream: MediaStream = streamRef.current;

    if (audioStreams && audioStreams.length > 0) {
      try {
        const mixCtx = new AudioContext();
        const mixDest = mixCtx.createMediaStreamDestination();
        for (const stream of audioStreams) {
          const src = mixCtx.createMediaStreamSource(stream);
          src.connect(mixDest);
        }
        mixingContextRef.current = mixCtx;

        // Combine screen video track(s) with the mixed audio track
        const combined = new MediaStream();
        for (const track of streamRef.current.getVideoTracks()) {
          combined.addTrack(track);
        }
        for (const track of mixDest.stream.getAudioTracks()) {
          combined.addTrack(track);
        }
        recordingStream = combined;
        console.log(`[ScreenCapture] Mixed ${audioStreams.length} audio stream(s) into recording`);
      } catch (err) {
        console.warn('[ScreenCapture] Audio mixing failed, recording video-only:', err);
      }
    }

    // Start MediaRecorder for full video recording
    recordedChunksRef.current = [];
    try {
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
      const recorder = new MediaRecorder(recordingStream, { mimeType });
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };
      // Request data every 5 seconds to avoid losing everything if the recording is interrupted
      recorder.start(5000);
      mediaRecorderRef.current = recorder;
      console.log(`[ScreenCapture] MediaRecorder started (${mimeType})`);
    } catch (err) {
      console.warn('[ScreenCapture] MediaRecorder not available, video recording disabled:', err);
      mediaRecorderRef.current = null;
    }

    // Start periodic screenshot capture
    intervalRef.current = setInterval(captureFrame, intervalSeconds * 1000);

    setStatus('active');
    console.log(`[ScreenCapture] Recording started (interval: ${intervalSeconds}s, batch: ${batchSize})`);
  }, [intervalSeconds, batchSize, captureFrame]);

  /**
   * Stop screen capture and video recording.
   * Returns pending screenshot captures and a promise that resolves with the video blob.
   */
  const stopCapture = useCallback((): StopCaptureResult => {
    const remaining = pendingRef.current.splice(0);

    // Build a Promise for the recording blob — MediaRecorder.stop() fires its
    // final ondataavailable + onstop events asynchronously, so we must wait.
    let recordingBlob: Promise<Blob | null>;
    const recorder = mediaRecorderRef.current;

    if (recorder && recorder.state !== 'inactive') {
      recordingBlob = new Promise<Blob | null>((resolve) => {
        recorder.onstop = () => {
          if (recordedChunksRef.current.length > 0) {
            const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
            console.log(`[ScreenCapture] Video recording: ${(blob.size / 1024 / 1024).toFixed(1)} MB`);
            recordedChunksRef.current = [];
            resolve(blob);
          } else {
            console.log('[ScreenCapture] No recorded chunks available');
            resolve(null);
          }
        };
        recorder.stop();
      });
    } else if (recordedChunksRef.current.length > 0) {
      // Recorder already stopped but chunks available
      const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
      console.log(`[ScreenCapture] Video recording (already stopped): ${(blob.size / 1024 / 1024).toFixed(1)} MB`);
      recordedChunksRef.current = [];
      recordingBlob = Promise.resolve(blob);
    } else {
      recordingBlob = Promise.resolve(null);
    }
    mediaRecorderRef.current = null;

    // Clean up audio mixing context
    if (mixingContextRef.current) {
      mixingContextRef.current.close();
      mixingContextRef.current = null;
    }

    // Clean up stream and interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current = null;
    }

    setStatus('stopped');
    console.log(`[ScreenCapture] Stopped. ${remaining.length} pending captures`);

    return { pendingCaptures: remaining, recordingBlob };
  }, []);

  return {
    status,
    requestStream,
    startInterval,
    stopCapture,
    captureCount,
  };
};
