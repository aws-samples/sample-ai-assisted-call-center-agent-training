import { useRef, useState, useCallback } from 'react';

export interface AudioRecordingResult {
  stereoBlob: Blob | null;
}

/**
 * Hook for always-on stereo audio recording during training sessions.
 * Records a single stereo WebM file:
 * - Left channel: customer/AI playback audio
 * - Right channel: agent/trainee microphone audio
 */
export const useAudioRecording = () => {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const mixingContextRef = useRef<AudioContext | null>(null);
  const [isRecording, setIsRecording] = useState(false);

  const startRecording = useCallback((agentStream: MediaStream, customerStream?: MediaStream) => {
    // Create AudioContext at 48kHz for best MediaRecorder compatibility
    const mixCtx = new AudioContext({ sampleRate: 48000 });
    const merger = mixCtx.createChannelMerger(2);
    const dest = mixCtx.createMediaStreamDestination();

    // Customer (playback) -> left channel (input 0)
    if (customerStream) {
      const customerSource = mixCtx.createMediaStreamSource(customerStream);
      customerSource.connect(merger, 0, 0);
    }

    // Agent (mic) -> right channel (input 1)
    const agentSource = mixCtx.createMediaStreamSource(agentStream);
    agentSource.connect(merger, 0, 1);

    merger.connect(dest);
    mixingContextRef.current = mixCtx;
    console.log(`[AudioRecording] Stereo merge: customer(L) + agent(R), customerStream=${!!customerStream}`);

    // Record stereo audio as WebM Opus
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    const recorder = new MediaRecorder(dest.stream, { mimeType });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
    };
    recorder.start(5000); // request data every 5s
    mediaRecorderRef.current = recorder;

    setIsRecording(true);
    console.log('[AudioRecording] Started stereo recording');
  }, []);

  /**
   * Stop recording and return the stereo blob.
   */
  const stopRecording = useCallback((): Promise<AudioRecordingResult> => {
    const recorder = mediaRecorderRef.current;
    const chunks = recordedChunksRef.current;

    mediaRecorderRef.current = null;

    if (mixingContextRef.current) {
      mixingContextRef.current.close();
      mixingContextRef.current = null;
    }

    setIsRecording(false);

    if (recorder && recorder.state !== 'inactive') {
      return new Promise<AudioRecordingResult>((resolve) => {
        recorder.onstop = () => {
          if (chunks.length > 0) {
            const blob = new Blob(chunks, { type: 'audio/webm' });
            console.log(`[AudioRecording] Stereo recording: ${(blob.size / 1024 / 1024).toFixed(1)} MB`);
            chunks.length = 0;
            resolve({ stereoBlob: blob });
          } else {
            resolve({ stereoBlob: null });
          }
        };
        recorder.stop();
      });
    } else if (chunks.length > 0) {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      console.log(`[AudioRecording] Stereo recording (already stopped): ${(blob.size / 1024 / 1024).toFixed(1)} MB`);
      chunks.length = 0;
      return Promise.resolve({ stereoBlob: blob });
    }
    return Promise.resolve({ stereoBlob: null });
  }, []);

  return { isRecording, startRecording, stopRecording };
};
