import { useEffect, useState } from 'react';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import { config } from '../config';
import type { HistoryItem } from '../types';
import { getGradeColor } from '../utils/scoringUtils';

interface TrainingHistoryProps {
  onBack: () => void;
}

export const TrainingHistory = ({ onBack }: TrainingHistoryProps) => {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadHistory();
  }, []);

  const loadHistory = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${config.backendUrl}/api/evaluations`);
      const data = await response.json();

      if (data.evaluations && data.evaluations.length > 0) {
        setHistory(data.evaluations);
        setError(null);
      } else {
        setHistory([]);
        setError('No training history available');
      }
    } catch (err) {
      console.error('Error loading history:', err);
      setError('Failed to load training history');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container
      header={
        <Header
          variant="h1"
          actions={
            <Button onClick={onBack}>
              Back
            </Button>
          }
        >
          Training History
        </Header>
      }
    >
      {error ? (
        <Box color="text-status-error" padding="l">
          {error}
        </Box>
      ) : (
        <Cards
          cardDefinition={{
            header: (item) => item.scenario_name || 'Training Session',
            sections: [
              {
                id: 'timestamp',
                header: 'Date',
                content: (item) => new Date(item.timestamp).toLocaleString(),
              },
              {
                id: 'score',
                header: 'Score',
                content: (item) => (
                  <Box variant="strong" color={getGradeColor(item.overall_score)}>
                    {item.overall_score || 'N/A'}
                  </Box>
                ),
              },
            ],
          }}
          cardsPerRow={[
            { cards: 1 },
            { minWidth: 500, cards: 2 },
            { minWidth: 900, cards: 3 },
          ]}
          items={history}
          loading={loading}
          loadingText="Loading history..."
          empty={
            <Box textAlign="center" color="inherit">
              <SpaceBetween size="xxs">
                <div>
                  <b>No history</b>
                </div>
                <Box color="text-body-secondary">
                  No training history available.
                </Box>
              </SpaceBetween>
            </Box>
          }
        />
      )}
    </Container>
  );
};
