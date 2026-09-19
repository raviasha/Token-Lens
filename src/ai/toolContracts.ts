import {
  ContextCurationInput,
  CuratedContextBundle,
  CuratedContextItem,
  DecompositionStep,
  DecompositionStrategy,
  PromptDimension,
  PromptDimensionAssessment,
  PromptIssue,
  PromptOption,
  PromptReviewInput,
  PromptReviewResult,
  SessionFitInput,
  SessionFitResult,
  TaskDecompositionInput,
  TaskDecompositionResult,
  TOOL_CONTRACT_VERSION,
  ToolFailure
} from '../core/contracts';
import { decompositionRecommended, detectNewTask, promptInterventionRecommended, shouldRecommendFreshTask, stableId } from '../core/policyEngine';
import { CodeBuddyPolicy, CurationSection } from '../core/contracts';
import rubric from '../resources/code-buddy-scoring-rubric.json';

const promptDimensions = new Set<PromptDimension>([
  'goalClarity', 'scope', 'relevantContext', 'constraints', 'acceptanceCriteria', 'validation', 'ambiguity', 'breadth'
]);
const curationSections = new Set<CurationSection>([
  'background', 'decision', 'constraint', 'file', 'implementation_state', 'completed_work', 'remaining_work', 'issue',
  'validation', 'open_question', 'excluded_history'
]);

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function strings(value: unknown, limit = 20): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, limit)
    : [];
}

function score(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : undefined;
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(withoutFence.slice(start, end + 1));
    }
    throw new Error('The model response did not contain a JSON object.');
  }
}

export function buildPromptReviewRequest(input: PromptReviewInput): string {
  return [
    'You are the semantic Prompt Reviewer for Code Buddy.',
    'Evaluate only dimensions that materially matter for this coding request. Do not mechanically penalize irrelevant omissions.',
    'Preserve the developer’s original intent. Do not invent requirements, files, constraints, or acceptance criteria.',
    'Return JSON only with: score (0-100), dimensions, reasons, issues, interventionRecommended, suggestions, and options.',
    'Each dimension must use one of goalClarity, scope, relevantContext, constraints, acceptanceCriteria, validation, ambiguity, breadth.',
    'Each options entry must contain id, label, prompt, and preservesOriginalIntent. Offer at most three context-aware alternatives.',
    'Do not include the original option; Code Buddy adds it deterministically.',
    `PROMPT: ${input.prompt}`,
    ...(input.relevantContext?.length ? [`RELEVANT CONTEXT:\n${input.relevantContext.join('\n')}`] : [])
  ].join('\n\n');
}

export function normalizePromptReview(raw: unknown, input: PromptReviewInput, policy: CodeBuddyPolicy): PromptReviewResult {
  const object = asObject(raw);
  const numericScore = score(object?.score);
  if (!object || numericScore === undefined || !Array.isArray(object.dimensions)) {
    throw new Error('Prompt Reviewer returned an invalid score or dimensions array.');
  }
  const dimensions: PromptDimensionAssessment[] = object.dimensions.flatMap((value) => {
    const item = asObject(value);
    const dimension = item?.dimension;
    const assessment = item?.assessment;
    if (typeof dimension !== 'string' || !promptDimensions.has(dimension as PromptDimension)
      || !['strong', 'adequate', 'weak', 'not_applicable'].includes(String(assessment)) || typeof item?.reason !== 'string') {
      return [];
    }
    return [{ dimension: dimension as PromptDimension, assessment: assessment as PromptDimensionAssessment['assessment'], reason: item.reason }];
  });
  if (!dimensions.length) {
    throw new Error('Prompt Reviewer returned no valid dimension assessments.');
  }
  const issues: PromptIssue[] = Array.isArray(object.issues) ? object.issues.flatMap((value) => {
    const item = asObject(value);
    if (typeof item?.dimension !== 'string' || !promptDimensions.has(item.dimension as PromptDimension)
      || typeof item.reason !== 'string' || !['low', 'medium', 'high'].includes(String(item.severity))) {
      return [];
    }
    return [{ dimension: item.dimension as PromptDimension, reason: item.reason, severity: item.severity as PromptIssue['severity'] }];
  }) : [];
  const alternatives: PromptOption[] = Array.isArray(object.options) ? object.options.flatMap((value, index) => {
    const item = asObject(value);
    if (typeof item?.label !== 'string' || typeof item.prompt !== 'string' || !item.prompt.trim()) {
      return [];
    }
    return [{
      id: typeof item.id === 'string' && item.id ? item.id : `enhanced_${index + 1}`,
      label: item.label,
      prompt: item.prompt,
      preservesOriginalIntent: item.preservesOriginalIntent !== false
    }];
  }).slice(0, 3) : [];
  const options: PromptOption[] = [{
    id: 'original',
    label: 'Continue with my original prompt',
    prompt: input.prompt,
    preservesOriginalIntent: true
  }, ...alternatives.filter((option) => option.id !== 'original')];
  return {
    contractVersion: TOOL_CONTRACT_VERSION,
    kind: 'prompt_review',
    status: 'ok',
    score: numericScore,
    dimensions,
    reasons: strings(object.reasons),
    issues,
    interventionRecommended: promptInterventionRecommended(numericScore, object.interventionRecommended === true, policy),
    suggestions: strings(object.suggestions),
    options,
    originalPromptRetained: true
  };
}

export function promptReviewFallback(input: PromptReviewInput, failure: ToolFailure): PromptReviewResult {
  return {
    contractVersion: TOOL_CONTRACT_VERSION,
    kind: 'prompt_review',
    status: 'fallback',
    score: 100,
    dimensions: [],
    reasons: [failure.message],
    issues: [],
    interventionRecommended: false,
    suggestions: [],
    options: [{ id: 'original', label: 'Continue with my original prompt', prompt: input.prompt, preservesOriginalIntent: true }],
    selectedOptionId: 'original',
    originalPromptRetained: true,
    failure
  };
}

export function buildTaskDecompositionRequest(input: TaskDecompositionInput): string {
  return [
    'You are the semantic Task Decomposer for Code Buddy.',
    'Assess whether decomposition would materially improve execution; do not decompose small cohesive requests.',
    'Consider objectives, components, architectural impact, dependencies, uncertainty, testing scope, sequencing, and independent work.',
    'Return JSON only with complexityScore (0-100), reasons, decompositionRecommended, and strategies.',
    'Each strategy must contain id, label, rationale, and ordered steps. Each step has id, title, objective, dependsOn, and optional suggestedValidation.',
    'When useful, offer minimal, feature-oriented, or architecture-first strategies generated from this actual task.',
    'Do not include the original-task option; Code Buddy adds it deterministically.',
    `TASK: ${input.task}`,
    ...(input.relevantContext?.length ? [`RELEVANT CONTEXT:\n${input.relevantContext.join('\n')}`] : [])
  ].join('\n\n');
}

function normalizeStep(value: unknown, index: number): DecompositionStep | undefined {
  const item = asObject(value);
  if (typeof item?.title !== 'string' || typeof item.objective !== 'string') {
    return undefined;
  }
  return {
    id: typeof item.id === 'string' && item.id ? item.id : `step_${index + 1}`,
    title: item.title,
    objective: item.objective,
    dependsOn: strings(item.dependsOn, 10),
    ...(typeof item.suggestedValidation === 'string' ? { suggestedValidation: item.suggestedValidation } : {})
  };
}

export function normalizeTaskDecomposition(raw: unknown, input: TaskDecompositionInput, policy: CodeBuddyPolicy): TaskDecompositionResult {
  const object = asObject(raw);
  const complexityScore = score(object?.complexityScore);
  if (!object || complexityScore === undefined || !Array.isArray(object.strategies)) {
    throw new Error('Task Decomposer returned an invalid complexity score or strategies array.');
  }
  const strategies: DecompositionStrategy[] = object.strategies.flatMap((value, index) => {
    const item = asObject(value);
    if (typeof item?.label !== 'string' || typeof item.rationale !== 'string' || !Array.isArray(item.steps)) {
      return [];
    }
    const steps = item.steps.map(normalizeStep).filter((step): step is DecompositionStep => Boolean(step));
    if (!steps.length) {
      return [];
    }
    return [{
      id: typeof item.id === 'string' && item.id ? item.id : `strategy_${index + 1}`,
      label: item.label,
      rationale: item.rationale,
      steps
    }];
  }).slice(0, 3);
  const recommended = decompositionRecommended(complexityScore, object.decompositionRecommended === true, policy);
  if (recommended && !strategies.length) {
    throw new Error('Task Decomposer recommended decomposition without a valid strategy.');
  }
  return {
    contractVersion: TOOL_CONTRACT_VERSION,
    kind: 'task_decomposition',
    status: 'ok',
    complexityScore,
    reasons: strings(object.reasons),
    decompositionRecommended: recommended,
    strategies,
    originalTaskOption: { id: 'original', label: 'Continue with the original task', task: input.task },
    originalTaskRetained: true
  };
}

export function taskDecompositionFallback(input: TaskDecompositionInput, failure: ToolFailure): TaskDecompositionResult {
  return {
    contractVersion: TOOL_CONTRACT_VERSION,
    kind: 'task_decomposition',
    status: 'fallback',
    complexityScore: 0,
    reasons: [failure.message],
    decompositionRecommended: false,
    strategies: [],
    originalTaskOption: { id: 'original', label: 'Continue with the original task', task: input.task },
    originalTaskRetained: true,
    failure
  };
}

export function buildSessionFitRequest(input: SessionFitInput): string {
  return [
    'You are the semantic Session Fit evaluator for Code Buddy.',
    'Determine whether the current meaningful coding prompt starts a substantially new task or continues the prior task.',
    'Use the prior prompt only as supplied. Do not invent task history or create a task; this assessment only informs a developer-controlled recommendation.',
    'Return JSON only with newTaskLikelihood (0-100), confidence (high, medium, or low), and a concise reason.',
    `CALIBRATION: continuation (${rubric.sessionFit.continuation.example}) => ${rubric.sessionFit.continuation.newTaskLikelihood}; unrelated (${rubric.sessionFit.unrelated.example}) => ${rubric.sessionFit.unrelated.newTaskLikelihood}.`,
    `CURRENT PROMPT: ${input.prompt}`,
    ...(input.previousPrompt ? [`PREVIOUS PROMPT: ${input.previousPrompt}`] : ['PREVIOUS PROMPT: unavailable']),
    ...(input.relevantContext?.length ? [`RELEVANT CONTEXT:\n${input.relevantContext.join('\n')}`] : [])
  ].join('\n\n');
}

export function normalizeSessionFit(raw: unknown, input: SessionFitInput, policy: CodeBuddyPolicy): SessionFitResult {
  const object = asObject(raw);
  const newTaskLikelihood = score(object?.newTaskLikelihood);
  const confidence = object?.confidence;
  const reason = object?.reason;
  if (newTaskLikelihood === undefined || !['high', 'medium', 'low'].includes(String(confidence)) || typeof reason !== 'string' || !reason.trim()) {
    throw new Error('Session Fit returned an invalid likelihood, confidence, or reason.');
  }
  return {
    contractVersion: TOOL_CONTRACT_VERSION,
    kind: 'session_fit',
    status: 'ok',
    newTaskLikelihood,
    confidence: confidence as SessionFitResult['confidence'],
    reason,
    freshTaskRecommended: shouldRecommendFreshTask(newTaskLikelihood, policy),
    assessmentSource: 'codex_model'
  };
}

export function sessionFitFallback(input: SessionFitInput, policy: CodeBuddyPolicy): SessionFitResult {
  if (!input.previousPrompt?.trim()) {
    return {
      contractVersion: TOOL_CONTRACT_VERSION,
      kind: 'session_fit',
      status: 'fallback',
      newTaskLikelihood: 0,
      confidence: 'low',
      reason: 'No prior meaningful task to compare.',
      freshTaskRecommended: false,
      assessmentSource: 'lexical_fallback'
    };
  }
  const assessment = detectNewTask(input.previousPrompt, input.prompt, policy.sessionFit.fallbackLexicalOverlapBelow);
  const newTaskLikelihood = assessment.isLikelyNewTask ? 80 : 0;
  return {
    contractVersion: TOOL_CONTRACT_VERSION,
    kind: 'session_fit',
    status: 'fallback',
    newTaskLikelihood,
    confidence: assessment.confidence,
    reason: assessment.reason,
    freshTaskRecommended: shouldRecommendFreshTask(newTaskLikelihood, policy),
    assessmentSource: 'lexical_fallback'
  };
}

export function buildContextCurationRequest(input: ContextCurationInput): string {
  const source = {
    conversationHistory: input.conversationHistory ?? [],
    knownDecisions: input.knownDecisions ?? [],
    relevantFiles: input.relevantFiles ?? [],
    constraints: input.constraints ?? [],
    implementationState: input.implementationState ?? [],
    completedWork: input.completedWork ?? [],
    remainingWork: input.remainingWork ?? [],
    knownIssues: input.knownIssues ?? [],
    validation: input.validation ?? [],
    openQuestions: input.openQuestions ?? [],
    pinnedItems: input.pinnedItems ?? []
  };
  return [
    'You are the semantic Context Curator for Code Buddy.',
    'Produce the minimum sufficient task-specific context, not a chronological summary of everything.',
    'Keep facts relevant to the target task, preserve pinned items, and explicitly identify excluded irrelevant history.',
    'Do not invent implementation state, decisions, validation, or file references.',
    'Return JSON only with taskObjective, items, suggestedStartingInstruction, and excludedHistory.',
    'Each item must contain id, section, content, and pinned. Sections: background, decision, constraint, file, implementation_state, completed_work, remaining_work, issue, validation, open_question, excluded_history.',
    `MODE: ${input.mode}`,
    `TARGET TASK: ${input.targetTask}`,
    `AVAILABLE SOURCE: ${JSON.stringify(source)}`
  ].join('\n\n');
}

export function normalizeCuratedContext(raw: unknown, input: ContextCurationInput): CuratedContextBundle {
  const object = asObject(raw);
  if (!object || typeof object.taskObjective !== 'string' || typeof object.suggestedStartingInstruction !== 'string' || !Array.isArray(object.items)) {
    throw new Error('Context Curator returned an invalid bundle.');
  }
  const pinned = new Set(input.pinnedItems ?? []);
  const items: CuratedContextItem[] = object.items.flatMap((value, index) => {
    const item = asObject(value);
    if (typeof item?.section !== 'string' || !curationSections.has(item.section as CurationSection)
      || typeof item.content !== 'string' || !item.content.trim()) {
      return [];
    }
    return [{
      id: typeof item.id === 'string' && item.id ? item.id : stableId('context', { index, content: item.content }),
      section: item.section as CurationSection,
      content: item.content,
      pinned: item.pinned === true || pinned.has(item.content)
    }];
  }).slice(0, 60);
  if (!items.length) {
    throw new Error('Context Curator returned no usable context items.');
  }
  return {
    contractVersion: TOOL_CONTRACT_VERSION,
    kind: 'context_curation',
    status: 'ok',
    taskObjective: object.taskObjective,
    items,
    suggestedStartingInstruction: object.suggestedStartingInstruction,
    excludedHistory: strings(object.excludedHistory),
    accepted: false
  };
}

export function contextCurationFallback(input: ContextCurationInput, failure: ToolFailure): CuratedContextBundle {
  return {
    contractVersion: TOOL_CONTRACT_VERSION,
    kind: 'context_curation',
    status: 'fallback',
    taskObjective: input.targetTask,
    items: [],
    suggestedStartingInstruction: input.targetTask,
    excludedHistory: [],
    accepted: false,
    failure
  };
}
