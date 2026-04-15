import { useEffect, useState } from 'react';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Spinner from '@cloudscape-design/components/spinner';
import Textarea from '@cloudscape-design/components/textarea';
import FormField from '@cloudscape-design/components/form-field';
import Flashbar, { type FlashbarProps } from '@cloudscape-design/components/flashbar';
import type { TraineeSession, SessionComment } from '../../types';
import { getSessionScorecard, getSessionTranscript, getSessionAudioUrl, getSessionScreenRecordingUrl, getSessionComment, saveSessionComment } from '../../services/admin';
import { getGrade, getGradeColor, transformScorecardCriteria } from '../../utils/scoringUtils';
import { ScorecardRubric } from '../ScorecardRubric';
import { CallAnalytics } from '../CallAnalytics';

const TALK_OVER_MIN_OVERLAP = 0.5;
const TALK_OVER_MIN_INTO_TURN = 1.0;

function getTalkOverIndices(turns: { speaker: string; audio_start_time?: number; audio_duration?: number }[]): Set<number> {
  const indices = new Set<number>();
  for (let i = 0; i < turns.length - 1; i++) {
    const current = turns[i];
    const next = turns[i + 1];
    if (current.speaker === next.speaker) continue;
    if (current.audio_start_time == null || current.audio_duration == null || next.audio_start_time == null) continue;
    const overlap = (current.audio_start_time + current.audio_duration) - next.audio_start_time;
    const timeIntoTurn = next.audio_start_time - current.audio_start_time;
    if (overlap > TALK_OVER_MIN_OVERLAP && timeIntoTurn > TALK_OVER_MIN_INTO_TURN) {
      indices.add(i);
      indices.add(i + 1);
    }
  }
  return indices;
}

interface SessionDetailProps {
  session: TraineeSession;
  onBack: () => void;
}

export const SessionDetail = ({ session, onBack }: SessionDetailProps) => {
  const [scorecard, setScorecard] = useState<any>(null);
  const [transcript, setTranscript] = useState<any>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [screenRecordingUrl, setScreenRecordingUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState<SessionComment | null>(null);
  const [commentText, setCommentText] = useState('');
  const [isSavingComment, setIsSavingComment] = useState(false);
  const [flashItems, setFlashItems] = useState<FlashbarProps.MessageDefinition[]>([]);

  useEffect(() => {
    loadSessionData();
  }, [session.sessionId]);

  const loadSessionData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [scorecardData, transcriptData, commentData] = await Promise.all([
        getSessionScorecard(session.userId, session.sessionId).catch(() => null),
        getSessionTranscript(session.userId, session.sessionId).catch(() => null),
        getSessionComment(session.userId, session.sessionId).catch(() => null),
      ]);
      setScorecard(scorecardData);
      setTranscript(transcriptData);
      setComment(commentData);
      setCommentText(commentData?.text || '');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePlayAudio = async () => {
    try {
      const url = await getSessionAudioUrl(session.userId, session.sessionId);
      setAudioUrl(url);
    } catch (err: any) {
      console.error('[SessionDetail] Failed to get audio URL:', err);
      setError('Failed to load audio: ' + err.message);
    }
  };

  const handlePlayScreenRecording = async () => {
    try {
      const url = await getSessionScreenRecordingUrl(session.userId, session.sessionId);
      setScreenRecordingUrl(url);
    } catch (err: any) {
      console.error('[SessionDetail] Failed to get screen recording URL:', err);
      setError('Failed to load screen recording: ' + err.message);
    }
  };

  const handleSaveComment = async () => {
    const trimmed = commentText.trim();
    if (!trimmed) {
      setFlashItems([{
        type: 'warning',
        content: 'Comment cannot be empty.',
        dismissible: true,
        onDismiss: () => setFlashItems([]),
      }]);
      return;
    }
    setIsSavingComment(true);
    try {
      const saved = await saveSessionComment(session.userId, session.sessionId, trimmed);
      setComment(saved);
      setCommentText(saved.text);
      setFlashItems([{
        type: 'success',
        content: 'Comment saved.',
        dismissible: true,
        onDismiss: () => setFlashItems([]),
      }]);
    } catch (err: any) {
      setFlashItems([{
        type: 'error',
        content: `Failed to save comment: ${err.message}`,
        dismissible: true,
        onDismiss: () => setFlashItems([]),
      }]);
    } finally {
      setIsSavingComment(false);
    }
  };

  if (isLoading) {
    return (
      <Box textAlign="center" padding="xl">
        <SpaceBetween size="m" alignItems="center">
          <Spinner size="large" />
          <Box color="text-body-secondary">Loading session details...</Box>
        </SpaceBetween>
      </Box>
    );
  }

  return (
    <SpaceBetween size="l">
      {/* Header */}
      <Container
        header={
          <Header
            variant="h1"
            actions={<Button onClick={onBack}>Back to Sessions</Button>}
          >
            Session: {session.scenarioName || session.sessionId}
          </Header>
        }
      >
        <ColumnLayout columns={4} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">Trainee</Box>
            <div>{session.userName || session.userId}</div>
          </div>
          <div>
            <Box variant="awsui-key-label">Date</Box>
            <div>{session.timestamp ? new Date(session.timestamp.endsWith('Z') || session.timestamp.includes('+') ? session.timestamp : session.timestamp + 'Z').toLocaleString() : '--'}</div>
          </div>
          <div>
            <Box variant="awsui-key-label">Score</Box>
            <div>
              {scorecard?.percentage_score != null ? (
                <Box color={getGradeColor(scorecard.percentage_score)} variant="strong">
                  {scorecard.percentage_score.toFixed(0)}%
                </Box>
              ) : '--'}
            </div>
          </div>
          <div>
            <Box variant="awsui-key-label">Result</Box>
            <div>
              {scorecard?.passed != null ? (
                scorecard.passed
                  ? <StatusIndicator type="success">Passed</StatusIndicator>
                  : <StatusIndicator type="error">Failed</StatusIndicator>
              ) : '--'}
            </div>
          </div>
        </ColumnLayout>
      </Container>

      {error && (
        <Box color="text-status-error">Error: {error}</Box>
      )}

      {/* Scorecard — shared rubric component */}
      {scorecard && (
        <Container header={<Header variant="h2">Performance Scoring</Header>}>
          <ScorecardRubric
            finalScore={scorecard.final_score}
            totalPossibleScore={scorecard.total_possible_score}
            percentageScore={scorecard.percentage_score}
            grade={getGrade(scorecard.percentage_score)}
            metrics={scorecard.criteria ? transformScorecardCriteria(scorecard.criteria) : []}
            criticalFailures={scorecard.critical_failures}
          />
        </Container>
      )}

      {/* Call Analytics */}
      {scorecard?.analytics && (
        <CallAnalytics analytics={scorecard.analytics} />
      )}

      {/* Token Usage */}
      {scorecard?.token_usage && Object.keys(scorecard.token_usage).length > 0 && (
        <Container header={<Header variant="h2">Token Usage</Header>}>
          <ColumnLayout columns={Object.keys(scorecard.token_usage).length} variant="text-grid">
            {Object.entries(scorecard.token_usage).map(([component, usage]: [string, any]) => (
              <SpaceBetween size="xxs" key={component}>
                <Box variant="awsui-key-label">
                  {component === 'nova_sonic' ? 'Nova Sonic (Voice)' :
                   component === 'scoring' ? 'Scoring (Claude)' :
                   component === 'screen_analysis' ? 'Screen Analysis (Claude)' : component}
                </Box>
                <div>Model: {usage.model || '--'}</div>
                <div>Input: {(usage.input_tokens || 0).toLocaleString()}</div>
                <div>Output: {(usage.output_tokens || 0).toLocaleString()}</div>
                {usage.total_tokens != null && component !== 'nova_sonic' && (
                  <div><Box variant="strong">Total: {usage.total_tokens.toLocaleString()}</Box></div>
                )}
              </SpaceBetween>
            ))}
          </ColumnLayout>
        </Container>
      )}

      {/* Audio playback */}
      <Container header={<Header variant="h2">Audio Recording</Header>}>
        {audioUrl ? (
          <audio controls src={audioUrl} style={{ width: '100%' }}>
            Your browser does not support audio playback.
          </audio>
        ) : (
          <Button onClick={handlePlayAudio} iconName="caret-right-filled">
            Load Audio
          </Button>
        )}
      </Container>

      {/* Screen recording playback */}
      <Container header={<Header variant="h2">Screen Recording</Header>}>
        {screenRecordingUrl ? (
          <video controls src={screenRecordingUrl} style={{ width: '100%', maxHeight: '600px' }}>
            Your browser does not support video playback.
          </video>
        ) : (
          <Button onClick={handlePlayScreenRecording} iconName="caret-right-filled">
            Load Screen Recording
          </Button>
        )}
      </Container>

      {/* Transcript */}
      {transcript?.transcript && (
        <Container header={<Header variant="h2">Conversation Transcript</Header>}>
          <div style={{ maxHeight: '500px', overflow: 'auto' }}>
            <SpaceBetween size="s">
              {(() => {
                const talkOverIndices = getTalkOverIndices(transcript.transcript);
                return transcript.transcript.map((turn: any, index: number) => {
                  const isCustomer = turn.speaker === 'customer';
                  const isAgent = turn.speaker === 'agent';
                  const isTalkOver = talkOverIndices.has(index);
                  return (
                    <div
                      key={index}
                      style={{
                        padding: '12px',
                        backgroundColor: isCustomer ? '#f0f7ff' : isAgent ? '#f0fdf4' : '#f8fafc',
                        borderLeft: `4px solid ${isCustomer ? '#2563eb' : isAgent ? '#16a34a' : '#94a3b8'}`,
                        borderRight: isTalkOver ? '4px solid #f59e0b' : 'none',
                        borderRadius: '4px',
                      }}
                    >
                      <SpaceBetween size="xxs">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Box
                            variant="strong"
                            color={isCustomer ? 'text-status-info' : isAgent ? 'text-status-success' : 'inherit'}
                          >
                            {isCustomer ? 'Customer' : isAgent ? 'Agent (Trainee)' : turn.speaker}
                          </Box>
                          {isTalkOver && (
                            <span style={{
                              backgroundColor: '#fef3c7',
                              color: '#92400e',
                              padding: '1px 6px',
                              borderRadius: '4px',
                              fontSize: '11px',
                              fontWeight: 600,
                            }}>
                              Talk-over
                            </span>
                          )}
                        </div>
                        <Box>{turn.text}</Box>
                        <Box variant="small" color="text-body-secondary">
                          {turn.timestamp}
                        </Box>
                      </SpaceBetween>
                    </div>
                  );
                });
              })()}
            </SpaceBetween>
          </div>
        </Container>
      )}

      {/* Admin Notes */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <Button
                onClick={handleSaveComment}
                loading={isSavingComment}
                variant="primary"
              >
                Save Comment
              </Button>
            }
            description={
              comment
                ? `Last updated by ${comment.authorEmail} on ${new Date(comment.updatedAt).toLocaleString()}`
                : undefined
            }
          >
            Admin Notes
          </Header>
        }
      >
        <SpaceBetween size="s">
          <Flashbar items={flashItems} />
          <FormField>
            <Textarea
              value={commentText}
              onChange={({ detail }) => setCommentText(detail.value)}
              placeholder="Add notes about this session..."
              rows={4}
            />
          </FormField>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
};
