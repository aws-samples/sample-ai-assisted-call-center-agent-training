import { useEffect, useState } from 'react';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import Table from '@cloudscape-design/components/table';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Modal from '@cloudscape-design/components/modal';
import FormField from '@cloudscape-design/components/form-field';
import Input from '@cloudscape-design/components/input';
import Textarea from '@cloudscape-design/components/textarea';
import Select from '@cloudscape-design/components/select';
import Spinner from '@cloudscape-design/components/spinner';
import Flashbar from '@cloudscape-design/components/flashbar';
import type { FlashbarProps } from '@cloudscape-design/components/flashbar';

import Toggle from '@cloudscape-design/components/toggle';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import ColumnLayout from '@cloudscape-design/components/column-layout';

import {
  listScenarios,
  getScenario,
  createScenario,
  updateScenario,
  deleteScenario,
  generateScenarioFromTranscript,
} from '../../services/admin';
import type { DynamoScenario, DynamoScenarioCharacter } from '../../types';

interface ScenarioManagerProps {
  onBack: () => void;
}

const EMPTY_SCENARIO: DynamoScenario = {
  scenarioId: '',
  name: '',
  context: '',
  key_challenges: [],
  success_criteria: [],
  difficulty: 'intermediate',
  initial_message: '',
  original_call_logs: '',
  caller_gender: '',
};

const DIFFICULTY_OPTIONS = [
  { label: 'Beginner', value: 'beginner' },
  { label: 'Intermediate', value: 'intermediate' },
  { label: 'Advanced', value: 'advanced' },
];

const GENDER_OPTIONS = [
  { label: 'Male', value: 'male' },
  { label: 'Female', value: 'female' },
];

const DEFAULT_VOICE: Record<string, string> = { male: 'matthew', female: 'tiffany' };

function makeEmptyCharacter(index: number, isPrimary: boolean): DynamoScenarioCharacter {
  return {
    id: `customer_${index + 1}`,
    name: '',
    voice: isPrimary ? 'matthew' : 'tiffany',
    gender: isPrimary ? 'male' : 'female',
    is_primary: isPrimary,
    context: '',
    initial_message: '',
    handoff_trigger: '',
    handoff_to: '',
  };
}

/** Re-index character IDs and auto-wire handoff_to references */
function reindexCharacters(chars: DynamoScenarioCharacter[]): DynamoScenarioCharacter[] {
  const reindexed = chars.map((c, i) => ({ ...c, id: `customer_${i + 1}` }));
  // For each character, handoff_to points to the next character (wrap around)
  return reindexed.map((c, i) => ({
    ...c,
    handoff_to: reindexed.length > 1
      ? reindexed[(i + 1) % reindexed.length].id
      : '',
  }));
}


export const ScenarioManager = ({ onBack }: ScenarioManagerProps) => {
  const [scenarios, setScenarios] = useState<DynamoScenario[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [flashItems, setFlashItems] = useState<FlashbarProps.MessageDefinition[]>([]);

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editingScenario, setEditingScenario] = useState<DynamoScenario>(EMPTY_SCENARIO);
  const [isNew, setIsNew] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Delete confirmation
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingId, setDeletingId] = useState('');

  // Import from transcript state
  const [showImportModal, setShowImportModal] = useState(false);
  const [transcriptText, setTranscriptText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);

  // Multi-character state
  const [isMultiCharacter, setIsMultiCharacter] = useState(false);

  // Textarea helpers for list fields
  const [challengesText, setChallengesText] = useState('');
  const [criteriaText, setCriteriaText] = useState('');

  const loadScenarios = async () => {
    setIsLoading(true);
    try {
      const data = await listScenarios();
      setScenarios(data);
    } catch (err: any) {
      setFlashItems([{ type: 'error', content: `Failed to load scenarios: ${err.message}`, dismissible: true, onDismiss: () => setFlashItems([]) }]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { loadScenarios(); }, []);

  const handleCreate = () => {
    setEditingScenario(EMPTY_SCENARIO);
    setChallengesText('');
    setCriteriaText('');
    setIsMultiCharacter(false);
    setIsNew(true);
    setShowModal(true);
  };

  const handleEdit = async (scenarioId: string) => {
    try {
      const full = await getScenario(scenarioId);
      if (full) {
        setEditingScenario(full);
        setChallengesText((full.key_challenges || []).join('\n'));
        setCriteriaText((full.success_criteria || []).join('\n'));
        setIsMultiCharacter((full.characters?.length ?? 0) > 1);
        setIsNew(false);
        setShowModal(true);
      }
    } catch (err: any) {
      setFlashItems([{ type: 'error', content: `Failed to load scenario: ${err.message}`, dismissible: true, onDismiss: () => setFlashItems([]) }]);
    }
  };

  const handleSave = async () => {
    if (!editingScenario.scenarioId || !editingScenario.name) {
      setFlashItems([{ type: 'warning', content: 'Scenario ID and Name are required.', dismissible: true, onDismiss: () => setFlashItems([]) }]);
      return;
    }

    setIsSaving(true);
    try {
      const toSave: DynamoScenario = {
        ...editingScenario,
        key_challenges: challengesText.split('\n').map(s => s.trim()).filter(Boolean),
        success_criteria: criteriaText.split('\n').map(s => s.trim()).filter(Boolean),
      };

      if (isMultiCharacter && toSave.characters && toSave.characters.length > 1) {
        // Multi-character: clear single-character fields
        toSave.context = toSave.context || '';
        toSave.initial_message = '';
        toSave.caller_gender = '';
      } else {
        // Single-character: strip characters
        delete toSave.characters;
      }

      if (isNew) {
        await createScenario(toSave);
      } else {
        await updateScenario(toSave);
      }

      setShowModal(false);
      setFlashItems([{ type: 'success', content: `Scenario ${isNew ? 'created' : 'updated'}.`, dismissible: true, onDismiss: () => setFlashItems([]) }]);
      await loadScenarios();
    } catch (err: any) {
      setFlashItems([{ type: 'error', content: `Failed to save: ${err.message}`, dismissible: true, onDismiss: () => setFlashItems([]) }]);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteConfirm = async () => {
    try {
      await deleteScenario(deletingId);
      setShowDeleteConfirm(false);
      setFlashItems([{ type: 'success', content: 'Scenario deleted.', dismissible: true, onDismiss: () => setFlashItems([]) }]);
      await loadScenarios();
    } catch (err: any) {
      setFlashItems([{ type: 'error', content: `Failed to delete: ${err.message}`, dismissible: true, onDismiss: () => setFlashItems([]) }]);
    }
  };

  const handleImportGenerate = async () => {
    if (!transcriptText.trim()) {
      setFlashItems([{ type: 'warning', content: 'Please paste a call transcript.', dismissible: true, onDismiss: () => setFlashItems([]) }]);
      return;
    }

    setIsGenerating(true);
    try {
      const generated = await generateScenarioFromTranscript(transcriptText);
      setShowImportModal(false);
      setTranscriptText('');

      // Populate the create/edit form with generated data
      setEditingScenario({
        scenarioId: generated.scenarioId || '',
        name: generated.name || '',
        context: generated.context || '',
        key_challenges: generated.key_challenges || [],
        success_criteria: generated.success_criteria || [],
        difficulty: generated.difficulty || 'intermediate',
        initial_message: generated.initial_message || '',
        original_call_logs: generated.original_call_logs || '',
        caller_gender: generated.caller_gender || '',
      });
      setChallengesText((generated.key_challenges || []).join('\n'));
      setCriteriaText((generated.success_criteria || []).join('\n'));
      setIsMultiCharacter(false);
      setIsNew(true);
      setShowModal(true);

      setFlashItems([{ type: 'info', content: 'Scenario generated from transcript. Review and edit before saving.', dismissible: true, onDismiss: () => setFlashItems([]) }]);
    } catch (err: any) {
      setFlashItems([{ type: 'error', content: `Failed to generate scenario: ${err.message}`, dismissible: true, onDismiss: () => setFlashItems([]) }]);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <SpaceBetween size="l">
      <Flashbar items={flashItems} />

      <Container
        header={
          <Header
            variant="h1"
            actions={
              <SpaceBetween size="xs" direction="horizontal">
                <Button onClick={onBack} iconName="arrow-left">Back</Button>
                <Button onClick={() => setShowImportModal(true)} iconName="upload">Import from Transcript</Button>
                <Button variant="primary" onClick={handleCreate} iconName="add-plus">Create Scenario</Button>
              </SpaceBetween>
            }
            counter={`(${scenarios.length})`}
          >
            Scenario Manager
          </Header>
        }
      >
        {isLoading ? (
          <Box textAlign="center" padding="xl">
            <SpaceBetween size="m" alignItems="center">
              <Spinner size="large" />
              <Box color="text-body-secondary">Loading scenarios...</Box>
            </SpaceBetween>
          </Box>
        ) : (
          <Table
            items={scenarios}
            columnDefinitions={[
              {
                id: 'scenarioId',
                header: 'Scenario ID',
                cell: (item) => (
                  <Button variant="link" onClick={() => handleEdit(item.scenarioId)}>
                    {item.scenarioId}
                  </Button>
                ),
                sortingField: 'scenarioId',
              },
              {
                id: 'name',
                header: 'Name',
                cell: (item) => item.name,
                sortingField: 'name',
              },
              {
                id: 'difficulty',
                header: 'Difficulty',
                cell: (item) => item.difficulty || '--',
                sortingField: 'difficulty',
              },
              {
                id: 'type',
                header: 'Type',
                cell: (item) => (item.characters?.length ?? 0) > 1
                  ? `Multi (${item.characters!.length})`
                  : 'Single',
              },
              {
                id: 'actions',
                header: 'Actions',
                cell: (item) => (
                  <SpaceBetween size="xs" direction="horizontal">
                    <Button iconName="edit" variant="icon" onClick={() => handleEdit(item.scenarioId)} />
                    <Button
                      iconName="remove"
                      variant="icon"
                      onClick={() => { setDeletingId(item.scenarioId); setShowDeleteConfirm(true); }}
                    />
                  </SpaceBetween>
                ),
              },
            ]}
            empty={
              <Box textAlign="center" padding="xl" color="text-body-secondary">
                No scenarios found. Click "Create Scenario" to add one, or run the seed script.
              </Box>
            }
            sortingDisabled={false}
            variant="full-page"
            stickyHeader
          />
        )}
      </Container>

      {/* Create/Edit Modal */}
      <Modal
        visible={showModal}
        onDismiss={() => setShowModal(false)}
        header={isNew ? 'Create Scenario' : 'Edit Scenario'}
        size="large"
        footer={
          <Box float="right">
            <SpaceBetween size="xs" direction="horizontal">
              <Button onClick={() => setShowModal(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleSave} loading={isSaving}>
                {isNew ? 'Create' : 'Save'}
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <FormField label="Scenario ID" description="Unique identifier (e.g., athene_loan_01). Cannot be changed after creation.">
            <Input
              value={editingScenario.scenarioId}
              onChange={({ detail }) => setEditingScenario(prev => ({ ...prev, scenarioId: detail.value }))}
              disabled={!isNew}
              placeholder="company_scenario_01"
            />
          </FormField>

          <FormField label="Name">
            <Input
              value={editingScenario.name}
              onChange={({ detail }) => setEditingScenario(prev => ({ ...prev, name: detail.value }))}
              placeholder="Scenario display name"
            />
          </FormField>

          <FormField label="Difficulty">
            <Select
              selectedOption={DIFFICULTY_OPTIONS.find(o => o.value === editingScenario.difficulty) || null}
              onChange={({ detail }) => setEditingScenario(prev => ({ ...prev, difficulty: detail.selectedOption.value }))}
              options={DIFFICULTY_OPTIONS}
            />
          </FormField>

          <Toggle
            checked={isMultiCharacter}
            onChange={({ detail }) => {
              setIsMultiCharacter(detail.checked);
              if (detail.checked && (!editingScenario.characters || editingScenario.characters.length < 2)) {
                setEditingScenario(prev => ({
                  ...prev,
                  characters: reindexCharacters([
                    makeEmptyCharacter(0, true),
                    makeEmptyCharacter(1, false),
                  ]),
                }));
              }
            }}
          >
            Multi-character scenario
          </Toggle>

          {!isMultiCharacter && (
            <>
              <FormField label="Caller Gender" description="Used to auto-select the AI voice in trainee UI.">
                <Select
                  selectedOption={GENDER_OPTIONS.find(o => o.value === editingScenario.caller_gender) || null}
                  onChange={({ detail }) => setEditingScenario(prev => ({ ...prev, caller_gender: detail.selectedOption.value }))}
                  options={GENDER_OPTIONS}
                  placeholder="Select gender"
                />
              </FormField>

              <FormField label="Context" description="Role-play instructions for the AI customer.">
                <Textarea
                  value={editingScenario.context || ''}
                  onChange={({ detail }) => setEditingScenario(prev => ({ ...prev, context: detail.value }))}
                  rows={6}
                  placeholder="Describe the customer's situation, what they need, their background..."
                />
              </FormField>

              <FormField label="Initial Message" description="What the customer says first when the call starts.">
                <Textarea
                  value={editingScenario.initial_message || ''}
                  onChange={({ detail }) => setEditingScenario(prev => ({ ...prev, initial_message: detail.value }))}
                  rows={2}
                />
              </FormField>
            </>
          )}

          {isMultiCharacter && (
            <SpaceBetween size="m">
              <FormField label="Shared Context" description="Optional high-level context shared across all characters.">
                <Textarea
                  value={editingScenario.context || ''}
                  onChange={({ detail }) => setEditingScenario(prev => ({ ...prev, context: detail.value }))}
                  rows={3}
                  placeholder="Brief scenario overview (optional)..."
                />
              </FormField>

              {(editingScenario.characters || []).map((char, idx) => (
                <ExpandableSection
                  key={char.id}
                  defaultExpanded
                  variant="container"
                  headerText={`${char.name || `Character ${idx + 1}`} (${char.id})${char.is_primary ? ' — Primary' : ''}`}
                  headerActions={
                    (editingScenario.characters?.length ?? 0) > 2 ? (
                      <Button
                        iconName="remove"
                        variant="icon"
                        onClick={() => {
                          setEditingScenario(prev => {
                            const updated = (prev.characters || []).filter((_, i) => i !== idx);
                            // Ensure at least one is primary
                            if (updated.length > 0 && !updated.some(c => c.is_primary)) {
                              updated[0].is_primary = true;
                            }
                            return { ...prev, characters: reindexCharacters(updated) };
                          });
                        }}
                      />
                    ) : undefined
                  }
                >
                  <SpaceBetween size="s">
                    <ColumnLayout columns={3}>
                      <FormField label="Name">
                        <Input
                          value={char.name}
                          onChange={({ detail }) => {
                            setEditingScenario(prev => {
                              const chars = [...(prev.characters || [])];
                              chars[idx] = { ...chars[idx], name: detail.value };
                              return { ...prev, characters: chars };
                            });
                          }}
                          placeholder="Character name"
                        />
                      </FormField>
                      <FormField label="Gender">
                        <Select
                          selectedOption={GENDER_OPTIONS.find(o => o.value === char.gender) || null}
                          onChange={({ detail }) => {
                            const gender = detail.selectedOption.value || 'male';
                            setEditingScenario(prev => {
                              const chars = [...(prev.characters || [])];
                              chars[idx] = {
                                ...chars[idx],
                                gender,
                                voice: DEFAULT_VOICE[gender] || chars[idx].voice,
                              };
                              return { ...prev, characters: chars };
                            });
                          }}
                          options={GENDER_OPTIONS}
                        />
                      </FormField>
                      <FormField label="Voice">
                        <Input
                          value={char.voice}
                          onChange={({ detail }) => {
                            setEditingScenario(prev => {
                              const chars = [...(prev.characters || [])];
                              chars[idx] = { ...chars[idx], voice: detail.value };
                              return { ...prev, characters: chars };
                            });
                          }}
                          placeholder="e.g. matthew, tiffany"
                        />
                      </FormField>
                    </ColumnLayout>

                    <Toggle
                      checked={char.is_primary}
                      onChange={({ detail }) => {
                        setEditingScenario(prev => {
                          const chars = (prev.characters || []).map((c, i) => ({
                            ...c,
                            is_primary: i === idx ? detail.checked : (detail.checked ? false : c.is_primary),
                          }));
                          return { ...prev, characters: chars };
                        });
                      }}
                    >
                      Primary character (speaks first)
                    </Toggle>

                    <FormField label="Context" description="Role-play instructions for this character.">
                      <Textarea
                        value={char.context}
                        onChange={({ detail }) => {
                          setEditingScenario(prev => {
                            const chars = [...(prev.characters || [])];
                            chars[idx] = { ...chars[idx], context: detail.value };
                            return { ...prev, characters: chars };
                          });
                        }}
                        rows={6}
                        placeholder="You are [name]. Describe who they are, their situation..."
                      />
                    </FormField>

                    {char.is_primary && (
                      <FormField label="Initial Message" description="What this character says first when the call starts.">
                        <Textarea
                          value={char.initial_message}
                          onChange={({ detail }) => {
                            setEditingScenario(prev => {
                              const chars = [...(prev.characters || [])];
                              chars[idx] = { ...chars[idx], initial_message: detail.value };
                              return { ...prev, characters: chars };
                            });
                          }}
                          rows={2}
                        />
                      </FormField>
                    )}

                    <FormField label="Handoff Trigger" description="When should the agent hand off to this character's partner?">
                      <Textarea
                        value={char.handoff_trigger}
                        onChange={({ detail }) => {
                          setEditingScenario(prev => {
                            const chars = [...(prev.characters || [])];
                            chars[idx] = { ...chars[idx], handoff_trigger: detail.value };
                            return { ...prev, characters: chars };
                          });
                        }}
                        rows={2}
                        placeholder="e.g. The agent asks to speak with the other person"
                      />
                    </FormField>

                    <FormField label="Handoff To">
                      <Input value={char.handoff_to} disabled />
                    </FormField>
                  </SpaceBetween>
                </ExpandableSection>
              ))}

              <Button
                iconName="add-plus"
                onClick={() => {
                  setEditingScenario(prev => {
                    const chars = [...(prev.characters || [])];
                    chars.push(makeEmptyCharacter(chars.length, false));
                    return { ...prev, characters: reindexCharacters(chars) };
                  });
                }}
              >
                Add Character
              </Button>
            </SpaceBetween>
          )}

          <FormField label="Key Challenges" description="One per line.">
            <Textarea
              value={challengesText}
              onChange={({ detail }) => setChallengesText(detail.value)}
              rows={4}
              placeholder="Challenge 1&#10;Challenge 2"
            />
          </FormField>

          <FormField label="Success Criteria" description="One per line.">
            <Textarea
              value={criteriaText}
              onChange={({ detail }) => setCriteriaText(detail.value)}
              rows={4}
              placeholder="Criterion 1&#10;Criterion 2"
            />
          </FormField>
        </SpaceBetween>
      </Modal>

      {/* Import from Transcript Modal */}
      <Modal
        visible={showImportModal}
        onDismiss={() => { if (!isGenerating) setShowImportModal(false); }}
        header="Import from Call Transcript"
        size="large"
        footer={
          <Box float="right">
            <SpaceBetween size="xs" direction="horizontal">
              <Button onClick={() => setShowImportModal(false)} disabled={isGenerating}>Cancel</Button>
              <Button variant="primary" onClick={handleImportGenerate} loading={isGenerating}>
                Generate Scenario
              </Button>
            </SpaceBetween>
          </Box>
        }
      >
        <SpaceBetween size="m">
          <Box color="text-body-secondary">
            Paste a call center transcript below. The AI will analyze it and generate a structured training scenario that you can review and edit before saving.
          </Box>
          <FormField label="Call Transcript">
            <Textarea
              value={transcriptText}
              onChange={({ detail }) => setTranscriptText(detail.value)}
              rows={16}
              placeholder="Paste the call transcript here..."
              disabled={isGenerating}
            />
          </FormField>
          {isGenerating && (
            <Box textAlign="center" padding="s">
              <SpaceBetween size="xs" alignItems="center">
                <Spinner />
                <Box color="text-body-secondary">Analyzing transcript and generating scenario...</Box>
              </SpaceBetween>
            </Box>
          )}
        </SpaceBetween>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        visible={showDeleteConfirm}
        onDismiss={() => setShowDeleteConfirm(false)}
        header="Delete Scenario"
        footer={
          <Box float="right">
            <SpaceBetween size="xs" direction="horizontal">
              <Button onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
              <Button variant="primary" onClick={handleDeleteConfirm}>Delete</Button>
            </SpaceBetween>
          </Box>
        }
      >
        Are you sure you want to delete scenario <strong>{deletingId}</strong>? This will also remove its criteria configuration. This action cannot be undone.
      </Modal>
    </SpaceBetween>
  );
};
