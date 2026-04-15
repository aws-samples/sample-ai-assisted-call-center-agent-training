/**
 * API client for the Connect admin API Gateway.
 * Uses Cognito ID tokens (JWT) for authentication.
 */

import { fetchAuthSession } from 'aws-amplify/auth';

const API_BASE_URL = import.meta.env.VITE_API_URL || '';

async function getIdToken(): Promise<string> {
  const session = await fetchAuthSession();
  const idToken = session.tokens?.idToken?.toString();
  if (!idToken) {
    throw new Error('Not authenticated - no ID token available');
  }
  return idToken;
}

/**
 * Make an authenticated API request to the Connect admin API Gateway.
 */
export async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST';
    body?: unknown;
  } = {}
): Promise<T> {
  const { method = 'GET', body } = options;

  if (!API_BASE_URL) {
    throw new Error('API URL not configured. Set VITE_API_URL environment variable.');
  }

  const token = await getIdToken();

  const base = API_BASE_URL.replace(/\/$/, '');
  const fullPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${base}${fullPath}`;

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `API request failed: ${response.status}`);
  }

  return response.json();
}


export async function getSessionDetail(sessionId: string) {
  return apiRequest<SessionDetailResponse>(`/calls/${sessionId}`);
}

export async function getSessionAudioUrl(sessionId: string) {
  return apiRequest<{ url: string; key: string }>(`/calls/${sessionId}/audio`);
}

export interface SessionDetailResponse {
  session: Record<string, unknown>;
  scorecard: ScorecardData | null;
  transcript: TranscriptTurn[] | null;
}

export interface TranscriptTurn {
  speaker: string;
  text: string;
  timestamp?: string;
  audio_start_time?: number;
  audio_duration?: number;
  turn?: number;
}

export interface ScorecardData {
  session_id: string;
  scenario_name: string;
  final_score: number;
  total_possible_score: number;
  percentage_score: number;
  passed: boolean;
  critical_failures?: string[];
  general_comments?: string;
  sections: ScorecardSection[];
  /** Flat criteria map keyed by criterion_id (backend format) */
  criteria?: Record<string, ScorecardCriterion>;
  analytics?: CallAnalytics;
}

export interface ScorecardSection {
  section_id: string;
  section_name: string;
  section_score: number;
  max_score: number;
}

export interface ScorecardCriterion {
  description: string;
  criticality: string;
  passed: boolean;
  score: number;
  max_points: number;
  comments: string;
}

export interface CallAnalytics {
  call_duration_seconds?: number;
  agent_silence_seconds?: number;
  agent_silence_percentage?: number;
  max_silence_gap_seconds?: number;
  silence_violations_count?: number;
  talk_over_count?: number;
  questions_asked?: number;
  questions_answered?: number;
  avg_agent_response_time?: number;
  hold_count?: number;
  confidence_language_count?: number;
  empathy?: {
    score: number;
    reason: string;
    components?: Record<string, { score: number; weight: number }>;
  };
}
