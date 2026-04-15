import { useEffect, useState } from 'react';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Button from '@cloudscape-design/components/button';
import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Select from '@cloudscape-design/components/select';
import RadioGroup from '@cloudscape-design/components/radio-group';
import FormField from '@cloudscape-design/components/form-field';
import { getScenarios, type Scenario } from '../services/scenarios';
import {
  getGroupedVoiceOptions,
  autoSelectVoice,
  isEnglishOnlyVoice,
  getVoiceNativeLanguageName,
} from '../constants/voices';

interface ScenarioSelectionProps {
  onScenarioSelect: (
    scenario: Scenario,
    voiceId: string,
    customerMood: string,
    languageMode: string,
    characterVoices?: Record<string, string>,
  ) => void;
}

export const ScenarioSelection = ({ onScenarioSelect }: ScenarioSelectionProps) => {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<{
    label?: string;
    value?: string;
  }>({
    label: 'Matthew (US English, Masculine)',
    value: 'matthew'
  });
  const [selectedScenario, setSelectedScenario] = useState<{
    label?: string;
    value?: string;
  } | null>(null);
  const [selectedMood, setSelectedMood] = useState<{
    label?: string;
    value?: string;
  } | null>({ label: 'Neutral', value: 'neutral' });
  const [languageMode, setLanguageMode] = useState<string>('english');

  // Per-character voice selections for duo scenarios
  const [characterVoices, setCharacterVoices] = useState<
    Record<string, { label?: string; value?: string }>
  >({});

  const moodOptions = [
    { label: 'Frustrated', value: 'frustrated' },
    { label: 'Concerned', value: 'concerned' },
    { label: 'Confused', value: 'confused' },
    { label: 'Neutral', value: 'neutral' },
    { label: 'Angry', value: 'angry' },
    { label: 'Anxious', value: 'anxious' }
  ];

  useEffect(() => {
    loadScenarios();
  }, []);

  const loadScenarios = async () => {
    try {
      setLoading(true);
      const data = await getScenarios();
      setScenarios(data);
      setError(null);
    } catch (err) {
      console.error('Error loading scenarios:', err);
      setError('Failed to load scenarios.');
    } finally {
      setLoading(false);
    }
  };

  const currentScenario = scenarios.find(s => s.id === selectedScenario?.value);
  const isDuo = currentScenario?.characters && currentScenario.characters.length > 1;

  const handleStartConversation = () => {
    if (!selectedScenario || !selectedMood) {
      return;
    }

    const scenario = scenarios.find(s => s.id === selectedScenario.value);
    if (!scenario) return;

    if (isDuo) {
      // Build character_voices map from per-character selections
      const voices: Record<string, string> = {};
      for (const char of scenario.characters || []) {
        voices[char.id] = characterVoices[char.id]?.value || char.voice;
      }
      // Use the primary character's voice as the top-level voiceId
      const primary = scenario.characters?.find(c => c.is_primary) || scenario.characters?.[0];
      onScenarioSelect(
        scenario,
        voices[primary?.id || ''] || 'matthew',
        selectedMood.value || 'neutral',
        languageMode,
        voices,
      );
    } else {
      onScenarioSelect(
        scenario,
        selectedVoice.value || 'matthew',
        selectedMood.value || 'neutral',
        languageMode,
      );
    }
  };

  const scenarioOptions = scenarios.map(s => ({
    label: s.name,
    value: s.id,
  }));

  const isStartEnabled = isDuo
    ? selectedScenario && selectedMood && !loading
    : selectedScenario && selectedMood && selectedVoice && !loading;

  const voiceNativeLang = getVoiceNativeLanguageName(selectedVoice?.value || 'matthew');
  const isVoiceEnglishOnly = isEnglishOnlyVoice(selectedVoice?.value || 'matthew');

  return (
    <Container
      header={
        <Header variant="h1">
          Configure Training Session
        </Header>
      }
    >
      <SpaceBetween size="l">
        {error ? (
          <Box color="text-status-error" padding="l">
            {error}
          </Box>
        ) : (
          <>
            <FormField
              label="Training Scenario"
              description="Choose the call center scenario to practice"
            >
              <Select
                selectedOption={selectedScenario}
                onChange={({ detail }) => {
                  setSelectedScenario(detail.selectedOption);
                  const scenario = scenarios.find(s => s.id === detail.selectedOption.value);
                  if (scenario?.characters && scenario.characters.length > 1) {
                    // Duo scenario — auto-select per-character voices
                    const voices: Record<string, { label?: string; value?: string }> = {};
                    for (const char of scenario.characters) {
                      const bestVoice = autoSelectVoice('en', char.gender);
                      voices[char.id] = { label: bestVoice.label, value: bestVoice.id };
                    }
                    setCharacterVoices(voices);
                    setLanguageMode('english');
                  } else if (scenario) {
                    // Single scenario — auto-select single voice
                    const bestVoice = autoSelectVoice('en', scenario.caller_gender);
                    setSelectedVoice({ label: bestVoice.label, value: bestVoice.id });
                    setCharacterVoices({});
                    setLanguageMode('english');
                  }
                }}
                options={scenarioOptions}
                placeholder="Select a scenario"
                loadingText="Loading scenarios..."
                statusType={loading ? 'loading' : 'finished'}
                disabled={loading}
              />
            </FormField>

            <FormField
              label="Customer Mood"
              description="Select the emotional state of the customer"
            >
              <Select
                selectedOption={selectedMood}
                onChange={({ detail }) => setSelectedMood(detail.selectedOption)}
                options={moodOptions}
                placeholder="Select a mood"
                disabled={loading}
              />
            </FormField>

            {isDuo ? (
              /* Per-character voice dropdowns for duo scenarios */
              <>
                {currentScenario?.characters?.map((char) => (
                  <FormField
                    key={char.id}
                    label={`${char.name} Voice`}
                    description={`Choose the voice for ${char.name}${char.is_primary ? ' (primary caller)' : ''}`}
                  >
                    <Select
                      selectedOption={characterVoices[char.id] || null}
                      onChange={({ detail }) => {
                        setCharacterVoices(prev => ({
                          ...prev,
                          [char.id]: detail.selectedOption,
                        }));
                      }}
                      options={getGroupedVoiceOptions()}
                      placeholder="Choose a voice"
                      disabled={loading}
                    />
                  </FormField>
                ))}
              </>
            ) : (
              /* Single voice dropdown for regular scenarios */
              <FormField
                label="AI Customer Voice"
                description="Choose the voice for the AI customer"
              >
                <Select
                  selectedOption={selectedVoice}
                  onChange={({ detail }) => {
                    setSelectedVoice(detail.selectedOption);
                    if (isEnglishOnlyVoice(detail.selectedOption.value || '')) {
                      setLanguageMode('english');
                    }
                  }}
                  options={getGroupedVoiceOptions()}
                  placeholder="Choose a voice"
                  disabled={loading}
                />
              </FormField>
            )}

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
                    disabled: isVoiceEnglishOnly || isDuo,
                  },
                ]}
              />
            </FormField>

            <Box textAlign="center" padding={{ top: 'l' }}>
              <Button
                variant="primary"
                onClick={handleStartConversation}
                disabled={!isStartEnabled}
                iconName="call"
              >
                Start Conversation
              </Button>
            </Box>
          </>
        )}
      </SpaceBetween>
    </Container>
  );
};
