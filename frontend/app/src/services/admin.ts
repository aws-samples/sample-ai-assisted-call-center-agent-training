/**
 * Admin service for calling admin API endpoints via HTTP API Gateway.
 * Lists trainees, sessions, scorecards, transcripts, and audio URLs.
 */

import { apiRequest } from './api';
import type { TraineeInfo, TraineeSession, CriteriaRubric, CriteriaConfig, DynamoScenario, SessionComment } from '../types';

export async function listTrainees(): Promise<TraineeInfo[]> {
  const data = await apiRequest<{ trainees: TraineeInfo[] }>('/admin/trainees');
  return data.trainees || [];
}

export async function listTraineeSessions(userId: string): Promise<TraineeSession[]> {
  const data = await apiRequest<{ sessions: TraineeSession[] }>(
    `/admin/trainees/${encodeURIComponent(userId)}/sessions`
  );
  return data.sessions || [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getSessionScorecard(userId: string, sessionId: string): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await apiRequest<{ scorecard: any }>(
    `/admin/trainees/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/scorecard`
  );
  return data.scorecard;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getSessionTranscript(userId: string, sessionId: string): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await apiRequest<{ transcript: any }>(
    `/admin/trainees/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/transcript`
  );
  return data.transcript;
}

export async function getSessionAudioUrl(userId: string, sessionId: string): Promise<string> {
  const data = await apiRequest<{ audioUrl: string }>(
    `/admin/trainees/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/audio-url`
  );
  return data.audioUrl;
}

export async function getSessionScreenRecordingUrl(userId: string, sessionId: string): Promise<string> {
  const data = await apiRequest<{ screenRecordingUrl: string }>(
    `/admin/trainees/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/screen-recording-url`
  );
  return data.screenRecordingUrl;
}

// ============================================================================
// Session Comments
// ============================================================================

export async function getSessionComment(userId: string, sessionId: string): Promise<SessionComment | null> {
  const data = await apiRequest<{ comment: SessionComment }>(
    `/admin/trainees/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/comment`
  );
  return data.comment && data.comment.text ? data.comment : null;
}

export async function saveSessionComment(userId: string, sessionId: string, text: string): Promise<SessionComment> {
  const data = await apiRequest<{ comment: SessionComment }>(
    `/admin/trainees/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}/comment`,
    { method: 'PUT', body: { text } }
  );
  return data.comment;
}

// ============================================================================
// Scenario CRUD
// ============================================================================

export async function listScenarios(): Promise<DynamoScenario[]> {
  const data = await apiRequest<{ scenarios: DynamoScenario[] }>('/admin/scenarios');
  return data.scenarios || [];
}

export async function getScenario(scenarioId: string): Promise<DynamoScenario | null> {
  const data = await apiRequest<{ scenario: DynamoScenario }>(
    `/admin/scenarios/${encodeURIComponent(scenarioId)}`
  );
  return data.scenario || null;
}

export async function createScenario(scenario: DynamoScenario): Promise<DynamoScenario> {
  const data = await apiRequest<{ scenario: DynamoScenario }>('/admin/scenarios', {
    method: 'POST',
    body: { scenario },
  });
  return data.scenario;
}

export async function updateScenario(scenario: DynamoScenario): Promise<DynamoScenario> {
  const data = await apiRequest<{ scenario: DynamoScenario }>(
    `/admin/scenarios/${encodeURIComponent(scenario.scenarioId)}`,
    { method: 'PUT', body: { scenario } }
  );
  return data.scenario;
}

export async function deleteScenario(scenarioId: string): Promise<void> {
  await apiRequest(`/admin/scenarios/${encodeURIComponent(scenarioId)}`, { method: 'DELETE' });
}

export async function generateScenarioFromTranscript(transcript: string): Promise<DynamoScenario> {
  const data = await apiRequest<{ scenario: DynamoScenario }>('/admin/scenarios/generate', {
    method: 'POST',
    body: { transcript },
  });
  return data.scenario;
}

// ============================================================================
// Criteria Configuration
// ============================================================================

export async function listAllCriteria(): Promise<CriteriaRubric> {
  const data = await apiRequest<{ rubric: CriteriaRubric }>('/admin/criteria');
  return data.rubric || {};
}

export async function getCriteriaConfig(scenarioId: string): Promise<CriteriaConfig> {
  const data = await apiRequest<{ criteriaConfig: CriteriaConfig }>(
    `/admin/criteria/config/${encodeURIComponent(scenarioId)}`
  );
  return data.criteriaConfig || { scenarioId, disabledCriteria: [] };
}

export async function saveCriteriaConfig(scenarioId: string, disabledCriteria: string[]): Promise<CriteriaConfig> {
  const data = await apiRequest<{ criteriaConfig: CriteriaConfig }>(
    `/admin/criteria/config/${encodeURIComponent(scenarioId)}`,
    { method: 'PUT', body: { disabledCriteria } }
  );
  return data.criteriaConfig || { scenarioId, disabledCriteria };
}
