import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Button from '@cloudscape-design/components/button';
import type { ScoringData } from '../types';
import type { RubricMetric } from '../utils/scoringUtils';
import { ScorecardRubric } from './ScorecardRubric';
import { CallAnalytics } from './CallAnalytics';

interface ScoringResultsProps {
  scoring: ScoringData;
  onNewSession: () => void;
  onViewHistory: () => void;
}

export const ScoringResults = ({ scoring, onNewSession, onViewHistory }: ScoringResultsProps) => {
  const metricsArray: RubricMetric[] = Object.entries(scoring.metrics).map(([name, metric]) => ({
    name,
    description: metric.description,
    score: metric.score,
    grade: metric.grade,
    reason: metric.reason,
    weight: metric.weight,
  }));

  return (
    <SpaceBetween size="l">
      <Container
        header={
          <Header variant="h1">
            Performance Scoring
          </Header>
        }
      >
        <SpaceBetween size="l">
          <ScorecardRubric
            finalScore={scoring.finalScore}
            totalPossibleScore={scoring.totalPossibleScore}
            percentageScore={scoring.overallScore}
            grade={scoring.overallGrade}
            metrics={metricsArray}
            showWeights={true}
          />

          <Box textAlign="center">
            <SpaceBetween direction="horizontal" size="xs">
              <Button variant="primary" onClick={onNewSession}>
                Start New Session
              </Button>
              <Button onClick={onViewHistory}>
                View History
              </Button>
            </SpaceBetween>
          </Box>
        </SpaceBetween>
      </Container>

      {scoring.analytics && (
        <CallAnalytics analytics={scoring.analytics} />
      )}
    </SpaceBetween>
  );
};
