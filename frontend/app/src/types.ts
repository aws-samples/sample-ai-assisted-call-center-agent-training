export interface ScenarioCharacter {
  id: string;
  name: string;
  voice: string;
  gender: string;
  is_primary: boolean;
}

export interface Scenario {
  id: string;
  name: string;
  context: string;
  key_challenges: string[];
  success_criteria: string[];
  difficulty?: string;
  initial_message?: string;
  original_call_logs?: string;
  caller_gender?: string;
  characters?: ScenarioCharacter[];
}

export interface TranscriptMessage {
  speaker: string;
  text: string;
  timestamp: number;
}

export interface SessionData {
  sessionId: string | null;
  scenarioId: string;
  scenarioName: string;
  startTime: number | null;
  transcript: TranscriptMessage[];
}

export interface ScoringMetric {
  score: number;
  grade: string;
  reason: string;
  weight: number;
  description: string;
}

export interface CallAnalytics {
  call_duration_seconds: number;
  agent_silence_seconds: number;
  agent_silence_percentage: number;
  max_silence_gap_seconds?: number;
  silence_violations_count?: number;
  talk_over_count: number;
  questions_asked: number;
  questions_answered: number;
  questions_unanswered: number;
  avg_agent_response_time: number;
  hold_count?: number;
  confidence_language_count?: number;
  empathy?: {
    score: number;
    reason: string;
    features: Record<string, number>;
    components?: Record<string, { score: number; weight: number }>;
  };
}

export interface ScoringData {
  sessionId: string;
  overallScore: number;
  overallGrade: string;
  finalScore: number;
  totalPossibleScore: number;
  metrics: Record<string, ScoringMetric>;
  timestamp: string;
  analytics?: CallAnalytics;
}

export interface HistoryItem {
  scenario_name: string;
  timestamp: string;
  overall_score: number;
}

export type SessionStatus = 'ready' | 'active' | 'ended' | 'scoring';
export type ViewType = 'scenario' | 'session' | 'scoring' | 'history'
  | 'admin-dashboard' | 'admin-trainee-sessions' | 'admin-session-detail'
  | 'admin-scenarios' | 'admin-criteria-config';
export type UserRole = 'admin' | 'trainee';

export interface TraineeInfo {
  userId: string;
  userName: string;
  sessionCount: number;
  latestScore?: number | null;
  latestDate?: string | null;
  totalInputTokens?: number;
  totalOutputTokens?: number;
}

export interface TokenUsageComponent {
  model?: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
}

export interface TraineeSession {
  sessionId: string;
  userId: string;
  userName: string;
  scenarioName: string;
  score: number | null;
  grade: string | null;
  passed: boolean | null;
  timestamp: string;
  tokenUsage?: Record<string, TokenUsageComponent> | null;
}

// Screen Capture types
export interface ScreenCapture {
  imageData: string;
  timestamp: number;
  elapsedSeconds: number;
  captureIndex: number;
}

export type ScreenCaptureStatus = 'idle' | 'requesting' | 'ready_to_record' | 'active' | 'stopped' | 'denied';

export interface ScreenAnalysisRequest {
  sessionId: string;
  scenarioId: string;
  scenarioName: string;
  captures: Array<{
    imageData: string;
    timestamp: number;
    elapsedSeconds: number;
    captureIndex: number;
  }>;
}

export interface ScreenActionSummary {
  timestamp: number;
  elapsedSeconds: number;
  captureIndex: number;
  actionDescription: string;
  visibleApplications: string[];
  confidence: string;
}

export interface ScreenAnalysisResponse {
  sessionId: string;
  summaries: ScreenActionSummary[];
  s3Url: string;
  timestamp: string;
}

// Criteria Configuration types
export interface CriterionInfo {
  criterionId: string;
  description: string;
  criticality: 'Critical' | 'Non-Critical';
  maxPoints: number;
}

export interface CriteriaSectionInfo {
  name: string;
  description: string;
  criteria: Record<string, CriterionInfo>;
}

export type CriteriaRubric = Record<string, CriteriaSectionInfo>;

export interface CriteriaConfig {
  scenarioId: string;
  disabledCriteria: string[];
}

// Admin session comment
export interface SessionComment {
  text: string;
  authorId: string;
  authorEmail: string;
  createdAt: string;
  updatedAt: string;
}

// Full character type for admin editing (includes prompt/handoff fields)
export interface DynamoScenarioCharacter {
  id: string;
  name: string;
  voice: string;
  gender: string;
  is_primary: boolean;
  context: string;
  initial_message: string;
  handoff_trigger: string;
  handoff_to: string;
}

// DynamoDB Scenario type (from admin API, uses scenarioId key)
export interface DynamoScenario {
  scenarioId: string;
  name: string;
  context: string;
  key_challenges: string[];
  success_criteria: string[];
  difficulty?: string;
  initial_message?: string;
  original_call_logs?: string;
  caller_gender?: string;
  characters?: DynamoScenarioCharacter[];
}
