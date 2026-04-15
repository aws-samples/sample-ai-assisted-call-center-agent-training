/**
 * Shared scorecard rubric display used by both trainee and admin views.
 * Shows overall score, grade, and per-criterion breakdown in a 2-column grid.
 */

import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { RubricMetric } from '../utils/scoringUtils';
import { getGradeColor } from '../utils/scoringUtils';

interface ScorecardRubricProps {
  finalScore: number;
  totalPossibleScore: number;
  percentageScore: number;
  grade: string;
  metrics: RubricMetric[];
  criticalFailures?: string[];
  showWeights?: boolean;
}

export const ScorecardRubric = ({
  finalScore,
  totalPossibleScore,
  percentageScore,
  grade,
  metrics,
  criticalFailures,
  showWeights = false,
}: ScorecardRubricProps) => {
  return (
    <SpaceBetween size="l">
      <Box textAlign="center">
        <SpaceBetween size="xs">
          <Box variant="h1" fontSize="display-l">
            {typeof finalScore === 'number' ? finalScore.toFixed(1) : finalScore} / {typeof totalPossibleScore === 'number' ? totalPossibleScore.toFixed(1) : totalPossibleScore}
          </Box>
          <Box variant="h2" color={getGradeColor(percentageScore)}>
            Grade: {grade}
          </Box>
          <Box variant="p" color="text-body-secondary">
            Overall Performance
          </Box>
          {criticalFailures && criticalFailures.length > 0 && (
            <StatusIndicator type="error">
              {criticalFailures.length} critical failure(s)
            </StatusIndicator>
          )}
        </SpaceBetween>
      </Box>

      {metrics.length > 0 && (
        <ColumnLayout columns={2} variant="text-grid">
          {metrics.map((metric) => (
            <Box key={metric.name}>
              <SpaceBetween size="xxs">
                <Box variant="strong">{metric.name} — {metric.description}</Box>
                <Box variant="h2" fontSize="heading-xl" color={getGradeColor(metric.score)}>
                  {metric.score.toFixed(1)}% ({metric.grade})
                </Box>
                {showWeights && metric.weight != null && (
                  <Box variant="small" color="text-body-secondary">
                    Weight: {(metric.weight * 100).toFixed(0)}%
                  </Box>
                )}
                <Box variant="p">
                  {metric.reason}
                </Box>
              </SpaceBetween>
            </Box>
          ))}
        </ColumnLayout>
      )}
    </SpaceBetween>
  );
};
