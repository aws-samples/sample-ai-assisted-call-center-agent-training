/**
 * Screenshot analysis service for sending screen captures to the API for LLM summarization.
 * Uses HTTP API Gateway instead of direct Lambda invocation.
 */

import { apiRequest } from './api';
import type { ScreenCapture, ScreenAnalysisResponse } from '../types';

/**
 * Send a batch of screen captures to the analysis API for summarization.
 *
 * @param sessionId - Current training session ID
 * @param scenarioId - Scenario identifier
 * @param scenarioName - Scenario display name (used as context for Claude)
 * @param captures - Array of screen captures to analyze
 * @param userId - Optional user ID for user-scoped S3 paths
 * @returns Analysis response with action summaries
 */
export const analyzeScreenCaptures = async (
  sessionId: string,
  scenarioId: string,
  scenarioName: string,
  captures: ScreenCapture[],
  userId?: string
): Promise<ScreenAnalysisResponse> => {
  console.log(`[ScreenAnalysis] Sending ${captures.length} captures for session: ${sessionId}`);

  const data = await apiRequest<ScreenAnalysisResponse>('/screen-analysis', {
    method: 'POST',
    body: {
      sessionId,
      scenarioId,
      scenarioName,
      ...(userId ? { userId } : {}),
      captures: captures.map((c) => ({
        imageData: c.imageData,
        timestamp: c.timestamp,
        elapsedSeconds: c.elapsedSeconds,
        captureIndex: c.captureIndex,
      })),
    },
  });

  console.log(`[ScreenAnalysis] Analysis complete: ${data.summaries?.length ?? 0} summaries`);
  return data;
};
