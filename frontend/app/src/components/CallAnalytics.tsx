/**
 * Call Analytics display component — shows transcript-based metrics
 * and optional audio empathy analysis results.
 * Used by both trainee (ScoringResults) and admin (SessionDetail) views.
 */

import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import type { CallAnalytics as CallAnalyticsType } from '../types';

interface CallAnalyticsProps {
  analytics: CallAnalyticsType;
}

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

export const CallAnalytics = ({ analytics }: CallAnalyticsProps) => {
  return (
    <Container header={<Header variant="h2">Call Analytics</Header>}>
      <SpaceBetween size="l">
        {/* Top-level metrics grid */}
        <ColumnLayout columns={4} variant="text-grid">
          {/* Call Duration */}
          <div>
            <Box variant="awsui-key-label">Call Duration</Box>
            <Box variant="h2" fontSize="heading-xl">
              {formatDuration(analytics.call_duration_seconds)}
            </Box>
          </div>

          {/* Agent Silence */}
          <div>
            <Box variant="awsui-key-label">Agent Silence</Box>
            <Box variant="h2" fontSize="heading-xl">
              <StatusIndicator type={getSilenceStatus(analytics.agent_silence_percentage)}>
                {analytics.agent_silence_seconds.toFixed(1)}s ({analytics.agent_silence_percentage.toFixed(0)}%)
              </StatusIndicator>
            </Box>
          </div>

          {/* Talk-Overs */}
          <div>
            <Box variant="awsui-key-label">Talk-Overs</Box>
            <Box variant="h2" fontSize="heading-xl">
              <StatusIndicator type={getTalkOverStatus(analytics.talk_over_count)}>
                {analytics.talk_over_count}
              </StatusIndicator>
            </Box>
          </div>

          {/* Questions Answered */}
          <div>
            <Box variant="awsui-key-label">Questions Answered</Box>
            <Box variant="h2" fontSize="heading-xl">
              <StatusIndicator type={getQuestionsStatus(analytics.questions_asked, analytics.questions_answered)}>
                {analytics.questions_answered}/{analytics.questions_asked}
              </StatusIndicator>
            </Box>
          </div>
        </ColumnLayout>

        {/* Second row of metrics */}
        <ColumnLayout columns={4} variant="text-grid">
          {/* Average Response Time */}
          <div>
            <Box variant="awsui-key-label">Avg. Response Time</Box>
            <Box variant="h2" fontSize="heading-xl">
              {analytics.avg_agent_response_time.toFixed(1)}s
            </Box>
          </div>

          {/* Max Silence Gap */}
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

          {/* Hedging Phrases */}
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

        {/* Hold count if present */}
        {analytics.hold_count != null && analytics.hold_count > 0 && (
          <Box>
            <Box variant="awsui-key-label">Hold Events Detected</Box>
            <Box variant="p">{analytics.hold_count}</Box>
          </Box>
        )}

        {/* Empathy Analysis (conditional) */}
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

            {/* Empathy sub-scores breakdown */}
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
};
