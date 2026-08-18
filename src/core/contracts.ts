export const TOOL_CONTRACT_VERSION = 1;
export const CONTEXT_ESTIMATOR_VERSION = 'code_buddy_context_estimator_v2';

export type PromptDimension =
  | 'goalClarity'
  | 'scope'
  | 'relevantContext'
  | 'constraints'
  | 'acceptanceCriteria'
  | 'validation'
  | 'ambiguity'
  | 'breadth';

export interface PromptDimensionAssessment {
  dimension: PromptDimension;
  assessment: 'strong' | 'adequate' | 'weak' | 'not_applicable';
  reason: string;
}

export interface PromptIssue {
  dimension: PromptDimension;
  reason: string;
  severity: 'low' | 'medium' | 'high';
}

export interface PromptOption {
  id: string;
  label: string;
  prompt: string;
  preservesOriginalIntent: boolean;
}

export interface PromptReviewInput {
  prompt: string;
  sessionId?: string;
  taskId?: string;
  relevantContext?: string[];
}

export interface PromptReviewResult {
  contractVersion: number;
  kind: 'prompt_review';
  status: 'ok' | 'fallback';
  score: number;
  dimensions: PromptDimensionAssessment[];
  reasons: string[];
  issues: PromptIssue[];
  interventionRecommended: boolean;
  suggestions: string[];
  options: PromptOption[];
  selectedOptionId?: string;
  originalPromptRetained: boolean;
  failure?: ToolFailure;
}

export interface DecompositionStep {
  id: string;
  title: string;
  objective: string;
  dependsOn: string[];
  suggestedValidation?: string;
}

export interface DecompositionStrategy {
  id: string;
  label: string;
  rationale: string;
  steps: DecompositionStep[];
}

export interface TaskDecompositionInput {
  task: string;
  sessionId?: string;
  taskId?: string;
  relevantContext?: string[];
}

export interface TaskDecompositionResult {
  contractVersion: number;
  kind: 'task_decomposition';
  status: 'ok' | 'fallback';
  complexityScore: number;
  reasons: string[];
  decompositionRecommended: boolean;
  strategies: DecompositionStrategy[];
  originalTaskOption: { id: 'original'; label: string; task: string };
  selectedStrategyId?: string;
  selectedStepId?: string;
  originalTaskRetained: boolean;
  failure?: ToolFailure;
}

export interface SessionFitInput {
  prompt: string;
  previousPrompt?: string;
  sessionId?: string;
  taskId?: string;
  relevantContext?: string[];
}

export interface SessionFitResult {
  contractVersion: number;
  kind: 'session_fit';
  status: 'ok' | 'fallback';
  newTaskLikelihood: number;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  freshTaskRecommended: boolean;
  assessmentSource: 'codex_model' | 'lexical_fallback';
  failure?: ToolFailure;
}

export type ContextMeasurementMethod = 'api' | 'vision' | 'estimate';
export type ContextThresholdState = 'normal' | 'warning' | 'critical' | 'unavailable';

export interface ContextEstimate {
  value: number;
  unit: 'tokens' | 'estimated_tokens';
  utilization?: number;
  capacityTokens?: number;
  method: ContextMeasurementMethod;
  confidence: 'high' | 'medium' | 'low';
  thresholdState: ContextThresholdState;
  estimatorVersion?: string;
  providerId?: string;
  measurementTimestamp?: string;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  terminology: 'Actual Context Utilization' | 'Estimated Context Pressure';
}

export interface ContextMeasurementCandidate {
  value: number;
  unit: 'tokens';
  confidence: 'high' | 'medium' | 'low';
  providerId: string;
  capacityTokens?: number;
  utilization?: number;
  measurementTimestamp?: string;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  evidence?: string;
}

export interface ContextMeasurementInput {
  sessionId?: string;
  nativeMeasurement?: ContextMeasurementCandidate;
  visionMeasurement?: ContextMeasurementCandidate;
  estimate?: Omit<ContextEstimate, 'method' | 'terminology'>;
}

export interface ContextMeasurementResult {
  contractVersion: number;
  kind: 'context_measurement';
  status: 'ok' | 'fallback';
  measurement: ContextEstimate;
  providerId: string;
  recommendation: 'none' | 'consider_curation' | 'curate_or_start_fresh';
  availableActions: Array<'start_fresh' | 'curate_current' | 'continue_unchanged'>;
  failure?: ToolFailure;
}

export type CurationSection =
  | 'background'
  | 'decision'
  | 'constraint'
  | 'file'
  | 'implementation_state'
  | 'completed_work'
  | 'remaining_work'
  | 'issue'
  | 'validation'
  | 'open_question'
  | 'excluded_history';

export interface CuratedContextItem {
  id: string;
  section: CurationSection;
  content: string;
  pinned: boolean;
}

export interface ContextCurationInput {
  targetTask: string;
  mode: 'fresh_task' | 'continue_current';
  sessionId?: string;
  conversationHistory?: string[];
  knownDecisions?: string[];
  relevantFiles?: string[];
  constraints?: string[];
  implementationState?: string[];
  completedWork?: string[];
  remainingWork?: string[];
  knownIssues?: string[];
  validation?: string[];
  openQuestions?: string[];
  pinnedItems?: string[];
}

export interface CuratedContextBundle {
  contractVersion: number;
  kind: 'context_curation';
  status: 'ok' | 'fallback';
  taskObjective: string;
  items: CuratedContextItem[];
  suggestedStartingInstruction: string;
  excludedHistory: string[];
  accepted: boolean;
  failure?: ToolFailure;
}

export interface ToolFailure {
  code: 'disabled' | 'model_unavailable' | 'model_error' | 'invalid_output' | 'cancelled' | 'provider_unavailable';
  message: string;
  continuation: 'use_original' | 'use_estimate' | 'continue_current_session';
}

export interface ObservableSignals {
  turns: number;
  promptCharacters: number;
  responseCharacters: number;
  observedCharacters: number;
  toolCalls: number;
  toolFailures: number;
  filesReferenced: number;
  filesChanged: number;
  linesAdded: number | null;
  linesDeleted: number | null;
  durationSeconds: number;
  estimatedTokens: number;
}

export interface SessionContextSnapshot {
  sessionId: string;
  timestamp: string;
  signals: ObservableSignals;
  estimate: ContextEstimate;
}

export interface ProviderCapabilities {
  providerId: string;
  conversationEventAccess: 'none' | 'hook' | 'native';
  nativeContextMeasurement: boolean;
  visionContextMeasurement: boolean;
  toolInvocation: boolean;
  interactiveQuickPick: boolean;
  automaticNewChatSeed: boolean;
}

export interface CodeBuddyPolicy {
  healthCheck: { showOnEveryMeaningfulCodingTask: boolean };
  promptReview: { enabled: boolean; interventionThreshold: number };
  taskDecomposition: { enabled: boolean; interventionThreshold: number };
  sessionFit: {
    recommendFreshTaskAtOrAbove: number;
    fallbackLexicalOverlapBelow: number;
  };
  context: {
    estimatedContextCapacityTokens: number;
    warningThreshold: number;
    criticalThreshold: number;
    allowVisionVerification: boolean;
    offerCurationOnNewSession: boolean;
    offerCurationOnNewTask: boolean;
  };
  measurement: {
    humanRetries: {
      minimumComparableTasks: number;
      minimumTasksPerFactor: number;
      reliabilityThreshold: number;
      minimumEffectSize: number;
      overdispersionThreshold: number;
    };
  };
}

export interface ProjectPolicyDiagnostic {
  code: 'invalid_value' | 'unsupported_syntax' | 'unknown_key' | 'missing_file';
  path: string;
  message: string;
}

export interface ProjectPolicyLoad {
  policy: CodeBuddyPolicy;
  diagnostics: ProjectPolicyDiagnostic[];
}

export interface InterventionEvent {
  schemaVersion: 1;
  eventId: string;
  timestamp: string;
  eventType: string;
  sessionId?: string;
  taskId?: string;
  data: Record<string, unknown>;
}
