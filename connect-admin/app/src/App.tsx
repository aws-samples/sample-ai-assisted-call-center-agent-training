import { useState } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import AppLayout from '@cloudscape-design/components/app-layout';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import { ScenarioSelector } from './components/ScenarioSelector';
import { CallHistory } from './components/CallHistory';
import { SessionDetail } from './components/SessionDetail';

type View = 'initiate' | 'history' | 'detail';

function App() {
  const [currentView, setCurrentView] = useState<View>('initiate');
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');

  const handleSelectSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setCurrentView('detail');
  };

  const handleBackToHistory = () => {
    setCurrentView('history');
    setSelectedSessionId('');
  };

  const getHeaderText = () => {
    switch (currentView) {
      case 'initiate':
        return 'Start Training Session';
      case 'history':
        return 'Training Call History';
      case 'detail':
        return 'Session Details';
    }
  };

  const getHeaderDescription = () => {
    switch (currentView) {
      case 'initiate':
        return 'Select a scenario and start a training call via Amazon Connect';
      case 'history':
        return 'View past training sessions and their scores';
      case 'detail':
        return 'View scorecard, transcript, and analytics for this session';
    }
  };

  return (
    <Authenticator>
      {({ signOut, user }) => (
        <>
          <TopNavigation
            identity={{
              href: '#',
              title: 'Call Center Training - Admin',
            }}
            utilities={[
              {
                type: 'button',
                text: 'Start Training',
                onClick: () => setCurrentView('initiate'),
              },
              {
                type: 'button',
                text: 'Call History',
                onClick: () => setCurrentView('history'),
              },
              {
                type: 'menu-dropdown',
                text: user?.signInDetails?.loginId || 'Admin',
                items: [
                  { id: 'signout', text: 'Sign Out' },
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
              <ContentLayout
                header={
                  <Header variant="h1" description={getHeaderDescription()}>
                    {getHeaderText()}
                  </Header>
                }
              >
                {currentView === 'initiate' && <ScenarioSelector />}
                {currentView === 'history' && (
                  <CallHistory onSelectSession={handleSelectSession} />
                )}
                {currentView === 'detail' && selectedSessionId && (
                  <SessionDetail
                    sessionId={selectedSessionId}
                    onBack={handleBackToHistory}
                  />
                )}
              </ContentLayout>
            }
          />
        </>
      )}
    </Authenticator>
  );
}

export default App;
