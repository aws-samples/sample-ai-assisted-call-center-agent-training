import { useState } from 'react';
import AppLayout from '@cloudscape-design/components/app-layout';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import Spinner from '@cloudscape-design/components/spinner';
import Box from '@cloudscape-design/components/box';
import { ScenarioSelection } from './components/ScenarioSelection';
import { TrainingSession } from './components/TrainingSession';
import { ScoringResults } from './components/ScoringResults';
import { TrainingHistory } from './components/TrainingHistory';
import { AdminDashboard } from './components/admin/AdminDashboard';
import { TraineeSessionList } from './components/admin/TraineeSessionList';
import { SessionDetail } from './components/admin/SessionDetail';
import { ScenarioManager } from './components/admin/ScenarioManager';
import { CriteriaConfig } from './components/admin/CriteriaConfig';
import { useUserRole } from './hooks/useUserRole';
import type { Scenario, ViewType, ScoringData, TraineeInfo, TraineeSession } from './types';

interface AppProps {
  signOut?: () => void;
  user?: any;
}

function App({ signOut, user }: AppProps) {
  const { role, userId, userName, isLoading: isRoleLoading } = useUserRole();

  // Trainee state
  const [currentView, setCurrentView] = useState<ViewType>('scenario');
  const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(null);
  const [scoringData, setScoringData] = useState<ScoringData | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<string>('matthew');
  const [selectedMood, setSelectedMood] = useState<string>('neutral');
  const [selectedLanguageMode, setSelectedLanguageMode] = useState<string>('english');
  const [selectedCharacterVoices, setSelectedCharacterVoices] = useState<Record<string, string> | undefined>(undefined);

  // Admin state
  const [selectedTrainee, setSelectedTrainee] = useState<TraineeInfo | null>(null);
  const [selectedSession, setSelectedSession] = useState<TraineeSession | null>(null);

  // Set initial view based on role once loaded
  const effectiveView = isRoleLoading
    ? currentView
    : (role === 'admin' && currentView === 'scenario')
      ? 'admin-dashboard'
      : currentView;

  const handleScenarioSelect = (scenario: Scenario, voiceId: string, customerMood: string, languageMode: string, characterVoices?: Record<string, string>) => {
    setSelectedScenario(scenario);
    setSelectedVoice(voiceId);
    setSelectedMood(customerMood);
    setSelectedLanguageMode(languageMode);
    setSelectedCharacterVoices(characterVoices);
    setCurrentView('session');
  };

  const handleBackToScenarios = () => {
    setSelectedScenario(null);
    setScoringData(null);
    setCurrentView('scenario');
  };

  const handleScoringComplete = (scoring: ScoringData) => {
    setScoringData(scoring);
    setCurrentView('scoring');
  };

  const handleViewHistory = () => {
    setCurrentView('history');
  };

  // Admin navigation handlers
  const handleSelectTrainee = (trainee: TraineeInfo) => {
    setSelectedTrainee(trainee);
    setCurrentView('admin-trainee-sessions');
  };

  const handleSelectSession = (session: TraineeSession) => {
    setSelectedSession(session);
    setCurrentView('admin-session-detail');
  };

  const handleBackToDashboard = () => {
    setSelectedTrainee(null);
    setSelectedSession(null);
    setCurrentView('admin-dashboard');
  };

  const handleBackToTraineeSessions = () => {
    setSelectedSession(null);
    setCurrentView('admin-trainee-sessions');
  };

  return (
    <>
      <TopNavigation
        identity={{
          href: '#',
          title: 'Call Center Training Agent',
        }}
        utilities={[
          ...(role === 'admin' ? [
            {
              type: 'button' as const,
              text: 'Admin',
              iconName: 'settings' as const,
              onClick: () => handleBackToDashboard(),
            },
            {
              type: 'button' as const,
              text: 'Scenarios',
              onClick: () => setCurrentView('admin-scenarios'),
            },
            {
              type: 'button' as const,
              text: 'Criteria',
              onClick: () => setCurrentView('admin-criteria-config'),
            },
          ] : []),
          {
            type: 'menu-dropdown',
            text: user?.signInDetails?.loginId || userName || 'User',
            iconName: 'user-profile',
            items: [
              {
                id: 'signout',
                text: 'Sign Out',
              },
            ],
            onItemClick: ({ detail }) => {
              if (detail.id === 'signout' && signOut) {
                signOut();
              }
            },
          },
        ]}
      />
      <AppLayout
        navigationHide
        toolsHide
        content={
          <div style={{ padding: '20px' }}>
            {isRoleLoading ? (
              <Box textAlign="center" padding="xl">
                <Spinner size="large" />
              </Box>
            ) : (
              <>
                {/* Admin views */}
                {effectiveView === 'admin-dashboard' && (
                  <AdminDashboard onSelectTrainee={handleSelectTrainee} />
                )}

                {effectiveView === 'admin-trainee-sessions' && selectedTrainee && (
                  <TraineeSessionList
                    trainee={selectedTrainee}
                    onSelectSession={handleSelectSession}
                    onBack={handleBackToDashboard}
                  />
                )}

                {effectiveView === 'admin-session-detail' && selectedSession && (
                  <SessionDetail
                    session={selectedSession}
                    onBack={handleBackToTraineeSessions}
                  />
                )}

                {effectiveView === 'admin-scenarios' && (
                  <ScenarioManager onBack={handleBackToDashboard} />
                )}

                {effectiveView === 'admin-criteria-config' && (
                  <CriteriaConfig onBack={handleBackToDashboard} />
                )}

                {/* Trainee views */}
                {effectiveView === 'scenario' && (
                  <ScenarioSelection
                    onScenarioSelect={handleScenarioSelect}
                  />
                )}

                {effectiveView === 'session' && selectedScenario && (
                  <TrainingSession
                    scenario={selectedScenario}
                    voiceId={selectedVoice}
                    customerMood={selectedMood}
                    languageMode={selectedLanguageMode}
                    characterVoices={selectedCharacterVoices}
                    userId={userId}
                    userName={userName}
                    onBack={handleBackToScenarios}
                    onScoringComplete={handleScoringComplete}
                  />
                )}

                {effectiveView === 'scoring' && scoringData && (
                  <ScoringResults
                    scoring={scoringData}
                    onNewSession={handleBackToScenarios}
                    onViewHistory={handleViewHistory}
                  />
                )}

                {effectiveView === 'history' && (
                  <TrainingHistory
                    onBack={handleBackToScenarios}
                  />
                )}
              </>
            )}
          </div>
        }
      />
    </>
  );
}

export default App;
