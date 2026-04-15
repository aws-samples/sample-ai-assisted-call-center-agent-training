/**
 * Scoring service for requesting AI scoring of training sessions.
 * Uses HTTP API Gateway with async polling pattern:
 * 1. POST /scoring → kicks off scoring (returns 202)
 * 2. GET /scoring/{sessionId} → polls for result until completed
 */

import { apiRequest } from './api';
import type { CallAnalytics } from '../types';

export interface CriterionScore {
  description: string;
  criticality: 'Critical' | 'Non-Critical';
  passed: boolean;
  score: number;
  max_points: number;
  comments: string;
}

export interface SectionScore {
  section_id: string;
  section_name: string;
  section_score: number;
  max_score: number;
}

export interface ScorecardResponse {
  sessionId: string;
  scorecard: {
    session_id: string;
    scenario_name: string;
    evaluation_timestamp: string;
    final_score: number;
    total_possible_score: number;
    percentage_score: number;
    passed: boolean;
    critical_failures: string[];
    sections: SectionScore[];
    criteria: Record<string, CriterionScore>;
    general_comments?: string;
    analytics?: CallAnalytics;
  };
  s3Url: string;
  timestamp: string;
}

interface ScoringStatusResponse {
  sessionId: string;
  status: 'scoring' | 'completed';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scorecard?: any;
}

/**
 * Request scoring for a training session.
 * Kicks off async scoring and polls until the result is ready.
 *
 * @param sessionId - The session ID to score
 * @param userId - Optional user ID for user-scoped S3 paths
 * @returns Promise<ScorecardResponse>
 */
export const requestScoring = async (sessionId: string, userId?: string): Promise<ScorecardResponse> => {
  console.log('[Scoring] Requesting scoring for session:', sessionId);

  // Step 1: Kick off scoring (may return 200 if already scored, or 202 if starting)
  const kickoff = await apiRequest<ScoringStatusResponse>('/scoring', {
    method: 'POST',
    body: { sessionId, ...(userId ? { userId } : {}) },
  });

  // If scoring already completed (scorecard existed), return immediately
  if (kickoff.status === 'completed' && kickoff.scorecard) {
    console.log('[Scoring] Scorecard already exists, returning cached result');
    return {
      sessionId,
      scorecard: kickoff.scorecard,
      s3Url: '',
      timestamp: new Date().toISOString(),
    };
  }

  console.log('[Scoring] Scoring started, polling for result...');

  // Step 2: Poll for results
  const maxAttempts = 60; // 5 minutes at 5-second intervals
  const pollInterval = 5000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, pollInterval));

    const queryParams: Record<string, string> = {};
    if (userId) queryParams.userId = userId;

    const result = await apiRequest<ScoringStatusResponse>(
      `/scoring/${encodeURIComponent(sessionId)}`,
      { queryParams }
    );

    if (result.status === 'completed' && result.scorecard) {
      console.log('[Scoring] Scoring completed successfully');
      console.log('[Scoring] Final score:', result.scorecard.final_score, '/', result.scorecard.total_possible_score);
      console.log('[Scoring] Passed:', result.scorecard.passed);

      return {
        sessionId,
        scorecard: result.scorecard,
        s3Url: '',
        timestamp: new Date().toISOString(),
      };
    }

    console.log(`[Scoring] Still scoring... (attempt ${attempt + 1}/${maxAttempts})`);
  }

  throw new Error('Scoring timed out after 5 minutes');
};
