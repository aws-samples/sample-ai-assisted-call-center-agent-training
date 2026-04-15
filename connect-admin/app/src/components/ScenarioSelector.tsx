import { useState, useEffect } from 'react';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Button from '@cloudscape-design/components/button';
import Select from '@cloudscape-design/components/select';
import RadioGroup from '@cloudscape-design/components/radio-group';
import FormField from '@cloudscape-design/components/form-field';
import Alert from '@cloudscape-design/components/alert';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { apiRequest } from '../services/api';
import {
  getGroupedVoiceOptions,
  autoSelectVoice,
  isEnglishOnlyVoice,
  getVoiceNativeLanguageName,
  VOICE_LIST,
} from '../constants/voices';

interface Scenario {
  id: string;
  name: string;
  context: string;
  key_challenges: string[];
  caller_gender?: string;
}

interface CallResult {
  contact_id: string;
  session_id: string;
  scenario: { id: string; name: string };
}

export const ScenarioSelector = () => {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<{ label: string; value: string }>({
    label: 'Matthew (US English, Masculine)',
    value: 'matthew',
  });
  const [selectedMood, setSelectedMood] = useState<{ label: string; value: string }>({
    label: 'Neutral',
    value: 'neutral',
  });
  const [languageMode, setLanguageMode] = useState('english');
  const [isStarting, setIsStarting] = useState(false);
  const [callResult, setCallResult] = useState<CallResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadScenarios();
  }, []);

  const loadScenarios = async () => {
    try {
      setLoading(true);
      const data = await apiRequest<{ scenarios: Scenario[] }>('/scenarios');
      setScenarios(data.scenarios || []);
    } catch (err) {
      console.error('Error loading scenarios:', err);
      setError('Failed to load scenarios from API');
    } finally {
      setLoading(false);
    }
  };

  const handleStartCall = async () => {
    if (!selectedScenario) {
      setError('Please select a training scenario.');
      return;
    }

    setIsStarting(true);
    setError(null);
    setCallResult(null);

    try {
      // Get locale from selected voice
      const voice = VOICE_LIST.find(v => v.id === selectedVoice.value);
      const languageCode = voice?.locale || 'en-US';

      const data = await apiRequest<CallResult>('/start-call', {
        method: 'POST',
        body: {
          scenario_id: selectedScenario.id,
          voice_id: selectedVoice.value,
          language_code: languageCode,
          customer_mood: selectedMood.value,
          language_mode: languageMode,
        },
      });
      setCallResult(data);
    } catch (err: any) {
      setError(err.message || 'Error initiating call');
    } finally {
      setIsStarting(false);
    }
  };

  const voiceNativeLang = getVoiceNativeLanguageName(selectedVoice.value);
  const isVoiceEnglishOnly = isEnglishOnlyVoice(selectedVoice.value);

  return (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2">Call Settings</Header>}>
        <SpaceBetween size="l">
          <FormField
            label="Training Scenario"
            description="Choose the call center scenario to practice"
          >
            <Select
              selectedOption={
                selectedScenario
                  ? { label: selectedScenario.name, value: selectedScenario.id }
                  : null
              }
              onChange={({ detail }) => {
                const scenario = scenarios.find((s) => s.id === detail.selectedOption.value) || null;
                setSelectedScenario(scenario);
                if (scenario) {
                  setSelectedVoice(autoSelectVoice(scenario.caller_gender));
                  setLanguageMode('english');
                }
                setCallResult(null);
                setError(null);
              }}
              options={scenarios.map((s) => ({ label: s.name, value: s.id }))}
              placeholder="Select a scenario"
              loadingText="Loading scenarios..."
              statusType={loading ? 'loading' : 'finished'}
              empty="No scenarios available"
            />
          </FormField>

          <FormField
            label="AI Customer Voice"
            description="Choose the voice for the AI customer"
          >
            <Select
              selectedOption={selectedVoice}
              onChange={({ detail }) => {
                setSelectedVoice(detail.selectedOption as typeof selectedVoice);
                if (isEnglishOnlyVoice(detail.selectedOption.value || '')) {
                  setLanguageMode('english');
                }
              }}
              options={getGroupedVoiceOptions()}
              placeholder="Choose a voice"
            />
          </FormField>

          <FormField
            label="Customer Mood"
            description="Set the emotional tone of the AI customer"
          >
            <Select
              selectedOption={selectedMood}
              onChange={({ detail }) =>
                setSelectedMood(detail.selectedOption as typeof selectedMood)
              }
              options={[
                { label: 'Neutral', value: 'neutral' },
                { label: 'Frustrated', value: 'frustrated' },
                { label: 'Concerned', value: 'concerned' },
                { label: 'Confused', value: 'confused' },
                { label: 'Angry', value: 'angry' },
                { label: 'Anxious', value: 'anxious' },
              ]}
            />
          </FormField>

          <FormField
            label="Language Mode"
            description="Choose whether the AI customer speaks English or their native language"
          >
            <RadioGroup
              value={languageMode}
              onChange={({ detail }) => setLanguageMode(detail.value)}
              items={[
                { value: 'english', label: 'English' },
                {
                  value: 'native',
                  label: `Native (${voiceNativeLang})`,
                  disabled: isVoiceEnglishOnly,
                },
              ]}
            />
          </FormField>

          <Button
            variant="primary"
            onClick={handleStartCall}
            loading={isStarting}
            disabled={!selectedScenario}
            iconName="call"
          >
            Start Training Call
          </Button>

          {error && (
            <Alert type="error" header="Error">
              {error}
            </Alert>
          )}

          {callResult && (
            <Alert type="success" header="Training Call Initiated">
              <SpaceBetween size="s">
                <StatusIndicator type="success">Call started</StatusIndicator>
                <Box variant="p"><strong>Scenario:</strong> {callResult.scenario?.name}</Box>
                <Box variant="p"><strong>Contact ID:</strong> {callResult.contact_id}</Box>
                <Box variant="p"><strong>Session ID:</strong> {callResult.session_id}</Box>
                <Box variant="p">The agent should receive the call in their CCP shortly.</Box>
              </SpaceBetween>
            </Alert>
          )}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
};
