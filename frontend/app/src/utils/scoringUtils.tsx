/**
 * Shared scoring utilities used by both trainee and admin views.
 */

import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Box from '@cloudscape-design/components/box';
import type { BoxProps } from '@cloudscape-design/components/box';

/** Metric data for rubric display. */
export interface RubricMetric {
  name: string;
  description: string;
  score: number;
  grade: string;
  reason: string;
  weight?: number;
}

/** Letter grade from percentage score. */
export function getGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/** Cloudscape Box color based on score. */
export function getGradeColor(score: number): BoxProps.Color {
  if (score >= 90) return 'text-status-success';
  if (score >= 70) return 'text-status-warning';
  return 'text-status-error';
}

/** StatusIndicator badge for score cells in tables. */
export function getScoreBadge(score: number | null | undefined, passed?: boolean | null) {
  if (score == null) return <Box color="text-body-secondary">--</Box>;
  if (passed === false) return <StatusIndicator type="error">{score.toFixed(0)}% (Failed)</StatusIndicator>;
  if (score >= 90) return <StatusIndicator type="success">{score.toFixed(0)}%</StatusIndicator>;
  if (score >= 70) return <StatusIndicator type="warning">{score.toFixed(0)}%</StatusIndicator>;
  return <StatusIndicator type="error">{score.toFixed(0)}%</StatusIndicator>;
}

/** Transform raw scorecard criteria object into a RubricMetric array. */
export function transformScorecardCriteria(criteria: Record<string, any>): RubricMetric[] {
  return Object.entries(criteria).map(([key, val]) => {
    const pct = val.max_points > 0 ? (val.score / val.max_points) * 100 : 0;
    return {
      name: key,
      description: val.description,
      score: pct,
      grade: getGrade(pct),
      reason: val.comments || val.description,
    };
  });
}
