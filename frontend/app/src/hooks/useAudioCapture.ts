import { useRef, useState, useCallback } from 'react';
import { arrayBufferToBase64 } from '../utils/audioUtils';

export interface SpeechTiming {
  startTime: number;  // seconds from session start
  duration: number;   // seconds
}

export const useAudioCapture = (onAudioData?: (base64Audio: string) => void) => {
  const [isCapturing, setIsCapturing] = useState(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioProcessorRef = useRef<AudioWorkletNode | null>(null);

  // VAD speech timing tracking
  const sessionStartMsRef = useRef<number | null>(null);
  const speechStartMsRef = useRef<number | null>(null);
  const currentSpeechTimingRef = useRef<SpeechTiming | null>(null);

  const startCapture = useCallback(async () => {
    try {
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000,
        },
      });

      mediaStreamRef.current = stream;

      // Setup audio context
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000
      });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);

      // Load AudioWorklet module
      try {
        await audioContext.audioWorklet.addModule('/audio-processor.worklet.js');
      } catch (error) {
        console.error('Failed to load audio worklet module:', error);
        throw new Error('AudioWorklet not supported or failed to load. Please use a modern browser.');
      }

      // Create AudioWorkletNode for audio capture
      const workletNode = new AudioWorkletNode(audioContext, 'audio-capture-processor');
      audioProcessorRef.current = workletNode;

      // Setup message handler to receive processed audio and VAD events from worklet
      workletNode.port.onmessage = (event) => {
        if (!isCapturing && !audioProcessorRef.current) return;

        const { type } = event.data;

        if (type === 'vad') {
          const { speaking } = event.data;
          const now = Date.now();
          if (speaking) {
            // Speech started — record the start time
            speechStartMsRef.current = now;
          } else if (speechStartMsRef.current !== null && sessionStartMsRef.current !== null) {
            // Speech ended — compute timing and store for pickup
            const startTime = (speechStartMsRef.current - sessionStartMsRef.current) / 1000;
            const duration = (now - speechStartMsRef.current) / 1000;
            currentSpeechTimingRef.current = { startTime, duration };
            speechStartMsRef.current = null;
          }
          return;
        }

        // PCM audio data
        const { pcmData } = event.data;
        const int16Array = new Int16Array(pcmData);

        // Convert to base64 and send to callback
        if (onAudioData) {
          const base64Audio = arrayBufferToBase64(int16Array.buffer);
          onAudioData(base64Audio);
        }
      };

      // Connect audio graph: MediaStream -> AudioWorklet -> Destination
      source.connect(workletNode);
      workletNode.connect(audioContext.destination);

      setIsCapturing(true);
      return stream;
    } catch (error) {
      console.error('Error starting audio capture:', error);
      return null;
    }
  }, [onAudioData, isCapturing]);

  const stopCapture = useCallback(() => {
    // Stop media stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    // Disconnect and clean up audio processor
    if (audioProcessorRef.current) {
      audioProcessorRef.current.disconnect();
      audioProcessorRef.current.port.close(); // Close MessagePort
      audioProcessorRef.current = null;
    }

    // Close audio context
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Reset VAD timing state
    sessionStartMsRef.current = null;
    speechStartMsRef.current = null;
    currentSpeechTimingRef.current = null;

    setIsCapturing(false);
  }, []);

  const setSessionStart = useCallback((sessionStartMs: number) => {
    sessionStartMsRef.current = sessionStartMs;
    speechStartMsRef.current = null;
    currentSpeechTimingRef.current = null;
  }, []);

  const getAndResetSpeechTiming = useCallback((): SpeechTiming | null => {
    // If currently speaking, finalize the timing up to now
    if (speechStartMsRef.current !== null && sessionStartMsRef.current !== null) {
      const now = Date.now();
      const startTime = (speechStartMsRef.current - sessionStartMsRef.current) / 1000;
      const duration = (now - speechStartMsRef.current) / 1000;
      currentSpeechTimingRef.current = { startTime, duration };
      speechStartMsRef.current = null;
    }

    const timing = currentSpeechTimingRef.current;
    currentSpeechTimingRef.current = null;
    return timing;
  }, []);

  return {
    isCapturing,
    startCapture,
    stopCapture,
    setSessionStart,
    getAndResetSpeechTiming,
    mediaStream: mediaStreamRef.current,
  };
};
