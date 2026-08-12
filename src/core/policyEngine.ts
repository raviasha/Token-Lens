import { createHash } from 'node:crypto';
import {
  CodeBuddyPolicy,
  ContextEstimate,
  ContextThresholdState,
  ObservableSignals,
  SessionContextSnapshot
} from './contracts';

export const DEFAULT_POLICY: CodeBuddyPolicy = {
  healthCheck: { showOnEveryMeaningfulCodingTask: true },
  promptReview: { enabled: true, interventionThreshold: 75 },
  taskDecomposition: { enabled: true, interventionThreshold: 65 },
  sessionFit: {
    recommendFreshTaskAtOrAbove: 75,
    fallbackLexicalOverlapBelow: 0.20
  },
  context: {
    estimatedContextCapacityTokens: 40_000,
    warningThreshold: 0.70,
    criticalThreshold: 0.85,
    allowVisionVerification: true,
    offerCurationOnNewSession: true,
    offerCurationOnNewTask: true
  }
};

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function classifyContext(utilization: number, policy: CodeBuddyPolicy = DEFAULT_POLICY): ContextThresholdState {
  if (utilization >= policy.context.criticalThreshold) {
    return 'critical';
  }
  if (utilization >= policy.context.warningThreshold) {
    return 'warning';
  }
  return 'normal';
}

export function isMeaningfulPrompt(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized || /^(yes|no|continue|go ahead|run it|do it|ok|okay|cancel|stop|retry)[.!]?$/i.test(normalized)) {
    return false;
  }
  return normalized.split(/\s+/).length >= 3 || normalized.length >= 20;
}

export function promptInterventionRecommended(score: number, modelRecommendation: boolean, policy: CodeBuddyPolicy = DEFAULT_POLICY): boolean {
  return policy.promptReview.enabled && (modelRecommendation || score < policy.promptReview.interventionThreshold);
}

export function decompositionRecommended(score: number, modelRecommendation: boolean, policy: CodeBuddyPolicy = DEFAULT_POLICY): boolean {
  return policy.taskDecomposition.enabled && (modelRecommendation || score >= policy.taskDecomposition.interventionThreshold);
}

export function shouldRecommendFreshTask(newTaskLikelihood: number, policy: CodeBuddyPolicy = DEFAULT_POLICY): boolean {
  return newTaskLikelihood >= policy.sessionFit.recommendFreshTaskAtOrAbove;
}

export function estimateContext(
  signals: ObservableSignals,
  sessionId: string,
  timestamp: string,
  policy: CodeBuddyPolicy = DEFAULT_POLICY
): SessionContextSnapshot {
  const utilization = signals.estimatedTokens / Math.max(1, policy.context.estimatedContextCapacityTokens);
  const estimate: ContextEstimate = {
    value: signals.estimatedTokens,
    unit: 'estimated_tokens',
    utilization,
    method: 'estimate',
    confidence: 'low',
    thresholdState: classifyContext(utilization, policy),
    estimatorVersion: 'code_buddy_context_estimator_v2',
    terminology: 'Estimated Context Pressure'
  };
  return { sessionId, timestamp, signals, estimate };
}

const ignoredTaskWords = new Set([
  'about', 'after', 'again', 'also', 'and', 'before', 'code', 'continue', 'current', 'existing', 'for', 'from',
  'have', 'into', 'make', 'more', 'please', 'should', 'task', 'that', 'the', 'then', 'this', 'with', 'work'
]);

function taskTerms(prompt: string): Set<string> {
  return new Set(
    (prompt.toLowerCase().match(/[a-z0-9_.\/-]{3,}/g) ?? [])
      .filter((term) => !ignoredTaskWords.has(term))
  );
}

export interface TaskBoundaryAssessment {
  isLikelyNewTask: boolean;
  confidence: 'high' | 'medium' | 'low';
  overlap: number;
  reason: string;
}

export interface PromptReference {
  sessionId: string;
  prompt: string;
}

export interface CurationBoundaryAssessment {
  kind: 'none' | 'new_session' | 'new_task';
  reason: string;
  taskBoundary?: TaskBoundaryAssessment;
}

export function detectNewTask(previousPrompt: string, currentPrompt: string): TaskBoundaryAssessment {
  if (!isMeaningfulPrompt(previousPrompt) || !isMeaningfulPrompt(currentPrompt)) {
    return { isLikelyNewTask: false, confidence: 'low', overlap: 1, reason: 'Insufficient meaningful prompt history.' };
  }
  if (/^(continue|next|now|also|then|build on|following up|same task)\b/i.test(currentPrompt.trim())) {
    return { isLikelyNewTask: false, confidence: 'high', overlap: 1, reason: 'The prompt explicitly continues prior work.' };
  }
  const previous = taskTerms(previousPrompt);
  const current = taskTerms(currentPrompt);
  const shared = [...current].filter((term) => previous.has(term)).length;
  const overlap = shared / Math.max(1, Math.min(previous.size, current.size));
  const isLikelyNewTask = previous.size >= 2 && current.size >= 2 && overlap < 0.2;
  return {
    isLikelyNewTask,
    confidence: overlap < 0.1 ? 'high' : overlap < 0.3 ? 'medium' : 'low',
    overlap: Number(overlap.toFixed(2)),
    reason: isLikelyNewTask
      ? 'The new prompt has little task-specific overlap with the prior prompt.'
      : 'The prompts retain task-specific overlap.'
  };
}

function hasKnownSessionId(value: string): boolean {
  const sessionId = value.trim();
  return Boolean(sessionId) && sessionId !== 'unknown';
}

export function detectCurationBoundary(
  previous: PromptReference,
  current: PromptReference
): CurationBoundaryAssessment {
  if (!isMeaningfulPrompt(previous.prompt) || !isMeaningfulPrompt(current.prompt)) {
    return {
      kind: 'none',
      reason: 'A curation boundary requires meaningful prompts in both the prior and current context.'
    };
  }
  const previousKnown = hasKnownSessionId(previous.sessionId);
  const currentKnown = hasKnownSessionId(current.sessionId);
  if (previousKnown && currentKnown && previous.sessionId !== current.sessionId) {
    return {
      kind: 'new_session',
      reason: 'The first meaningful prompt belongs to a different Copilot session and prior Code Buddy context exists.'
    };
  }
  if (!previousKnown || !currentKnown || previous.sessionId !== current.sessionId) {
    return {
      kind: 'none',
      reason: 'A same-session task boundary could not be established from the available session identifiers.'
    };
  }
  const taskBoundary = detectNewTask(previous.prompt, current.prompt);
  return {
    kind: taskBoundary.isLikelyNewTask ? 'new_task' : 'none',
    reason: taskBoundary.reason,
    taskBoundary
  };
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)}`;
}
