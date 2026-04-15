import { useState, useEffect, useCallback } from 'react';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Table from '@cloudscape-design/components/table';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Badge from '@cloudscape-design/components/badge';
import { apiRequest } from '../services/api';

interface CallRecord {
  session_id: string;
  contact_id: string;
  scenario_id: string;
  scenario_name: string;
  start_time: string;
  end_time: string;
  status: string;
  score: number | null;
  grade: string | null;
  passed: boolean | null;
  source: string;
}

interface CallHistoryProps {
  onSelectSession: (sessionId: string) => void;
}

export const CallHistory = ({ onSelectSession }: CallHistoryProps) => {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const loadCalls = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<{ calls: CallRecord[] }>('/calls');
      const sorted = (data.calls || []).sort(
        (a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
      );
      setCalls(sorted);
    } catch (err) {
      console.error('Error loading call history:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCalls();
  }, [loadCalls]);

  // Auto-refresh if any session is still scoring
  useEffect(() => {
    const hasScoring = calls.some((c) => c.status === 'scoring');
    if (!hasScoring) return;
    const interval = setInterval(loadCalls, 10000);
    return () => clearInterval(interval);
  }, [calls, loadCalls]);

  const getStatusIndicator = (status: string) => {
    switch (status) {
      case 'initiated':
        return <StatusIndicator type="pending">Initiated</StatusIndicator>;
      case 'in_progress':
        return <StatusIndicator type="in-progress">In Progress</StatusIndicator>;
      case 'completed':
        return <StatusIndicator type="info">Completed</StatusIndicator>;
      case 'scoring':
        return <StatusIndicator type="loading">Scoring...</StatusIndicator>;
      default:
        return <StatusIndicator type="info">{status || '-'}</StatusIndicator>;
    }
  };

  const getGradeBadge = (item: CallRecord) => {
    if (!item.grade) return '-';
    const color = item.passed ? 'green' : 'red';
    return <Badge color={color}>{item.grade} ({item.score?.toFixed(0)}%)</Badge>;
  };

  return (
    <Container
      header={
        <Header
          variant="h2"
          actions={
            <Button onClick={loadCalls} loading={loading} iconName="refresh">
              Refresh
            </Button>
          }
        >
          Training Call History
        </Header>
      }
    >
      <Table
        items={calls}
        loading={loading}
        loadingText="Loading call history..."
        onRowClick={({ detail }) => {
          if (detail.item.session_id) {
            onSelectSession(detail.item.session_id);
          }
        }}
        columnDefinitions={[
          {
            id: 'scenario_name',
            header: 'Scenario',
            cell: (item) => item.scenario_name || item.scenario_id,
            sortingField: 'scenario_name',
          },
          {
            id: 'contact_id',
            header: 'Contact ID',
            cell: (item) => item.contact_id ? item.contact_id.substring(0, 8) + '...' : '-',
          },
          {
            id: 'start_time',
            header: 'Start Time',
            cell: (item) => item.start_time ? new Date(item.start_time).toLocaleString() : '-',
            sortingField: 'start_time',
          },
          {
            id: 'status',
            header: 'Status',
            cell: (item) => getStatusIndicator(item.status),
          },
          {
            id: 'score',
            header: 'Score',
            cell: (item) => getGradeBadge(item),
          },
        ]}
        empty={
          <Box textAlign="center" padding="l">
            <Box variant="p" color="text-body-secondary">
              No training calls found. Start a training session to see history here.
            </Box>
          </Box>
        }
        sortingColumn={{ sortingField: 'start_time' }}
        sortingDescending
        variant="embedded"
      />
    </Container>
  );
};
