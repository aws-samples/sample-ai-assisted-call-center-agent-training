import { useState, useEffect } from 'react';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Box from '@cloudscape-design/components/box';
import type { BoxProps } from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import Spinner from '@cloudscape-design/components/spinner';
import {
  getSessionDetail,
  getSessionAudioUrl,
  SessionDetailResponse,
  ScorecardData,
  ScorecardCriterion,
  TranscriptTurn,
  CallAnalytics,
} from '../services/api';

// ============================================================================
// Utility functions (replicated from frontend/app/src/utils/scoringUtils.tsx)
// ============================================================================

function getGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function getGradeColor(score: number): BoxProps.Color {
  if (score >= 90) return 'text-status-success';
  if (score >= 70) return 'text-status-warning';
  return 'text-status-error';
}

// ============================================================================
// Analytics utility functions (replicated from frontend CallAnalytics.tsx)
// ============================================================================

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function getSilenceStatus(pct: number): 'success' | 'warning' | 'error' {
  if (pct < 10) return 'success';
  if (pct < 20) return 'warning';
  return 'error';
}

function getTalkOverStatus(count: number): 'success' | 'warning' | 'error' {
  if (count <= 1) return 'success';
  if (count <= 3) return 'warning';
  return 'error';
}

function getCountStatus(count: number, yellowThreshold = 1, redThreshold = 3): 'success' | 'warning' | 'error' {
  if (count < yellowThreshold) return 'success';
  if (count < redThreshold) return 'warning';
  return 'error';
}

function getSilenceGapStatus(seconds: number): 'success' | 'warning' | 'error' {
  if (seconds < 15) return 'success';
  if (seconds < 20) return 'warning';
  return 'error';
}

function getQuestionsStatus(asked: number, answered: number): 'success' | 'warning' | 'error' {
  if (asked === 0) return 'success';
  const ratio = answered / asked;
  if (ratio >= 0.8) return 'success';
  if (ratio >= 0.5) return 'warning';
  return 'error';
}

function getEmpathyStatus(score: number): 'success' | 'warning' | 'error' {
  if (score >= 0.7) return 'success';
  if (score >= 0.4) return 'warning';
  return 'error';
}

const COMPONENT_LABELS: Record<string, { name: string; description: string }> = {
  pitch_variation: { name: 'Pitch Variation', description: 'Voice modulation showing engagement' },
  energy: { name: 'Energy & Volume', description: 'Controlled, patient volume' },
  speaking_rate: { name: 'Speaking Rate', description: 'Pace and clarity' },
  voice_quality: { name: 'Voice Quality', description: 'Warmth and tone' },
  consistency: { name: 'Consistency', description: 'Steady delivery across turns' },
};

/** Transform flat criteria map into RubricMetric-style array. */
function transformCriteria(criteria: Record<string, ScorecardCriterion>) {
  return Object.entries(criteria).map(([key, val]) => {
    const pct = val.max_points > 0 ? (val.score / val.max_points) * 100 : 0;
    return {
      id: key,
      description: val.description,
      pct,
      grade: getGrade(pct),
      comments: val.comments || '',
    };
  });
}

// ============================================================================
// Main Component
// ============================================================================

interface SessionDetailProps {
  sessionId: string;
  onBack: () => void;
}

export const SessionDetail = ({ sessionId, onBack }: SessionDetailProps) => {
  const [data, setData] = useState<SessionDetailResponse | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const detail = await getSessionDetail(sessionId);
        setData(detail);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load session');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [sessionId]);

  // Poll if scoring in progress
  useEffect(() => {
    const status = (data?.session as Record<string, string>)?.status;
    if (status !== 'scoring') return;
    const interval = setInterval(async () => {
      try {
        const detail = await getSessionDetail(sessionId);
        setData(detail);
      } catch { /* ignore polling errors */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [sessionId, data?.session]);

  const handleLoadAudio = async () => {
    try {
      const audio = await getSessionAudioUrl(sessionId);
      setAudioUrl(audio.url);
    } catch {
      // Audio not available
    }
  };

  if (loading) {
    return (
      <Box textAlign="center" padding="xxl">
        <SpaceBetween size="m" alignItems="center">
          <Spinner size="large" />
          <Box color="text-body-secondary">Loading session details...</Box>
        </SpaceBetween>
      </Box>
    );
  }

  if (error) {
    return (
      <Container>
        <SpaceBetween size="m">
          <Button onClick={onBack} iconName="arrow-left">Back to History</Button>
          <StatusIndicator type="error">{error}</StatusIndicator>
        </SpaceBetween>
      </Container>
    );
  }

  const session = data?.session as Record<string, unknown> || {};
  const scorecard = data?.scorecard ?? null;
  const transcript = data?.transcript ?? null;

  return (
    <SpaceBetween size="l">
      {/* Header */}
      <Container
        header={
          <Header
            variant="h1"
            actions={<Button onClick={onBack}>Back to History</Button>}
          >
            Session: {(session.scenarioName as string) || 'Training Session'}
          </Header>
        }
      >
        <ColumnLayout columns={4} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">Contact ID</Box>
            <div>{(session.contactId as string) || '-'}</div>
          </div>
          <div>
            <Box variant="awsui-key-label">Date</Box>
            <div>
              {session.startTime
                ? new Date(session.startTime as string).toLocaleString()
                : '-'}
            </div>
          </div>
          <div>
            <Box variant="awsui-key-label">Score</Box>
            <div>
              {scorecard?.percentage_score != null ? (
                <Box color={getGradeColor(scorecard.percentage_score)} variant="strong">
                  {scorecard.percentage_score.toFixed(0)}%
                </Box>
              ) : '-'}
            </div>
          </div>
          <div>
            <Box variant="awsui-key-label">Result</Box>
            <div>
              {scorecard?.passed != null ? (
                scorecard.passed
                  ? <StatusIndicator type="success">Passed</StatusIndicator>
                  : <StatusIndicator type="error">Failed</StatusIndicator>
              ) : '-'}
            </div>
          </div>
        </ColumnLayout>
      </Container>

      {/* Scoring Status */}
      {session.status === 'scoring' && !scorecard && (
        <Container>
          <StatusIndicator type="loading">
            Scoring in progress... This may take 1-3 minutes.
          </StatusIndicator>
        </Container>
      )}

      {/* Performance Scoring */}
      {scorecard && <ScorecardView scorecard={scorecard} />}

      {/* Call Analytics */}
      {scorecard?.analytics && <AnalyticsView analytics={scorecard.analytics} />}

      {/* Audio Recording */}
      <Container header={<Header variant="h2">Audio Recording</Header>}>
        {audioUrl ? (
          <audio controls src={audioUrl} style={{ width: '100%' }}>
            Your browser does not support the audio element.
          </audio>
        ) : (
          <Button onClick={handleLoadAudio} iconName="caret-right-filled">
            Load Audio
          </Button>
        )}
      </Container>

      {/* Transcript */}
      {transcript && transcript.length > 0 && <TranscriptView transcript={transcript} />}
    </SpaceBetween>
  );
};

// ============================================================================
// Scorecard — matches Web UI ScorecardRubric pattern
// ============================================================================

const ScorecardView = ({ scorecard }: { scorecard: ScorecardData }) => {
  const metrics = scorecard.criteria ? transformCriteria(scorecard.criteria) : [];

  return (
    <Container header={<Header variant="h2">Performance Scoring</Header>}>
      <SpaceBetween size="l">
        {/* Large centered score display */}
        <Box textAlign="center">
          <SpaceBetween size="xs">
            <Box variant="h1" fontSize="display-l">
              {scorecard.final_score.toFixed(1)} / {scorecard.total_possible_score.toFixed(1)}
            </Box>
            <Box variant="h2" color={getGradeColor(scorecard.percentage_score)}>
              Grade: {getGrade(scorecard.percentage_score)}
            </Box>
            <Box variant="p" color="text-body-secondary">
              Overall Performance
            </Box>
            {scorecard.critical_failures && scorecard.critical_failures.length > 0 && (
              <StatusIndicator type="error">
                {scorecard.critical_failures.length} critical failure(s)
              </StatusIndicator>
            )}
          </SpaceBetween>
        </Box>

        {/* General comments */}
        {scorecard.general_comments && (
          <Box variant="p">{scorecard.general_comments}</Box>
        )}

        {/* Per-criterion 2-column grid */}
        {metrics.length > 0 && (
          <ColumnLayout columns={2} variant="text-grid">
            {metrics.map((metric) => (
              <Box key={metric.id}>
                <SpaceBetween size="xxs">
                  <Box variant="strong">{metric.id} — {metric.description}</Box>
                  <Box variant="h2" fontSize="heading-xl" color={getGradeColor(metric.pct)}>
                    {metric.pct.toFixed(1)}% ({metric.grade})
                  </Box>
                  <Box variant="p">{metric.comments}</Box>
                </SpaceBetween>
              </Box>
            ))}
          </ColumnLayout>
        )}
      </SpaceBetween>
    </Container>
  );
};

// ============================================================================
// Analytics — matches Web UI CallAnalytics pattern
// ============================================================================

const AnalyticsView = ({ analytics }: { analytics: CallAnalytics }) => (
  <Container header={<Header variant="h2">Call Analytics</Header>}>
    <SpaceBetween size="l">
      {/* Row 1: 4-column grid */}
      <ColumnLayout columns={4} variant="text-grid">
        <div>
          <Box variant="awsui-key-label">Call Duration</Box>
          <Box variant="h2" fontSize="heading-xl">
            {analytics.call_duration_seconds != null ? formatDuration(analytics.call_duration_seconds) : '-'}
          </Box>
        </div>
        <div>
          <Box variant="awsui-key-label">Agent Silence</Box>
          <Box variant="h2" fontSize="heading-xl">
            {analytics.agent_silence_percentage != null ? (
              <StatusIndicator type={getSilenceStatus(analytics.agent_silence_percentage)}>
                {analytics.agent_silence_seconds?.toFixed(1)}s ({analytics.agent_silence_percentage.toFixed(0)}%)
              </StatusIndicator>
            ) : '-'}
          </Box>
        </div>
        <div>
          <Box variant="awsui-key-label">Talk-Overs</Box>
          <Box variant="h2" fontSize="heading-xl">
            {analytics.talk_over_count != null ? (
              <StatusIndicator type={getTalkOverStatus(analytics.talk_over_count)}>
                {analytics.talk_over_count}
              </StatusIndicator>
            ) : '-'}
          </Box>
        </div>
        <div>
          <Box variant="awsui-key-label">Questions Answered</Box>
          <Box variant="h2" fontSize="heading-xl">
            {analytics.questions_asked != null && analytics.questions_answered != null ? (
              <StatusIndicator type={getQuestionsStatus(analytics.questions_asked, analytics.questions_answered)}>
                {analytics.questions_answered}/{analytics.questions_asked}
              </StatusIndicator>
            ) : '-'}
          </Box>
        </div>
      </ColumnLayout>

      {/* Row 2: 4-column grid */}
      <ColumnLayout columns={4} variant="text-grid">
        <div>
          <Box variant="awsui-key-label">Avg. Response Time</Box>
          <Box variant="h2" fontSize="heading-xl">
            {analytics.avg_agent_response_time?.toFixed(1) ?? '-'}s
          </Box>
        </div>
        {analytics.max_silence_gap_seconds != null && (
          <div>
            <Box variant="awsui-key-label">Max Silence Gap</Box>
            <Box variant="h2" fontSize="heading-xl">
              <StatusIndicator type={getSilenceGapStatus(analytics.max_silence_gap_seconds)}>
                {analytics.max_silence_gap_seconds.toFixed(1)}s
              </StatusIndicator>
            </Box>
            {analytics.silence_violations_count != null && analytics.silence_violations_count > 0 && (
              <Box variant="small" color="text-status-error">
                {analytics.silence_violations_count} violation{analytics.silence_violations_count > 1 ? 's' : ''} (&gt;20s)
              </Box>
            )}
          </div>
        )}
        {analytics.confidence_language_count != null && (
          <div>
            <Box variant="awsui-key-label">Hedging Phrases</Box>
            <Box variant="h2" fontSize="heading-xl">
              <StatusIndicator type={getCountStatus(analytics.confidence_language_count)}>
                {analytics.confidence_language_count}
              </StatusIndicator>
            </Box>
          </div>
        )}
      </ColumnLayout>

      {/* Hold count */}
      {analytics.hold_count != null && analytics.hold_count > 0 && (
        <Box>
          <Box variant="awsui-key-label">Hold Events Detected</Box>
          <Box variant="p">{analytics.hold_count}</Box>
        </Box>
      )}

      {/* Empathy Analysis */}
      {analytics.empathy && (
        <SpaceBetween size="m">
          <SpaceBetween size="s">
            <Box variant="awsui-key-label">Voice Empathy Score</Box>
            <ProgressBar
              value={Math.round(analytics.empathy.score * 100)}
              status={getEmpathyStatus(analytics.empathy.score) === 'error' ? 'error' : undefined}
              additionalInfo={`${(analytics.empathy.score * 100).toFixed(0)}%`}
            />
            <StatusIndicator type={getEmpathyStatus(analytics.empathy.score)}>
              {analytics.empathy.reason}
            </StatusIndicator>
          </SpaceBetween>

          {analytics.empathy.components && Object.keys(analytics.empathy.components).length > 0 && (
            <SpaceBetween size="xs">
              <Box variant="awsui-key-label">Component Breakdown</Box>
              <ColumnLayout columns={3} variant="text-grid">
                {Object.entries(analytics.empathy.components).map(([key, comp]) => {
                  const label = COMPONENT_LABELS[key] || { name: key, description: '' };
                  const pct = Math.round(comp.score * 100);
                  return (
                    <div key={key}>
                      <Box variant="awsui-key-label">
                        {label.name} ({Math.round(comp.weight * 100)}%)
                      </Box>
                      <StatusIndicator type={getEmpathyStatus(comp.score)}>
                        {pct}%
                      </StatusIndicator>
                      {label.description && (
                        <Box variant="small" color="text-body-secondary">{label.description}</Box>
                      )}
                    </div>
                  );
                })}
              </ColumnLayout>
            </SpaceBetween>
          )}
        </SpaceBetween>
      )}
    </SpaceBetween>
  </Container>
);

// ============================================================================
// Transcript — matches Web UI card-based style
// ============================================================================

function getTalkOverIndices(turns: { speaker: string; audio_start_time?: number; audio_duration?: number }[]): Set<number> {
  const indices = new Set<number>();
  for (let i = 0; i < turns.length - 1; i++) {
    const current = turns[i];
    const next = turns[i + 1];
    if (current.speaker === next.speaker) continue;
    if (current.audio_start_time == null || current.audio_duration == null || next.audio_start_time == null) continue;
    if (current.audio_start_time + current.audio_duration > next.audio_start_time) {
      indices.add(i);
      indices.add(i + 1);
    }
  }
  return indices;
}

const TranscriptView = ({ transcript }: { transcript: TranscriptTurn[] }) => {
  const talkOverIndices = getTalkOverIndices(transcript);
  return (
    <Container header={<Header variant="h2">Conversation Transcript</Header>}>
      <div style={{ maxHeight: '500px', overflow: 'auto' }}>
        <SpaceBetween size="s">
          {transcript.map((turn, i) => {
            const isCustomer = turn.speaker === 'customer';
            const isAgent = turn.speaker === 'agent';
            const isTalkOver = talkOverIndices.has(i);
            return (
              <div
                key={i}
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
                  {turn.audio_start_time != null && (
                    <Box variant="small" color="text-body-secondary">
                      {turn.audio_start_time.toFixed(1)}s
                    </Box>
                  )}
                </SpaceBetween>
              </div>
            );
          })}
        </SpaceBetween>
      </div>
    </Container>
  );
};
