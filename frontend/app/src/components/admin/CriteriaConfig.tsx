import { useEffect, useState, useCallback } from 'react';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Select from '@cloudscape-design/components/select';
import FormField from '@cloudscape-design/components/form-field';
import Checkbox from '@cloudscape-design/components/checkbox';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Spinner from '@cloudscape-design/components/spinner';
import Flashbar from '@cloudscape-design/components/flashbar';
import Badge from '@cloudscape-design/components/badge';
import type { FlashbarProps } from '@cloudscape-design/components/flashbar';

import {
  listAllCriteria,
  getCriteriaConfig,
  saveCriteriaConfig,
  listScenarios,
} from '../../services/admin';
import type { CriteriaRubric, DynamoScenario } from '../../types';

interface CriteriaConfigProps {
  onBack: () => void;
}

export const CriteriaConfig = ({ onBack }: CriteriaConfigProps) => {
  const [scenarios, setScenarios] = useState<DynamoScenario[]>([]);
  const [rubric, setRubric] = useState<CriteriaRubric | null>(null);
  const [selectedScenario, setSelectedScenario] = useState<{ label?: string; value?: string } | null>(null);
  const [disabledCriteria, setDisabledCriteria] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingConfig, setIsLoadingConfig] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [flashItems, setFlashItems] = useState<FlashbarProps.MessageDefinition[]>([]);

  // Load scenarios and rubric on mount
  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        const [scenarioList, rubricData] = await Promise.all([
          listScenarios(),
          listAllCriteria(),
        ]);
        setScenarios(scenarioList);
        setRubric(rubricData);
      } catch (err: any) {
        setFlashItems([{ type: 'error', content: `Failed to load data: ${err.message}`, dismissible: true, onDismiss: () => setFlashItems([]) }]);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, []);

  // Load criteria config when scenario changes
  const loadConfig = useCallback(async (scenarioId: string) => {
    setIsLoadingConfig(true);
    try {
      const config = await getCriteriaConfig(scenarioId);
      setDisabledCriteria(new Set(config.disabledCriteria || []));
    } catch (err: any) {
      setFlashItems([{ type: 'error', content: `Failed to load config: ${err.message}`, dismissible: true, onDismiss: () => setFlashItems([]) }]);
    } finally {
      setIsLoadingConfig(false);
    }
  }, []);

  const handleScenarioChange = (option: { label?: string; value?: string } | null) => {
    setSelectedScenario(option);
    if (option?.value) {
      loadConfig(option.value);
    } else {
      setDisabledCriteria(new Set());
    }
  };

  const handleToggle = (criterionId: string, enabled: boolean) => {
    setDisabledCriteria(prev => {
      const next = new Set(prev);
      if (enabled) {
        next.delete(criterionId);
      } else {
        next.add(criterionId);
      }
      return next;
    });
  };

  const handleSave = async () => {
    if (!selectedScenario?.value) return;
    setIsSaving(true);
    try {
      await saveCriteriaConfig(selectedScenario.value, Array.from(disabledCriteria));
      setFlashItems([{ type: 'success', content: 'Criteria configuration saved.', dismissible: true, onDismiss: () => setFlashItems([]) }]);
    } catch (err: any) {
      setFlashItems([{ type: 'error', content: `Failed to save: ${err.message}`, dismissible: true, onDismiss: () => setFlashItems([]) }]);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSelectAll = () => setDisabledCriteria(new Set());

  const handleDeselectAll = () => {
    if (!rubric) return;
    const all = new Set<string>();
    for (const section of Object.values(rubric)) {
      for (const cid of Object.keys(section.criteria)) {
        all.add(cid);
      }
    }
    setDisabledCriteria(all);
  };

  // Count totals
  let totalCriteria = 0;
  let enabledCount = 0;
  if (rubric) {
    for (const section of Object.values(rubric)) {
      for (const cid of Object.keys(section.criteria)) {
        totalCriteria++;
        if (!disabledCriteria.has(cid)) enabledCount++;
      }
    }
  }

  const scenarioOptions = scenarios.map(s => ({
    label: s.name,
    value: s.scenarioId,
  }));

  if (isLoading) {
    return (
      <Container header={<Header variant="h1">Criteria Configuration</Header>}>
        <Box textAlign="center" padding="xl">
          <SpaceBetween size="m" alignItems="center">
            <Spinner size="large" />
            <Box color="text-body-secondary">Loading...</Box>
          </SpaceBetween>
        </Box>
      </Container>
    );
  }

  return (
    <SpaceBetween size="l">
      <Flashbar items={flashItems} />

      <Container
        header={
          <Header
            variant="h1"
            actions={<Button onClick={onBack} iconName="arrow-left">Back</Button>}
          >
            Criteria Configuration
          </Header>
        }
      >
        <SpaceBetween size="l">
          <FormField
            label="Select Scenario"
            description="Choose a scenario to configure which evaluation criteria apply."
          >
            <Select
              selectedOption={selectedScenario}
              onChange={({ detail }) => handleScenarioChange(detail.selectedOption)}
              options={scenarioOptions}
              placeholder="Select a scenario"
            />
          </FormField>

          {selectedScenario?.value && !isLoadingConfig && rubric && (
            <>
              <Box>
                <SpaceBetween size="xs" direction="horizontal">
                  <Badge color="green">{enabledCount} enabled</Badge>
                  <Badge color="grey">{totalCriteria - enabledCount} disabled</Badge>
                  <Button variant="link" onClick={handleSelectAll}>Select All</Button>
                  <Button variant="link" onClick={handleDeselectAll}>Deselect All</Button>
                </SpaceBetween>
              </Box>

              {Object.entries(rubric).map(([sectionId, section]) => (
                <ExpandableSection
                  key={sectionId}
                  headerText={`Section ${sectionId}: ${section.name}`}
                  defaultExpanded
                >
                  <SpaceBetween size="s">
                    <Box color="text-body-secondary" fontSize="body-s">{section.description}</Box>
                    {Object.entries(section.criteria).map(([criterionId, criterion]) => (
                      <Box key={criterionId} padding={{ left: 's' }}>
                        <Checkbox
                          checked={!disabledCriteria.has(criterionId)}
                          onChange={({ detail }) => handleToggle(criterionId, detail.checked)}
                        >
                          <SpaceBetween size="xs" direction="horizontal">
                            <Box fontWeight="bold">{criterionId}</Box>
                            <Badge color={criterion.criticality === 'Critical' ? 'red' : 'blue'}>
                              {criterion.criticality}
                            </Badge>
                            <Box>{criterion.description}</Box>
                            <Box color="text-body-secondary">({criterion.maxPoints} pts)</Box>
                          </SpaceBetween>
                        </Checkbox>
                      </Box>
                    ))}
                  </SpaceBetween>
                </ExpandableSection>
              ))}

              <Box textAlign="right">
                <Button
                  variant="primary"
                  onClick={handleSave}
                  loading={isSaving}
                >
                  Save Configuration
                </Button>
              </Box>
            </>
          )}

          {isLoadingConfig && (
            <Box textAlign="center" padding="l">
              <Spinner /> Loading criteria configuration...
            </Box>
          )}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
};
