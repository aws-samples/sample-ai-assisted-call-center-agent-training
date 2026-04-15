import { useEffect, useState, useRef, useCallback } from 'react';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Button from '@cloudscape-design/components/button';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Box from '@cloudscape-design/components/box';
import Alert from '@cloudscape-design/components/alert';
import Spinner from '@cloudscape-design/components/spinner';
import Toggle from '@cloudscape-design/components/toggle';
import FormField from '@cloudscape-design/components/form-field';
import type { Scenario, TranscriptMessage, SessionStatus, ScoringData, ScreenCapture } from '../types';
import { useAudioCapture } from '../hooks/useAudioCapture';
import { useScreenCapture } from '../hooks/useScreenCapture';
import { useAudioRecording } from '../hooks/useAudioRecording';
import { playAudioFromBase64, closeAudioContext, getPlaybackStream, initPlaybackContext, setPlaybackSessionStart, getAndResetPlaybackTiming } from '../utils/audioUtils';
import { generatePresignedWebSocketUrl, AgentCoreWebSocketClient } from '../services/websocket-presigned';
import { requestScoring } from '../services/scoring';
import { createSession } from '../services/scenarios';
import { analyzeScreenCaptures } from '../services/screenshotAnalyzer';
import { uploadScreenRecording, uploadAudioRecording, uploadEnrichedTranscript } from '../services/screenRecordingUploader';
import { getGrade } from '../utils/scoringUtils';

interface TrainingSessionProps {
  scenario: Scenario;
  voiceId: string;
  customerMood: string;
  languageMode: string;
  characterVoices?: Record<string, string>;
  userId: string;
  userName: string;
  onBack: () => void;
  onScoringComplete: (scoring: ScoringData) => void;
}

export const TrainingSession = ({ scenario, voiceId, customerMood, languageMode, characterVoices, userId, userName, onBack, onScoringComplete }: TrainingSessionProps) => {
  // WebSocket client state - use ref to avoid stale closure issues
  const wsClientRef = useRef<AgentCoreWebSocketClient | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('ready');
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [autoGreeting, setAutoGreeting] = useState(false);
  const [enableScreenCapture, setEnableScreenCapture] = useState(false);
  const [showEvaluationPrompt, setShowEvaluationPrompt] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [isEndingSession, setIsEndingSession] = useState(false);
  const [isStartingSession, setIsStartingSession] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  // Timer state
  const [sessionStartTime, setSessionStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState<number>(0);

  // Auto-scroll state
  const [isUserScrolling, setIsUserScrolling] = useState(false);

  // Always-on audio recording (independent of screen capture)
  const { startRecording: startAudioRecording, stopRecording: stopAudioRecording } = useAudioRecording();

  // Enriched transcript with accurate audio timing (for analytics)
  interface EnrichedTranscriptTurn {
    speaker: 'agent' | 'customer';
    text: string;
    audio_start_time: number;
    audio_duration: number;
    timestamp: string;
  }
  const enrichedTranscriptRef = useRef<EnrichedTranscriptTurn[]>([]);
  const sessionStartTimeRef = useRef<number | null>(null);

  // Track in-flight uploads so we can await them before scoring
  const screenRecordingUploadRef = useRef<Promise<void>>(Promise.resolve());
  const audioRecordingUploadRef = useRef<Promise<void>>(Promise.resolve());

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // Refs for timer and auto-scroll
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  const lastScrollTopRef = useRef<number>(0);

  const handleAudioData = useCallback(async (base64Audio: string) => {
    try {
      const client = wsClientRef.current;
      if (client) {
        client.sendAudioChunk(base64Audio);
      }
    } catch (error) {
      console.error('Error sending audio:', error);
    }
  }, []);

  const { isCapturing, startCapture, stopCapture, setSessionStart: setAudioCaptureSessionStart, getAndResetSpeechTiming } = useAudioCapture(handleAudioData);

  // Screen capture batch handler (fire-and-forget)
  const handleScreenCapturesBatch = useCallback(async (captures: ScreenCapture[]) => {
    if (!currentSessionId || !scenario) return;
    try {
      await analyzeScreenCaptures(currentSessionId, scenario.id, scenario.name, captures, userId);
      console.log('[ScreenCapture] Batch analyzed:', captures.length, 'captures');
    } catch (error) {
      console.error('[ScreenCapture] Batch analysis failed (non-blocking):', error);
    }
  }, [currentSessionId, scenario]);

  const {
    status: screenCaptureStatus,
    requestStream: requestScreenStream,
    startInterval: startScreenInterval,
    stopCapture: stopScreenCapture,
    captureCount: totalScreenCaptures,
  } = useScreenCapture({
    intervalSeconds: 10,
    batchSize: 3,
    onCapturesBatch: handleScreenCapturesBatch,
  });

  // Handle Strands BidiAgent events
  const handleWebSocketEvent = useCallback((event: any) => {
    const eventType = event.type;

    switch (eventType) {
      case 'session_started':
        console.log('[Event] Session started, id:', event.session_id);
        break;

      case 'bidi_audio_stream':
          console.log('[Event]', eventType);
        // Play audio from Nova Sonic (customer voice)
        if (event.audio) {
          playAudioFromBase64(event.audio);
        }
        break;

      case 'bidi_transcript_stream': {
        // Strands provides is_final flag — only show final transcripts (no duplicates)
        const role = event.role || 'assistant';
        const text = event.text || '';
        const isFinal = event.is_final;

        console.log('[Event] Transcript:', role, 'is_final:', isFinal, text?.substring(0, 50));

        if (isFinal && text) {
          const characterName = event.character_name;
          const speaker = role === 'user' ? 'You' : (characterName || 'Customer');
          addTranscriptMessage(speaker, text);

          // Build enriched transcript with accurate audio timing
          const startMs = sessionStartTimeRef.current;
          if (startMs) {
            const enrichedSpeaker = role === 'user' ? 'agent' : 'customer';
            let audioStartTime: number;
            let audioDuration: number;

            if (enrichedSpeaker === 'customer') {
              // Customer (AI) voice: use tracked playback timing from audioUtils
              const playbackTiming = getAndResetPlaybackTiming();
              if (playbackTiming) {
                audioStartTime = playbackTiming.startTime;
                audioDuration = playbackTiming.duration;
              } else {
                // Fallback: estimate from text
                audioStartTime = (Date.now() - startMs) / 1000;
                audioDuration = Math.max(text.split(/\s+/).length / 2.5, 0.5);
              }
            } else {
              // Agent (trainee) mic: use VAD-tracked speech timing if available
              const speechTiming = getAndResetSpeechTiming();
              if (speechTiming) {
                audioStartTime = speechTiming.startTime;
                audioDuration = speechTiming.duration;
              } else {
                // Fallback: estimate from text length
                const wordCount = text.split(/\s+/).length;
                audioDuration = Math.max(wordCount / 2.5, 0.5);
                audioStartTime = Math.max(0, (Date.now() - startMs) / 1000 - audioDuration);
              }
            }

            enrichedTranscriptRef.current.push({
              speaker: enrichedSpeaker,
              text,
              audio_start_time: Math.round(audioStartTime * 100) / 100,
              audio_duration: Math.round(audioDuration * 100) / 100,
              timestamp: new Date().toISOString(),
            });
          }
        }
        break;
      }

      case 'bidi_interruption':
        console.log('[Event] Interruption detected', event);
        break;

      case 'tool_use_stream':
        console.log('[Event] Tool use:', event.current_tool_use?.name);
        break;

      case 'tool_result':
        console.log('[Event] Tool result:', event.tool_result);
        break;

      case 'error':
        console.error('[Event] Error:', event.message);
        break;

      default:
        console.log('[Event] Unhandled:', eventType, event);
        break;
    }
  }, []);

  // Timer effect
  useEffect(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    if (sessionStartTime && sessionStatus === 'active') {
      timerIntervalRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
        setElapsedTime(elapsed);
      }, 1000);
    }

    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
        timerIntervalRef.current = null;
      }
    };
  }, [sessionStartTime, sessionStatus]);

  // Detect user scrolling
  useEffect(() => {
    const container = transcriptContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;

      if (!isAtBottom && scrollTop < lastScrollTopRef.current) {
        setIsUserScrolling(true);
      } else if (isAtBottom) {
        setIsUserScrolling(false);
      }

      lastScrollTopRef.current = scrollTop;
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-scroll
  useEffect(() => {
    const container = transcriptContainerRef.current;
    if (!container || isUserScrolling) return;

    setTimeout(() => {
      container.scrollTop = container.scrollHeight;
    }, 100);
  }, [transcript, isUserScrolling]);

  const addTranscriptMessage = (speaker: string, text: string) => {
    const message: TranscriptMessage = {
      speaker,
      text,
      timestamp: Date.now(),
    };
    setTranscript((prev) => [...prev, message]);
  };

  const startTraining = async () => {
    try {
      setIsStartingSession(true);

      // Generate session ID for this training session
      const sessionId = crypto.randomUUID();
      setCurrentSessionId(sessionId);
      console.log('[TrainingSession] Generated session ID:', sessionId);

      // Register session in DynamoDB before connecting to AgentCore
      try {
        await createSession({
          sessionId,
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          customerMood,
          difficulty: scenario.difficulty || '',
        });
        console.log('[TrainingSession] Session registered in DynamoDB');
      } catch (error) {
        console.error('[TrainingSession] Failed to register session (non-blocking):', error);
      }

      console.log('[TrainingSession] Generating presigned WebSocket URL...');
      const presignedUrl = await generatePresignedWebSocketUrl(3600, sessionId);

      console.log('[TrainingSession] Connecting to WebSocket...');
      const client = new AgentCoreWebSocketClient();
      await client.connect(presignedUrl);

      console.log('[TrainingSession] Starting training session...');

      // Set up event handler before starting session
      client.onMessage(handleWebSocketEvent);

      // Send session config with scenario info — server creates BidiAgent
      await client.startSessionWithId(
        {
          voiceId: voiceId,
          scenarioId: scenario.id,
          customerMood: customerMood,
          languageMode: languageMode,
          userId: userId,
          userName: userName,
          ...(characterVoices ? { character_voices: characterVoices } : {}),
        },
        sessionId
      );

      // Store client reference
      wsClientRef.current = client;

      console.log('[TrainingSession] Training session started successfully');

      // Mark session as started
      const startMs = Date.now();
      setSessionStartTime(startMs);
      sessionStartTimeRef.current = startMs;
      setPlaybackSessionStart(startMs);
      setAudioCaptureSessionStart(startMs);
      enrichedTranscriptRef.current = [];
      addTranscriptMessage('System', 'Customer is calling...');

      // Send initial audio to trigger Nova Sonic to speak first (if enabled)
      if (autoGreeting) {
        console.log('[TrainingSession] Loading initial audio file...');
        try {
          const response = await fetch('/audio/hi.raw');
          if (!response.ok) {
            throw new Error(`Failed to load initial audio: ${response.status}`);
          }

          const arrayBuffer = await response.arrayBuffer();
          const initialAudioData = new Int16Array(arrayBuffer);
          console.log('[TrainingSession] Initial audio loaded, length:', initialAudioData.length);

          // Send initial audio in chunks
          const chunkSize = 512;
          for (let i = 0; i < initialAudioData.length; i += chunkSize) {
            const end = Math.min(i + chunkSize, initialAudioData.length);
            const chunk = initialAudioData.slice(i, end);

            const base64Audio = btoa(
              String.fromCharCode(...new Uint8Array(chunk.buffer))
            );

            client.sendAudioChunk(base64Audio);
          }

          console.log('[TrainingSession] Initial audio sent, waiting for customer response...');

          await new Promise(resolve => setTimeout(resolve, 1000));

        } catch (error) {
          console.error('[TrainingSession] Error loading initial audio:', error);
          addTranscriptMessage('System', 'Failed to load greeting audio. Please start speaking.');
        }
      }

      // Start audio capture for the conversation
      const micStream = await startCapture();
      if (!micStream) {
        alert('Failed to access microphone. Please ensure microphone permissions are granted.');
        await client.endSession();
        setSessionStatus('ready');
        return;
      }

      setupVisualization();
      setSessionStatus('active');

      // Always start audio recording (independent of screen capture)
      initPlaybackContext(); // ensure playback destination exists before getPlaybackStream()
      const playbackStream = getPlaybackStream();
      startAudioRecording(micStream, playbackStream ?? undefined);

      // Start periodic screen capture if stream was already acquired via toggle
      if (screenCaptureStatus === 'ready_to_record') {
        const audioStreams = [micStream, ...(playbackStream ? [playbackStream] : [])];
        startScreenInterval(audioStreams);
        addTranscriptMessage('System', 'Screen capture active.');
      }

    } catch (error) {
      console.error('Error starting training:', error);
      alert('Failed to start training session: ' + (error as Error).message);
      setSessionStatus('ready');
      stopCapture();
    } finally {
      setIsStartingSession(false);
    }
  };

  const stopTraining = async () => {
    setIsEndingSession(true);
    stopCapture();
    closeAudioContext();

    // Stop audio recording and upload to S3
    const sessionId = currentSessionId;
    const { stereoBlob } = await stopAudioRecording();
    if (stereoBlob && sessionId) {
      audioRecordingUploadRef.current = uploadAudioRecording(sessionId, stereoBlob, userId)
        .then(() => {})
        .catch((error) => console.error('[AudioRecording] Upload failed:', error));
    }
    // Upload enriched transcript with accurate audio timing
    if (sessionId && enrichedTranscriptRef.current.length > 0) {
      uploadEnrichedTranscript(sessionId, enrichedTranscriptRef.current, userId)
        .catch((error) => console.error('[EnrichedTranscript] Upload failed:', error));
    }

    // Always stop screen capture (releases browser screen-sharing stream)
    const { pendingCaptures, recordingBlob } = stopScreenCapture();
    if (pendingCaptures.length > 0 && currentSessionId && scenario) {
      analyzeScreenCaptures(currentSessionId, scenario.id, scenario.name, pendingCaptures, userId)
        .catch((error) => console.error('[ScreenCapture] Final flush failed:', error));
    }
    const screenSessionId = currentSessionId;
    screenRecordingUploadRef.current = recordingBlob
      .then((blob) => {
        if (blob && screenSessionId) {
          return uploadScreenRecording(screenSessionId, blob, userId).then(() => {});
        }
      })
      .catch((error) => console.error('[ScreenRecording] Upload failed:', error));

    setSessionStatus('ended');
    setSessionStartTime(null);

    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    // End WebSocket session (closing triggers server-side recording save)
    try {
      await wsClientRef.current?.endSession();
      wsClientRef.current = null;
    } catch (error) {
      console.error('Error ending session:', error);
    }

    // Wait for all uploads to complete before showing evaluation prompt
    await Promise.all([audioRecordingUploadRef.current, screenRecordingUploadRef.current]);

    setIsEndingSession(false);
    setShowEvaluationPrompt(true);
  };

  const handleRequestEvaluation = async () => {
    setShowEvaluationPrompt(false);
    setIsEvaluating(true);
    setSessionStatus('scoring');

    console.log('[TrainingSession] Current session ID:', currentSessionId);

    if (!currentSessionId) {
      alert('No session ID available. Please try again.');
      setIsEvaluating(false);
      setSessionStatus('ended');
      return;
    }

    try {
      // Ensure audio and screen recording uploads complete before scoring
      await Promise.all([audioRecordingUploadRef.current, screenRecordingUploadRef.current]);

      console.log('[TrainingSession] Requesting evaluation for session:', currentSessionId);

      const evaluationData = await requestScoring(currentSessionId, userId);

      console.log('[TrainingSession] Scoring received:', evaluationData);

      // Map scorecard response to EvaluationData format
      const evaluation: ScoringData = {
        sessionId: evaluationData.sessionId,
        overallScore: evaluationData.scorecard.percentage_score,
        overallGrade: getGrade(evaluationData.scorecard.percentage_score),
        finalScore: evaluationData.scorecard.final_score,
        totalPossibleScore: evaluationData.scorecard.total_possible_score,
        metrics: Object.entries(evaluationData.scorecard.criteria).reduce((acc, [key, criterion]) => {
          acc[key] = {
            score: (criterion.score / criterion.max_points) * 100,
            grade: getGrade((criterion.score / criterion.max_points) * 100),
            reason: criterion.comments || criterion.description,
            weight: 1.0,
            description: criterion.description,
          };
          return acc;
        }, {} as Record<string, any>),
        timestamp: evaluationData.scorecard.evaluation_timestamp,
        analytics: evaluationData.scorecard.analytics,
      };

      setIsEvaluating(false);

      console.log('Detailed Evaluation:', evaluation);
      onScoringComplete(evaluation);

    } catch (error: any) {
      console.error('[TrainingSession] Evaluation error:', error);
      setIsEvaluating(false);
      alert(`Evaluation failed: ${error.message}\n\nPlease check the console for details.`);
    }
  };

  const skipEvaluation = () => {
    setShowEvaluationPrompt(false);
    onBack();
  };

  const setupVisualization = () => {
    if (!canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      analyser.fftSize = 256;

      analyserRef.current = analyser;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const draw = () => {
        if (!isCapturing) return;

        animationRef.current = requestAnimationFrame(draw);
        analyser.getByteFrequencyData(dataArray);

        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const barWidth = (canvas.width / bufferLength) * 2.5;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          const barHeight = (dataArray[i] / 255) * canvas.height;

          ctx.fillStyle = '#2563eb';
          ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);

          x += barWidth + 1;
        }
      };

      draw();
    });
  };

  const formatElapsedTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getStatusIndicator = () => {
    switch (sessionStatus) {
      case 'ready':
        return <StatusIndicator type="pending">Ready</StatusIndicator>;
      case 'active':
        return <StatusIndicator type="in-progress">Active</StatusIndicator>;
      case 'ended':
        return <StatusIndicator type="stopped">Ended</StatusIndicator>;
      case 'scoring':
        return <StatusIndicator type="loading">Scoring</StatusIndicator>;
      default:
        return <StatusIndicator type="pending">Ready</StatusIndicator>;
    }
  };

  return (
    <SpaceBetween size="s">
      <Container
        header={
          <Header
            variant="h1"
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                {getStatusIndicator()}
                {sessionStartTime && (
                  <Box variant="awsui-key-label">
                    <SpaceBetween direction="horizontal" size="xxs">
                      <Box variant="strong">Time:</Box>
                      <Box><span style={{ fontFamily: 'monospace' }}>{formatElapsedTime(elapsedTime)}</span></Box>
                    </SpaceBetween>
                  </Box>
                )}
                {screenCaptureStatus === 'active' && (
                  <StatusIndicator type="info">
                    Screen: {totalScreenCaptures} captures
                  </StatusIndicator>
                )}
                {(isCapturing || isEndingSession) && (
                  <Button
                    variant="primary"
                    iconName={isEndingSession ? undefined : "close"}
                    onClick={stopTraining}
                    disabled={isEndingSession}
                    loading={isEndingSession}
                  >
                    {isEndingSession ? 'Saving session...' : 'End Session'}
                  </Button>
                )}
                <Button onClick={onBack} disabled={isCapturing || isEvaluating || isStartingSession}>
                  Back to Scenarios
                </Button>
              </SpaceBetween>
            }
          >
            {scenario.name}
          </Header>
        }
      >
        <SpaceBetween size="s">
          {!isCapturing && sessionStatus === 'ready' && (
            <Box textAlign="center">
              <SpaceBetween size="m" alignItems="center">
                <SpaceBetween size="s" direction="horizontal">
                  <FormField
                    label="Automatic First Message"
                    description="When enabled, sends a greeting to trigger the AI customer to speak first"
                  >
                    <Toggle
                      checked={autoGreeting}
                      onChange={({ detail }) => setAutoGreeting(detail.checked)}
                      disabled={isStartingSession}
                    >
                      {autoGreeting ? 'On' : 'Off'}
                    </Toggle>
                  </FormField>
                  {typeof navigator.mediaDevices?.getDisplayMedia === 'function' && (
                    <FormField
                      label="Screen Capture"
                      description="When enabled, captures your screen periodically for evaluation"
                    >
                      <Toggle
                        checked={enableScreenCapture}
                        onChange={async ({ detail }) => {
                          if (detail.checked) {
                            const success = await requestScreenStream();
                            setEnableScreenCapture(success);
                          } else {
                            stopScreenCapture();
                            setEnableScreenCapture(false);
                          }
                        }}
                        disabled={isStartingSession}
                      >
                        {enableScreenCapture ? 'On' : 'Off'}
                      </Toggle>
                    </FormField>
                  )}
                </SpaceBetween>
                <Button
                  variant="primary"
                  iconName={isStartingSession ? undefined : "microphone"}
                  onClick={startTraining}
                  disabled={isStartingSession || screenCaptureStatus === 'requesting'}
                  loading={isStartingSession}
                >
                  {isStartingSession ? 'Connecting...' : screenCaptureStatus === 'requesting' ? 'Waiting for screen share...' : 'Start Training'}
                </Button>
              </SpaceBetween>
            </Box>
          )}

          {isCapturing && (
            <Box>
              <canvas
                ref={canvasRef}
                width={600}
                height={60}
                style={{ width: '100%', maxWidth: '600px', height: '60px', display: 'block', margin: '0 auto' }}
              />
            </Box>
          )}

          {showEvaluationPrompt && (
            <Alert
              type="info"
              header="Session Complete"
              action={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button onClick={handleRequestEvaluation}>View Evaluation</Button>
                  <Button variant="link" onClick={skipEvaluation}>Skip</Button>
                </SpaceBetween>
              }
            >
              Would you like to see your performance evaluation?
            </Alert>
          )}

          {isEvaluating && (
            <Box textAlign="center" padding="l">
              <SpaceBetween size="m" alignItems="center">
                <Spinner size="large" />
                <Box variant="p" color="text-body-secondary">
                  Analyzing your performance...
                </Box>
              </SpaceBetween>
            </Box>
          )}
        </SpaceBetween>
      </Container>

      <Container header={<Header variant="h2">Conversation Transcript</Header>}>
        <div
          ref={transcriptContainerRef}
          style={{ maxHeight: 'calc(100vh - 350px)', minHeight: '200px', overflow: 'auto' }}
        >
          <Box padding="s">
            {isUserScrolling && (
              <Box margin={{ bottom: 'xs' }} textAlign="center">
                <Alert
                  type="info"
                  dismissible
                  onDismiss={() => {
                    setIsUserScrolling(false);
                    if (transcriptContainerRef.current) {
                      transcriptContainerRef.current.scrollTop = transcriptContainerRef.current.scrollHeight;
                    }
                  }}
                >
                  Auto-scroll paused. Scroll to bottom or dismiss to resume.
                </Alert>
              </Box>
            )}
            {transcript.length === 0 ? (
              <Box color="text-body-secondary">
                Transcript will appear here during the conversation...
              </Box>
            ) : (
              <SpaceBetween size="s">
                {transcript.map((msg, index) => {
                const isAgent = msg.speaker === 'You';
                const isCustomer = !isAgent && msg.speaker !== 'System';

                return (
                  <div
                    key={index}
                    style={{
                      padding: '12px',
                      backgroundColor: isCustomer ? '#f0f7ff' : isAgent ? '#f0fdf4' : '#f8fafc',
                      borderLeft: `4px solid ${isCustomer ? '#2563eb' : isAgent ? '#16a34a' : '#94a3b8'}`,
                      borderRadius: '4px'
                    }}
                  >
                    <SpaceBetween size="xxs">
                      <Box
                        variant="strong"
                        color={isCustomer ? 'text-status-info' : isAgent ? 'text-status-success' : 'inherit'}
                      >
                        {msg.speaker}
                      </Box>
                      <Box>{msg.text}</Box>
                      <Box variant="small" color="text-body-secondary">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </Box>
                    </SpaceBetween>
                  </div>
                );
              })}
            </SpaceBetween>
          )}
          </Box>
        </div>
      </Container>
    </SpaceBetween>
  );
};