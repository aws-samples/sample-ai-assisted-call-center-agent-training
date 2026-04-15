import { useEffect, useState } from 'react';
import Table from '@cloudscape-design/components/table';
import Header from '@cloudscape-design/components/header';
import Container from '@cloudscape-design/components/container';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Spinner from '@cloudscape-design/components/spinner';
import type { TraineeInfo, TraineeSession } from '../../types';
import { listTraineeSessions } from '../../services/admin';
import { getScoreBadge } from '../../utils/scoringUtils';

interface TraineeSessionListProps {
  trainee: TraineeInfo;
  onSelectSession: (session: TraineeSession) => void;
  onBack: () => void;
}

export const TraineeSessionList = ({ trainee, onSelectSession, onBack }: TraineeSessionListProps) => {
  const [sessions, setSessions] = useState<TraineeSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadSessions();
  }, [trainee.userId]);

  const loadSessions = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await listTraineeSessions(trainee.userId);
      setSessions(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };


  return (
    <Container
      header={
        <Header
          variant="h1"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button iconName="refresh" onClick={loadSessions} loading={isLoading}>
                Refresh
              </Button>
              <Button onClick={onBack}>Back to Dashboard</Button>
            </SpaceBetween>
          }
          counter={`(${sessions.length})`}
        >
          Sessions: {trainee.userName || trainee.userId}
        </Header>
      }
    >
      {error && (
        <Box color="text-status-error" margin={{ bottom: 'm' }}>
          Error loading sessions: {error}
        </Box>
      )}

      {isLoading ? (
        <Box textAlign="center" padding="xl">
          <SpaceBetween size="m" alignItems="center">
            <Spinner size="large" />
            <Box color="text-body-secondary">Loading sessions...</Box>
          </SpaceBetween>
        </Box>
      ) : (
        <Table
          items={sessions}
          columnDefinitions={[
            {
              id: 'scenarioName',
              header: 'Scenario',
              cell: (item) => (
                <Button variant="link" onClick={() => onSelectSession(item)}>
                  {item.scenarioName || item.sessionId}
                </Button>
              ),
              sortingField: 'scenarioName',
            },
            {
              id: 'score',
              header: 'Score',
              cell: (item) => getScoreBadge(item.score, item.passed),
              sortingField: 'score',
            },
            {
              id: 'grade',
              header: 'Grade',
              cell: (item) => item.grade || '--',
              sortingField: 'grade',
            },
            {
              id: 'tokens',
              header: 'Tokens',
              cell: (item) => {
                if (!item.tokenUsage) return '--';
                let total = 0;
                for (const component of Object.values(item.tokenUsage)) {
                  total += (component.input_tokens || 0) + (component.output_tokens || 0);
                }
                return total > 0 ? total.toLocaleString() : '--';
              },
            },
            {
              id: 'timestamp',
              header: 'Date',
              cell: (item) =>
                item.timestamp
                  ? new Date(item.timestamp.endsWith('Z') || item.timestamp.includes('+') ? item.timestamp : item.timestamp + 'Z').toLocaleString()
                  : '--',
              sortingField: 'timestamp',
            },
          ]}
          empty={
            <Box textAlign="center" padding="xl" color="text-body-secondary">
              No sessions found for this trainee.
            </Box>
          }
          sortingDisabled={false}
          variant="full-page"
          stickyHeader
        />
      )}
    </Container>
  );
};
