import { useEffect, useState } from 'react';
import Table from '@cloudscape-design/components/table';
import Header from '@cloudscape-design/components/header';
import Container from '@cloudscape-design/components/container';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Spinner from '@cloudscape-design/components/spinner';
import type { TraineeInfo } from '../../types';
import { listTrainees } from '../../services/admin';
import { getScoreBadge } from '../../utils/scoringUtils';

interface AdminDashboardProps {
  onSelectTrainee: (trainee: TraineeInfo) => void;
}

export const AdminDashboard = ({ onSelectTrainee }: AdminDashboardProps) => {
  const [trainees, setTrainees] = useState<TraineeInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTrainees();
  }, []);

  const loadTrainees = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await listTrainees();
      setTrainees(data);
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
            <Button iconName="refresh" onClick={loadTrainees} loading={isLoading}>
              Refresh
            </Button>
          }
          counter={`(${trainees.length})`}
        >
          Trainee Dashboard
        </Header>
      }
    >
      {error && (
        <Box color="text-status-error" margin={{ bottom: 'm' }}>
          Error loading trainees: {error}
        </Box>
      )}

      {isLoading ? (
        <Box textAlign="center" padding="xl">
          <SpaceBetween size="m" alignItems="center">
            <Spinner size="large" />
            <Box color="text-body-secondary">Loading trainees...</Box>
          </SpaceBetween>
        </Box>
      ) : (
        <Table
          items={trainees}
          columnDefinitions={[
            {
              id: 'userName',
              header: 'Trainee Name',
              cell: (item) => (
                <Button variant="link" onClick={() => onSelectTrainee(item)}>
                  {item.userName || item.userId}
                </Button>
              ),
              sortingField: 'userName',
            },
            {
              id: 'sessionCount',
              header: 'Sessions',
              cell: (item) => item.sessionCount,
              sortingField: 'sessionCount',
            },
            {
              id: 'latestScore',
              header: 'Latest Score',
              cell: (item) => getScoreBadge(item.latestScore),
              sortingField: 'latestScore',
            },
            {
              id: 'totalTokens',
              header: 'Total Tokens',
              cell: (item) => {
                const total = (item.totalInputTokens || 0) + (item.totalOutputTokens || 0);
                return total > 0 ? total.toLocaleString() : '--';
              },
              sortingField: 'totalInputTokens',
            },
            {
              id: 'latestDate',
              header: 'Last Active',
              cell: (item) =>
                item.latestDate
                  ? new Date(item.latestDate.endsWith('Z') || item.latestDate.includes('+') ? item.latestDate : item.latestDate + 'Z').toLocaleDateString()
                  : '--',
              sortingField: 'latestDate',
            },
          ]}
          empty={
            <Box textAlign="center" padding="xl" color="text-body-secondary">
              No trainees found. Training sessions with user tracking will appear here.
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
