// Scenario service — loads scenarios from DynamoDB via trainee API (read-only).
// The trainee API only supports listScenarios and getScenario (no write access).
// Admin CRUD operations remain in services/admin.ts via the admin API.

import { apiRequest } from './api';
import type { Scenario } from '../types';

/**
 * Convert DynamoDB scenario (scenarioId key) to frontend Scenario (id key)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toScenario(dynamo: any): Scenario {
  return {
    id: dynamo.scenarioId || dynamo.id,
    name: dynamo.name || '',
    context: dynamo.context || '',
    key_challenges: dynamo.key_challenges || [],
    success_criteria: dynamo.success_criteria || [],
    difficulty: dynamo.difficulty,
    initial_message: dynamo.initial_message,
    original_call_logs: dynamo.original_call_logs,
    caller_gender: dynamo.caller_gender,
    characters: dynamo.characters,
  };
}

/**
 * Get all available scenarios
 */
export const getScenarios = async (): Promise<Scenario[]> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await apiRequest<{ scenarios: any[] }>('/scenarios');
    return (data.scenarios || []).map(toScenario);
  } catch (err) {
    console.error('Failed to load scenarios from DynamoDB:', err);
    return [];
  }
};

/**
 * Get a specific scenario by ID
 */
export const getScenario = async (id: string): Promise<Scenario | undefined> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await apiRequest<{ scenario: any }>(`/scenarios/${encodeURIComponent(id)}`);
    return data.scenario ? toScenario(data.scenario) : undefined;
  } catch (err) {
    console.error(`Failed to load scenario ${id} from DynamoDB:`, err); // nosemgrep: unsafe-formatstring
    return undefined;
  }
};

/**
 * Create a session record in DynamoDB when starting a training call.
 */
export const createSession = async (params: {
  sessionId: string;
  scenarioId: string;
  scenarioName: string;
  customerMood: string;
  difficulty: string;
}): Promise<void> => {
  await apiRequest('/sessions', {
    method: 'POST',
    body: params,
  });
};

export type { Scenario };
